import type {
  CausalComparison,
  CausalVersion,
  ConflictRecord,
  CookieRecord,
  DeviceCheckpoint,
  LocalStorageRecord,
  ObjectType,
  Tombstone,
} from '../types';
import {
  compareHlcDeterministic,
  compareVectorClocks,
  mergeVectorClocks,
} from './clock';

export const DEFAULT_TOMBSTONE_MIN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface MergeOutcome<T extends CookieRecord | LocalStorageRecord> {
  comparison: CausalComparison;
  winner: 'local' | 'remote' | 'tombstone';
  record?: T;
  tombstone?: Tombstone;
  conflict?: ConflictRecord;
  changedLocal: boolean;
}

type EffectiveSide<T extends CookieRecord | LocalStorageRecord> =
  | { kind: 'record'; record: T; version: CausalVersion }
  | { kind: 'tombstone'; tombstone: Tombstone; version: CausalVersion };

function isCookieRecord(
  record: CookieRecord | LocalStorageRecord,
): record is CookieRecord {
  return 'domain' in record;
}

function getObjectType(record: CookieRecord | LocalStorageRecord): ObjectType {
  return isCookieRecord(record) ? 'cookie' : 'localStorage';
}

function resolveEffectiveSide<T extends CookieRecord | LocalStorageRecord>(
  record?: T,
  tombstone?: Tombstone,
): EffectiveSide<T> | null {
  if (!record && !tombstone) return null;
  if (record && !tombstone) {
    return { kind: 'record', record, version: record.version };
  }
  if (!record && tombstone) {
    return { kind: 'tombstone', tombstone, version: tombstone.deleteVersion };
  }

  // Both record and tombstone exist on this side — determine which supersedes the other.
  // Prohibition #4: an older or equal record MUST NEVER resurrect a tombstone.
  const rec = record as T;
  const tomb = tombstone as Tombstone;
  const cmp = compareVectorClocks(rec.version.vectorClock, tomb.deleteVersion.vectorClock);

  if (cmp === 'LOCAL_NEWER') {
    return { kind: 'record', record: rec, version: rec.version };
  }
  if (cmp === 'REMOTE_NEWER' || cmp === 'EQUAL') {
    return { kind: 'tombstone', tombstone: tomb, version: tomb.deleteVersion };
  }

  // CONCURRENT on the same side: deterministic HLC tie-break (tombstone wins exact tie)
  const hlcCmp = compareHlcDeterministic(rec.version, tomb.deleteVersion);
  if (hlcCmp > 0) {
    return { kind: 'record', record: rec, version: rec.version };
  }
  return { kind: 'tombstone', tombstone: tomb, version: tomb.deleteVersion };
}

function buildDeletedPlaceholder<T extends CookieRecord | LocalStorageRecord>(
  template: T,
  tombstone: Tombstone,
): T {
  if (isCookieRecord(template)) {
    const placeholder: CookieRecord = {
      ...template,
      value: '',
      deleted: true,
      deleteReason: tombstone.reason,
      version: tombstone.deleteVersion,
      sourceDevice: tombstone.sourceDevice,
      updatedAt: tombstone.createdAt,
      syncStatus: 'DELETED',
    };
    return placeholder as T;
  }

  const placeholder: LocalStorageRecord = {
    ...template,
    value: '',
    deleted: true,
    version: tombstone.deleteVersion,
    sourceDevice: tombstone.sourceDevice,
    updatedAt: tombstone.createdAt,
    syncStatus: 'DELETED',
  };
  return placeholder as T;
}

function buildConflictId(objectId: string, versionA: CausalVersion, versionB: CausalVersion): string {
  const pair = [versionA.versionId, versionB.versionId].sort();
  return `conflict::${objectId}::${pair[0]}::${pair[1]}`;
}

function buildConflictRecord<T extends CookieRecord | LocalStorageRecord>(params: {
  spaceId: string;
  localRecord: T;
  remoteRecord: T;
  winningSide: 'local' | 'remote';
  resolvedRecord: T;
}): ConflictRecord {
  const { spaceId, localRecord, remoteRecord, winningSide, resolvedRecord } = params;
  return {
    conflictId: buildConflictId(
      resolvedRecord.logicalId,
      localRecord.version,
      remoteRecord.version,
    ),
    spaceId,
    siteKey: resolvedRecord.siteKey,
    trackId: resolvedRecord.trackId,
    objectType: getObjectType(resolvedRecord),
    objectId: resolvedRecord.logicalId,
    localRecord,
    remoteRecord,
    winningSide,
    resolvedRecord,
    detectedAt: Date.now(),
    resolved: false,
    resolvedBy: 'auto',
  };
}

function mergeAckDevices(a: string[], b: string[]): { merged: string[]; changedFromA: boolean } {
  const setA = new Set(a);
  const mergedSet = new Set(a);
  for (const id of b) {
    mergedSet.add(id);
  }
  const merged = Array.from(mergedSet).sort();
  const changedFromA = merged.length !== setA.size;
  return { merged, changedFromA };
}

/**
 * Resolves merging local and remote states (record, tombstone, or absent) for a single item.
 *
 * Guarantees:
 * - Causal dominance (VectorClock) always wins regardless of wall-clock skew.
 * - Prohibition #4: an older or equal record NEVER resurrects a Tombstone.
 * - True CONCURRENT updates (record vs record, or record vs delete) resolve deterministically
 *   via `compareHlcDeterministic` so any set of devices (A/B/C) converges to the exact same state,
 *   while emitting a `ConflictRecord` for user inspection in the Conflict Center.
 */
export function resolveItemMerge<T extends CookieRecord | LocalStorageRecord>(params: {
  spaceId: string;
  localRecord?: T;
  localTombstone?: Tombstone;
  remoteRecord?: T;
  remoteTombstone?: Tombstone;
  primaryDeviceId?: string;
}): MergeOutcome<T> {
  const localEff = resolveEffectiveSide(params.localRecord, params.localTombstone);
  const remoteEff = resolveEffectiveSide(params.remoteRecord, params.remoteTombstone);

  // Neither side has data
  if (!localEff && !remoteEff) {
    return {
      comparison: 'EQUAL',
      winner: 'local',
      changedLocal: false,
    };
  }

  // Only local has data
  if (localEff && !remoteEff) {
    if (localEff.kind === 'record') {
      return {
        comparison: 'LOCAL_NEWER',
        winner: 'local',
        record: localEff.record,
        changedLocal: false,
      };
    }
    return {
      comparison: 'LOCAL_NEWER',
      winner: 'tombstone',
      tombstone: localEff.tombstone,
      changedLocal: false,
    };
  }

  // Only remote has data
  if (!localEff && remoteEff) {
    if (remoteEff.kind === 'record') {
      return {
        comparison: 'REMOTE_NEWER',
        winner: 'remote',
        record: remoteEff.record,
        changedLocal: true,
      };
    }
    return {
      comparison: 'REMOTE_NEWER',
      winner: 'tombstone',
      tombstone: remoteEff.tombstone,
      changedLocal: true,
    };
  }

  // Both sides have an effective state
  const localSide = localEff as EffectiveSide<T>;
  const remoteSide = remoteEff as EffectiveSide<T>;
  const comparison = compareVectorClocks(
    localSide.version.vectorClock,
    remoteSide.version.vectorClock,
  );

  // Case A: Record vs Record
  if (localSide.kind === 'record' && remoteSide.kind === 'record') {
    if (comparison === 'EQUAL' || comparison === 'LOCAL_NEWER') {
      return {
        comparison,
        winner: 'local',
        record: localSide.record,
        changedLocal: false,
      };
    }
    if (comparison === 'REMOTE_NEWER') {
      return {
        comparison,
        winner: 'remote',
        record: remoteSide.record,
        changedLocal: true,
      };
    }

    // CONCURRENT: authority primaryDeviceId tie-break (if configured), else deterministic HLC tie-break
    const primaryId = params.primaryDeviceId;
    const localIsPrimary = Boolean(primaryId && localSide.record.sourceDevice === primaryId);
    const remoteIsPrimary = Boolean(primaryId && remoteSide.record.sourceDevice === primaryId);
    const hlcCmp = compareHlcDeterministic(localSide.version, remoteSide.version);
    const localWins =
      localIsPrimary !== remoteIsPrimary ? localIsPrimary : hlcCmp >= 0;
    const winningSide: 'local' | 'remote' = localWins ? 'local' : 'remote';
    const resolvedRecord = localWins ? localSide.record : remoteSide.record;

    return {
      comparison: 'CONCURRENT',
      winner: winningSide,
      record: resolvedRecord,
      conflict: buildConflictRecord({
        spaceId: params.spaceId,
        localRecord: localSide.record,
        remoteRecord: remoteSide.record,
        winningSide,
        resolvedRecord,
      }),
      changedLocal: !localWins,
    };
  }

  // Case B: Local Tombstone vs Remote Record
  if (localSide.kind === 'tombstone' && remoteSide.kind === 'record') {
    // Prohibition #4: older or equal remote record MUST NEVER resurrect local tombstone
    if (comparison === 'EQUAL' || comparison === 'LOCAL_NEWER') {
      return {
        comparison,
        winner: 'tombstone',
        tombstone: localSide.tombstone,
        changedLocal: false,
      };
    }

    // Strictly newer causal remote record (e.g., post-delete re-login or explicit RESTORE)
    if (comparison === 'REMOTE_NEWER') {
      return {
        comparison,
        winner: 'remote',
        record: remoteSide.record,
        changedLocal: true,
      };
    }

    // CONCURRENT delete vs remote update
    const primaryId = params.primaryDeviceId;
    const localIsPrimary = Boolean(primaryId && localSide.tombstone.sourceDevice === primaryId);
    const remoteIsPrimary = Boolean(primaryId && remoteSide.record.sourceDevice === primaryId);
    const hlcCmp = compareHlcDeterministic(localSide.version, remoteSide.version);
    const localPlaceholder = buildDeletedPlaceholder(
      params.localRecord ?? remoteSide.record,
      localSide.tombstone,
    );

    const localTombstoneWins =
      localIsPrimary !== remoteIsPrimary ? localIsPrimary : hlcCmp >= 0;

    if (localTombstoneWins) {
      return {
        comparison: 'CONCURRENT',
        winner: 'tombstone',
        tombstone: localSide.tombstone,
        conflict: buildConflictRecord({
          spaceId: params.spaceId,
          localRecord: localPlaceholder,
          remoteRecord: remoteSide.record,
          winningSide: 'local',
          resolvedRecord: localPlaceholder,
        }),
        changedLocal: false,
      };
    }

    return {
      comparison: 'CONCURRENT',
      winner: 'remote',
      record: remoteSide.record,
      conflict: buildConflictRecord({
        spaceId: params.spaceId,
        localRecord: localPlaceholder,
        remoteRecord: remoteSide.record,
        winningSide: 'remote',
        resolvedRecord: remoteSide.record,
      }),
      changedLocal: true,
    };
  }

  // Case C: Local Record vs Remote Tombstone
  if (localSide.kind === 'record' && remoteSide.kind === 'tombstone') {
    // Prohibition #4: remote tombstone equal to or causally newer than local record deletes it
    if (comparison === 'EQUAL' || comparison === 'REMOTE_NEWER') {
      return {
        comparison,
        winner: 'tombstone',
        tombstone: remoteSide.tombstone,
        changedLocal: true,
      };
    }

    // Local record is causally strictly newer than remote tombstone (e.g., local restored / re-logged in)
    if (comparison === 'LOCAL_NEWER') {
      return {
        comparison,
        winner: 'local',
        record: localSide.record,
        changedLocal: false,
      };
    }

    // CONCURRENT local update vs remote delete (symmetric tie-break with Case B: tombstone wins exact tie)
    const primaryId = params.primaryDeviceId;
    const localIsPrimary = Boolean(primaryId && localSide.record.sourceDevice === primaryId);
    const remoteIsPrimary = Boolean(primaryId && remoteSide.tombstone.sourceDevice === primaryId);
    const hlcCmp = compareHlcDeterministic(localSide.version, remoteSide.version);
    const remotePlaceholder = buildDeletedPlaceholder(
      params.remoteRecord ?? localSide.record,
      remoteSide.tombstone,
    );

    const localRecordWins =
      localIsPrimary !== remoteIsPrimary ? localIsPrimary : hlcCmp > 0;

    if (localRecordWins) {
      return {
        comparison: 'CONCURRENT',
        winner: 'local',
        record: localSide.record,
        conflict: buildConflictRecord({
          spaceId: params.spaceId,
          localRecord: localSide.record,
          remoteRecord: remotePlaceholder,
          winningSide: 'local',
          resolvedRecord: localSide.record,
        }),
        changedLocal: false,
      };
    }

    return {
      comparison: 'CONCURRENT',
      winner: 'tombstone',
      tombstone: remoteSide.tombstone,
      conflict: buildConflictRecord({
        spaceId: params.spaceId,
        localRecord: localSide.record,
        remoteRecord: remotePlaceholder,
        winningSide: 'remote',
        resolvedRecord: remotePlaceholder,
      }),
      changedLocal: true,
    };
  }

  // Case D: Local Tombstone vs Remote Tombstone
  const localTomb = (localSide as { kind: 'tombstone'; tombstone: Tombstone; version: CausalVersion })
    .tombstone;
  const remoteTomb = (remoteSide as { kind: 'tombstone'; tombstone: Tombstone; version: CausalVersion })
    .tombstone;
  const { merged: acknowledgedDevices, changedFromA } = mergeAckDevices(
    localTomb.acknowledgedDevices,
    remoteTomb.acknowledgedDevices,
  );
  const reclaimable = localTomb.reclaimable && remoteTomb.reclaimable;

  if (comparison === 'EQUAL' || comparison === 'LOCAL_NEWER') {
    const merged: Tombstone = {
      ...localTomb,
      acknowledgedDevices,
      reclaimable,
    };
    return {
      comparison,
      winner: 'tombstone',
      tombstone: merged,
      changedLocal: changedFromA || reclaimable !== localTomb.reclaimable,
    };
  }

  if (comparison === 'REMOTE_NEWER') {
    const merged: Tombstone = {
      ...remoteTomb,
      acknowledgedDevices,
      reclaimable,
    };
    return {
      comparison,
      winner: 'tombstone',
      tombstone: merged,
      changedLocal: true,
    };
  }

  // CONCURRENT tombstones: deterministically pick winning tombstone metadata & merge vector clocks
  const primaryId = params.primaryDeviceId;
  const localIsPrimary = Boolean(primaryId && localTomb.sourceDevice === primaryId);
  const remoteIsPrimary = Boolean(primaryId && remoteTomb.sourceDevice === primaryId);
  const hlcCmp = compareHlcDeterministic(localTomb.deleteVersion, remoteTomb.deleteVersion);
  const localWins = localIsPrimary !== remoteIsPrimary ? localIsPrimary : hlcCmp >= 0;
  const base = localWins ? localTomb : remoteTomb;
  const mergedVectorClock = mergeVectorClocks(
    localTomb.deleteVersion.vectorClock,
    remoteTomb.deleteVersion.vectorClock,
  );
  const mergedTombstone: Tombstone = {
    ...base,
    deleteVersion: {
      ...base.deleteVersion,
      vectorClock: mergedVectorClock,
    },
    acknowledgedDevices,
    reclaimable,
  };

  return {
    comparison: 'CONCURRENT',
    winner: 'tombstone',
    tombstone: mergedTombstone,
    changedLocal: true,
  };
}

/**
 * Evaluates whether a Tombstone is safe to reclaim during garbage collection.
 * Sets `reclaimable = true` ONLY when:
 * 1. `activeDeviceIds` is non-empty and EVERY active device's checkpoint has
 *    `processedVectorClock[tombstone.deleteVersion.deviceId] >= tombstone.deleteVersion.deviceSeq`, AND
 * 2. `(nowMs - tombstone.createdAt) >= minRetentionMs` (defaults to 7 days).
 */
export function updateTombstoneReclaimability(
  tombstone: Tombstone,
  activeDeviceIds: string[],
  checkpoints: Record<string, DeviceCheckpoint>,
  nowMs: number = Date.now(),
  minRetentionMs: number = DEFAULT_TOMBSTONE_MIN_RETENTION_MS,
): Tombstone {
  const deleteDevId = tombstone.deleteVersion.deviceId;
  const deleteSeq = tombstone.deleteVersion.deviceSeq;

  const ackSet = new Set<string>(tombstone.acknowledgedDevices);
  for (const [deviceId, checkpoint] of Object.entries(checkpoints)) {
    if (!checkpoint?.processedVectorClock) continue;
    const seenSeq = checkpoint.processedVectorClock[deleteDevId] ?? 0;
    if (seenSeq >= deleteSeq) {
      ackSet.add(deviceId);
    }
  }

  const allActiveAcknowledged =
    activeDeviceIds.length > 0 &&
    activeDeviceIds.every((deviceId) => {
      const cp = checkpoints[deviceId];
      if (!cp?.processedVectorClock) return false;
      const seenSeq = cp.processedVectorClock[deleteDevId] ?? 0;
      return seenSeq >= deleteSeq;
    });

  const retentionElapsed = nowMs - tombstone.createdAt >= minRetentionMs;

  return {
    ...tombstone,
    acknowledgedDevices: Array.from(ackSet).sort(),
    reclaimable: allActiveAcknowledged && retentionElapsed,
  };
}
