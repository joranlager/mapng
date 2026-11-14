// QR-overføring 4: fontene-koder (LT-koder) over QR-koder og fargerutenett.
//
// Strømmen [u16 metaLen][meta JSON][bildefil] deles i K blokker på B byte.
// Hver symbol er en XOR av noen blokker, og tapte symboler gjør ingenting:
// mottakeren trenger bare nok symboler, ikke de bestemte.
// De første K symbolene er systematiske (en blokk hver), deretter tilfeldige.
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

// ---------------------------------------------------------------- fordeling
const cdfCache = new Map();

// Robust soliton-fordeling (Luby 2002), c = 0.1, delta = 0.05.
export function degreeCdf(K) {
  if (cdfCache.has(K)) return cdfCache.get(K);
  const cdf = new Float64Array(K + 1);
  if (K === 1) {
    cdf[1] = 1;
  } else {
    const c = 0.1, delta = 0.05;
    const S = c * Math.log(K / delta) * Math.sqrt(K);
    const pivot = Math.max(1, Math.min(K, Math.floor(K / S)));
    const mu = new Float64Array(K + 1);
    let Z = 0;
    for (let i = 1; i <= K; i++) {
      const rho = i === 1 ? 1 / K : 1 / (i * (i - 1));
      let tau = 0;
      if (i < pivot) tau = S / (K * i);
      else if (i === pivot) tau = (S * Math.log(S / delta)) / K;
      mu[i] = rho + tau;
      Z += mu[i];
    }
    let acc = 0;
    for (let i = 1; i <= K; i++) { acc += mu[i] / Z; cdf[i] = acc; }
    cdf[K] = 1;
  }
  cdfCache.set(K, cdf);
  return cdf;
}

// Liten, deterministisk PRNG (mulberry32): samme seed gir samme blokker hos sender og mottaker.
export function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function neighbors(K, seed, flags) {
  if (flags & FLAG_SYSTEMATIC) return [seed];
  const rnd = mulberry32(seed);
  const cdf = degreeCdf(K);
  const u = rnd();
  let d = K;
  for (let i = 1; i <= K; i++) if (u <= cdf[i]) { d = i; break; }
  const set = new Set();
  while (set.size < d) set.add(Math.floor(rnd() * K));
  return [...set];
}

function xorInto(dst, src) {
  for (let i = 0; i < dst.length; i++) dst[i] ^= src[i];
}

// ---------------------------------------------------------------- sender
export class Encoder {
  constructor(stream, B, tid, base = (crypto.getRandomValues(new Uint32Array(1))[0] >>> 0)) {
    this.B = B;
    this.tid = tid;
    this.streamLen = stream.length;
    this.K = Math.max(1, Math.ceil(stream.length / B));
    this.blocks = [];
    for (let i = 0; i < this.K; i++) {
      const blk = new Uint8Array(B);
      blk.set(stream.subarray(i * B, (i + 1) * B));
      this.blocks.push(blk);
    }
    this.base = base;
    this.count = 0;
  }
  next() {
    const i = this.count++;
    if (i < this.K) return this._sym(FLAG_SYSTEMATIC, i, this.blocks[i]);
    const seed = (this.base + i) >>> 0;
    const payload = new Uint8Array(this.B);
    for (const j of neighbors(this.K, seed, 0)) xorInto(payload, this.blocks[j]);
    return this._sym(0, seed, payload);
  }
  _sym(flags, seed, payload) {
    return symbolBytes({ flags, tid: this.tid, K: this.K, B: this.B, streamLen: this.streamLen, seed, payload });
  }
}

// ---------------------------------------------------------------- mottaker
export class Decoder {
  constructor() { this.reset(); }
  reset() {
    this.tid = null;
    this.K = 0; this.B = 0; this.streamLen = 0;
    this.blocks = null;
    this.decoded = 0;
    this.seen = new Set();
    this.waiters = new Map();
    this.symbols = 0;
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
    this.seen.add(key);
    this.symbols++;

    const nb = new Set(neighbors(this.K, sym.seed, sym.flags));
    const data = sym.payload.slice();
    for (const j of [...nb]) {
      if (this.blocks[j]) { xorInto(data, this.blocks[j]); nb.delete(j); }
    }
    if (nb.size === 0) return 'redundant';
    if (nb.size === 1) {
      this._solve([...nb][0], data);
    } else {
      const ref = { nb, data, done: false };
      for (const j of nb) {
        if (!this.waiters.has(j)) this.waiters.set(j, []);
        this.waiters.get(j).push(ref);
      }
    }
    return 'new';
  }

  // Peeling: en blokk er kjent -> trekk den ut av alle symboler som venter på den.
  _solve(j, data) {
    this.blocks[j] = data;
    this.decoded++;
    const queue = [j];
    while (queue.length) {
      const idx = queue.pop();
      const list = this.waiters.get(idx) || [];
      this.waiters.delete(idx);
      for (const ref of list) {
        if (ref.done || !ref.nb.has(idx)) continue;
        xorInto(ref.data, this.blocks[idx]);
        ref.nb.delete(idx);
        if (ref.nb.size === 1) {
          const [k] = ref.nb;
          ref.nb.delete(k);
          ref.done = true;
          if (!this.blocks[k]) {
            this.blocks[k] = ref.data;
            this.decoded++;
            queue.push(k);
          }
        } else if (ref.nb.size === 0) {
          ref.done = true;
        }
      }
    }
  }

  assemble() {
    const out = new Uint8Array(this.K * this.B);
    this.blocks.forEach((b, i) => out.set(b, i * this.B));
    return parseStreamBytes(out.subarray(0, this.streamLen));
  }
}
