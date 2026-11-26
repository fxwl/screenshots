export { bytesToBase64, base64ToBytes, bytesToBase64Url, base64UrlToBytes, bytesToHex } from './encoding';
export {
  type SmesHeader,
  SmesCryptoError,
  SMES_MAGIC,
  SMES_VERSION,
  SMES_FLAG_GZIP,
  SMES_FLAG_PROTOBUF,
  generateRandomBytes,
  sha256Hex,
  deriveOpaqueId,
  generateSpaceDekBase64,
  encryptWithPassword,
  decryptWithPassword,
  encryptWithDek,
  decryptWithDek,
  isSmesEnvelope,
  parseSmesHeader,
} from './smes';
export { encodePairingCode, decodePairingCode } from './pairing';
export {
  SESSION_SHARE_PREFIX,
  SESSION_SHARE_AAD,
  SESSION_SHARE_PBKDF2_ITERATIONS,
  generateSharePassphrase,
  encodeSessionShare,
  decodeSessionShare,
  toSessionSharePreview,
  clampSharedCookiesExpiry,
} from './sessionShare';
export {
  type TypedCloneEncodeResult,
  type IdbKeyEncodeResult,
  encodeTypedValue,
  decodeTypedValue,
  encodeIdbKey,
  decodeIdbKey,
} from './typedCloneCodec';
