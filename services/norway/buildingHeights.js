// Measured building heights for map areas in Norway.
//
// Kartverket publishes two national 1 m lidar models with the same tiles: the
// terrain (DTM1, the bare ground) and the surface (DOM1, with buildings and
// trees on it). Their difference under a building's outline is the building's
// height as surveyed. OpenStreetMap seldom has a height in Norway, and the
// Matrikkel has none at all, so without this a building's height is a guess
// from its type.
//
// Each building with an outline gets tags.height (metres, ground to roof top)
// unless OSM already gives one, and mapng:height_source = kartverket_dom.
//
// Source: Kartverket, Høydedata DOM1 and DTM1 (CC BY 4.0).
import proj4 from 'proj4';
import { fetchKartverketDtmRaw, loadDtmFeed } from './kartverketDtm.js';

export const KARTVERKET_DOM_FEED = 'https://nedlasting.geonorge.no/geonorge/ATOM/hoydedata/datasett/DOM1.atom';
export const NORWAY_BUILDING_HEIGHTS_STORAGE_KEY = 'mapng_norwayBuildingHeights';
export const BUILDING_HEIGHTS_ATTRIBUTION = 'Kartverket, Høydedata DOM1 (CC BY 4.0)';

const UTM33 = '+proj=utm +zone=33 +ellps=GRS80 +units=m +no_defs';
const MAX_SAMPLES = 400;       // points measured inside one outline, at most
const MIN_SAMPLES = 4;
const ROOF_PERCENTILE = 0.85;  // the roof top, short of a mast or a tree leaning over it
const MIN_HEIGHT_M = 2.2;      // lower than this: nothing stood there when the survey flew (or a shed's worth of noise)
const MAX_HEIGHT_M = 250;

/** On unless switched off in settings (localStorage mapng_norwayBuildingHeights = "0"). */
export function norwayBuildingHeightsEnabled(storage = globalThis.localStorage) {
  try { return storage?.getItem(NORWAY_BUILDING_HEIGHTS_STORAGE_KEY) !== '0'; } catch { return true; }
}

/** A height lookup over the grid chunks fetchKartverketDtmRaw returns: at(easting, northing) -> metres or NaN. */
export function chunkSampler(chunks) {
  return (e, n) => {
    for (const c of chunks) {
      const col = Math.round((e - c.originX) / c.resX), row = Math.round((n - c.originY) / c.resY);
      if (col < 0 || row < 0 || col >= c.width || row >= c.height) continue;
      const v = c.raster[row * c.width + col];
      if (v !== c.noData && Number.isFinite(v)) return v;
    }
    return NaN;
  };
}

const inside = (ring, x, y) => {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
};

/**
 * The height of what stands in an outline: the ROOF_PERCENTILE of surface minus
 * terrain over points inside it, or null when too little was measured.
 * ring: [[easting, northing]]; surfaceAt, groundAt: (e, n) -> metres or NaN; step: the models' pixel size.
 */
export function heightInOutline(ring, surfaceAt, groundAt, step = 1) {
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  for (const [x, y] of ring) { west = Math.min(west, x); east = Math.max(east, x); south = Math.min(south, y); north = Math.max(north, y); }
  if (!(east > west) || !(north > south)) return null;
  const d = Math.max(step, Math.sqrt(((east - west) * (north - south)) / MAX_SAMPLES));
  const values = [];
  for (let y = south + d / 2; y < north; y += d) {
    for (let x = west + d / 2; x < east; x += d) {
      if (!inside(ring, x, y)) continue;
      const top = surfaceAt(x, y), ground = groundAt(x, y);
      if (Number.isFinite(top) && Number.isFinite(ground)) values.push(top - ground);
    }
  }
  if (values.length < MIN_SAMPLES) return null;
  values.sort((a, b) => a - b);
  const h = values[Math.min(values.length - 1, Math.floor(values.length * ROOF_PERCENTILE))];
  return h >= MIN_HEIGHT_M && h <= MAX_HEIGHT_M ? Math.round(h * 10) / 10 : null;
}

const isMeasurable = (f) => f?.type === 'building' && f.geometry?.length >= 3 && !f.tags?.['building:part']
  && !(Number.parseFloat(f.tags?.height) > 0);

/**
 * Heights onto the map's buildings. features: the map's features (type
 * 'building': geometry [{ lat, lng }] outline). Returns { features, stats: {
 * buildings, measured, metersPerPixel } }; features that gain a height are new
 * objects, the input is not mutated. Throws when Kartverket can't be read.
 * opts: { signal, onProgress, fetchModel (fetchKartverketDtmRaw), metersPerPixel }
 */
export async function measureNorwayBuildingHeights(features, bounds, opts = {}) {
  const { signal, onProgress, fetchModel = fetchKartverketDtmRaw, metersPerPixel = 1 } = opts;
  const wanted = (features || []).filter(isMeasurable);
  const stats = { buildings: wanted.length, measured: 0, metersPerPixel: null };
  if (!wanted.length) return { features, stats };
  onProgress?.('Measuring building heights (Kartverket surface model)...');
  const common = { metersPerPixel, signal, fetchImpl: opts.fetchImpl ?? globalThis.fetch, ...(opts.openTiff ? { openTiff: opts.openTiff } : {}) };
  const surface = await fetchModel(bounds, { ...common, loadFeed: (o) => (opts.loadFeed ?? loadDtmFeed)({ ...o, url: KARTVERKET_DOM_FEED }) });
  if (!surface) return { features, stats };
  const ground = await fetchModel(bounds, { ...common, ...(opts.loadFeed ? { loadFeed: opts.loadFeed } : {}) });
  if (!ground) return { features, stats };
  const surfaceAt = chunkSampler(surface.tiles), groundAt = chunkSampler(ground.tiles);
  const step = Math.max(surface.metersPerPixel, ground.metersPerPixel);
  stats.metersPerPixel = step;
  const toUtm = proj4('EPSG:4326', UTM33);
  const out = features.map((f) => {
    if (!isMeasurable(f)) return f;
    const ring = f.geometry.map((p) => toUtm.forward([p.lng ?? p.lon, p.lat]));
    const h = heightInOutline(ring, surfaceAt, groundAt, step);
    if (h == null) return f;
    stats.measured++;
    return { ...f, tags: { ...f.tags, height: String(h), 'mapng:height_source': 'kartverket_dom' } };
  });
  return { features: out, stats };
}
