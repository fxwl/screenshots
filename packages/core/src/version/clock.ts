import type {
  CausalComparison,
  CausalVersion,
  HybridLogicalClock,
  VectorClock,
} from '../types';

/**
 * Hybrid Logical Clock (HLC) preserving strict monotonicity and causality
 * even under arbitrary physical wall-clock skew or backwards clock jumps.
 */
export class HlcClock {
  private readonly deviceId: string;
  private state: HybridLogicalClock;

  constructor(deviceId: string, initial?: HybridLogicalClock) {
    this.deviceId = deviceId;
    this.state = {
      physicalMs: initial ? initial.physicalMs : 0,
      logical: initial ? initial.logical : 0,
      deviceId,
    };
  }

  tick(nowMs: number = Date.now()): HybridLogicalClock {
    const prevPhysical = this.state.physicalMs;
    if (nowMs > prevPhysical) {
      this.state = {
        physicalMs: nowMs,
        logical: 0,
        deviceId: this.deviceId,
      };
    } else {
      this.state = {
        physicalMs: prevPhysical,
        logical: this.state.logical + 1,
        deviceId: this.deviceId,
      };
    }
    return { ...this.state };
  }

  receive(remote: HybridLogicalClock, nowMs: number = Date.now()): HybridLogicalClock {
    const prevPhysical = this.state.physicalMs;
    const remotePhysical = remote.physicalMs;
    const nextPhysical = Math.max(prevPhysical, remotePhysical, nowMs);

    let nextLogical: number;
    if (nextPhysical === prevPhysical && nextPhysical === remotePhysical) {
      nextLogical = Math.max(this.state.logical, remote.logical) + 1;
    } else if (nextPhysical === prevPhysical) {
      nextLogical = this.state.logical + 1;
    } else if (nextPhysical === remotePhysical) {
      nextLogical = remote.logical + 1;
    } else {
      nextLogical = 0;
    }

    this.state = {
      physicalMs: nextPhysical,
      logical: nextLogical,
      deviceId: this.deviceId,
    };
    return { ...this.state };
  }

  current(): HybridLogicalClock {
    return { ...this.state };
  }
}

/**
 * Purely increments (or advances to `seq`) the entry for `deviceId` in a VectorClock.
 */
export function incrementVectorClock(
  vc: VectorClock,
  deviceId: string,
  seq?: number,
): VectorClock {
  const next: VectorClock = { ...vc };
  const current = next[deviceId] ?? 0;
  next[deviceId] = seq !== undefined ? Math.max(current, seq) : current + 1;
  return next;
}

/**
 * Computes the element-wise maximum of two VectorClocks.
 */
export function mergeVectorClocks(a: VectorClock, b: VectorClock): VectorClock {
  const merged: VectorClock = { ...a };
  for (const [deviceId, value] of Object.entries(b)) {
    merged[deviceId] = Math.max(merged[deviceId] ?? 0, value);
  }
  return merged;
}

/**
 * Compares two VectorClocks using strict causal partial-order semantics.
 * Completely independent of physical system clocks.
 */
export function compareVectorClocks(
  local: VectorClock,
  remote: VectorClock,
): CausalComparison {
  const keys = new Set<string>([...Object.keys(local), ...Object.keys(remote)]);
  let localGreater = false;
  let remoteGreater = false;

  for (const key of keys) {
    const lv = local[key] ?? 0;
    const rv = remote[key] ?? 0;
    if (lv > rv) {
      localGreater = true;
    } else if (rv > lv) {
      remoteGreater = true;
    }
    if (localGreater && remoteGreater) {
      return 'CONCURRENT';
    }
  }

  if (localGreater) return 'LOCAL_NEWER';
  if (remoteGreater) return 'REMOTE_NEWER';
  return 'EQUAL';
}

/**
 * Deterministic strict total order comparator for breaking ties between concurrent versions:
 * (hlc.physicalMs, hlc.logical, deviceId, deviceSeq, eventId ?? versionId).
 * Returns > 0 if `a` wins over `b`, < 0 if `b` wins over `a`, 0 if identical.
 */
export function compareHlcDeterministic(
  a: CausalVersion,
  b: CausalVersion,
  eventIdA?: string,
  eventIdB?: string,
): number {
  if (a.hlc.physicalMs !== b.hlc.physicalMs) {
    return a.hlc.physicalMs - b.hlc.physicalMs;
  }
  if (a.hlc.logical !== b.hlc.logical) {
    return a.hlc.logical - b.hlc.logical;
  }

  const devA = a.hlc.deviceId || a.deviceId;
  const devB = b.hlc.deviceId || b.deviceId;
  if (devA !== devB) {
    return devA < devB ? -1 : 1;
  }

  if (a.deviceSeq !== b.deviceSeq) {
    return a.deviceSeq - b.deviceSeq;
  }

  const idA = eventIdA ?? a.versionId ?? '';
  const idB = eventIdB ?? b.versionId ?? '';
  if (idA !== idB) {
    return idA < idB ? -1 : 1;
  }

  return 0;
}

/**
 * Advances the local HLC + VectorClock to produce the next CausalVersion.
 */
export function createNextCausalVersion(params: {
  clock: HlcClock;
  baseVectorClock: VectorClock;
  deviceId: string;
  nextDeviceSeq: number;
  nowMs?: number;
}): CausalVersion {
  const hlc = params.clock.tick(params.nowMs);
  const vectorClock = incrementVectorClock(
    params.baseVectorClock,
    params.deviceId,
    params.nextDeviceSeq,
  );
  const versionId = `${params.deviceId}:${params.nextDeviceSeq}:${hlc.physicalMs}.${hlc.logical}`;

  return {
    hlc,
    vectorClock,
    deviceId: params.deviceId,
    deviceSeq: params.nextDeviceSeq,
    versionId,
  };
}
