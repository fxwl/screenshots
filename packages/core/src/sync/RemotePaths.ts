export const REMOTE_ROOT_PREFIX = 'SessionMesh/v1/spaces';

export function spacesRootDir(): string {
  return REMOTE_ROOT_PREFIX;
}

export function spaceBasePath(opaqueSpaceId: string): string {
  return `${REMOTE_ROOT_PREFIX}/${opaqueSpaceId}`;
}

export function spaceInfoPath(opaqueSpaceId: string): string {
  return `${spaceBasePath(opaqueSpaceId)}/space-info.txt`;
}

export function spaceMetaDir(opaqueSpaceId: string): string {
  return `${spaceBasePath(opaqueSpaceId)}/metadata`;
}

export function spaceMetaPath(opaqueSpaceId: string): string {
  return `${spaceMetaDir(opaqueSpaceId)}/space.enc`;
}

export function devicesDir(opaqueSpaceId: string): string {
  return `${spaceBasePath(opaqueSpaceId)}/devices`;
}

export function deviceFilePath(opaqueSpaceId: string, deviceId: string): string {
  return `${devicesDir(opaqueSpaceId)}/${deviceId}.enc`;
}

export function eventsDir(opaqueSpaceId: string): string {
  return `${spaceBasePath(opaqueSpaceId)}/events`;
}

export function deviceEventsDir(opaqueSpaceId: string, deviceId: string): string {
  return `${eventsDir(opaqueSpaceId)}/${deviceId}`;
}

export function eventBatchPath(
  opaqueSpaceId: string,
  deviceId: string,
  toSeq: number,
  batchId: string,
): string {
  const padded = String(Math.max(0, toSeq)).padStart(10, '0');
  return `${deviceEventsDir(opaqueSpaceId, deviceId)}/${padded}_${batchId}.enc`;
}

export function checkpointsDir(opaqueSpaceId: string): string {
  return `${spaceBasePath(opaqueSpaceId)}/checkpoints`;
}

export function checkpointFilePath(opaqueSpaceId: string, deviceId: string): string {
  return `${checkpointsDir(opaqueSpaceId)}/${deviceId}.enc`;
}

export function snapshotsDir(opaqueSpaceId: string): string {
  return `${spaceBasePath(opaqueSpaceId)}/snapshots`;
}

export function snapshotFilePath(opaqueSpaceId: string, snapshotId: string): string {
  const name = snapshotId.endsWith('.enc') ? snapshotId : `${snapshotId}.enc`;
  return `${snapshotsDir(opaqueSpaceId)}/${name}`;
}

export function backupsDir(opaqueSpaceId: string): string {
  return `${spaceBasePath(opaqueSpaceId)}/backups`;
}

export function backupFilePath(opaqueSpaceId: string, backupId: string): string {
  const name = backupId.endsWith('.enc') ? backupId : `${backupId}.enc`;
  return `${backupsDir(opaqueSpaceId)}/${name}`;
}

export function buildSpaceMetaAad(spaceId: string, remotePath: string): string {
  return `${spaceId}|meta|space_meta|${remotePath}`;
}

export function buildFileAad(
  spaceId: string,
  keyEpoch: number,
  fileType: 'device' | 'event_batch' | 'checkpoint' | 'snapshot' | 'backup',
  remotePath: string,
): string {
  return `${spaceId}|${keyEpoch}|${fileType}|${remotePath}`;
}

/**
 * Extracts numeric sequence prefix from `{zeroPaddedSeq}_{batchId}.enc`.
 */
export function parseEventFilenameSeq(filename: string): number {
  const match = /^(\d+)_/.exec(filename);
  return match ? Number.parseInt(match[1], 10) : 0;
}
