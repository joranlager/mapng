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

// ---------------------------------------------------------------------------
// Acknowledgements (receiver -> sender), shown as small QR codes on the
// receiver's screen and read by the sender's (often poor) front camera.
// Kept tiny (<= ACK_MAX_BYTES, QR version 2 = 25x25 modules) so the modules
// are large enough to be read from a distance.
//
//   0     1  magic/version 0xA2
//   1     1  type: 0 = bitmap segment, 1 = "everything except" list
//   2     2  transfer id (low 16 bits)
//   type 0:  4  2  byte offset of segment
//            6  .. bitmap: bit (i % 8) of byte (i >> 3) = chunk i received
//   type 1:  4  .. u16 ids (chunk indices) still MISSING (empty = complete)
//   type 2:  4  .. u16 ids (chunk indices) just RECEIVED – sent right away so the
//                 sender stops showing them as soon as possible

export const ACK_MAGIC = 0xa2;
export const ACK_MAX_BYTES = 26;                 // QR v2-M byte capacity
const BITMAP_HDR = 6, LIST_HDR = 4;
export const ACK_SEGMENT_BYTES = ACK_MAX_BYTES - BITMAP_HDR;   // 20 bytes = 160 chunks
export const ACK_MAX_MISSING = (ACK_MAX_BYTES - LIST_HDR) >> 1; // 11

function ackHead(type, id, len) {
  const a = new Uint8Array(len);
  a[0] = ACK_MAGIC; a[1] = type; a[2] = (id >>> 8) & 0xff; a[3] = id & 0xff;
  return a;
}

// Returns { segments: [Uint8Array per bitmap segment], list: Uint8Array | null }.
// `list` is set when few enough chunks are missing to name them all in one code.
export function makeAcks(assembler) {
  const total = Math.ceil(assembler.count / 8);
  const bitmap = new Uint8Array(total);
  const missing = [];
  for (let i = 0; i < assembler.count; i++) {
    if (assembler.parts[i]) bitmap[i >> 3] |= 1 << (i & 7);
    else missing.push(i);
  }
  const segments = [];
  for (let off = 0; off < total; off += ACK_SEGMENT_BYTES) {
    const seg = bitmap.subarray(off, Math.min(total, off + ACK_SEGMENT_BYTES));
    const a = ackHead(0, assembler.id, BITMAP_HDR + seg.length);
    a[4] = off >> 8; a[5] = off & 0xff;
    a.set(seg, BITMAP_HDR);
    segments.push(a);
  }
  let list = null;
  if (missing.length <= ACK_MAX_MISSING) {
    list = ackHead(1, assembler.id, LIST_HDR + 2 * missing.length);
    missing.forEach((m, k) => { list[LIST_HDR + 2 * k] = m >> 8; list[LIST_HDR + 2 * k + 1] = m & 0xff; });
  }
  return { segments, list };
}

// Kvittering for konkrete id-er (maks ACK_MAX_MISSING per kode).
export function makeReceivedAck(transferId, ids) {
  const a = ackHead(2, transferId, LIST_HDR + 2 * ids.length);
  ids.forEach((m, k) => { a[LIST_HDR + 2 * k] = m >> 8; a[LIST_HDR + 2 * k + 1] = m & 0xff; });
  return a;
}

// -> { id16, received: [indices] } | { id16, missing: [indices] } | null
export function parseAck(b) {
  if (!b || b.length < LIST_HDR || b[0] !== ACK_MAGIC) return null;
  const id16 = (b[2] << 8) | b[3];
  if (b[1] === 1 || b[1] === 2) {
    if ((b.length - LIST_HDR) & 1) return null;
    const ids = [];
    for (let k = LIST_HDR; k < b.length; k += 2) ids.push((b[k] << 8) | b[k + 1]);
    return b[1] === 1 ? { id16, missing: ids } : { id16, received: ids };
  }
  if (b[1] !== 0 || b.length < BITMAP_HDR) return null;
  const off = (b[4] << 8) | b[5];
  const received = [];
  for (let k = BITMAP_HDR; k < b.length; k++) {
    const byte = b[k];
    if (!byte) continue;
    for (let bit = 0; bit < 8; bit++) if (byte & (1 << bit)) received.push((off + k - BITMAP_HDR) * 8 + bit);
  }
  return { id16, received };
}
