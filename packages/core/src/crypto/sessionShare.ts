/**
 * Temporary encrypted team Session Share (`smesh://share/v1.<base64url>`).
 * Domain-separated from pairing codes via dedicated prefix and GCM AAD.
 */
import type {
  BrowserCookieInput,
  SessionSharePayload,
  SessionSharePreview,
} from '../types';
import { base64UrlToBytes, bytesToBase64Url } from './encoding';
import {
  decryptWithPassword,
  encryptWithPassword,
  generateRandomBytes,
  SmesCryptoError,
} from './smes';

export const SESSION_SHARE_PREFIX = 'smesh://share/v1.';
export const SESSION_SHARE_AAD = 'sessionmesh:share:v1';
export const SESSION_SHARE_PBKDF2_ITERATIONS = 150_000;

// Excludes visually ambiguous characters (0/O/o, 1/I/l) for human-readable passphrases.
const PASSPHRASE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';

/**
 * Generates a uniform, high-entropy alphanumeric passphrase using rejection sampling.
 */
export function generateSharePassphrase(length = 16): string {
  if (!Number.isInteger(length) || length < 1) {
    throw new SmesCryptoError('CRYPTO_INVALID_ARG', `Invalid passphrase length: ${length}`);
  }
  const alphabetLen = PASSPHRASE_ALPHABET.length;
  const maxUnbiasedByte = 256 - (256 % alphabetLen);
  let out = '';
  while (out.length < length) {
    const needed = length - out.length;
    const chunk = generateRandomBytes(Math.max(needed * 2, 16));
    for (let i = 0; i < chunk.length && out.length < length; i += 1) {
      const byte = chunk[i];
      if (byte < maxUnbiasedByte) {
        out += PASSPHRASE_ALPHABET[byte % alphabetLen];
      }
    }
  }
  return out;
}

export async function encodeSessionShare(
  payload: SessionSharePayload,
  passphrase: string,
  options?: { iterations?: number },
): Promise<string> {
  if (!passphrase) {
    throw new SmesCryptoError('ENCRYPT_EMPTY_PASSWORD', 'Session share passphrase must not be empty');
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    payload.version !== 1 ||
    typeof payload.shareId !== 'string' ||
    !payload.shareId ||
    typeof payload.siteKey !== 'string' ||
    !payload.siteKey ||
    !Array.isArray(payload.cookies)
  ) {
    throw new SmesCryptoError('ENCRYPT_INVALID_SHARE_PAYLOAD', 'Session share payload is malformed');
  }
  if (
    !Number.isFinite(payload.createdAt) ||
    !Number.isFinite(payload.expiresAt) ||
    payload.expiresAt <= payload.createdAt
  ) {
    throw new SmesCryptoError(
      'ENCRYPT_INVALID_SHARE_TTL',
      'Session share expiresAt must be greater than createdAt',
    );
  }

  const iterations = options?.iterations ?? SESSION_SHARE_PBKDF2_ITERATIONS;
  const envelope = await encryptWithPassword(payload, passphrase, SESSION_SHARE_AAD, {
    compress: true,
    encoding: 'json',
    iterations,
    keyEpoch: 1,
  });
  return `${SESSION_SHARE_PREFIX}${bytesToBase64Url(envelope)}`;
}

export async function decodeSessionShare(
  code: string,
  passphrase: string,
  options?: { nowMs?: number; allowExpired?: boolean },
): Promise<SessionSharePayload> {
  if (!passphrase) {
    throw new SmesCryptoError('DECRYPT_ERROR', 'Session share passphrase must not be empty');
  }
  const trimmed = (code || '').trim();
  if (!trimmed.startsWith(SESSION_SHARE_PREFIX)) {
    throw new SmesCryptoError(
      'DECRYPT_INVALID_SHARE_CODE',
      `Session share code must start with "${SESSION_SHARE_PREFIX}"`,
    );
  }
  const encodedBody = trimmed.slice(SESSION_SHARE_PREFIX.length);
  if (!encodedBody) {
    throw new SmesCryptoError('DECRYPT_INVALID_SHARE_CODE', 'Session share code payload is empty');
  }

  let envelopeBytes: Uint8Array;
  try {
    envelopeBytes = base64UrlToBytes(encodedBody);
  } catch (err) {
    throw new SmesCryptoError(
      'DECRYPT_INVALID_SHARE_CODE',
      'Session share code contains invalid base64url data',
      err,
    );
  }

  const decoded = await decryptWithPassword<SessionSharePayload>(
    envelopeBytes,
    passphrase,
    SESSION_SHARE_AAD,
  );
  if (
    !decoded ||
    typeof decoded !== 'object' ||
    decoded.version !== 1 ||
    typeof decoded.shareId !== 'string' ||
    !decoded.shareId ||
    typeof decoded.siteKey !== 'string' ||
    !decoded.siteKey ||
    !Array.isArray(decoded.cookies) ||
    !Number.isFinite(decoded.createdAt) ||
    !Number.isFinite(decoded.expiresAt)
  ) {
    throw new SmesCryptoError('DECRYPT_INVALID_SHARE_CODE', 'Decrypted session share payload is malformed');
  }

  if (options?.allowExpired !== true) {
    const nowMs = options?.nowMs ?? Date.now();
    if (nowMs > decoded.expiresAt) {
      throw new SmesCryptoError('SHARE_EXPIRED', '该临时分享会话已过期失效');
    }
  }

  return decoded;
}

function countStorageEntries(byOrigin?: Record<string, Record<string, string>>): number {
  if (!byOrigin) return 0;
  let total = 0;
  for (const entries of Object.values(byOrigin)) {
    if (entries && typeof entries === 'object') {
      total += Object.keys(entries).length;
    }
  }
  return total;
}

export function toSessionSharePreview(
  payload: SessionSharePayload,
  nowMs = Date.now(),
): SessionSharePreview {
  const cookieNames = Array.from(new Set(payload.cookies.map((c) => c.name)));
  return {
    shareId: payload.shareId,
    siteKey: payload.siteKey,
    accountLabel: payload.accountLabel,
    note: payload.note,
    sharedBy: payload.sharedBy,
    createdAt: payload.createdAt,
    expiresAt: payload.expiresAt,
    remainingMs: Math.max(0, payload.expiresAt - nowMs),
    clampCookieExpiry: Boolean(payload.clampCookieExpiry),
    cookieCount: payload.cookies.length,
    cookieNames,
    localStorageCount: countStorageEntries(payload.localStorageByOrigin),
    sessionStorageCount: countStorageEntries(payload.sessionStorageByOrigin),
  };
}

export function clampSharedCookiesExpiry(
  cookies: BrowserCookieInput[],
  expiresAtMs: number,
  clamp: boolean,
): BrowserCookieInput[] {
  if (!clamp) {
    return cookies.map((cookie) => ({ ...cookie }));
  }
  const maxExpSec = Math.floor(expiresAtMs / 1000);
  return cookies.map((cookie) => {
    const existingExpSec = cookie.expirationDate
      ? cookie.expirationDate > 1e12
        ? Math.floor(cookie.expirationDate / 1000)
        : cookie.expirationDate
      : maxExpSec;
    return {
      ...cookie,
      session: false,
      expirationDate: Math.min(existingExpSec, maxExpSec),
    };
  });
}
