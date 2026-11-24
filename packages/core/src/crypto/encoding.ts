/**
 * Cross-runtime binary encoding utilities & MV3-CSP-safe Protobuf wire codec.
 * Zero Node-only imports; zero eval/new Function (safe in Edge MV3 Service Workers & Node 20+).
 */

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_LOOKUP = new Uint8Array(128).fill(255);
for (let i = 0; i < BASE64_CHARS.length; i += 1) {
  BASE64_LOOKUP[BASE64_CHARS.charCodeAt(i)] = i;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export function utf8ToBytes(str: string): Uint8Array {
  return utf8Encoder.encode(str);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return utf8Decoder.decode(bytes);
}

export function bytesToBase64(bytes: Uint8Array): string {
  const len = bytes.length;
  if (len === 0) return '';
  let out = '';
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      BASE64_CHARS[(n >>> 18) & 63] +
      BASE64_CHARS[(n >>> 12) & 63] +
      BASE64_CHARS[(n >>> 6) & 63] +
      BASE64_CHARS[n & 63];
  }
  const rem = len - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += BASE64_CHARS[(n >>> 18) & 63] + BASE64_CHARS[(n >>> 12) & 63] + '==';
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out +=
      BASE64_CHARS[(n >>> 18) & 63] +
      BASE64_CHARS[(n >>> 12) & 63] +
      BASE64_CHARS[(n >>> 6) & 63] +
      '=';
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  const cleaned = b64.replace(/[\r\n\s]/g, '');
  if (cleaned.length === 0) return new Uint8Array(0);
  // Normalize base64url characters if present
  let normalized = cleaned.replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4 !== 0) {
    normalized += '=';
  }

  let padding = 0;
  if (normalized.endsWith('==')) padding = 2;
  else if (normalized.endsWith('=')) padding = 1;

  const byteLength = (normalized.length / 4) * 3 - padding;
  const out = new Uint8Array(byteLength);

  let outIdx = 0;
  for (let i = 0; i < normalized.length; i += 4) {
    const c0 = normalized.charCodeAt(i);
    const c1 = normalized.charCodeAt(i + 1);
    const c2 = normalized.charCodeAt(i + 2);
    const c3 = normalized.charCodeAt(i + 3);

    const v0 = c0 < 128 ? BASE64_LOOKUP[c0] : 255;
    const v1 = c1 < 128 ? BASE64_LOOKUP[c1] : 255;
    const v2 = c2 === 61 ? 0 : c2 < 128 ? BASE64_LOOKUP[c2] : 255;
    const v3 = c3 === 61 ? 0 : c3 < 128 ? BASE64_LOOKUP[c3] : 255;

    if (v0 === 255 || v1 === 255 || v2 === 255 || v3 === 255) {
      throw new Error('DECRYPT_INVALID_BASE64: Invalid base64 character encountered');
    }

    const n = (v0 << 18) | (v1 << 12) | (v2 << 6) | v3;
    if (outIdx < byteLength) out[outIdx++] = (n >>> 16) & 0xff;
    if (outIdx < byteLength) out[outIdx++] = (n >>> 8) & 0xff;
    if (outIdx < byteLength) out[outIdx++] = n & 0xff;
  }

  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlToBytes(b64url: string): Uint8Array {
  return base64ToBytes(b64url);
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Standard google.protobuf.Value / Struct / ListValue wire format encoder & decoder.
 * Proto3 schema:
 *   message Value {
 *     oneof kind {
 *       NullValue null_value = 1;    // tag 0x08 (varint 0)
 *       double number_value = 2;     // tag 0x11 (fixed64 LE)
 *       string string_value = 3;     // tag 0x1a (len-delimited UTF-8)
 *       bool bool_value = 4;         // tag 0x20 (varint 0|1)
 *       Struct struct_value = 5;     // tag 0x2a (len-delimited)
 *       ListValue list_value = 6;    // tag 0x32 (len-delimited)
 *     }
 *   }
 *   message Struct { map<string, Value> fields = 1; } // repeated Entry (tag 0x0a): { 1: key (0x0a), 2: value (0x12) }
 *   message ListValue { repeated Value values = 1; }  // repeated Value (tag 0x0a)
 */
class WireWriter {
  private chunks: Uint8Array[] = [];
  private total = 0;

  writeByte(b: number): void {
    this.chunks.push(Uint8Array.of(b & 0xff));
    this.total += 1;
  }

  writeVarint(value: number): void {
    let v = value >>> 0;
    const buf: number[] = [];
    while (v >= 0x80) {
      buf.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    buf.push(v);
    const arr = new Uint8Array(buf);
    this.chunks.push(arr);
    this.total += arr.length;
  }

  writeFixed64Double(num: number): void {
    const arr = new Uint8Array(8);
    new DataView(arr.buffer).setFloat64(0, num, true);
    this.chunks.push(arr);
    this.total += 8;
  }

  writeBytes(bytes: Uint8Array): void {
    this.writeVarint(bytes.length);
    if (bytes.length > 0) {
      this.chunks.push(bytes);
      this.total += bytes.length;
    }
  }

  writeString(str: string): void {
    this.writeBytes(utf8ToBytes(str));
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

class WireReader {
  pos = 0;
  private readonly view: DataView;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get eof(): boolean {
    return this.pos >= this.buf.length;
  }

  readVarint(): number {
    let result = 0;
    let shift = 0;
    while (true) {
      if (this.pos >= this.buf.length) {
        throw new Error('DECRYPT_PROTOBUF_TRUNCATED: Unexpected EOF while reading varint');
      }
      const b = this.buf[this.pos++];
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) {
        return result >>> 0;
      }
      shift += 7;
      if (shift > 35) {
        throw new Error('DECRYPT_PROTOBUF_OVERFLOW: Varint exceeds 32-bit unsigned range');
      }
    }
  }

  readFixed64Double(): number {
    if (this.pos + 8 > this.buf.length) {
      throw new Error('DECRYPT_PROTOBUF_TRUNCATED: Unexpected EOF while reading double');
    }
    const val = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return val;
  }

  readLengthDelimited(): Uint8Array {
    const len = this.readVarint();
    if (this.pos + len > this.buf.length) {
      throw new Error('DECRYPT_PROTOBUF_TRUNCATED: Unexpected EOF while reading length-delimited field');
    }
    const slice = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return slice;
  }

  skipField(wireType: number): void {
    switch (wireType) {
      case 0:
        this.readVarint();
        break;
      case 1:
        if (this.pos + 8 > this.buf.length) throw new Error('DECRYPT_PROTOBUF_TRUNCATED');
        this.pos += 8;
        break;
      case 2:
        this.readLengthDelimited();
        break;
      case 5:
        if (this.pos + 4 > this.buf.length) throw new Error('DECRYPT_PROTOBUF_TRUNCATED');
        this.pos += 4;
        break;
      default:
        throw new Error(`DECRYPT_PROTOBUF_WIRETYPE: Unsupported wire type ${wireType}`);
    }
  }
}

function encodeProtoValueInto(val: unknown, writer: WireWriter): void {
  if (val === null || val === undefined) {
    writer.writeByte(0x08); // field 1, varint
    writer.writeVarint(0);
    return;
  }
  const t = typeof val;
  if (t === 'number') {
    writer.writeByte(0x11); // field 2, 64-bit
    writer.writeFixed64Double(val as number);
    return;
  }
  if (t === 'string') {
    writer.writeByte(0x1a); // field 3, length-delimited
    writer.writeString(val as string);
    return;
  }
  if (t === 'boolean') {
    writer.writeByte(0x20); // field 4, varint
    writer.writeVarint(val ? 1 : 0);
    return;
  }
  if (Array.isArray(val)) {
    const listWriter = new WireWriter();
    for (const item of val) {
      const itemWriter = new WireWriter();
      encodeProtoValueInto(item, itemWriter);
      listWriter.writeByte(0x0a); // ListValue.values field 1
      listWriter.writeBytes(itemWriter.finish());
    }
    writer.writeByte(0x32); // field 6, length-delimited
    writer.writeBytes(listWriter.finish());
    return;
  }
  if (t === 'object') {
    const structWriter = new WireWriter();
    const record = val as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const fieldVal = record[key];
      if (fieldVal === undefined) continue; // Match JSON.stringify omission semantics
      const entryWriter = new WireWriter();
      entryWriter.writeByte(0x0a); // MapEntry.key field 1
      entryWriter.writeString(key);
      const valWriter = new WireWriter();
      encodeProtoValueInto(fieldVal, valWriter);
      entryWriter.writeByte(0x12); // MapEntry.value field 2
      entryWriter.writeBytes(valWriter.finish());

      structWriter.writeByte(0x0a); // Struct.fields field 1
      structWriter.writeBytes(entryWriter.finish());
    }
    writer.writeByte(0x2a); // field 5, length-delimited
    writer.writeBytes(structWriter.finish());
    return;
  }
  // Fallback for unexpected primitives (e.g. bigint)
  writer.writeByte(0x1a);
  writer.writeString(String(val));
}

function decodeProtoStruct(bytes: Uint8Array): Record<string, unknown> {
  const reader = new WireReader(bytes);
  const obj: Record<string, unknown> = {};
  while (!reader.eof) {
    const tag = reader.readVarint();
    const fieldNum = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNum === 1 && wireType === 2) {
      const entryBytes = reader.readLengthDelimited();
      const entryReader = new WireReader(entryBytes);
      let key = '';
      let value: unknown = null;
      while (!entryReader.eof) {
        const eTag = entryReader.readVarint();
        const eField = eTag >>> 3;
        const eWire = eTag & 7;
        if (eField === 1 && eWire === 2) {
          key = bytesToUtf8(entryReader.readLengthDelimited());
        } else if (eField === 2 && eWire === 2) {
          value = decodeProtobufValue(entryReader.readLengthDelimited());
        } else {
          entryReader.skipField(eWire);
        }
      }
      obj[key] = value;
    } else {
      reader.skipField(wireType);
    }
  }
  return obj;
}

function decodeProtoList(bytes: Uint8Array): unknown[] {
  const reader = new WireReader(bytes);
  const arr: unknown[] = [];
  while (!reader.eof) {
    const tag = reader.readVarint();
    const fieldNum = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNum === 1 && wireType === 2) {
      arr.push(decodeProtobufValue(reader.readLengthDelimited()));
    } else {
      reader.skipField(wireType);
    }
  }
  return arr;
}

export function encodeProtobufValue(value: unknown): Uint8Array {
  const writer = new WireWriter();
  encodeProtoValueInto(value, writer);
  return writer.finish();
}

export function decodeProtobufValue(bytes: Uint8Array): unknown {
  const reader = new WireReader(bytes);
  let result: unknown = null;
  while (!reader.eof) {
    const tag = reader.readVarint();
    const fieldNum = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNum === 1 && wireType === 0) {
      reader.readVarint();
      result = null;
    } else if (fieldNum === 2 && wireType === 1) {
      result = reader.readFixed64Double();
    } else if (fieldNum === 3 && wireType === 2) {
      result = bytesToUtf8(reader.readLengthDelimited());
    } else if (fieldNum === 4 && wireType === 0) {
      result = reader.readVarint() !== 0;
    } else if (fieldNum === 5 && wireType === 2) {
      result = decodeProtoStruct(reader.readLengthDelimited());
    } else if (fieldNum === 6 && wireType === 2) {
      result = decodeProtoList(reader.readLengthDelimited());
    } else {
      reader.skipField(wireType);
    }
  }
  return result;
}
