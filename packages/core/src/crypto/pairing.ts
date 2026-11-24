/**
 * Encrypted cross-device Pairing Code (`smesh://pair/v1.<base64url>`).
 */
import type { PairingPayload } from '../types';
import { base64UrlToBytes, bytesToBase64Url } from './encoding';
import { decryptWithPassword, encryptWithPassword, SmesCryptoError } from './smes';

const PAIRING_PREFIX = 'smesh://pair/v1.';
const PAIRING_AAD = 'sessionmesh:pairing:v1';
const PAIRING_PBKDF2_ITERATIONS = 100_000;

export async function encodePairingCode(payload: PairingPayload, passphrase: string): Promise<string> {
  if (!passphrase) {
    throw new SmesCryptoError('ENCRYPT_EMPTY_PASSWORD', 'Pairing passphrase must not be empty');
  }
  const envelope = await encryptWithPassword(payload, passphrase, PAIRING_AAD, {
    compress: true,
    encoding: 'json',
    iterations: PAIRING_PBKDF2_ITERATIONS,
    keyEpoch: 1,
  });
  return `${PAIRING_PREFIX}${bytesToBase64Url(envelope)}`;
}

export async function decodePairingCode(code: string, passphrase: string): Promise<PairingPayload> {
  if (!passphrase) {
    throw new SmesCryptoError('DECRYPT_ERROR', 'Pairing passphrase must not be empty');
  }
  const trimmed = (code || '').trim();
  if (!trimmed.startsWith(PAIRING_PREFIX)) {
    throw new SmesCryptoError(
      'DECRYPT_INVALID_PAIRING_CODE',
      `Pairing code must start with "${PAIRING_PREFIX}"`,
    );
  }
  const encodedBody = trimmed.slice(PAIRING_PREFIX.length);
  if (!encodedBody) {
    throw new SmesCryptoError('DECRYPT_INVALID_PAIRING_CODE', 'Pairing code payload is empty');
  }
  const envelopeBytes = base64UrlToBytes(encodedBody);
  const decoded = await decryptWithPassword<PairingPayload>(envelopeBytes, passphrase, PAIRING_AAD);
  if (!decoded || decoded.version !== 1 || !decoded.webdav || !decoded.spaceId) {
    throw new SmesCryptoError('DECRYPT_INVALID_PAIRING_CODE', 'Decrypted pairing payload is malformed');
  }
  return decoded;
}
