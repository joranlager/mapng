// Format for QR-overføring 2 – så enkelt som mulig.
//
// Data-QR (avsender -> mottaker), binær byte-modus:
//   [u16 nr][data]          nr = hvilken bit av bildet (0, 1, 2, …), big endian
//
// Bitene er bitene av én "strøm":
//   [u16 antall biter][u16 metaLen][meta JSON (UTF-8)][bildefil]
// meta = { name, type, size, crc } der crc er CRC-32 av bildefila.
// Antall biter står altså først i bit 0, ikke i hver QR-kode.
//
// Kvitterings-QR (mottaker -> avsender):
//   [u16 nr][u16 nr]…       numrene på biter som er mottatt

export const ACK_IDS_PER_CODE = 11;   // 22 byte -> QR versjon 2 (25×25 ruter) med feilretting M

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

// Deler bildet i biter; returnerer én Uint8Array per QR-kode ([u16 nr][data]).
export function makeChunks(fileBytes, { name, type }, payloadSize) {
  const meta = new TextEncoder().encode(
    JSON.stringify({ name, type, size: fileBytes.length, crc: crc32(fileBytes) })
  );
  const stream = new Uint8Array(4 + meta.length + fileBytes.length);
  const count = Math.ceil(stream.length / payloadSize);
  if (count > 0xffff) throw new Error('For mange biter – øk bitstørrelsen eller komprimer bildet mer.');
  stream[0] = count >> 8; stream[1] = count & 0xff;
  stream[2] = meta.length >> 8; stream[3] = meta.length & 0xff;
  stream.set(meta, 4);
  stream.set(fileBytes, 4 + meta.length);
  const chunks = [];
  for (let i = 0; i < count; i++) {
    const payload = stream.subarray(i * payloadSize, (i + 1) * payloadSize);
    const c = new Uint8Array(2 + payload.length);
    c[0] = i >> 8; c[1] = i & 0xff;
    c.set(payload, 2);
    chunks.push(c);
  }
  return chunks;
}

export function parseChunk(b) {
  if (!b || b.length < 3) return null;
  return { index: (b[0] << 8) | b[1], payload: b.slice(2) };
}

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// Samler bitene. Antall biter blir kjent når bit 0 kommer.
export class Assembler {
  constructor() {
    this.parts = new Map();
    this.count = 0;      // 0 = ukjent ennå
    this.maxIndex = -1;
  }
  // 'new' | 'dup' | 'conflict' (samme nr med annet innhold => en ny overføring har startet)
  add({ index, payload }) {
    const old = this.parts.get(index);
    if (old) return sameBytes(old, payload) ? 'dup' : 'conflict';
    if (this.count && index >= this.count) return 'conflict';
    if (index === 0) {
      const count = (payload[0] << 8) | payload[1];
      if (!count || count <= this.maxIndex) return 'conflict';
      this.count = count;
    }
    this.parts.set(index, payload);
    if (index > this.maxIndex) this.maxIndex = index;
    return 'new';
  }
  get received() { return this.parts.size; }
  get complete() { return this.count > 0 && this.parts.size === this.count; }
  assemble() {
    let total = 0;
    for (let i = 0; i < this.count; i++) total += this.parts.get(i).length;
    const s = new Uint8Array(total);
    let o = 0;
    for (let i = 0; i < this.count; i++) { s.set(this.parts.get(i), o); o += this.parts.get(i).length; }
    const metaLen = (s[2] << 8) | s[3];
    const meta = JSON.parse(new TextDecoder().decode(s.subarray(4, 4 + metaLen)));
    const file = s.slice(4 + metaLen, 4 + metaLen + meta.size);
    return { meta, file, ok: file.length === meta.size && crc32(file) === meta.crc };
  }
}

// Bytes -> "binær streng" (ett tegn per byte) for qrcode-generators byte-modus.
export function bytesToBinaryString(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

export function makeAck(ids) {
  const a = new Uint8Array(2 * ids.length);
  ids.forEach((n, k) => { a[2 * k] = n >> 8; a[2 * k + 1] = n & 0xff; });
  return a;
}

export function parseAck(b) {
  if (!b || b.length < 2 || b.length & 1 || b.length > 2 * ACK_IDS_PER_CODE) return null;
  const ids = [];
  for (let k = 0; k < b.length; k += 2) ids.push((b[k] << 8) | b[k + 1]);
  return ids;
}
