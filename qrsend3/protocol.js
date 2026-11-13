// Wire format shared by sender and receiver.
//
// The file is wrapped in a "stream":   [u16 metaLen][meta JSON (UTF-8)][file bytes]
// The stream is cut into chunks; each chunk becomes one QR code (binary / byte mode):
//
//   offset size field
//   0      1    magic  0x51 ('Q')
//   1      1    version (1)
//   2      4    transfer id (random, same for every chunk of one transfer)
//   6      2    chunk index  (0-based, big endian)
//   8      2    chunk count  (big endian)
//   10     ...  payload
//
// meta = { name, type, size, crc } where crc is CRC-32 of the file bytes.

export const MAGIC = 0x51;
export const VERSION = 1;
export const HEADER_SIZE = 10;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function buildStream(fileBytes, { name, type }) {
  const meta = new TextEncoder().encode(
    JSON.stringify({ name, type, size: fileBytes.length, crc: crc32(fileBytes) })
  );
  const out = new Uint8Array(2 + meta.length + fileBytes.length);
  out[0] = meta.length >> 8;
  out[1] = meta.length & 0xff;
  out.set(meta, 2);
  out.set(fileBytes, 2 + meta.length);
  return out;
}

export function parseStream(stream) {
  const metaLen = (stream[0] << 8) | stream[1];
  const meta = JSON.parse(new TextDecoder().decode(stream.subarray(2, 2 + metaLen)));
  const file = stream.slice(2 + metaLen, 2 + metaLen + meta.size);
  const ok = file.length === meta.size && crc32(file) === meta.crc;
  return { meta, file, ok };
}

export function makeChunks(stream, payloadSize, id) {
  const count = Math.ceil(stream.length / payloadSize);
  if (count > 0xffff) throw new Error('For mange biter – øk bitstørrelsen eller komprimer bildet mer.');
  const chunks = [];
  for (let i = 0; i < count; i++) {
    const payload = stream.subarray(i * payloadSize, (i + 1) * payloadSize);
    const c = new Uint8Array(HEADER_SIZE + payload.length);
    c[0] = MAGIC;
    c[1] = VERSION;
    c[2] = (id >>> 24) & 0xff;
    c[3] = (id >>> 16) & 0xff;
    c[4] = (id >>> 8) & 0xff;
    c[5] = id & 0xff;
    c[6] = i >> 8;
    c[7] = i & 0xff;
    c[8] = count >> 8;
    c[9] = count & 0xff;
    c.set(payload, HEADER_SIZE);
    chunks.push(c);
  }
  return chunks;
}

export function parseChunk(b) {
  if (!b || b.length <= HEADER_SIZE || b[0] !== MAGIC || b[1] !== VERSION) return null;
  const id = ((b[2] << 24) | (b[3] << 16) | (b[4] << 8) | b[5]) >>> 0;
  const index = (b[6] << 8) | b[7];
  const count = (b[8] << 8) | b[9];
  if (count === 0 || index >= count) return null;
  return { id, index, count, payload: b.slice(HEADER_SIZE) };
}

// Bytes -> "binary string" (one char per byte) for qrcode-generator's byte mode.
export function bytesToBinaryString(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

export class Assembler {
  constructor(id, count) {
    this.id = id;
    this.count = count;
    this.parts = new Array(count);
    this.received = 0;
  }
  add(chunk) {
    if (chunk.id !== this.id || chunk.count !== this.count) return false;
    if (this.parts[chunk.index]) return false;
    this.parts[chunk.index] = chunk.payload;
    this.received++;
    return true;
  }
  get complete() {
    return this.received === this.count;
  }
  missing() {
    const m = [];
    for (let i = 0; i < this.count; i++) if (!this.parts[i]) m.push(i);
    return m;
  }
  assemble() {
    const total = this.parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return parseStream(out);
  }
}
