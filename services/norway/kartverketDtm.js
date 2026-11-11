// Kartverket's national 1 m terrain model (Høydedata DTM1), read straight from
// Kartverket for map areas in Norway.
//
// The model is published as 15 km GeoTIFF tiles in EPSG:25833 (about 250 MB
// each), listed in an Atom feed with each tile's outline. Only the part of a
// tile under the map is read, by HTTP range requests in fixed 1 MiB blocks, so
// a map never downloads a whole tile and the same map always asks for the same
// blocks (the desktop app records and replays them).
//
// Output: overlapping grid chunks (EPSG:25833) the resampler reads like any
// raster source, the same form services/mapterhorn.js returns.
//
// Source: Kartverket, Høydedata DTM1 (CC BY 4.0).
import proj4 from 'proj4';
import { GeoTIFF } from 'geotiff';
import { mapterhornMosaicBudget } from '../mapterhorn.js';

export const KARTVERKET_DTM_FEED = 'https://nedlasting.geonorge.no/geonorge/ATOM/hoydedata/datasett/DTM1.atom';
export const KARTVERKET_DTM_ATTRIBUTION = 'Kartverket, Høydedata DTM1 (CC BY 4.0)';
export const NORWAY_ELEVATION_STORAGE_KEY = 'mapng_norwayElevation';
export const KARTVERKET_DTM_EPSG = 25833;

const UTM33 = '+proj=utm +zone=33 +ellps=GRS80 +units=m +no_defs';
const NO_DATA = -99999;
const CHUNK_PX = 4096;      // grid chunk size (the resampler skips a tile's last row/column: chunks overlap)
const OVERLAP_PX = 2;
const BLOCK_BYTES = 1 << 20;
const BAND_PX = 8e6;        // source pixels read per step
const MAX_PARALLEL = 6;

/** On unless switched off in settings (localStorage mapng_norwayElevation = "0"). */
export function norwayElevationEnabled(storage = globalThis.localStorage) {
  try { return storage?.getItem(NORWAY_ELEVATION_STORAGE_KEY) !== '0'; } catch { return true; }
}

const toUtm33 = (lat, lng) => proj4('EPSG:4326', UTM33).forward([lng, lat]);

/** The map area's box in EPSG:25833 metres (its outline sampled: the box is not square there). */
export function utm33Box(bounds, samples = 8) {
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  const add = (lat, lng) => {
    const [e, n] = toUtm33(lat, lng);
    west = Math.min(west, e); east = Math.max(east, e); south = Math.min(south, n); north = Math.max(north, n);
  };
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const lat = bounds.south + t * (bounds.north - bounds.south);
    const lng = bounds.west + t * (bounds.east - bounds.west);
    add(bounds.south, lng); add(bounds.north, lng); add(lat, bounds.west); add(lat, bounds.east);
  }
  return { west, east, south, north };
}

/** The feed's tiles: [{ id, url, utm: { west, east, south, north } }] (outlines projected to EPSG:25833). */
export function parseDtmFeed(xml) {
  const tiles = [];
  for (const m of String(xml).matchAll(/<entry[\s>][\s\S]*?<\/entry>/g)) {
    const entry = m[0];
    const url = [...entry.matchAll(/href="([^"]+)"/g)].map((h) => h[1]).find((h) => /\.tiff?(\?|$)/i.test(h));
    const polygon = entry.match(/<(?:[\w.-]+:)?polygon>([^<]+)</);
    if (!url || !polygon) continue;
    const nums = polygon[1].trim().split(/\s+/).map(Number);
    if (nums.length < 6 || nums.some((v) => !Number.isFinite(v))) continue;
    let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
    for (let i = 0; i + 1 < nums.length; i += 2) {   // latitude, longitude pairs
      const [e, n] = toUtm33(nums[i], nums[i + 1]);
      west = Math.min(west, e); east = Math.max(east, e); south = Math.min(south, n); north = Math.max(north, n);
    }
    const id = (url.match(/([^/]+)\.tiff?(\?|$)/i) || [])[1] || url;
    tiles.push({ id, url, utm: { west: Math.round(west), east: Math.round(east), south: Math.round(south), north: Math.round(north) } });
  }
  return tiles;
}

/** The tiles that hold part of the box (tiles that only touch its edge are left out). */
export const tilesForBox = (tiles, box) => tiles.filter((t) => (
  t.utm.east > box.west + 1 && t.utm.west < box.east - 1 && t.utm.north > box.south + 1 && t.utm.south < box.north - 1
));

const feeds = new Map();
/** The DTM1 tile list, loaded once per session. */
export function loadDtmFeed({ fetchImpl = globalThis.fetch, signal, url = KARTVERKET_DTM_FEED } = {}) {
  if (!feeds.has(url)) {
    feeds.set(url, (async () => {
      const res = await fetchImpl(url, { signal });
      if (!res.ok) throw new Error(`Kartverket elevation feed answered ${res.status}`);
      const tiles = parseDtmFeed(await res.text());
      if (!tiles.length) throw new Error('Kartverket elevation feed lists no tiles');
      return tiles;
    })().catch((e) => { feeds.delete(url); throw e; }));
  }
  return feeds.get(url);
}

/**
 * A file read by range requests in fixed blocks (a geotiff.js source). A server
 * that ignores the range (answers 200 with the whole file) is refused: the
 * caller falls back instead of downloading a 250 MB tile.
 */
export function rangeSource(url, { fetchImpl = globalThis.fetch, signal, blockBytes = BLOCK_BYTES } = {}) {
  const blocks = new Map();
  let size = null, active = 0;
  const waiting = [];
  const slot = async () => {
    if (active >= MAX_PARALLEL) await new Promise((go) => waiting.push(go));
    active++;
  };
  const release = () => { active--; waiting.shift()?.(); };
  const block = (i) => {
    if (!blocks.has(i)) {
      blocks.set(i, (async () => {
        await slot();
        try {
          const start = i * blockBytes;
          if (size != null && start >= size) return new Uint8Array(0);
          const res = await fetchImpl(url, { headers: { Range: `bytes=${start}-${start + blockBytes - 1}` }, signal });
          if (res.status === 416) return new Uint8Array(0);
          if (res.status !== 206) {
            try { await res.body?.cancel(); } catch { /* already closed */ }
            throw new Error(res.status === 200 ? 'the server does not answer range requests' : `the server answered ${res.status}`);
          }
          const total = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
          if (total) size = Number(total[1]);
          return new Uint8Array(await res.arrayBuffer());
        } finally { release(); }
      })());
    }
    return blocks.get(i);
  };
  return {
    get fileSize() { return size; },
    async fetch(slices) {
      return Promise.all(slices.map(async ({ offset, length }) => {
        const out = new Uint8Array(length);
        const first = Math.floor(offset / blockBytes), last = Math.floor((offset + length - 1) / blockBytes);
        const parts = await Promise.all(Array.from({ length: last - first + 1 }, (_, k) => block(first + k)));
        parts.forEach((bytes, k) => {
          const blockStart = (first + k) * blockBytes;
          const from = Math.max(offset, blockStart), to = Math.min(offset + length, blockStart + bytes.length);
          if (to > from) out.set(bytes.subarray(from - blockStart, to - blockStart), from - offset);
        });
        return out.buffer;
      }));
    },
    async close() { blocks.clear(); },
  };
}

const defaultOpenTiff = (url, opts) => GeoTIFF.fromSource(rangeSource(url, opts));

const validHeight = (v, noData) => Number.isFinite(v) && v !== noData && v > -1000 && v < 10000;

/**
 * Kartverket DTM1 for bounds. Returns null when no tile holds heights there
 * (outside Norway, or open sea), else
 * { tiles: grid chunks for the resampler (epsgCode 25833), metersPerPixel, sourceTiles, validFraction }.
 * Throws when Kartverket can't be read; the caller falls back to another source.
 * opts: { metersPerPixel, onProgress, signal, fetchImpl, openTiff, loadFeed, budget }
 */
export async function fetchKartverketDtmRaw(bounds, opts = {}) {
  const {
    metersPerPixel = 1, onProgress, signal, fetchImpl = globalThis.fetch,
    openTiff = defaultOpenTiff, loadFeed = loadDtmFeed, budget = mapterhornMosaicBudget(),
  } = opts;
  onProgress?.('Checking Kartverket elevation tiles (Norway)...');
  const box = utm33Box(bounds);
  const hits = tilesForBox(await loadFeed({ fetchImpl, signal }), box);
  if (!hits.length) return null;

  let grid = null;        // { res, west, north, W, H, mosaic, sum, count }
  const used = [];
  for (const [index, tile] of hits.entries()) {
    signal?.throwIfAborted?.();
    onProgress?.(`Fetching Kartverket elevation (tile ${tile.id}, ${index + 1}/${hits.length})...`);
    const tiff = await openTiff(tile.url, { fetchImpl, signal });
    try {
      const image = await tiff.getImage(0);
      // (Kartverket's files name the system by citation: the code is 32767, "user defined", with UTM zone 33N
      // as the projection, 16033)
      const keys = image.geoKeys || {};
      const named = keys.ProjectionGeoKey === 16033 || /UTM[_ ]Zone[_ ]33N/i.test(`${keys.GTCitationGeoKey || ''} ${keys.PCSCitationGeoKey || ''}`);
      const epsg = keys.ProjectedCSTypeGeoKey === 32767 && named ? KARTVERKET_DTM_EPSG : keys.ProjectedCSTypeGeoKey;
      if (epsg && epsg !== KARTVERKET_DTM_EPSG) { console.warn(`[Kartverket] Tile ${tile.id} is in EPSG:${epsg}, not ${KARTVERKET_DTM_EPSG}. Skipped.`); continue; }
      const [ox, oy] = image.getOrigin();
      const [rx, ry] = image.getResolution();
      const native = Math.abs(rx);
      if (!(native > 0) || Math.abs(Math.abs(ry) - native) > 1e-6) throw new Error(`tile ${tile.id} has an unexpected pixel size`);
      const noData = image.getGDALNoData();

      if (!grid) {
        // the coarsest whole multiple of the tile's pixels that is no larger than the map's, within the memory budget
        let step = Math.max(1, Math.floor(metersPerPixel / native + 1e-6));
        while (((box.east - box.west) / (native * step)) * ((box.north - box.south) / (native * step)) > budget) step++;
        const res = native * step;
        const west = Math.floor(box.west / res) * res, north = Math.ceil(box.north / res) * res;
        const W = Math.ceil((box.east - west) / res), H = Math.ceil((north - box.south) / res);
        grid = { res, step, west, north, W, H, mosaic: new Float32Array(W * H).fill(NO_DATA), sum: null, count: null };
        if (step > 1) { grid.sum = new Float32Array(W * H); grid.count = new Uint16Array(W * H); }
      }
      const { res, west, north, W, H } = grid;

      // the tile's pixels under the map
      const c0 = Math.max(0, Math.floor((west - ox) / native)), c1 = Math.min(image.getWidth(), Math.ceil((west + W * res - ox) / native));
      const r0 = Math.max(0, Math.floor((oy - north) / native)), r1 = Math.min(image.getHeight(), Math.ceil((oy - (north - H * res)) / native));
      if (c1 <= c0 || r1 <= r0) continue;
      const cols = c1 - c0;
      const mx = new Int32Array(cols);
      for (let c = 0; c < cols; c++) mx[c] = Math.floor((ox + (c0 + c + 0.5) * native - west) / res);
      const bandRows = Math.max(1, Math.floor(BAND_PX / cols));
      for (let r = r0; r < r1; r += bandRows) {
        signal?.throwIfAborted?.();
        const rEnd = Math.min(r1, r + bandRows);
        const [band] = await image.readRasters({ window: [c0, r, c1, rEnd], samples: [0], signal });
        for (let rr = r; rr < rEnd; rr++) {
          const my = Math.floor((north - (oy - (rr + 0.5) * native)) / res);
          if (my < 0 || my >= H) continue;
          const src = (rr - r) * cols, dst = my * W;
          for (let c = 0; c < cols; c++) {
            const x = mx[c];
            if (x < 0 || x >= W) continue;
            const v = band[src + c];
            if (!validHeight(v, noData)) continue;
            if (grid.sum) { grid.sum[dst + x] += v; grid.count[dst + x]++; } else grid.mosaic[dst + x] = v;
          }
        }
        if (r1 - r0 > bandRows) onProgress?.(`Fetching Kartverket elevation (tile ${tile.id}): ${Math.round(((rEnd - r0) / (r1 - r0)) * 100)}%...`);
      }
      used.push(tile.id);
    } finally {
      try { await tiff.close?.(); } catch { /* nothing to release */ }
    }
  }
  if (!grid || !used.length) return null;

  const { res, west, north, W, H, mosaic, sum, count } = grid;
  let valid = 0;
  if (sum) {
    for (let i = 0; i < mosaic.length; i++) if (count[i]) { mosaic[i] = sum[i] / count[i]; valid++; }
  } else {
    for (let i = 0; i < mosaic.length; i++) if (mosaic[i] !== NO_DATA) valid++;
  }
  if (!valid) return null;

  // overlapping chunks, pixel-centre origins
  const tiles = [];
  for (let cy = 0; cy < H; cy += CHUNK_PX - OVERLAP_PX) {
    for (let cx = 0; cx < W; cx += CHUNK_PX - OVERLAP_PX) {
      const w = Math.min(CHUNK_PX, W - cx), h = Math.min(CHUNK_PX, H - cy);
      if (w < 2 || h < 2) continue;
      const raster = new Float32Array(w * h);
      let any = false;
      for (let y = 0; y < h; y++) {
        const row = mosaic.subarray((cy + y) * W + cx, (cy + y) * W + cx + w);
        raster.set(row, y * w);
        if (!any) for (let i = 0; i < w; i += 16) if (row[i] !== NO_DATA) { any = true; break; }
      }
      if (any) tiles.push({ raster, width: w, height: h, originX: west + (cx + 0.5) * res, originY: north - (cy + 0.5) * res, resX: res, resY: -res, noData: NO_DATA, epsgCode: KARTVERKET_DTM_EPSG });
      if (cx + w >= W) break;
    }
    if (cy + Math.min(CHUNK_PX, H - cy) >= H) break;
  }
  if (!tiles.length) return null;
  return { tiles, metersPerPixel: res, sourceTiles: used, validFraction: valid / mosaic.length };
}
