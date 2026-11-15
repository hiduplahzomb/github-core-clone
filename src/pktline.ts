// pkt-line framing, the git smart-HTTP wire's packet layer (git's pkt-line format):
// every packet is a 4-hex-digit length (itself included) followed by that many bytes of payload.
// 0000 is a flush packet, 0001 a delimiter, 0002 a response-end. A data packet's payload is the
// length minus four bytes. The longest legal packet is 65520 bytes (0xfff0).

/** The flush packet: `0000`. Ends a section or a whole message. */
export const FLUSH = Buffer.from('0000', 'ascii');
/** The delimiter packet: `0001`. Separates the sections of a protocol v2 message. */
export const DELIM = Buffer.from('0001', 'ascii');

/** One parsed packet: data with its payload, or one of the three control packets. */
export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Encode one data packet (a string is UTF-8). Throws when the packet would exceed 65520 bytes. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > 0xfff0) throw new Error(`pkt-line of ${length} bytes exceeds the 65520-byte maximum`);
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

/** Encode a sequence; the strings 'flush' and 'delim' are the control packets. */
export function pktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/**
 * Parse a whole buffer of pkt-lines. Stops at the first flush packet and returns the bytes after
 * it as `rest` — a receive-pack request carries its raw packfile there. Throws on a malformed
 * length prefix, a truncated packet, or a length under four, so a caller can answer 400 without
 * the server dying.
 */
export function parsePktLines(buffer: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line length prefix');
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush' });
      return { packets, rest: buffer.subarray(offset + 4) };
    }
    if (head === '0001') {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (head === '0002') {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`malformed pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length < 4) throw new Error(`pkt-line length ${length} is under four`);
    if (offset + length > buffer.length) throw new Error('truncated pkt-line payload');
    packets.push({ kind: 'data', payload: Buffer.from(buffer.subarray(offset + 4, offset + length)) });
    offset += length;
  }
  return { packets, rest: Buffer.alloc(0) };
}

/** The data packets of a parsed buffer as UTF-8 lines, trailing newlines stripped. */
export function dataLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}
