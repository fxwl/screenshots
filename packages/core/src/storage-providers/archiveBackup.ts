/**
 * Single-file `.smesh-backup` password-encrypted archive helper.
 */
import type { ArchiveBackupPayload } from '../types';
import { decryptWithPassword, encryptWithPassword, SmesCryptoError } from '../crypto/smes';

export const ARCHIVE_BACKUP_AAD = 'sessionmesh:archive:v1';

export async function encodeArchiveBackup(
  payload: ArchiveBackupPayload,
  passphrase: string,
  options?: { iterations?: number },
): Promise<Uint8Array> {
  if (!passphrase) {
    throw new SmesCryptoError('ENCRYPT_EMPTY_PASSWORD', 'Archive backup passphrase must not be empty');
  }
  if (
    !payload ||
    payload.format !== 'sessionmesh_archive' ||
    payload.version !== 1 ||
    !payload.snapshot ||
    typeof payload.snapshot !== 'object'
  ) {
    throw new SmesCryptoError('ENCRYPT_INVALID_ARCHIVE', 'Archive backup payload is malformed');
  }
  return encryptWithPassword(payload, passphrase, ARCHIVE_BACKUP_AAD, {
    compress: true,
    encoding: 'json',
    iterations: options?.iterations,
    keyEpoch: 1,
  });
}

export async function decodeArchiveBackup(
  bytes: Uint8Array,
  passphrase: string,
): Promise<ArchiveBackupPayload> {
  if (!passphrase) {
    throw new SmesCryptoError('DECRYPT_ERROR', 'Archive backup passphrase must not be empty');
  }
  const decoded = await decryptWithPassword<ArchiveBackupPayload>(bytes, passphrase, ARCHIVE_BACKUP_AAD);
  if (
    !decoded ||
    decoded.format !== 'sessionmesh_archive' ||
    decoded.version !== 1 ||
    !decoded.snapshot ||
    typeof decoded.snapshot !== 'object'
  ) {
    throw new SmesCryptoError(
      'DECRYPT_INVALID_ARCHIVE',
      'Decrypted archive backup payload does not match sessionmesh_archive v1 schema',
    );
  }
  return decoded;
}
