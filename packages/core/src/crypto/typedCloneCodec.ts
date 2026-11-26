/**
 * Reversible typed JSON codec for structured-clone-compatible values and IndexedDB keys.
 * Fails gracefully with `{ ok: false, reason }` on circular references and non-serializable host handles.
 */
import { base64ToBytes, bytesToBase64, utf8ToBytes } from './encoding';

export type TypedCloneEncodeResult =
  | { ok: true; encoded: string; byteLength: number }
  | { ok: false; reason: string };

export type IdbKeyEncodeResult =
  | { ok: true; encodedKey: string }
  | { ok: false; reason: string };

const TAG_KEY = '$sm_t';

interface ArrayBufferViewConstructor {
  new (buffer: ArrayBuffer, byteOffset?: number, length?: number): ArrayBufferView;
}

const TYPED_VIEW_CONSTRUCTORS: Record<string, ArrayBufferViewConstructor | undefined> = {
  Int8Array: typeof Int8Array !== 'undefined' ? Int8Array : undefined,
  Uint8ClampedArray: typeof Uint8ClampedArray !== 'undefined' ? Uint8ClampedArray : undefined,
  Int16Array: typeof Int16Array !== 'undefined' ? Int16Array : undefined,
  Uint16Array: typeof Uint16Array !== 'undefined' ? Uint16Array : undefined,
  Int32Array: typeof Int32Array !== 'undefined' ? Int32Array : undefined,
  Uint32Array: typeof Uint32Array !== 'undefined' ? Uint32Array : undefined,
  Float32Array: typeof Float32Array !== 'undefined' ? Float32Array : undefined,
  Float64Array: typeof Float64Array !== 'undefined' ? Float64Array : undefined,
  BigInt64Array: typeof BigInt64Array !== 'undefined' ? BigInt64Array : undefined,
  BigUint64Array: typeof BigUint64Array !== 'undefined' ? BigUint64Array : undefined,
  DataView: typeof DataView !== 'undefined' ? DataView : undefined,
};

class CodecRejectError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function getObjectTag(value: object): string {
  const rawTag = Object.prototype.toString.call(value);
  const match = /^\[object (.+)\]$/.exec(rawTag);
  return match ? match[1] : 'Object';
}

function toExactArrayBuffer(u8: Uint8Array): ArrayBuffer {
  if (
    u8.byteOffset === 0 &&
    u8.byteLength === u8.buffer.byteLength &&
    u8.buffer instanceof ArrayBuffer
  ) {
    return u8.buffer;
  }
  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return copy.buffer;
}

function encodeTypedNode(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (value === undefined) {
    return { [TAG_KEY]: 'undef' };
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { [TAG_KEY]: 'num', v: 'NaN' };
    if (value === Infinity) return { [TAG_KEY]: 'num', v: 'Inf' };
    if (value === -Infinity) return { [TAG_KEY]: 'num', v: '-Inf' };
    if (Object.is(value, -0)) return { [TAG_KEY]: 'num', v: '-0' };
    return value;
  }
  if (typeof value === 'bigint') {
    return { [TAG_KEY]: 'bigint', v: value.toString() };
  }
  if (typeof value === 'function') {
    throw new CodecRejectError('unsupported_non_serializable_type:Function');
  }
  if (typeof value === 'symbol') {
    throw new CodecRejectError('unsupported_non_serializable_type:Symbol');
  }

  const obj = value as object;
  const tag = getObjectTag(obj);

  if (obj instanceof Date || tag === 'Date') {
    const d = obj as Date;
    return {
      [TAG_KEY]: 'date',
      v: Number.isNaN(d.getTime()) ? 'NaN' : d.toISOString(),
    };
  }
  if (obj instanceof RegExp || tag === 'RegExp') {
    const r = obj as RegExp;
    return { [TAG_KEY]: 'regexp', s: r.source, f: r.flags };
  }
  if (obj instanceof Uint8Array || tag === 'Uint8Array') {
    return { [TAG_KEY]: 'u8', b64: bytesToBase64(obj as Uint8Array) };
  }
  if (obj instanceof ArrayBuffer || tag === 'ArrayBuffer') {
    return { [TAG_KEY]: 'ab', b64: bytesToBase64(new Uint8Array(obj as ArrayBuffer)) };
  }
  if (ArrayBuffer.isView(obj)) {
    const kind = obj.constructor?.name || tag;
    if (!TYPED_VIEW_CONSTRUCTORS[kind]) {
      throw new CodecRejectError(`unsupported_non_serializable_type:${kind}`);
    }
    const bytes = new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength);
    return { [TAG_KEY]: 'view', kind, b64: bytesToBase64(bytes) };
  }

  if (seen.has(obj)) {
    throw new CodecRejectError('circular_reference');
  }
  seen.add(obj);

  try {
    if (Array.isArray(obj) || tag === 'Array') {
      const arr = obj as unknown[];
      const out: unknown[] = new Array(arr.length);
      for (let i = 0; i < arr.length; i += 1) {
        out[i] = encodeTypedNode(arr[i], seen);
      }
      return out;
    }

    if (obj instanceof Map || tag === 'Map') {
      const entries: Array<[unknown, unknown]> = [];
      for (const [k, v] of (obj as Map<unknown, unknown>).entries()) {
        entries.push([encodeTypedNode(k, seen), encodeTypedNode(v, seen)]);
      }
      return { [TAG_KEY]: 'map', e: entries };
    }

    if (obj instanceof Set || tag === 'Set') {
      const values: unknown[] = [];
      for (const item of (obj as Set<unknown>).values()) {
        values.push(encodeTypedNode(item, seen));
      }
      return { [TAG_KEY]: 'set', v: values };
    }

    // Reject DOM nodes, FileSystemHandle, CryptoKey, Blob, File, WeakMap, class instances, etc.
    const proto = Object.getPrototypeOf(obj);
    const ctorName = (obj as { constructor?: { name?: string } }).constructor?.name;
    if (tag !== 'Object') {
      throw new CodecRejectError(`unsupported_non_serializable_type:${tag}`);
    }
    if (proto !== Object.prototype && proto !== null) {
      throw new CodecRejectError(`unsupported_non_serializable_type:${ctorName || 'Object'}`);
    }
    const record = obj as Record<string, unknown>;
    if (
      typeof record.nodeType === 'number' &&
      typeof record.nodeName === 'string'
    ) {
      throw new CodecRejectError('unsupported_non_serializable_type:DOMNode');
    }

    const encodedRecord: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      encodedRecord[key] = encodeTypedNode(record[key], seen);
    }
    if (Object.prototype.hasOwnProperty.call(record, TAG_KEY)) {
      return { [TAG_KEY]: 'raw_obj', v: encodedRecord };
    }
    return encodedRecord;
  } finally {
    seen.delete(obj);
  }
}

function decodeTypedNode(node: unknown): unknown {
  if (node === null || typeof node !== 'object') {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(decodeTypedNode);
  }

  const record = node as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, TAG_KEY)) {
    const tagType = record[TAG_KEY];
    switch (tagType) {
      case 'undef':
        return undefined;
      case 'num':
        if (record.v === 'NaN') return NaN;
        if (record.v === 'Inf') return Infinity;
        if (record.v === '-Inf') return -Infinity;
        if (record.v === '-0') return -0;
        throw new Error(`INVALID_TYPED_CLONE_NUMBER: ${String(record.v)}`);
      case 'bigint':
        return BigInt(String(record.v));
      case 'date':
        return record.v === 'NaN' ? new Date(NaN) : new Date(String(record.v));
      case 'regexp':
        return new RegExp(String(record.s ?? ''), String(record.f ?? ''));
      case 'u8':
        return base64ToBytes(String(record.b64 ?? ''));
      case 'ab':
        return toExactArrayBuffer(base64ToBytes(String(record.b64 ?? '')));
      case 'view': {
        const kind = String(record.kind ?? '');
        const Ctor = TYPED_VIEW_CONSTRUCTORS[kind];
        if (!Ctor) {
          throw new Error(`UNSUPPORTED_TYPED_VIEW: ${kind}`);
        }
        const bytes = base64ToBytes(String(record.b64 ?? ''));
        return new Ctor(toExactArrayBuffer(bytes));
      }
      case 'map': {
        const map = new Map<unknown, unknown>();
        const entries = Array.isArray(record.e) ? record.e : [];
        for (const pair of entries) {
          if (Array.isArray(pair) && pair.length >= 2) {
            map.set(decodeTypedNode(pair[0]), decodeTypedNode(pair[1]));
          }
        }
        return map;
      }
      case 'set': {
        const set = new Set<unknown>();
        const values = Array.isArray(record.v) ? record.v : [];
        for (const item of values) {
          set.add(decodeTypedNode(item));
        }
        return set;
      }
      case 'raw_obj': {
        const inner = (record.v ?? {}) as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(inner)) {
          out[key] = decodeTypedNode(inner[key]);
        }
        return out;
      }
      default:
        throw new Error(`UNKNOWN_TYPED_CLONE_TAG: ${String(tagType)}`);
    }
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    out[key] = decodeTypedNode(record[key]);
  }
  return out;
}

export function encodeTypedValue(value: unknown): TypedCloneEncodeResult {
  try {
    const encodedNode = encodeTypedNode(value, new WeakSet<object>());
    const encoded = JSON.stringify(encodedNode);
    return {
      ok: true,
      encoded,
      byteLength: utf8ToBytes(encoded).byteLength,
    };
  } catch (err) {
    if (err instanceof CodecRejectError) {
      return { ok: false, reason: err.reason };
    }
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'typed_clone_encode_failed',
    };
  }
}

export function decodeTypedValue<T = unknown>(encoded: string): T {
  const parsed = JSON.parse(encoded) as unknown;
  return decodeTypedNode(parsed) as T;
}

function encodeIdbKeyNode(key: unknown, seen: WeakSet<object>): unknown {
  if (typeof key === 'string') {
    return key;
  }
  if (typeof key === 'number') {
    if (Number.isNaN(key)) {
      throw new CodecRejectError('invalid_idb_key:NaN');
    }
    if (key === Infinity) return ['n', 'Inf'];
    if (key === -Infinity) return ['n', '-Inf'];
    return Object.is(key, -0) ? 0 : key;
  }
  if (key === null || typeof key !== 'object') {
    throw new CodecRejectError(`invalid_idb_key:${typeof key}`);
  }

  const tag = getObjectTag(key);
  if (key instanceof Date || tag === 'Date') {
    const ms = (key as Date).getTime();
    if (Number.isNaN(ms)) {
      throw new CodecRejectError('invalid_idb_key:InvalidDate');
    }
    return ['d', ms];
  }
  if (key instanceof ArrayBuffer || tag === 'ArrayBuffer') {
    return ['b', bytesToBase64(new Uint8Array(key as ArrayBuffer))];
  }
  if (ArrayBuffer.isView(key)) {
    const bytes = new Uint8Array(key.buffer, key.byteOffset, key.byteLength);
    return ['b', bytesToBase64(bytes)];
  }
  if (Array.isArray(key) || tag === 'Array') {
    if (seen.has(key)) {
      throw new CodecRejectError('invalid_idb_key:circular_array');
    }
    seen.add(key);
    try {
      const arr = key as unknown[];
      const items: unknown[] = new Array(arr.length);
      for (let i = 0; i < arr.length; i += 1) {
        items[i] = encodeIdbKeyNode(arr[i], seen);
      }
      return ['a', items];
    } finally {
      seen.delete(key);
    }
  }

  throw new CodecRejectError(`invalid_idb_key:${tag}`);
}

function decodeIdbKeyNode(node: unknown): unknown {
  if (typeof node === 'string' || typeof node === 'number') {
    return node;
  }
  if (Array.isArray(node) && node.length === 2) {
    const [kind, payload] = node;
    if (kind === 'n') {
      if (payload === 'Inf') return Infinity;
      if (payload === '-Inf') return -Infinity;
    }
    if (kind === 'd' && typeof payload === 'number') {
      return new Date(payload);
    }
    if (kind === 'b' && typeof payload === 'string') {
      return toExactArrayBuffer(base64ToBytes(payload));
    }
    if (kind === 'a' && Array.isArray(payload)) {
      return payload.map(decodeIdbKeyNode);
    }
  }
  throw new Error('INVALID_ENCODED_IDB_KEY');
}

export function encodeIdbKey(key: unknown): IdbKeyEncodeResult {
  try {
    const encodedKey = JSON.stringify(encodeIdbKeyNode(key, new WeakSet<object>()));
    return { ok: true, encodedKey };
  } catch (err) {
    if (err instanceof CodecRejectError) {
      return { ok: false, reason: err.reason };
    }
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'invalid_idb_key',
    };
  }
}

export function decodeIdbKey(encodedKey: string): unknown {
  const parsed = JSON.parse(encodedKey) as unknown;
  return decodeIdbKeyNode(parsed);
}
