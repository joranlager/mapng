// Reed-Solomon over GF(256) for fargerutenettet.
//
// Et bilde på `cap` byte deles i kodeord på inntil 255 byte. Hvert kodeord har NSYM
// paritetsbyte og tåler NSYM/2 feilleste byte. Bytene flettes mellom kodeordene, så en
// skadet flekk i bildet fordeles på flere kodeord.

export const NSYM = 32;

const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const div = (a, b) => (a ? EXP[(LOG[a] + 255 - LOG[b]) % 255] : 0);

// Generatorpolynom (høyeste grad først) med røtter a^0 … a^(NSYM-1).
const GEN = (() => {
  let g = [1];
  for (let i = 0; i < NSYM; i++) {
    const n = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { n[j] ^= g[j]; n[j + 1] ^= mul(g[j], EXP[i]); }
    g = n;
  }
  return g;
})();

export function rsEncode(msg) {
  const out = new Uint8Array(msg.length + NSYM);
  out.set(msg);
  for (let i = 0; i < msg.length; i++) {
    const coef = out[i];
    if (coef) for (let j = 1; j < GEN.length; j++) out[i + j] ^= mul(GEN[j], coef);
  }
  out.set(msg);
  return out;
}

function syndromes(cw) {
  const s = new Uint8Array(NSYM);
  let any = 0;
  for (let j = 0; j < NSYM; j++) {
    let v = 0;
    const a = EXP[j];
    for (let i = 0; i < cw.length; i++) v = mul(v, a) ^ cw[i];
    s[j] = v; any |= v;
  }
  return any ? s : null;
}

// Retter kodeordet på stedet. Returnerer antall rettede byte, eller -1 hvis det ikke lar seg rette.
export function rsCorrect(cw) {
  const s = syndromes(cw);
  if (!s) return 0;
  const n = cw.length;
  // Berlekamp-Massey: feilposisjonspolynomet C (laveste grad først).
  let C = [1], B = [1], L = 0, m = 1, b = 1;
  for (let k = 0; k < NSYM; k++) {
    let d = s[k];
    for (let i = 1; i <= L; i++) d ^= mul(C[i] || 0, s[k - i]);
    if (d === 0) { m++; continue; }
    const T = C.slice(), coef = div(d, b);
    while (C.length < B.length + m) C.push(0);
    for (let i = 0; i < B.length; i++) C[i + m] ^= mul(coef, B[i]);
    if (2 * L <= k) { L = k + 1 - L; B = T; b = d; m = 1; } else m++;
  }
  if (L === 0 || 2 * L > NSYM) return -1;
  // Chien-søk: posisjoner der C(X^-1) = 0, med X = a^(n-1-idx).
  const pos = [], X = [];
  for (let idx = 0; idx < n; idx++) {
    const p = (n - 1 - idx) % 255, xi = EXP[(255 - p) % 255];
    let v = 0;
    for (let i = L; i >= 0; i--) v = mul(v, xi) ^ (C[i] || 0);
    if (v === 0) { pos.push(idx); X.push(EXP[p]); }
  }
  if (pos.length !== L) return -1;
  // Feilverdiene: løs S_j = sum e_k X_k^j (Vandermonde, Gauss).
  const M = [];
  for (let j = 0; j < L; j++) {
    const row = new Uint8Array(L + 1);
    for (let k = 0; k < L; k++) row[k] = j === 0 ? 1 : EXP[(LOG[X[k]] * j) % 255];
    row[L] = s[j];
    M.push(row);
  }
  for (let c = 0; c < L; c++) {
    let p = c;
    while (p < L && M[p][c] === 0) p++;
    if (p === L) return -1;
    [M[c], M[p]] = [M[p], M[c]];
    const inv = div(1, M[c][c]);
    for (let k = c; k <= L; k++) M[c][k] = mul(M[c][k], inv);
    for (let r = 0; r < L; r++) {
      if (r === c || M[r][c] === 0) continue;
      const f = M[r][c];
      for (let k = c; k <= L; k++) M[r][k] ^= mul(f, M[c][k]);
    }
  }
  for (let k = 0; k < L; k++) cw[pos[k]] ^= M[k][L];
  return syndromes(cw) ? -1 : L;
}

// ---------------------------------------------------------------- bilde
function layout(cap) {
  const nCw = Math.ceil(cap / 255);
  const base = Math.floor(cap / nCw), extra = cap % nCw;
  const lens = Array.from({ length: nCw }, (_, i) => base + (i < extra ? 1 : 0));
  return { nCw, lens, maxLen: base + (extra ? 1 : 0) };
}

// Hvor mange byte data et bilde på `cap` byte rommer etter paritet. 0 hvis for lite.
export function frameDataCapacity(cap) {
  const { nCw, lens } = layout(cap);
  if (lens[lens.length - 1] <= NSYM + 8) return 0;
  return cap - nCw * NSYM;
}

export function rsEncodeFrame(data, cap) {
  const { nCw, lens, maxLen } = layout(cap);
  const cws = [];
  let o = 0;
  for (let c = 0; c < nCw; c++) {
    const k = lens[c] - NSYM;
    const msg = new Uint8Array(k);
    msg.set(data.subarray(o, o + k));
    o += k;
    cws.push(rsEncode(msg));
  }
  const out = new Uint8Array(cap);
  let p = 0;
  for (let i = 0; i < maxLen; i++) for (let c = 0; c < nCw; c++) if (i < lens[c]) out[p++] = cws[c][i];
  return out;
}

// Returnerer { data, fixed } eller null hvis et kodeord ikke lar seg rette.
export function rsDecodeFrame(frame, cap) {
  const { nCw, lens, maxLen } = layout(cap);
  const cws = lens.map((n) => new Uint8Array(n));
  let p = 0;
  for (let i = 0; i < maxLen; i++) for (let c = 0; c < nCw; c++) if (i < lens[c]) cws[c][i] = frame[p++];
  const data = new Uint8Array(cap - nCw * NSYM);
  let o = 0, fixed = 0;
  for (let c = 0; c < nCw; c++) {
    const r = rsCorrect(cws[c]);
    if (r < 0) return null;
    fixed += r;
    const k = lens[c] - NSYM;
    data.set(cws[c].subarray(0, k), o);
    o += k;
  }
  return { data, fixed };
}
