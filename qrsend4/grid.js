// Fargerutenett: en svart ramme, en paletteremse som kalibrerer fargene i hvert bilde,
// og G×G datceller. Hver celle bærer 2 bit (4 farger) eller 3 bit (8 farger).
//
//   rad 0           svart ramme
//   rad 1           paletteremse (farge k = (kolonne-1) mod P)
//   rad 2 … G+1     datceller
//   rad G+2         svart ramme
//   kolonne 0 og G+1 svart ramme
//
// Mottakeren finner rammen, leser fargene i paletteremsen og klassifiserer hver
// datacelle etter nærmeste referansefarge. Symbolets CRC avgjør om avlesingen er riktig.

export const PALETTE4 = [[0, 0, 0], [255, 255, 255], [230, 30, 30], [30, 80, 230]];
export const PALETTE8 = [...PALETTE4, [30, 170, 60], [250, 210, 20], [220, 40, 200], [30, 200, 210]];
export const palette = (P) => (P === 8 ? PALETTE8 : PALETTE4);
export const bitsPer = (P) => (P === 8 ? 3 : 2);
export const gridCapacity = (G, P) => Math.floor((G * G * bitsPer(P)) / 8);
const dims = (G) => ({ C: G + 2, R: G + 3 });

function cellsFromBytes(bytes, G, P) {
  const bpc = bitsPer(P), out = new Uint8Array(G * G);
  let bit = 0;
  for (let k = 0; k < G * G; k++) {
    let v = 0;
    for (let b = 0; b < bpc; b++, bit++) v = (v << 1) | (((bytes[bit >> 3] ?? 0) >> (7 - (bit & 7))) & 1);
    out[k] = v;
  }
  return out;
}

function bytesFromCells(cells, G, P) {
  const bpc = bitsPer(P), out = new Uint8Array(gridCapacity(G, P));
  let bit = 0;
  for (let k = 0; k < G * G; k++) {
    const v = cells[k];
    for (let b = bpc - 1; b >= 0; b--, bit++) if ((v >> b) & 1) out[bit >> 3] |= 1 << (7 - (bit & 7));
  }
  return out;
}

// Tegner rutenettet i området (x0,y0,W,H) på et lerret/kontekst. Bruker hele arealet.
export function renderGrid(ctx, x0, y0, W, H, bytes, G, P) {
  const { C, R } = dims(G);
  ctx.fillStyle = '#fff';
  ctx.fillRect(x0, y0, W, H);
  const s = Math.floor(Math.min(W / C, H / R));
  if (s < 1) return;
  const ox = x0 + Math.floor((W - C * s) / 2), oy = y0 + Math.floor((H - R * s) / 2);
  const pal = palette(P).map(([r, g, b]) => `rgb(${r},${g},${b})`);
  ctx.fillStyle = '#000';
  ctx.fillRect(ox, oy, C * s, s);
  ctx.fillRect(ox, oy + (R - 1) * s, C * s, s);
  ctx.fillRect(ox, oy, s, R * s);
  ctx.fillRect(ox + (C - 1) * s, oy, s, R * s);
  for (let c = 1; c <= G; c++) {
    ctx.fillStyle = pal[(c - 1) % P];
    ctx.fillRect(ox + c * s, oy + s, s, s);
  }
  const cells = cellsFromBytes(bytes, G, P);
  for (let r = 0; r < G; r++) {
    for (let c = 0; c < G; c++) {
      ctx.fillStyle = pal[cells[r * G + c]];
      ctx.fillRect(ox + (c + 1) * s, oy + (r + 2) * s, s, s);
    }
  }
  return { cell: s, x: ox, y: oy };
}

// Løser 8×8-systemet med delvis pivotering (Gauss).
function solve8(A, b) {
  const n = 8, M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let p = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[p][col])) p = r;
    [M[col], M[p]] = [M[p], M[col]];
    if (Math.abs(M[col][col]) < 1e-12) return null;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// Homografi fra rutenettkoordinater (u,v) til bildepiksler (x,y), gitt fire punktpar.
function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = src[i], [x, y] = dst[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
  }
  const h = solve8(A, b);
  if (!h) return null;
  return (u, v) => {
    const d = h[6] * u + h[7] * v + 1;
    return [(h[0] * u + h[1] * v + h[2]) / d, (h[3] * u + h[4] * v + h[5]) / d];
  };
}

// Leser et bilde (ImageData). Returnerer { found, bytes }:
// found = true når rammen er funnet, bytes = null hvis kalibreringen eller lengden er feil.
// Tåler rotasjon og perspektiv: rammens fire hjørner gir en homografi til rutenettet.
export function decodeGrid(img, G, P) {
  const { width: w, height: h, data } = img;
  const { C, R } = dims(G);
  const lum = (o) => (data[o] * 299 + data[o + 1] * 587 + data[o + 2] * 114) / 1000;
  const NONE = { found: false, bytes: null };

  // 1) Skjermen: området med mye lys bakgrunn (grov, steg 3).
  const colB = new Uint32Array(w), rowB = new Uint32Array(h);
  for (let y = 0; y < h; y += 3) {
    for (let x = 0; x < w; x += 3) {
      if (lum((y * w + x) * 4) > 170) { colB[x]++; rowB[y]++; }
    }
  }
  const bounds = (arr, n, thr) => {
    let lo = -1, hi = -1;
    for (let i = 0; i < n; i++) if (arr[i] >= thr) { if (lo < 0) lo = i; hi = i; }
    return [lo, hi];
  };
  const [rx0, rx1] = bounds(colB, w, 0.3 * Math.max(0, ...colB));
  const [ry0, ry1] = bounds(rowB, h, 0.3 * Math.max(0, ...rowB));
  if (rx0 < 0 || ry0 < 0) return NONE;

  // 2) Skjermflatens hjørner (lyse piksler), så vi bare ser etter rammen innenfor skjermen.
  const extremes = () => ({ tl: null, tr: null, br: null, bl: null, minS: Infinity, maxS: -Infinity, minD: Infinity, maxD: -Infinity });
  const ext = extremes();
  const track = (e, x, y) => {
    const s = x + y, d = x - y;
    if (s < e.minS) { e.minS = s; e.tl = [x, y]; }
    if (s > e.maxS) { e.maxS = s; e.br = [x, y]; }
    if (d < e.minD) { e.minD = d; e.bl = [x, y]; }
    if (d > e.maxD) { e.maxD = d; e.tr = [x, y]; }
  };
  for (let y = ry0; y <= ry1; y += 2) {
    for (let x = rx0; x <= rx1; x += 2) if (lum((y * w + x) * 4) > 170) track(ext, x, y);
  }
  if (!ext.tl || !ext.tr || !ext.br || !ext.bl) return NONE;
  const screen = [ext.tl, ext.tr, ext.br, ext.bl];
  // Punkt p er inne i skjermfirkanten hvis det er på samme side av alle fire kanter.
  const inside = (p) => {
    let pos = 0, neg = 0;
    for (let i = 0; i < 4; i++) {
      const a = screen[i], b = screen[(i + 1) % 4];
      const cr = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
      if (cr > 0) pos++; else if (cr < 0) neg++;
    }
    return pos === 0 || neg === 0;
  };

  // 3) Hjørnene på den svarte rammen: ytterpunktene langs x+y og x-y, innenfor skjermen.
  const bor = extremes();
  let dark = 0;
  for (let y = ry0; y <= ry1; y++) {
    for (let x = rx0; x <= rx1; x++) {
      if (lum((y * w + x) * 4) >= 90) continue;
      if (!inside([x, y])) continue;
      dark++;
      track(bor, x, y);
    }
  }
  const { tl, tr, br, bl } = bor;
  if (!tl || !tr || !br || !bl || dark < 4 * (C + R)) return NONE;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const top = dist(tl, tr), bottom = dist(bl, br), left = dist(tl, bl), right = dist(tr, br);
  const cw = (top + bottom) / 2 / C, ch = (left + right) / 2 / R;
  if (cw < 2 || ch < 2) return NONE;
  if (Math.min(top, bottom) / Math.max(top, bottom) < 0.6) return NONE;
  if (Math.min(left, right) / Math.max(left, right) < 0.6) return NONE;
  if (Math.abs(cw - ch) / cw > 0.3) return NONE;

  const map = homography([[0, 0], [C, 0], [C, R], [0, R]], [tl, tr, br, bl]);
  if (!map) return NONE;

  // 4) Prøv hver celle: gjennomsnitt av midten.
  const rad = Math.min(cw, ch) >= 7 ? 1 : 0;
  const sample = (c, r) => {
    const [px, py] = map(c + 0.5, r + 0.5);
    const cx = Math.round(px), cy = Math.round(py);
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const o = (y * w + x) * 4;
        sr += data[o]; sg += data[o + 1]; sb += data[o + 2]; n++;
      }
    }
    return n ? [sr / n, sg / n, sb / n] : [0, 0, 0];
  };

  // 5) Referansefarger fra paletteremsen (kalibrerer lys og hvitbalanse for dette bildet).
  const acc = Array.from({ length: P }, () => [0, 0, 0, 0]);
  for (let c = 1; c <= G; c++) {
    const [r, g, b] = sample(c, 1);
    const a = acc[(c - 1) % P];
    a[0] += r; a[1] += g; a[2] += b; a[3]++;
  }
  if (acc.some((a) => a[3] === 0)) return { found: true, bytes: null };
  const refs = acc.map((a) => [a[0] / a[3], a[1] / a[3], a[2] / a[3]]);

  // 6) Klassifiser datacellene.
  const cells = new Uint8Array(G * G);
  for (let r = 2; r <= G + 1; r++) {
    for (let c = 1; c <= G; c++) {
      const [sr, sg, sb] = sample(c, r);
      let best = 0, bd = Infinity;
      for (let k = 0; k < P; k++) {
        const d = (sr - refs[k][0]) ** 2 + (sg - refs[k][1]) ** 2 + (sb - refs[k][2]) ** 2;
        if (d < bd) { bd = d; best = k; }
      }
      cells[(r - 2) * G + (c - 1)] = best;
    }
  }
  return { found: true, bytes: bytesFromCells(cells, G, P) };
}
