/**
 * Encrypted cross-device Pairing Code (`smesh://pair/v1.<base64url>`).
 * Supports both v1 (WebDAV) and v2 (multi-provider StorageProviderConfig) payloads.
 */
import type { PairingPayload, StorageProviderConfig, WebDAVConfig } from '../types';
import { base64UrlToBytes, bytesToBase64Url } from './encoding';
import { decryptWithPassword, encryptWithPassword, SmesCryptoError } from './smes';

const PAIRING_PREFIX = 'smesh://pair/v1.';
const PAIRING_AAD = 'sessionmesh:pairing:v1';
const PAIRING_PBKDF2_ITERATIONS = 100_000;

function stripWebdavProvider(storage: Extract<StorageProviderConfig, { provider: 'webdav' }>): WebDAVConfig {
  const { provider: _provider, ...rest } = storage;
  return rest;
}

function normalizePairingPayload(payload: PairingPayload): PairingPayload {
  const normalized: PairingPayload = { ...payload };
  if (normalized.storage) {
    if (normalized.storage.provider === 'webdav' && !normalized.webdav) {
      normalized.webdav = stripWebdavProvider(normalized.storage);
    }
  } else if (normalized.webdav) {
    normalized.storage = {
      provider: 'webdav',
      ...normalized.webdav,
    };
  }
  return normalized;
}

export async function encodePairingCode(payload: PairingPayload, passphrase: string): Promise<string> {
  if (!passphrase) {
    throw new SmesCryptoError('ENCRYPT_EMPTY_PASSWORD', 'Pairing passphrase must not be empty');
  }
  const normalized = normalizePairingPayload(payload);
  if (
    !normalized ||
    (normalized.version !== 1 && normalized.version !== 2) ||
    !normalized.spaceId
  ) {
    throw new SmesCryptoError('ENCRYPT_INVALID_PAIRING_CODE', 'Pairing payload is malformed');
  }
  if (normalized.version === 1 && !normalized.webdav) {
    throw new SmesCryptoError('ENCRYPT_INVALID_PAIRING_CODE', 'Pairing v1 payload requires webdav config');
  }
  if (normalized.version === 2 && !normalized.storage && !normalized.webdav) {
    throw new SmesCryptoError(
      'ENCRYPT_INVALID_PAIRING_CODE',
      'Pairing v2 payload requires storage or webdav config',
    );
  }

  const envelope = await encryptWithPassword(normalized, passphrase, PAIRING_AAD, {
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

  let envelopeBytes: Uint8Array;
  try {
    envelopeBytes = base64UrlToBytes(encodedBody);
  } catch (err) {
    throw new SmesCryptoError(
      'DECRYPT_INVALID_PAIRING_CODE',
      'Pairing code contains invalid base64url data',
      err,
    );
  }

  const decoded = await decryptWithPassword<PairingPayload>(envelopeBytes, passphrase, PAIRING_AAD);
  if (!decoded || typeof decoded !== 'object' || !decoded.spaceId) {
    throw new SmesCryptoError('DECRYPT_INVALID_PAIRING_CODE', 'Decrypted pairing payload is malformed');
  }
  if (decoded.version === 1) {
    if (!decoded.webdav) {
      throw new SmesCryptoError(
        'DECRYPT_INVALID_PAIRING_CODE',
        'Decrypted v1 pairing payload is missing webdav config',
      );
    }
  } else if (decoded.version === 2) {
    if (!decoded.storage && !decoded.webdav) {
      throw new SmesCryptoError(
        'DECRYPT_INVALID_PAIRING_CODE',
        'Decrypted v2 pairing payload is missing storage config',
      );
    }
  } else {
    throw new SmesCryptoError('DECRYPT_INVALID_PAIRING_CODE', 'Unsupported pairing payload version');
  }

  return normalizePairingPayload(decoded);
}
