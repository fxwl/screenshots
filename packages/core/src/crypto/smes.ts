/**
 * SMES v2 Authenticated Encryption Envelope (AES-256-GCM + PBKDF2-SHA256 / HKDF-SHA256).
 *
 * Binary Envelope Layout (Big-Endian):
 *   [0..3]   Magic: "SMES" (0x53 0x4D 0x45 0x53)
 *   [4]      Version: uint8 (2)
 *   [5]      Flags: uint8 (bit0 = gzip via pako, bit1 = protobuf vs json)
 *   [6..9]   keyEpoch: uint32 BE
 *   [10..13] iterations: uint32 BE (>0 for PBKDF2 password envelope, 0 for HKDF DEK envelope)
 *   [14..29] salt: 16 random bytes
 *   [30..41] iv: 12 random bytes
 *   [42..43] aadByteLen: uint16 BE
 *   [44..44+aadByteLen-1] aad: UTF-8 bytes
 *   [44+aadByteLen..end]  AES-256-GCM ciphertext + 16-byte authentication tag
 *
 * The entire header prefix [0..44+aadByteLen) is authenticated as GCM additionalData,
 * preventing header tampering (flags, epoch, iterations, salt, iv, or AAD) as well as
 * cross-space or cross-path file substitution attacks.
 */
import pako from 'pako';
import type { PayloadEncoding } from '../types';
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  bytesToUtf8,
  decodeProtobufValue,
  encodeProtobufValue,
  utf8ToBytes,
} from './encoding';

export const SMES_MAGIC = new Uint8Array([0x53, 0x4d, 0x45, 0x53]); // "SMES"
export const SMES_VERSION = 2;
export const SMES_FLAG_GZIP = 0x01;
export const SMES_FLAG_PROTOBUF = 0x02;

const FIXED_HEADER_SIZE = 44; // 4 + 1 + 1 + 4 + 4 + 16 + 12 + 2
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const GCM_TAG_LENGTH = 16;
const DEFAULT_PBKDF2_ITERATIONS = 200_000;

export interface SmesHeader {
  version: number; // 2
  flags: number; // bit0 = gzip compressed, bit1 = protobuf (0 = json)
  keyEpoch: number;
  iterations: number; // used for space master envelope; 0 for HKDF DEK files
  salt: Uint8Array; // 16 bytes
  iv: Uint8Array; // 12 bytes
  aad: string; // UTF-8 string e.g. `${spaceId}|${keyEpoch}|${fileType}|${remotePath}`
}

export class SmesCryptoError extends Error {
  readonly code: string;
  constructor(code: string, message: string, cause?: unknown) {
    super(`${code}: ${message}`);
    this.name = 'SmesCryptoError';
    this.code = code;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

function getWebCrypto(): Crypto {
  const c = globalThis.crypto;
  if (!c || !c.subtle || typeof c.getRandomValues !== 'function') {
    throw new SmesCryptoError('CRYPTO_UNAVAILABLE', 'Web Crypto API (crypto.subtle) is unavailable in this runtime');
  }
  return c;
}

/**
 * Ensures a clean ArrayBuffer-backed Uint8Array view for strict WebCrypto BufferSource typing.
 */
function toExactBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer;
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function generateRandomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 0) {
    throw new SmesCryptoError('CRYPTO_INVALID_ARG', `Invalid random byte length: ${length}`);
  }
  const out = new Uint8Array(length);
  if (length === 0) return out;
  const c = getWebCrypto();
  // WebCrypto getRandomValues has a 65536-byte per-call quota
  const MAX_CHUNK = 65536;
  for (let offset = 0; offset < length; offset += MAX_CHUNK) {
    const end = Math.min(offset + MAX_CHUNK, length);
    c.getRandomValues(out.subarray(offset, end));
  }
  return out;
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === 'string' ? utf8ToBytes(input) : input;
  const digest = await getWebCrypto().subtle.digest('SHA-256', toExactBuffer(data));
  return bytesToHex(new Uint8Array(digest));
}

export async function deriveOpaqueId(input: string, prefix = ''): Promise<string> {
  const hash = await sha256Hex(`sessionmesh:opaque:v1:${input}`);
  const shortHex = hash.slice(0, 24);
  if (!prefix) return shortHex;
  return prefix.endsWith('_') || prefix.endsWith('-') ? `${prefix}${shortHex}` : `${prefix}_${shortHex}`;
}

export async function generateSpaceDekBase64(): Promise<string> {
  return bytesToBase64(generateRandomBytes(32));
}

export function isSmesEnvelope(bytes: Uint8Array): boolean {
  if (!bytes || bytes.byteLength < FIXED_HEADER_SIZE + GCM_TAG_LENGTH) {
    return false;
  }
  return (
    bytes[0] === SMES_MAGIC[0] &&
    bytes[1] === SMES_MAGIC[1] &&
    bytes[2] === SMES_MAGIC[2] &&
    bytes[3] === SMES_MAGIC[3] &&
    bytes[4] === SMES_VERSION
  );
}

interface ParsedEnvelopeInternal {
  header: SmesHeader;
  headerBytes: Uint8Array;
  ciphertext: Uint8Array;
}

function parseEnvelopeInternal(bytes: Uint8Array): ParsedEnvelopeInternal {
  if (!bytes || bytes.byteLength < FIXED_HEADER_SIZE + GCM_TAG_LENGTH) {
    throw new SmesCryptoError(
      'DECRYPT_INVALID_ENVELOPE',
      `Envelope too short (${bytes ? bytes.byteLength : 0} bytes)`,
    );
  }
  if (
    bytes[0] !== SMES_MAGIC[0] ||
    bytes[1] !== SMES_MAGIC[1] ||
    bytes[2] !== SMES_MAGIC[2] ||
    bytes[3] !== SMES_MAGIC[3]
  ) {
    throw new SmesCryptoError('DECRYPT_INVALID_MAGIC', 'Invalid SMES envelope magic header');
  }
  const version = bytes[4];
  if (version !== SMES_VERSION) {
    throw new SmesCryptoError('DECRYPT_UNSUPPORTED_VERSION', `Unsupported SMES envelope version: ${version}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = bytes[5];
  const keyEpoch = view.getUint32(6, false);
  const iterations = view.getUint32(10, false);
  const salt = new Uint8Array(bytes.subarray(14, 14 + SALT_LENGTH));
  const iv = new Uint8Array(bytes.subarray(30, 30 + IV_LENGTH));
  const aadByteLen = view.getUint16(42, false);

  const headerEnd = FIXED_HEADER_SIZE + aadByteLen;
  if (bytes.byteLength < headerEnd + GCM_TAG_LENGTH) {
    throw new SmesCryptoError('DECRYPT_TRUNCATED_ENVELOPE', 'SMES envelope is truncated before ciphertext/tag');
  }

  let aad: string;
  try {
    aad = bytesToUtf8(bytes.subarray(FIXED_HEADER_SIZE, headerEnd));
  } catch (err) {
    throw new SmesCryptoError('DECRYPT_INVALID_AAD', 'SMES header AAD is not valid UTF-8', err);
  }

  const header: SmesHeader = {
    version,
    flags,
    keyEpoch,
    iterations,
    salt,
    iv,
    aad,
  };

  return {
    header,
    headerBytes: bytes.subarray(0, headerEnd),
    ciphertext: bytes.subarray(headerEnd),
  };
}

export function parseSmesHeader(bytes: Uint8Array): SmesHeader {
  return parseEnvelopeInternal(bytes).header;
}

function buildHeaderBytes(params: {
  flags: number;
  keyEpoch: number;
  iterations: number;
  salt: Uint8Array;
  iv: Uint8Array;
  aad: string;
}): Uint8Array {
  const aadBytes = utf8ToBytes(params.aad);
  if (aadBytes.byteLength > 0xffff) {
    throw new SmesCryptoError('ENCRYPT_AAD_TOO_LONG', `AAD exceeds max uint16 length (${aadBytes.byteLength})`);
  }
  const out = new Uint8Array(FIXED_HEADER_SIZE + aadBytes.byteLength);
  const view = new DataView(out.buffer);
  out.set(SMES_MAGIC, 0);
  out[4] = SMES_VERSION;
  out[5] = params.flags & 0xff;
  view.setUint32(6, params.keyEpoch >>> 0, false);
  view.setUint32(10, params.iterations >>> 0, false);
  out.set(params.salt, 14);
  out.set(params.iv, 30);
  view.setUint16(42, aadBytes.byteLength, false);
  out.set(aadBytes, FIXED_HEADER_SIZE);
  return out;
}

function encodePayload(obj: unknown, encoding: PayloadEncoding, compress: boolean): { bytes: Uint8Array; flags: number } {
  let rawBytes: Uint8Array;
  let flags = 0;
  if (encoding === 'protobuf') {
    flags |= SMES_FLAG_PROTOBUF;
    rawBytes = encodeProtobufValue(obj);
  } else {
    const jsonText = JSON.stringify(obj === undefined ? null : obj);
    rawBytes = utf8ToBytes(jsonText);
  }
  if (compress) {
    flags |= SMES_FLAG_GZIP;
    rawBytes = pako.gzip(rawBytes);
  }
  return { bytes: rawBytes, flags };
}

function decodePayload<T>(plaintextBytes: Uint8Array, flags: number): T {
  let dataBytes = plaintextBytes;
  if ((flags & SMES_FLAG_GZIP) !== 0) {
    try {
      dataBytes = pako.ungzip(plaintextBytes);
    } catch (err) {
      throw new SmesCryptoError('DECRYPT_DECOMPRESS_FAILED', 'Failed to decompress decrypted payload', err);
    }
  }
  if ((flags & SMES_FLAG_PROTOBUF) !== 0) {
    try {
      return decodeProtobufValue(dataBytes) as T;
    } catch (err) {
      throw new SmesCryptoError('DECRYPT_DECODE_FAILED', 'Failed to decode decrypted protobuf payload', err);
    }
  }
  try {
    return JSON.parse(bytesToUtf8(dataBytes)) as T;
  } catch (err) {
    throw new SmesCryptoError('DECRYPT_DECODE_FAILED', 'Failed to parse decrypted JSON payload', err);
  }
}

async function derivePbkdf2AesKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
  usage: KeyUsage,
): Promise<CryptoKey> {
  const subtle = getWebCrypto().subtle;
  const baseKey = await subtle.importKey('raw', toExactBuffer(utf8ToBytes(password)), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: toExactBuffer(salt),
      iterations,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

async function deriveHkdfAesKey(
  dekBase64: string,
  fileSalt: Uint8Array,
  aad: string,
  usage: KeyUsage,
): Promise<CryptoKey> {
  const dekBytes = base64ToBytes(dekBase64);
  if (dekBytes.byteLength < 16) {
    throw new SmesCryptoError('DECRYPT_INVALID_DEK', 'DEK must be at least 128 bits (recommended 256 bits)');
  }
  const subtle = getWebCrypto().subtle;
  const baseKey = await subtle.importKey('raw', toExactBuffer(dekBytes), 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toExactBuffer(fileSalt),
      info: toExactBuffer(utf8ToBytes(aad)),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

export async function encryptWithPassword(
  plaintextObj: unknown,
  password: string,
  aad: string,
  options?: { compress?: boolean; encoding?: PayloadEncoding; iterations?: number; keyEpoch?: number },
): Promise<Uint8Array> {
  if (!password) {
    throw new SmesCryptoError('ENCRYPT_EMPTY_PASSWORD', 'Encryption password must not be empty');
  }
  const compress = options?.compress ?? true;
  const encoding: PayloadEncoding = options?.encoding ?? 'json';
  const iterations = options?.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
  const keyEpoch = options?.keyEpoch ?? 1;
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new SmesCryptoError('ENCRYPT_INVALID_ITERATIONS', `PBKDF2 iterations must be a positive integer: ${iterations}`);
  }

  const salt = generateRandomBytes(SALT_LENGTH);
  const iv = generateRandomBytes(IV_LENGTH);
  const { bytes: payloadBytes, flags } = encodePayload(plaintextObj, encoding, compress);
  const headerBytes = buildHeaderBytes({ flags, keyEpoch, iterations, salt, iv, aad });

  const aesKey = await derivePbkdf2AesKey(password, salt, iterations, 'encrypt');
  const cipherBuffer = await getWebCrypto().subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: toExactBuffer(iv),
      additionalData: toExactBuffer(headerBytes),
    },
    aesKey,
    toExactBuffer(payloadBytes),
  );

  const cipherBytes = new Uint8Array(cipherBuffer);
  const envelope = new Uint8Array(headerBytes.byteLength + cipherBytes.byteLength);
  envelope.set(headerBytes, 0);
  envelope.set(cipherBytes, headerBytes.byteLength);
  return envelope;
}

export async function decryptWithPassword<T = unknown>(
  envelopeBytes: Uint8Array,
  password: string,
  expectedAad: string,
): Promise<T> {
  if (!password) {
    throw new SmesCryptoError('DECRYPT_ERROR', 'Decryption password must not be empty');
  }
  const { header, headerBytes, ciphertext } = parseEnvelopeInternal(envelopeBytes);
  if (header.iterations <= 0) {
    throw new SmesCryptoError(
      'DECRYPT_ENVELOPE_MODE_MISMATCH',
      'Envelope is a DEK/HKDF envelope (iterations=0), not a password envelope',
    );
  }
  if (header.aad !== expectedAad) {
    throw new SmesCryptoError(
      'DECRYPT_AAD_MISMATCH',
      `AAD verification failed: expected "${expectedAad}", got "${header.aad}"`,
    );
  }

  const aesKey = await derivePbkdf2AesKey(password, header.salt, header.iterations, 'decrypt');
  let plainBuffer: ArrayBuffer;
  try {
    plainBuffer = await getWebCrypto().subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toExactBuffer(header.iv),
        additionalData: toExactBuffer(headerBytes),
      },
      aesKey,
      toExactBuffer(ciphertext),
    );
  } catch (err) {
    throw new SmesCryptoError(
      'DECRYPT_ERROR',
      'Failed to decrypt password envelope: wrong password or corrupted/tampered ciphertext',
      err,
    );
  }

  return decodePayload<T>(new Uint8Array(plainBuffer), header.flags);
}

export async function encryptWithDek(
  plaintextObj: unknown,
  dekBase64: string,
  keyEpoch: number,
  aad: string,
  options?: { compress?: boolean; encoding?: PayloadEncoding },
): Promise<Uint8Array> {
  const compress = options?.compress ?? true;
  const encoding: PayloadEncoding = options?.encoding ?? 'json';

  const salt = generateRandomBytes(SALT_LENGTH);
  const iv = generateRandomBytes(IV_LENGTH);
  const { bytes: payloadBytes, flags } = encodePayload(plaintextObj, encoding, compress);
  const headerBytes = buildHeaderBytes({
    flags,
    keyEpoch,
    iterations: 0,
    salt,
    iv,
    aad,
  });

  const aesKey = await deriveHkdfAesKey(dekBase64, salt, aad, 'encrypt');
  const cipherBuffer = await getWebCrypto().subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: toExactBuffer(iv),
      additionalData: toExactBuffer(headerBytes),
    },
    aesKey,
    toExactBuffer(payloadBytes),
  );

  const cipherBytes = new Uint8Array(cipherBuffer);
  const envelope = new Uint8Array(headerBytes.byteLength + cipherBytes.byteLength);
  envelope.set(headerBytes, 0);
  envelope.set(cipherBytes, headerBytes.byteLength);
  return envelope;
}

export async function decryptWithDek<T = unknown>(
  envelopeBytes: Uint8Array,
  dekOrKeyring: string | Record<number, string>,
  expectedAadPrefix: string,
): Promise<{ data: T; header: SmesHeader }> {
  const { header, headerBytes, ciphertext } = parseEnvelopeInternal(envelopeBytes);
  if (header.iterations !== 0) {
    throw new SmesCryptoError(
      'DECRYPT_ENVELOPE_MODE_MISMATCH',
      'Envelope is a password/PBKDF2 envelope, not a DEK/HKDF envelope',
    );
  }
  if (expectedAadPrefix && !(header.aad === expectedAadPrefix || header.aad.startsWith(expectedAadPrefix))) {
    throw new SmesCryptoError(
      'DECRYPT_AAD_MISMATCH',
      `AAD prefix verification failed: expected prefix "${expectedAadPrefix}", got "${header.aad}"`,
    );
  }

  let dekBase64: string | undefined;
  if (typeof dekOrKeyring === 'string') {
    dekBase64 = dekOrKeyring;
  } else {
    dekBase64 = dekOrKeyring[header.keyEpoch];
  }
  if (!dekBase64) {
    throw new SmesCryptoError(
      'DECRYPT_KEY_EPOCH_MISSING',
      `No DEK found in keyring for keyEpoch ${header.keyEpoch}`,
    );
  }

  const aesKey = await deriveHkdfAesKey(dekBase64, header.salt, header.aad, 'decrypt');
  let plainBuffer: ArrayBuffer;
  try {
    plainBuffer = await getWebCrypto().subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toExactBuffer(header.iv),
        additionalData: toExactBuffer(headerBytes),
      },
      aesKey,
      toExactBuffer(ciphertext),
    );
  } catch (err) {
    throw new SmesCryptoError(
      'DECRYPT_ERROR',
      'Failed to decrypt DEK envelope: wrong key or corrupted/tampered ciphertext',
      err,
    );
  }

  const data = decodePayload<T>(new Uint8Array(plainBuffer), header.flags);
  return { data, header };
}
