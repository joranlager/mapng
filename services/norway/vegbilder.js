// Building facade colours from Statens vegvesen's Vegbilder (street-level 360° images) for map areas in
// Norway.
//
// Vegbilder is a national set of images taken along the state roads: forward-looking pictures, and full
// 360° pictures (equirectangular, 12288 x 6144 px, the picture's middle the direction of travel). Where a
// 360° picture was taken beside a building, the real wall is in it, and its colour can be read: the
// position, the heading, the building's outline and its height say where in the picture each wall is.
//
//   1. fetchVegbilder360: the images in the map box, from the WFS (position, heading, year, road).
//   2. planViews: for every wall of every building the images that see it from outside (not from behind,
//      not too slanting, not too far, nothing in between but trees), the best few per building, and no more
//      images in all than MAX_IMAGES (each is 4.5 MB).
//   3. each chosen image downloaded (by its id, through Vegbilder's own proxy: the links in the WFS answer
//      carry tokens that run out after ten hours, the proxy's do not, so the desktop app's download cache
//      keeps them for good), decoded at half size, and every wall read: wallColour.
//   4. applyVegbilder360: the buildings get building:colour (unless OSM gives one), from their walls.
//
// Source: Statens vegvesen, Vegbilder. The images are anonymised by Statens vegvesen (faces, number plates).
export const VEGBILDER_WFS = 'https://www.vegvesen.no/kart/ogc/vegbilder_1_0/ows';
export const VEGBILDER_PROXY = 'https://vegbilder-proxy.atlas.vegvesen.no/proxy';
export const VEGBILDER_ATTRIBUTION = 'Statens vegvesen, Vegbilder';
export const NORWAY_VEGBILDER_STORAGE_KEY = 'mapng_norwayVegbilder';
export const VEGBILDER_360_YEARS = [2026, 2025, 2024, 2023, 2022, 2021];

export const MAX_IMAGES = 120;         // 360° images used for one map (4.5 MB each)
const CAMERA_HEIGHT_M = 2.8;           // the 360° camera over the road
const MAX_DIST_M = 65;
const MIN_DIST_M = 5;
const MIN_COS = 0.3;                   // the wall seen at no more than about 72 degrees off straight on
const MIN_WALL_M = 3;
const VIEWS_PER_BUILDING = 4;
const WORK_WIDTH = 6144;               // the picture is read at half its width
const BAND = [0.4, 0.95];              // the part of a wall's height read: the upper floors (hedges, fences, cars and shop fronts hide the lower ones)
const MIN_SAMPLES = 24;
const MIN_LUMA = 0.17;
const MIN_SHARE = 0.3;                 // of the wall's points in the picture, the share that must be wall

/** On unless switched off in settings (localStorage mapng_norwayVegbilder = "0"). */
export function norwayVegbilderEnabled(storage = globalThis.localStorage) {
  try { return storage?.getItem(NORWAY_VEGBILDER_STORAGE_KEY) !== '0'; } catch { return true; }
}

export const proxyUrl = (id) => `${VEGBILDER_PROXY}?id=${encodeURIComponent(id)}`;

// ---- the image records ---------------------------------------------------------------------------

/**
 * The 360° images in the box: [{ id, year, time, lat, lon, heading, road, lane }]. One WFS request per year
 * layer; a year the service has no layer for, or that fails, is left out (all failing throws).
 */
export async function fetchVegbilder360(bounds, { fetchImpl = globalThis.fetch, signal, years = VEGBILDER_360_YEARS, count = 4000 } = {}) {
  const out = [];
  let failed = 0;
  await Promise.all(years.map(async (year) => {
    const params = new URLSearchParams({
      service: 'WFS', version: '2.0.0', request: 'GetFeature', typeNames: `vegbilder_1_0:Vegbilder_360_${year}`,
      outputFormat: 'application/json', srsName: 'urn:ogc:def:crs:EPSG::4326', count: String(count),
      bbox: `${bounds.south},${bounds.west},${bounds.north},${bounds.east},urn:ogc:def:crs:EPSG::4326`,
    });
    try {
      const res = await fetchImpl(`${VEGBILDER_WFS}?${params}`, { signal, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`Vegbilder answered ${res.status} for ${year}`);
      const body = await res.json();
      for (const f of body?.features || []) {
        const p = f.properties || {};
        const [lon, lat] = f.geometry?.coordinates || [];
        if (!f.id || !Number.isFinite(lat) || !Number.isFinite(lon) || p.RETNING == null || !Number.isFinite(Number(p.RETNING))) continue;
        out.push({
          id: f.id, year, time: String(p.TIDSPUNKT || ''), lat, lon, heading: Number(p.RETNING),
          road: `${p.VEGKATEGORI || ''}${p.VEGNUMMER || ''}`, lane: String(p.FELTKODE || ''),
        });
      }
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) throw error;
      failed++;
    }
  }));
  if (failed === years.length) throw new Error('Vegbilder did not answer');
  return out;
}

// ---- geometry --------------------------------------------------------------------------------------

const projectorFor = (bounds) => {
  const lat0 = (bounds.north + bounds.south) / 2, lon0 = (bounds.east + bounds.west) / 2;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110540;
  return (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky];
};

/** Twice the signed area of a ring [[x, y]] (positive: counter-clockwise, east/north). */
const area2 = (ring) => { let a = 0; for (let i = 0; i < ring.length; i++) { const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length]; a += x0 * y1 - x1 * y0; } return a; };

/** The walls of a ring: [{ ax, ay, bx, by, len, nx, ny }] with the outward normal (nx, ny). */
export function wallsOf(ring) {
  const out = [];
  const ccw = area2(ring) > 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 0.2) continue;
    const dx = (bx - ax) / len, dy = (by - ay) / len;
    out.push({ ax, ay, bx, by, len, nx: ccw ? dy : -dy, ny: ccw ? -dx : dx });
  }
  return out;
}

const segCross = (ax, ay, bx, by, cx, cy, dx, dy) => {
  const r = [bx - ax, by - ay], s = [dx - cx, dy - cy];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return false;
  const t = ((cx - ax) * s[1] - (cy - ay) * s[0]) / den, u = ((cx - ax) * r[1] - (cy - ay) * r[0]) / den;
  return t > 0.001 && t < 0.999 && u >= 0 && u <= 1;
};

/** A grid of every building wall, for line-of-sight checks: blocked(ax, ay, bx, by, exceptId). */
function sightGrid(buildings) {
  const CELL = 30;
  const cells = new Map();
  for (const b of buildings) {
    for (const w of b.walls) {
      const x0 = Math.floor(Math.min(w.ax, w.bx) / CELL), x1 = Math.floor(Math.max(w.ax, w.bx) / CELL);
      const y0 = Math.floor(Math.min(w.ay, w.by) / CELL), y1 = Math.floor(Math.max(w.ay, w.by) / CELL);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const k = `${x},${y}`; if (!cells.has(k)) cells.set(k, []); cells.get(k).push({ w, id: b.id }); }
    }
  }
  return (ax, ay, bx, by, exceptId) => {
    const x0 = Math.floor(Math.min(ax, bx) / CELL), x1 = Math.floor(Math.max(ax, bx) / CELL);
    const y0 = Math.floor(Math.min(ay, by) / CELL), y1 = Math.floor(Math.max(ay, by) / CELL);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      for (const { w, id } of cells.get(`${x},${y}`) || []) if (id !== exceptId && segCross(ax, ay, bx, by, w.ax, w.ay, w.bx, w.by)) return true;
    }
    return false;
  };
}

/**
 * Which images see which walls. buildings: [{ id, ring: [[x, y]], base, height }]; images: [{ id, x, y, heading, year }]
 * (metres). Returns { views: Map(imageId -> [{ building, wall: index, score }]), images: n }: every building's
 * best VIEWS_PER_BUILDING views (a wall seen from outside, near enough, not behind another building), and
 * only the maxImages images that carry the most.
 */
export function planViews(buildings, images, { maxImages = MAX_IMAGES, maxDist = MAX_DIST_M } = {}) {
  const list = buildings.map((b) => ({ ...b, walls: wallsOf(b.ring) }));
  const blocked = sightGrid(list);
  const CELL = 40;
  const grid = new Map();
  images.forEach((im, i) => { const k = `${Math.floor(im.x / CELL)},${Math.floor(im.y / CELL)}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
  const newest = Math.max(0, ...images.map((im) => im.year));
  const chosen = [];       // per building: [{ image, wall, score }]
  for (const b of list) {
    const cands = [];
    b.walls.forEach((w, wi) => {
      if (w.len < MIN_WALL_M) return;
      const mx = (w.ax + w.bx) / 2, my = (w.ay + w.by) / 2;
      const gx = Math.floor(mx / CELL), gy = Math.floor(my / CELL);
      for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
        for (const ii of grid.get(`${gx + i},${gy + j}`) || []) {
          const im = images[ii];
          const vx = im.x - mx, vy = im.y - my, d = Math.hypot(vx, vy);
          if (d < MIN_DIST_M || d > maxDist) continue;
          const cos = (vx * w.nx + vy * w.ny) / d;
          if (cos < MIN_COS) continue;
          if (blocked(im.x, im.y, mx + w.nx * 0.05, my + w.ny * 0.05, b.id)) continue;
          // (a long wall seen square on at moderate range scores most; newer pictures a little more)
          const score = cos * Math.min(1, w.len / 15) / (1 + d / 25) * (1 - 0.04 * (newest - im.year));
          cands.push({ image: ii, wall: wi, score });
        }
      }
    });
    cands.sort((p, q) => q.score - p.score);
    const picked = [];
    const perImage = new Set();
    for (const c of cands) {
      if (picked.length >= VIEWS_PER_BUILDING) break;
      const key = `${c.image}`;
      // (a second wall from an image already used for this building: allowed; the same wall twice: not)
      if (picked.some((p) => p.image === c.image && p.wall === c.wall)) continue;
      if (perImage.has(key) && picked.length < 2) { picked.push(c); continue; }
      perImage.add(key);
      picked.push(c);
    }
    chosen.push({ building: b.id, picked });
  }
  // the images that carry the most; the rest dropped
  const weight = new Map();
  for (const { picked } of chosen) for (const p of picked) weight.set(p.image, (weight.get(p.image) || 0) + p.score);
  const keep = new Set([...weight].sort((p, q) => q[1] - p[1]).slice(0, maxImages).map(([i]) => i));
  const views = new Map();
  for (const { building, picked } of chosen) {
    for (const p of picked) {
      if (!keep.has(p.image)) continue;
      const id = images[p.image].id;
      if (!views.has(id)) views.set(id, []);
      views.get(id).push({ building, wall: p.wall, score: p.score });
    }
  }
  return { views, images: views.size };
}

// ---- reading a wall out of an equirectangular picture -------------------------------------------------

/** The picture's pixel of a point: (x, y, z) relative to the camera, heading in degrees clockwise from north. */
export function equirectPixel(dx, dy, dz, heading, W, H) {
  let yaw = Math.atan2(dx, dy) - (heading * Math.PI) / 180;
  yaw = ((yaw + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
  const pitch = Math.atan2(dz, Math.hypot(dx, dy));
  return [(yaw / (2 * Math.PI) + 0.5) * W, (0.5 - pitch / Math.PI) * H, pitch];
}

const isSky = (r, g, b, pitch) => pitch > 0.12 && r + g + b > 450 && Math.max(r, g, b) - Math.min(r, g, b) < 45 && b >= r - 6;
// Leaves and hedges, green or olive in any light: a hue between yellow-green and blue-green with some colour
// in it. Walls are grey, white, beige, yellow, red or brown (hues below 55 degrees) and are left alone.
function isGreen(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (max < 24 || d < 0.06 * max) return false;
  let hue;
  if (max === r) hue = ((g - b) / d + 6) % 6; else if (max === g) hue = 2 + (b - r) / d; else hue = 4 + (r - g) / d;
  hue *= 60;
  if (hue >= 58 && hue <= 185) return true;
  // foliage in shade is dark and olive, brownish or yellowish: no wall in the picture is that dark with such a hue
  return max < 105 && hue >= 36 && hue < 58 && d > 0.2 * max;
}
const median = (v) => { const s = Float64Array.from(v).sort(); return s[s.length >> 1]; };

const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
const AGREE = 60;                      // views whose colours lie this far apart (of 441) do not agree

/**
 * One colour from what the views of a building read ([{ rgb, weight }]): the view the others agree with
 * most is the centre, views far from it (a tree in front of the wall in one picture, a lit wall in another)
 * are dropped and the rest averaged by weight. One view alone is kept only when it is strong (weight).
 */
export function agreeingColour(list) {
  if (!list.length) return null;
  if (list.length === 1) return list[0].weight >= 0.08 ? list[0].rgb : null;
  let centre = list[0], best = Infinity;
  for (const p of list) {
    const cost = list.reduce((s, q) => s + q.weight * Math.min(dist(p.rgb, q.rgb), 2 * AGREE), 0);
    if (cost < best) { best = cost; centre = p; }
  }
  const near = list.filter((p) => dist(p.rgb, centre.rgb) <= AGREE);
  const total = near.reduce((s, p) => s + p.weight, 0) || 1;
  return [0, 1, 2].map((k) => Math.round(near.reduce((s, p) => s + p.rgb[k] * p.weight, 0) / total));
}

/** A colour with its lightness held in a range walls really have (the pictures are taken in any light). */
export function plausibleWall([r, g, b]) {
  const y = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const k = y > 0 ? Math.min(0.9, Math.max(0.3, y)) / y : 1;
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return [c(r), c(g), c(b)];
}

export const hex = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/**
 * The colour of one wall as one picture has it: { rgb, share, samples } or null. pix: { width, height, data
 * (RGBA) }; cam: { x, y, z, heading } (metres); wall: { ax, ay, bx, by }; z0, z1: the wall's bottom and top.
 * Points of sky, green (trees, hedges) and the picture's black are left out; the colour is the median of the
 * rest, and null when too little of the wall is seen as wall.
 */
export function wallColour(pix, cam, wall, z0, z1) {
  const { width: W, height: H, data } = pix;
  const cols = Math.max(8, Math.min(60, Math.round(Math.hypot(wall.bx - wall.ax, wall.by - wall.ay) / 0.6)));
  const rows = 12;
  const R = [], G = [], B = [];
  let inside = 0;
  for (let i = 0; i < cols; i++) {
    const s = (i + 0.5) / cols;
    const px = wall.ax + (wall.bx - wall.ax) * s, py = wall.ay + (wall.by - wall.ay) * s;
    for (let j = 0; j < rows; j++) {
      const z = z0 + (z1 - z0) * (BAND[0] + ((BAND[1] - BAND[0]) * (j + 0.5)) / rows);
      const [u, v, pitch] = equirectPixel(px - cam.x, py - cam.y, z - cam.z, cam.heading, W, H);
      const x = Math.floor(u), y = Math.floor(v);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const o = (y * W + x) * 4;
      const r = data[o], g = data[o + 1], b = data[o + 2];
      if (r + g + b < 40) continue;                      // (the black under the picture, deep shadow)
      inside++;
      if (isSky(r, g, b, pitch) || isGreen(r, g, b)) continue;
      R.push(r); G.push(g); B.push(b);
    }
  }
  if (R.length < MIN_SAMPLES || R.length < MIN_SHARE * inside) return null;
  const rgb = [median(R), median(G), median(B)];
  // (as dark as a tree in shade, or as the shadow of an overhang: not a wall's colour, whatever the light)
  if ((0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 < MIN_LUMA) return null;
  return { rgb, share: R.length / Math.max(1, inside), samples: R.length };
}

// ---- the whole step ------------------------------------------------------------------------------------

/** Pixels of a picture as { width, height, data }, at most maxWidth across: through a canvas (the browser's or the desktop runner's). */
export async function decodeImage(bytes, maxWidth = WORK_WIDTH) {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  const w = Math.min(maxWidth, bitmap.width), h = Math.round((bitmap.height * w) / bitmap.width);
  const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const g = canvas.getContext('2d');
  g.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const image = g.getImageData(0, 0, w, h);
  return { width: w, height: h, data: image.data };
}

const parseM = (v) => { const n = Number.parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : NaN; };

/**
 * Wall colours onto the map's buildings. features: the map's features (type 'building', geometry [{ lat, lng }],
 * tags). groundAt(lat, lng) -> metres (optional: the ground under a wall and under the camera; without it the
 * camera is taken level with the wall's foot). Returns { features, stats: { buildings, coloured, images, records,
 * downloaded } }; features that gain a colour are new objects, the input is not mutated.
 * opts: { signal, onProgress, fetchImpl, records (the image list, for tests), decode, maxImages }
 */
export async function applyVegbilder360(features, bounds, opts = {}) {
  const { signal, onProgress, fetchImpl = globalThis.fetch, decode = decodeImage, maxImages = MAX_IMAGES, groundAt = null } = opts;
  const stats = { buildings: 0, coloured: 0, images: 0, records: 0, downloaded: 0 };
  const project = projectorFor(bounds);
  const targets = [];
  (features || []).forEach((f, index) => {
    if (f?.type !== 'building' || !(f.geometry?.length >= 3) || f.tags?.['building:part']) return;
    if (String(f.tags?.['building:colour'] || f.tags?.['building:color'] || '').trim()) return;
    const ring = f.geometry.map((p) => project(p.lat, p.lng ?? p.lon));
    const c = ring.reduce((s, p) => [s[0] + p[0] / ring.length, s[1] + p[1] / ring.length], [0, 0]);
    const height = parseM(f.tags?.height) || (Number.parseFloat(f.tags?.['building:levels']) || 2) * 3.1;
    targets.push({ id: index, ring, base: groundAt ? groundAt(f.geometry[0].lat, f.geometry[0].lng ?? f.geometry[0].lon) : 0, height, centre: c });
  });
  stats.buildings = targets.length;
  if (!targets.length) return { features, stats };

  onProgress?.('Looking for Vegbilder 360° images beside the buildings...');
  const records = opts.records ?? await fetchVegbilder360(bounds, { fetchImpl, signal });
  stats.records = records.length;
  if (!records.length) return { features, stats };
  const images = records.map((r) => ({ ...r, ...(() => { const [x, y] = project(r.lat, r.lon); return { x, y }; })() }));
  const { views } = planViews(targets, images, { maxImages });
  stats.images = views.size;
  if (!views.size) return { features, stats };

  const byId = new Map(images.map((im) => [im.id, im]));
  const targetById = new Map(targets.map((t) => [t.id, t]));
  const found = new Map();      // building -> [{ rgb, weight }]
  let done = 0;
  for (const [imageId, list] of views) {
    signal?.throwIfAborted?.();
    onProgress?.(`Reading building colours from Vegbilder (${++done}/${views.size})...`);
    const im = byId.get(imageId);
    let pix = null;
    try {
      const res = await fetchImpl(proxyUrl(imageId), { signal });
      if (!res.ok) continue;
      stats.downloaded++;
      pix = await decode(new Uint8Array(await res.arrayBuffer()));
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) throw error;
      continue;
    }
    const camGround = groundAt ? groundAt(im.lat, im.lon) : null;
    for (const v of list) {
      const t = targetById.get(v.building);
      const wall = wallsOf(t.ring)[v.wall];
      if (!wall) continue;
      const base = t.base;
      const cam = { x: im.x, y: im.y, z: (camGround ?? base) + CAMERA_HEIGHT_M, heading: im.heading };
      const c = wallColour(pix, cam, wall, base, base + Math.max(3, t.height));
      opts.onView?.({ building: t.id, image: im, wall: v.wall, score: v.score, colour: c, pix, cam, wallLine: wall, z0: base, z1: base + Math.max(3, t.height) });
      if (!c) continue;
      if (!found.has(t.id)) found.set(t.id, []);
      found.get(t.id).push({ rgb: c.rgb, weight: v.score * c.share });
    }
    pix = null;
  }

  const out = features.slice();
  for (const [index, list] of found) {
    const rgb = agreeingColour(list);
    if (!rgb) continue;
    const f = features[index];
    out[index] = { ...f, tags: { ...f.tags, 'building:colour': hex(plausibleWall(rgb)), 'mapng:colour_source': 'vegbilder' } };
    stats.coloured++;
  }
  return { features: out, stats };
}
