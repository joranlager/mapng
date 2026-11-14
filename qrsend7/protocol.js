// QR-overføring 7: Luby Transform-koder (LT-koder), den første praktiske fontene-koden (Luby 1998/2002).
//
// Strømmen [u16 metaLen][meta JSON][bildefil] deles i K blokker på B byte.
// Avsenderen lager en endeløs strøm av koder. Hver kode er XOR av d tilfeldige blokker, der
// graden d trekkes fra robust soliton-fordelingen. Koden bærer bare en seed ("oppskriften"):
// mottakeren kjører samme tilfeldige generator og vet dermed hvilke blokker som er slått sammen.
//
// Mottakeren dekoder med kjedereaksjon (peeling / belief propagation): en kode med én ukjent
// blokk gir den blokken, som trekkes ut av alle koder som inneholder den, og så videre.
// Stopper kjedereaksjonen når nok koder er samlet, løses resten som et ligningssett (Gauss).
//
// Kode (byte, big endian), 22 byte + B:
//   0  1  magic 0x46 ('F')        6  2  K antall blokker      14  4  seed
//   1  1  flagg (0)               8  2  B blokkstørrelse      18  B  nyttelast
//   2  4  overførings-id         10  4  streamLen             18+B 4 CRC-32

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

// ---------------------------------------------------------------- robust soliton
const C = 0.05, DELTA = 0.5;
const cdfCache = new Map();

// Kumulativ fordeling for graden d = 1 … K.
export function degreeCdf(K) {
  if (cdfCache.has(K)) return cdfCache.get(K);
  const cdf = new Float64Array(K + 1);
  if (K === 1) cdf[1] = 1;
  else {
    const S = C * Math.log(K / DELTA) * Math.sqrt(K);
    const pivot = Math.max(1, Math.min(K, Math.floor(K / S)));
    const mu = new Float64Array(K + 1);
    let Z = 0;
    for (let i = 1; i <= K; i++) {
      const rho = i === 1 ? 1 / K : 1 / (i * (i - 1));                       // ideell soliton
      const tau = i < pivot ? S / (K * i) : i === pivot ? (S * Math.log(S / DELTA)) / K : 0;
      mu[i] = rho + Math.max(0, tau);
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

// "Oppskriften": hvilke blokker en kode med denne seeden er XOR av.
export function neighbors(K, seed) {
  const rnd = mulberry32(seed), cdf = degreeCdf(K), u = rnd();
  let lo = 1, hi = K;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] >= u) hi = mid; else lo = mid + 1; }
  const d = lo, set = new Set();
  if (d > K / 2) {                       // høy grad: velg hvilke som IKKE er med
    const out = new Set();
    while (out.size < K - d) out.add(Math.floor(rnd() * K));
    for (let i = 0; i < K; i++) if (!out.has(i)) set.add(i);
  } else while (set.size < d) set.add(Math.floor(rnd() * K));
  return [...set];
}

const pad4 = (n) => (n + 3) & ~3;
function xorInto(dst, src) {
  const a = new Uint32Array(dst.buffer, dst.byteOffset, dst.length >> 2), b = new Uint32Array(src.buffer, src.byteOffset, src.length >> 2);
  for (let i = 0; i < a.length; i++) a[i] ^= b[i];
}

// ---------------------------------------------------------------- sender
export class Encoder {
  constructor(stream, B, tid, base = (crypto.getRandomValues(new Uint32Array(1))[0] >>> 0)) {
    this.B = B; this.tid = tid; this.streamLen = stream.length;
    this.K = Math.max(1, Math.ceil(stream.length / B));
    this.blocks = [];
    for (let i = 0; i < this.K; i++) {
      const blk = new Uint8Array(pad4(B));
      blk.set(stream.subarray(i * B, (i + 1) * B));
      this.blocks.push(blk);
    }
    this.base = base;
    this.count = 0;
  }
  // Neste kode i den endeløse strømmen. Ingen koder er like.
  next() {
    const seed = (this.base + this.count++) >>> 0;
    const acc = new Uint8Array(pad4(this.B));
    const nb = neighbors(this.K, seed);
    for (const j of nb) xorInto(acc, this.blocks[j]);
    this.lastDegree = nb.length;
    return symbolBytes({ flags: 0, tid: this.tid, K: this.K, B: this.B, streamLen: this.streamLen, seed, payload: acc.subarray(0, this.B) });
  }
}

// ---------------------------------------------------------------- mottaker
// status per blokk: 0 = ukjent, 1 = lest direkte (kode med én blokk), 2 = regnet ut med XOR.
export class Decoder {
  constructor() { this.reset(); }
  reset() {
    this.tid = null; this.K = 0; this.B = 0; this.streamLen = 0;
    this.blocks = null; this.status = null;
    this.decoded = 0; this.symbols = 0; this.dups = 0;
    this.seen = new Set(); this.waiters = new Map(); this.pending = [];
    this.gaussAt = 0; this.gaussUsed = false; this.byGauss = 0;
  }
  get complete() { return this.K > 0 && this.decoded === this.K; }

  // 'new' | 'dup' | 'done' | 'other'
  add(sym) {
    if (this.tid !== null && sym.tid !== this.tid) this.reset();     // ny overføring
    if (this.tid === null) {
      this.tid = sym.tid; this.K = sym.K; this.B = sym.B; this.streamLen = sym.streamLen;
      this.blocks = new Array(sym.K).fill(null);
      this.status = new Uint8Array(sym.K);
    } else if (sym.K !== this.K || sym.B !== this.B || sym.streamLen !== this.streamLen) return 'other';
    if (this.complete) return 'done';
    if (this.seen.has(sym.seed)) { this.dups++; return 'dup'; }
    this.seen.add(sym.seed);
    this.symbols++;
    const all = neighbors(this.K, sym.seed);
    const data = new Uint8Array(pad4(this.B));
    data.set(sym.payload);
    const nb = new Set();
    for (const j of all) { if (this.blocks[j]) xorInto(data, this.blocks[j]); else nb.add(j); }
    if (nb.size === 1) this._solve([...nb][0], data, all.length === 1 ? 1 : 2);
    else if (nb.size > 1) {
      const ref = { nb, data, done: false };
      this.pending.push(ref);
      for (const j of nb) { if (!this.waiters.has(j)) this.waiters.set(j, []); this.waiters.get(j).push(ref); }
    }
    if (!this.complete) this._maybeGauss();
    return 'new';
  }

  // Kjedereaksjonen: en kjent blokk trekkes ut av alle koder som venter på den.
  _solve(j, data, how) {
    this.blocks[j] = data; this.status[j] = how; this.decoded++;
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
          ref.done = true;
          if (!this.blocks[k]) { this.blocks[k] = ref.data; this.status[k] = 2; this.decoded++; queue.push(k); }
        } else if (ref.nb.size === 0) ref.done = true;
      }
    }
  }

  // Når kjedereaksjonen står stille og minst K koder er samlet: løs resten som ligningssett.
  _maybeGauss() {
    const U = this.K - this.decoded;
    if (this.symbols < this.K || this.symbols - this.gaussAt < Math.max(1, U >> 5)) return;
    this.gaussAt = this.symbols;
    this.pending = this.pending.filter((r) => !r.done);
    const rows = this.pending, R = rows.length;
    if (R < U) return;
    const col = new Int32Array(this.K).fill(-1), unk = [];
    for (let i = 0; i < this.K; i++) if (!this.blocks[i]) { col[i] = unk.length; unk.push(i); }
    const W = (U + 31) >>> 5, WR = (R + 31) >>> 5;
    // Hver rad: [koeffisienter over ukjente | hvilke opprinnelige rader som er XOR-et inn]
    const M = rows.map((r, ri) => {
      const w = new Uint32Array(W + WR);
      for (const j of r.nb) { const c = col[j]; w[c >>> 5] |= 1 << (c & 31); }
      w[W + (ri >>> 5)] |= 1 << (ri & 31);
      return w;
    });
    const pivotRow = new Int32Array(U).fill(-1);
    let rank = 0;
    for (let c = 0; c < U; c++) {
      const wi = c >>> 5, bit = 1 << (c & 31);
      let p = -1;
      for (let r = rank; r < R; r++) if (M[r][wi] & bit) { p = r; break; }
      if (p < 0) return;                                   // ikke nok uavhengige koder ennå
      [M[rank], M[p]] = [M[p], M[rank]];
      const pr = M[rank];
      for (let r = 0; r < R; r++) {
        if (r === rank || !(M[r][wi] & bit)) continue;
        const row = M[r];
        for (let k = wi; k < W + WR; k++) row[k] ^= pr[k];
      }
      pivotRow[c] = rank++;
    }
    for (let c = 0; c < U; c++) {
      const w = M[pivotRow[c]], data = new Uint8Array(pad4(this.B));
      for (let k = 0; k < WR; k++) {
        let x = w[W + k];
        while (x) { const b = 31 - Math.clz32(x & -x); x &= x - 1; xorInto(data, rows[k * 32 + b].data); }
      }
      this.blocks[unk[c]] = data; this.status[unk[c]] = 2;
    }
    this.byGauss = U; this.gaussUsed = true;
    this.decoded = this.K;
    this.pending = []; this.waiters = new Map();
  }

  assemble() {
    const out = new Uint8Array(this.K * this.B);
    this.blocks.forEach((b, i) => out.set(b.subarray(0, this.B), i * this.B));
    return parseStreamBytes(out.subarray(0, this.streamLen));
  }
}
