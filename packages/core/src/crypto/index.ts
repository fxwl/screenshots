export { bytesToBase64, base64ToBytes, bytesToHex } from './encoding';
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
