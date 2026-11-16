// Packfiles: the transfer format for git objects (gitformat-pack). The writer emits plain
// (undeltified) version-2 packs — every object zlib-deflated on its own — which any git client
// reads; the reader resolves OFS_DELTA and REF_DELTA entries too, because real git clients push
// thin packs whose deltas lean on objects the server already holds.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { hashObject, type GitObject, type GitObjectType } from './git-objects.ts';

const TYPE_NUMBER: Readonly<Record<GitObjectType, number>> = Object.freeze({
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
});

const NUMBER_TYPE: Readonly<Record<number, GitObjectType>> = Object.freeze({
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
});

/** The empty pack: a 12-byte header for zero objects plus its 20-byte trailer. */
export const EMPTY_PACK: Buffer = (() => {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(0, 8);
  const trailer = createHash('sha1').update(header).digest();
  return Buffer.concat([header, trailer]);
})();

/** Whether a buffer is a well-formed pack trailer match (SHA-1 of everything before the last 20 bytes). */
export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 32) return false;
  const body = pack.subarray(0, pack.length - 20);
  const trailer = pack.subarray(pack.length - 20);
  return createHash('sha1').update(body).digest().equals(trailer);
}

/** Encode one entry's type/size header: (type << 4) | low 4 size bits, then 7-bit size groups. */
function entryHeader(typeNumber: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeNumber << 4) | (size & 0x0f);
  let rest = size >>> 4;
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest >>>= 7;
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Write a version-2 pack of plain objects, in the caller's order, with the SHA-1 trailer. An
 * empty list writes the 32-byte empty pack. Deflate runs at level 1: these packs are small and
 * short-lived (a fetch response), and level 1 is several times faster than the default while
 * producing a valid pack any client reads — the trailer is computed over whatever bytes result.
 */
export function writePack(objects: readonly GitObject[]): Buffer {
  if (objects.length === 0) return EMPTY_PACK;
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(entryHeader(TYPE_NUMBER[object.type], object.data.length));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Read a 7-bit little-endian varint (the delta format's size encoding). */
function readSizeVarint(buffer: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let at = offset;
  for (;;) {
    if (at >= buffer.length) throw new Error('truncated varint in pack delta');
    const byte = buffer[at] as number;
    at += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: at };
}

/**
 * Apply a delta to its base: source size, target size, then copy/insert operations until the
 * delta is consumed. A copy op's byte has bit 7 set and its low seven bits say which offset and
 * size bytes follow; an insert op's byte is the byte count that follows it.
 */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const source = readSizeVarint(delta, 0);
  if (source.value !== base.length) throw new Error(`delta base size ${source.value} does not match ${base.length}`);
  const target = readSizeVarint(delta, source.next);
  const out = Buffer.alloc(target.value);
  let outAt = 0;
  let at = target.next;
  while (at < delta.length) {
    const op = delta[at] as number;
    at += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          if (at >= delta.length) throw new Error('truncated copy offset in pack delta');
          copyOffset |= (delta[at] as number) << (bit * 8);
          at += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((op & (0x10 << bit)) !== 0) {
          if (at >= delta.length) throw new Error('truncated copy size in pack delta');
          copySize |= (delta[at] as number) << (bit * 8);
          at += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length || outAt + copySize > target.value) {
        throw new Error('copy operation overruns its delta');
      }
      base.copy(out, outAt, copyOffset, copyOffset + copySize);
      outAt += copySize;
    } else if (op !== 0) {
      if (at + op > delta.length || outAt + op > target.value) throw new Error('insert operation overruns its delta');
      delta.copy(out, outAt, at, at + op);
      at += op;
      outAt += op;
    } else {
      throw new Error('delta operation byte 0 is reserved');
    }
  }
  if (outAt !== target.value) throw new Error(`delta produced ${outAt} bytes, expected ${target.value}`);
  return out;
}

/**
 * Read a version-2 or version-3 pack and resolve every object, deltas included. `lookup` resolves
 * a REF_DELTA base the pack itself does not carry (a thin pack leans on the receiver's store);
 * without it an external base is an error. The trailer checksum is verified. Throws on any
 * malformation, so the caller can report an unpack failure instead of storing garbage.
 * Each returned object carries its oid (already computed while reading), so the caller can store
 * it without hashing the bytes a second time.
 */
export function readPack(pack: Buffer, lookup?: (oid: string) => GitObject | undefined): Array<GitObject & { oid: string }> {
  try {
    return readPackInner(pack, lookup, findStreamEndAdler);
  } catch {
    // The Adler fast path failed: either a malformed pack, or the vanishingly rare case where
    // an entry's Adler bytes appear early inside its deflate data and desynchronize the walk.
    // Retry with the exact bisection finder, which throws the authoritative error for a bad pack.
    return readPackInner(pack, lookup, skipZlibStream);
  }
}

/** The Adler-32 checksum of a buffer (zlib's, big-endian in the stream trailer). The modulo is
 * deferred over 5552-byte runs, the largest run that cannot overflow a 32-bit accumulator. */
function adler32(data: Buffer): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  let at = 0;
  while (at < data.length) {
    const end = Math.min(data.length, at + 5552);
    for (; at < end; at += 1) {
      a += data[at] as number;
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Find where the zlib stream starting at `start` ends, given the bytes it inflates to. A zlib
 * stream ends with the Adler-32 of its uncompressed data, so the stream's end is the first
 * occurrence of those four bytes at or after `start + 2` (past the two-byte zlib header), plus
 * four. Returns -1 when the checksum bytes are not found before `end`. The caller validates the
 * walk as a whole (every entry's size, the final offset), so a coincidental early match — the
 * same four bytes inside the deflate data, about one chance in 2^32 per position — falls back
 * to the bisection finder instead of corrupting the read.
 */
function findStreamEndAdler(pack: Buffer, start: number, end: number, inflated: Buffer): number {
  const needle = Buffer.alloc(4);
  needle.writeUInt32BE(adler32(inflated), 0);
  const at = pack.indexOf(needle, start + 2);
  if (at < 0 || at + 4 > end) return -1;
  return at + 4;
}

type StreamEndFinder = (pack: Buffer, start: number, end: number, inflated: Buffer) => number;

function readPackInner(
  pack: Buffer,
  lookup: ((oid: string) => GitObject | undefined) | undefined,
  findEnd: StreamEndFinder,
): Array<GitObject & { oid: string }> {
  if (pack.length < 32) throw new Error('pack is too short for a header and trailer');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} is not 2 or 3`);
  if (!verifyPackChecksum(pack)) throw new Error('pack trailer checksum does not match its bytes');
  const count = pack.readUInt32BE(8);
  const objects: Array<GitObject & { oid: string }> = [];
  // By pack offset (for OFS_DELTA) and by oid (for REF_DELTA within this pack).
  const byOffset = new Map<number, GitObject>();
  const byOid = new Map<string, GitObject>();
  let offset = 12;
  const end = pack.length - 20;
  for (let index = 0; index < count; index += 1) {
    if (offset >= end) throw new Error('pack ends before its object count');
    const entryStart = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeNumber = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (offset >= end) throw new Error('truncated object header in pack');
      byte = pack[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let base: GitObject | undefined;
    let baseOid: string | undefined;
    if (typeNumber === 6) {
      // OFS_DELTA: a negative offset to the base entry, encoded base-128 with a +1 bias per byte.
      if (offset >= end) throw new Error('truncated OFS_DELTA offset in pack');
      byte = pack[offset] as number;
      offset += 1;
      let deltaOffset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        if (offset >= end) throw new Error('truncated OFS_DELTA offset in pack');
        byte = pack[offset] as number;
        offset += 1;
        deltaOffset = ((deltaOffset + 1) << 7) | (byte & 0x7f);
      }
      base = byOffset.get(entryStart - deltaOffset);
      if (base === undefined) throw new Error('OFS_DELTA base is not an earlier pack entry');
    } else if (typeNumber === 7) {
      // REF_DELTA: the base's 20-byte oid.
      if (offset + 20 > end) throw new Error('truncated REF_DELTA base oid in pack');
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      base = byOid.get(baseOid) ?? lookup?.(baseOid);
      if (base === undefined) throw new Error(`REF_DELTA base ${baseOid} is not in the pack or the store`);
    } else if (NUMBER_TYPE[typeNumber] === undefined) {
      throw new Error(`pack object type ${typeNumber} is not a git object type`);
    }
    let inflated: Buffer;
    try {
      inflated = inflateSync(pack.subarray(offset, end));
    } catch {
      throw new Error('pack entry is not valid zlib data');
    }
    // Where this entry's zlib stream ends: the fast path locates it from the inflated bytes'
    // checksum; the fallback bisects. Either way a -1 here is a malformed stream.
    const streamEnd = findEnd(pack, offset, end, inflated);
    if (streamEnd < 0) throw new Error('pack entry zlib stream has no clean end');
    offset = streamEnd;
    let object: GitObject;
    if (typeNumber === 6 || typeNumber === 7) {
      if (base === undefined) throw new Error('delta entry has no base object');
      object = { type: base.type, data: applyDelta(base.data, inflated) };
    } else {
      const type = NUMBER_TYPE[typeNumber] as GitObjectType;
      if (inflated.length !== size) throw new Error(`pack entry inflated to ${inflated.length} bytes, header said ${size}`);
      object = { type, data: inflated };
    }
    const oid = hashObject(object.type, object.data);
    byOffset.set(entryStart, object);
    byOid.set(oid, object);
    objects.push({ ...object, oid });
  }
  // The walk must end exactly at the trailer: a shortfall means the stream-end finder
  // desynchronized (or the pack is malformed), and the caller must not trust the objects.
  if (offset !== end) throw new Error('pack entries do not end at the trailer');
  return objects;
}

/**
 * Find where the zlib stream starting at `start` ends, by bisection: "inflates cleanly" is a
 * monotone predicate over the end position, so the stream's end is the smallest end that inflates
 * cleanly, found by doubling out to a clean end and bisecting. Node's zlib does not report the
 * consumed length, so this is the exact fallback when the Adler fast path cannot place an end
 * (a malformed stream, or a coincidental Adler match inside the deflate data). Each probe is a
 * full inflate, some of which throw, so this runs only on the rare path — the fast path handles
 * every well-formed pack.
 */
function skipZlibStream(pack: Buffer, start: number, end: number): number {
  const inflatesCleanly = (at: number): boolean => {
    if (at > end) return false;
    try {
      inflateSync(pack.subarray(start, at));
      return true;
    } catch {
      return false;
    }
  };
  let low = start + 2;
  if (inflatesCleanly(low)) return low;
  let high = low;
  while (high < end && !inflatesCleanly(high)) {
    low = high;
    high = Math.min(end, high + Math.max(1024, (high - start) * 2));
  }
  if (!inflatesCleanly(high)) throw new Error('pack entry zlib stream has no clean end');
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if (inflatesCleanly(mid)) high = mid;
    else low = mid;
  }
  return high;
}
