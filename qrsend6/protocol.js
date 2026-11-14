// QR-overføring 4: fontene-kode over QR-koder og fargerutenett.
//
// Strømmen [u16 metaLen][meta JSON][bildefil] deles i K blokker på B byte.
// De første K symbolene er systematiske (én blokk hver). Deretter er hvert symbol en XOR av
// et tilfeldig utvalg blokker (tilfeldig lineær kode over GF(2)). Mottakeren løser ligningene
// med Gauss-eliminasjon og trenger normalt bare noen få symboler mer enn K, uansett hvilke
// som gikk tapt.
//
// Symbol (byte, big endian):
//   0      1  magic 0x46 ('F')
//   1      1  flagg: bit0 = systematisk (seed er blokknummer)
//   2      4  overførings-id (tilfeldig, samme for alle symboler i én overføring)
//   6      2  K  antall blokker
//   8      2  B  blokkstørrelse
//   10     4  streamLen (lengde på strømmen før padding)
//   14     4  seed
//   18     B  nyttelast
//   18+B   4  CRC-32 av alt over
//
// Det gir OVERHEAD = 22 byte per symbol.

export const MAGIC = 0x46;
export const HEADER = 18;
export const OVERHEAD = 22;
export const FLAG_SYSTEMATIC = 1;

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

const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const put16 = (b, o, v) => { b[o] = (v >>> 8) & 255; b[o + 1] = v & 255; };
const put32 = (b, o, v) => { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; };

export function bytesToBinaryString(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

// ---------------------------------------------------------------- strøm
export function buildStreamBytes(fileBytes, { name, type }) {
  const meta = new TextEncoder().encode(
    JSON.stringify({ name, type, size: fileBytes.length, crc: crc32(fileBytes) })
  );
  const s = new Uint8Array(2 + meta.length + fileBytes.length);
  put16(s, 0, meta.length);
  s.set(meta, 2);
  s.set(fileBytes, 2 + meta.length);
  return s;
}

export function parseStreamBytes(s) {
  const ml = u16(s, 0);
  const meta = JSON.parse(new TextDecoder().decode(s.subarray(2, 2 + ml)));
  const file = s.slice(2 + ml, 2 + ml + meta.size);
  return { meta, file, ok: file.length === meta.size && crc32(file) === meta.crc };
}

// ---------------------------------------------------------------- symbol
export function symbolBytes({ flags, tid, K, B, streamLen, seed, payload }) {
  const out = new Uint8Array(OVERHEAD + B);
  out[0] = MAGIC;
  out[1] = flags;
  put32(out, 2, tid);
  put16(out, 6, K);
  put16(out, 8, B);
  put32(out, 10, streamLen);
  put32(out, 14, seed);
  out.set(payload, HEADER);
  put32(out, HEADER + B, crc32(out.subarray(0, HEADER + B)));
  return out;
}

// Returnerer null hvis bytene ikke er et gyldig symbol (feil magic, lengde eller CRC).
export function parseSymbol(b) {
  if (!b || b.length < OVERHEAD || b[0] !== MAGIC) return null;
  const B = u16(b, 8);
  if (!B || b.length < OVERHEAD + B) return null;
  if (crc32(b.subarray(0, HEADER + B)) !== u32(b, HEADER + B)) return null;
  return {
    flags: b[1], tid: u32(b, 2), K: u16(b, 6), B, streamLen: u32(b, 10), seed: u32(b, 14),
    payload: b.slice(HEADER, HEADER + B),
  };
}

// ---------------------------------------------------------------- koeffisienter
// Liten, deterministisk PRNG (mulberry32): samme seed gir samme utvalg hos sender og mottaker.
export function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

const DENSE_MAX = 1024;   // opptil så mange blokker: hver blokk er med i et symbol med sannsynlighet 1/2
const SPARSE_DEG = 512;   // flere blokker enn det: hvert symbol er XOR av 512 tilfeldige blokker

// Hvilke blokker et symbol er XOR av, som bitsett (bit i = blokk i). null hvis ugyldig.
export function coeffWords(K, seed, flags) {
  const w = new Uint32Array((K + 31) >>> 5);
  if (flags & FLAG_SYSTEMATIC) {
    if (seed >= K) return null;
    w[seed >>> 5] = (1 << (seed & 31)) >>> 0;
    return w;
  }
  const rnd = mulberry32(seed);
  if (K <= DENSE_MAX) {
    let any = 0;
    for (let i = 0; i < w.length; i++) { w[i] = rnd(); }
    if (K & 31) w[w.length - 1] &= (1 << (K & 31)) - 1;
    for (let i = 0; i < w.length; i++) any |= w[i];
    if (!any) w[0] = 1;
  } else {
    for (let n = 0; n < SPARSE_DEG;) {
      const j = rnd() % K;
      if (!((w[j >>> 5] >>> (j & 31)) & 1)) { w[j >>> 5] |= (1 << (j & 31)); n++; }
    }
  }
  return w;
}

const pad4 = (n) => (n + 3) & ~3;
function xorWords(dst, src, from = 0) {
  for (let i = from; i < dst.length; i++) dst[i] ^= src[i];
}

// ---------------------------------------------------------------- sender
export class Encoder {
  constructor(stream, B, tid, base = (crypto.getRandomValues(new Uint32Array(1))[0] >>> 0)) {
    this.B = B;
    this.tid = tid;
    this.streamLen = stream.length;
    this.K = Math.max(1, Math.ceil(stream.length / B));
    this.blocks = [];           // Uint32Array per blokk (polstret til hele ord)
    for (let i = 0; i < this.K; i++) {
      const bytes = new Uint8Array(pad4(B));
      bytes.set(stream.subarray(i * B, (i + 1) * B));
      this.blocks.push(new Uint32Array(bytes.buffer));
    }
    this.base = base;
    this.count = 0;
  }
  // Datakode nummer i (0 … K-1).
  data(i) { return this._sym(FLAG_SYSTEMATIC, i, this.blocks[i]); }
  // Paritetskode nummer n (0, 1, 2 …): XOR av et tilfeldig utvalg blokker. Hver n gir en ny kode.
  parity(n) {
    const seed = (this.base + this.K + n) >>> 0;
    const c = coeffWords(this.K, seed, 0);
    const acc = new Uint32Array(this.blocks[0].length);
    for (let wi = 0; wi < c.length; wi++) {
      let x = c[wi];
      while (x) {
        const bit = 31 - Math.clz32(x & -x);
        x &= x - 1;
        xorWords(acc, this.blocks[wi * 32 + bit]);
      }
    }
    return this._sym(0, seed, acc);
  }
  // Rekkefølgen: først alle K datakodene én gang, deretter bare paritetskoder (alltid nye).
  next() {
    const i = this.count++;
    return i < this.K ? this.data(i) : this.parity(i - this.K);
  }
  _sym(flags, seed, words) {
    const payload = new Uint8Array(words.buffer, words.byteOffset, this.B);
    return symbolBytes({ flags, tid: this.tid, K: this.K, B: this.B, streamLen: this.streamLen, seed, payload });
  }
}

// ---------------------------------------------------------------- mottaker
// Gauss-eliminasjon fortløpende: hver rad er (koeffisienter, data). blocks[i] er raden som har
// blokk i som laveste ukjente. Når alle K plassene er fylt, løses resten ved tilbakeinnsetting.
export class Decoder {
  constructor() { this.reset(); }
  reset() {
    this.tid = null;
    this.K = 0; this.B = 0; this.streamLen = 0;
    this.blocks = null;
    this.decoded = 0;       // rang: antall uavhengige ligninger
    this.seen = new Set();
    this.symbols = 0;
    this.solved = false;
  }
  get complete() { return this.K > 0 && this.decoded === this.K; }

  // Returnerer 'new' | 'redundant' | 'dup' | 'done' | 'other'
  add(sym) {
    if (this.tid !== null && sym.tid !== this.tid) this.reset();   // ny overføring
    if (this.tid === null) {
      this.tid = sym.tid; this.K = sym.K; this.B = sym.B; this.streamLen = sym.streamLen;
      this.blocks = new Array(sym.K).fill(null);
    } else if (sym.K !== this.K || sym.B !== this.B || sym.streamLen !== this.streamLen) {
      return 'other';
    }
    if (this.complete) return 'done';
    const key = sym.flags + ':' + sym.seed;
    if (this.seen.has(key)) return 'dup';
    const c = coeffWords(this.K, sym.seed, sym.flags);
    if (!c) return 'other';
    this.seen.add(key);
    this.symbols++;
    const bytes = new Uint8Array(pad4(this.B));
    bytes.set(sym.payload);
    const d = new Uint32Array(bytes.buffer);
    for (let wi = 0; wi < c.length; wi++) {
      while (c[wi]) {
        const i = wi * 32 + (31 - Math.clz32(c[wi] & -c[wi]));
        const piv = this.blocks[i];
        if (!piv) {
          this.blocks[i] = { c, d };
          this.decoded++;
          if (this.complete) this._backSubstitute();
          return 'new';
        }
        xorWords(c, piv.c, wi);
        xorWords(d, piv.d);
      }
    }
    return 'redundant';
  }

  _backSubstitute() {
    for (let i = this.K - 1; i >= 0; i--) {
      const row = this.blocks[i];
      for (let wi = i >>> 5; wi < row.c.length; wi++) {
        let x = row.c[wi];
        while (x) {
          const j = wi * 32 + (31 - Math.clz32(x & -x));
          x &= x - 1;
          if (j !== i) xorWords(row.d, this.blocks[j].d);
        }
      }
      row.c.fill(0);
      row.c[i >>> 5] = (1 << (i & 31)) >>> 0;
    }
    this.solved = true;
  }

  assemble() {
    const out = new Uint8Array(this.K * this.B);
    this.blocks.forEach((row, i) => out.set(new Uint8Array(row.d.buffer, 0, this.B), i * this.B));
    return parseStreamBytes(out.subarray(0, this.streamLen));
  }
}
