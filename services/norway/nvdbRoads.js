// Road data from NVDB (Nasjonal vegdatabank, Statens vegvesen) for map areas
// in Norway: speed limits, road widths, lane counts, stop and give-way signs,
// traffic signals, speed bumps, street lights and guard rails.
//
// The roads themselves stay OpenStreetMap's. NVDB's values are attached to
// the OSM road they lie on (nearest NVDB line running the same way), and its
// point objects are added as the OSM-style nodes the app already reads
// (highway=stop, highway=give_way, highway=traffic_signals, traffic_calming,
// highway=street_lamp) where OSM has none at that spot.
//
// API: NVDB API Les v4, https://nvdbapiles.atlas.vegvesen.no (no key).
// With srid=4326 the box is given west,south,east,north and geometry comes
// back as WKT in latitude, longitude order.
// Licence: NLOD 2.0. Credit: Statens vegvesen, NVDB.
import { NON_DRIVEABLE_HIGHWAYS } from '../roadWidth.js';

export const NVDB_BASE = 'https://nvdbapiles.atlas.vegvesen.no';
export const NVDB_ATTRIBUTION = 'Statens vegvesen, NVDB (NLOD 2.0)';
export const NORWAY_ROADS_STORAGE_KEY = 'mapng_norwayRoads';
// Ids stay clear of OSM ids, Overture's footprints (-1e12 down) and Matrikkel buildings (-2e12 down).
export const NVDB_ID_BASE = -3e12;

/** NVDB object types read for a map. */
export const NVDB_TYPES = {
  speedLimit: 105,       // Fartsgrense
  widthComputed: 838,    // Vegbredde, beregnet
  widthHistoric: 583,    // Vegbredde, historisk
  lanes: 616,            // Feltstrekning
  signPlate: 96,         // Skiltplate
  signals: 89,           // Signalanlegg
  speedBump: 103,        // Fartsdemper
  streetLight: 87,       // Belysningspunkt
  guardRail: 5,          // Rekkverk
};

const PAGE_SIZE = 1000;
const MAX_PAGES = 60;
const MATCH_M = 9;             // an NVDB line this close to an OSM road, running the same way, is that road
const MATCH_COS = 0.8;         // within about 37 degrees
const SAMPLE_M = 10;
const MIN_COVER = 0.4;         // share of a road's length NVDB must cover to set a value on it

/** On unless switched off in settings (localStorage mapng_norwayRoads = "0"). */
export function norwayRoadsEnabled(storage = globalThis.localStorage) {
  try { return storage?.getItem(NORWAY_ROADS_STORAGE_KEY) !== '0'; } catch { return true; }
}

/**
 * WKT from NVDB (srid 4326: latitude longitude [height]) as
 * { kind: 'point' | 'line' | 'polygon', lines: [[{ lat, lon }]] }, or null.
 */
export function parseWkt(wkt) {
  const m = /^\s*(MULTI)?(POINT|LINESTRING|POLYGON)\s*(?:Z|M|ZM)?\s*\(([\s\S]*)\)\s*$/i.exec(String(wkt || ''));
  if (!m) return null;
  const kind = m[2].toUpperCase() === 'POINT' ? 'point' : m[2].toUpperCase() === 'LINESTRING' ? 'line' : 'polygon';
  const lines = [];
  // every innermost "( ... )" group is one run of coordinates; a plain POINT or LINESTRING has none
  const groups = m[3].includes('(') ? [...m[3].matchAll(/\(([^()]+)\)/g)].map((g) => g[1]) : [m[3]];
  for (const group of groups) {
    const points = [];
    for (const part of group.split(',')) {
      const nums = part.trim().split(/\s+/).map(Number);
      if (nums.length >= 2 && Number.isFinite(nums[0]) && Number.isFinite(nums[1])) points.push({ lat: nums[0], lon: nums[1] });
    }
    if (points.length) lines.push(points);
  }
  return lines.length ? { kind, lines } : null;
}

/** The value of a named property (egenskap) of an NVDB object, or undefined. */
export const propertyOf = (object, name) => (object?.egenskaper || []).find((e) => e.navn === name)?.verdi;

/**
 * Every object of one type in the box (all pages), each with its properties and geometry.
 * A map with more than MAX_PAGES pages of one type gets the first MAX_PAGES (and a warning).
 */
export async function fetchNvdbObjects(typeId, bounds, { fetchImpl = globalThis.fetch, signal, pageSize = PAGE_SIZE, maxPages = MAX_PAGES } = {}) {
  const objects = [];
  let start = null;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      kartutsnitt: `${bounds.west},${bounds.south},${bounds.east},${bounds.north}`,
      srid: '4326', inkluder: 'egenskaper,geometri', antall: String(pageSize),
    });
    if (start) params.set('start', start);
    const res = await fetchImpl(`${NVDB_BASE}/vegobjekter/api/v4/vegobjekter/${typeId}?${params}`, {
      headers: { 'X-Client': 'MapNG', Accept: 'application/json' }, signal,
    });
    if (!res.ok) throw new Error(`NVDB answered ${res.status} for object type ${typeId}`);
    const body = await res.json();
    const got = body?.objekter || [];
    objects.push(...got);
    const meta = body?.metadata || {};
    const next = meta.neste?.start;
    // (NVDB always names a next page; the last one is the page that is not full)
    if (!got.length || !next || next === start || got.length < (meta['sidestørrelse'] || pageSize)) return objects;
    start = next;
  }
  console.warn(`[NVDB] Object type ${typeId}: more than ${maxPages} pages here; the rest is left out.`);
  return objects;
}

/** All the road data for a box: { speedLimit: [...], widthComputed: [...], ... } (NVDB objects per kind). */
export async function fetchNvdbRoadData(bounds, opts = {}) {
  const kinds = Object.keys(NVDB_TYPES);
  const lists = await Promise.all(kinds.map((kind) => fetchNvdbObjects(NVDB_TYPES[kind], bounds, opts)));
  return Object.fromEntries(kinds.map((kind, i) => [kind, lists[i]]));
}

// ---- matching NVDB lines to OSM roads ---------------------------------------

const projector = (bounds) => {
  const lat0 = (bounds.north + bounds.south) / 2, lon0 = (bounds.east + bounds.west) / 2;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110540;
  return (p) => [(p.lon - lon0) * kx, (p.lat - lat0) * ky];
};

const CELL_M = 40;
/** Line pieces with a value, in a grid: nearest(x, y, dx, dy) -> { value, along } of the closest piece running that way. */
function lineIndex(entries, project) {
  const cells = new Map();
  const put = (seg) => {
    const x0 = Math.floor((Math.min(seg.ax, seg.bx) - MATCH_M) / CELL_M), x1 = Math.floor((Math.max(seg.ax, seg.bx) + MATCH_M) / CELL_M);
    const y0 = Math.floor((Math.min(seg.ay, seg.by) - MATCH_M) / CELL_M), y1 = Math.floor((Math.max(seg.ay, seg.by) + MATCH_M) / CELL_M);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const k = `${x},${y}`;
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(seg);
    }
  };
  for (const { value, geometry } of entries) {
    for (const line of geometry?.lines || []) {
      for (let i = 0; i + 1 < line.length; i++) {
        const [ax, ay] = project(line[i]), [bx, by] = project(line[i + 1]);
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 0.05) continue;
        put({ ax, ay, bx, by, ux: (bx - ax) / len, uy: (by - ay) / len, len, value });
      }
    }
  }
  return (x, y, dx, dy) => {
    let best = null, bestD = MATCH_M;
    for (const seg of cells.get(`${Math.floor(x / CELL_M)},${Math.floor(y / CELL_M)}`) || []) {
      const cos = seg.ux * dx + seg.uy * dy;
      if (Math.abs(cos) < MATCH_COS) continue;
      const t = Math.max(0, Math.min(seg.len, (x - seg.ax) * seg.ux + (y - seg.ay) * seg.uy));
      const d = Math.hypot(x - (seg.ax + seg.ux * t), y - (seg.ay + seg.uy * t));
      if (d < bestD) { bestD = d; best = { value: seg.value, along: cos > 0 }; }
    }
    return best;
  };
}

/** Points every SAMPLE_M along a road, each with the road's direction there: [{ x, y, dx, dy, weight }]. */
function samplesAlong(geometry, project) {
  const out = [];
  for (let i = 0; i + 1 < geometry.length; i++) {
    const [ax, ay] = project(geometry[i]), [bx, by] = project(geometry[i + 1]);
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 0.05) continue;
    const n = Math.max(1, Math.round(len / SAMPLE_M));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      out.push({ x: ax + (bx - ax) * t, y: ay + (by - ay) * t, dx: (bx - ax) / len, dy: (by - ay) / len, weight: len / n });
    }
  }
  return out;
}

const weightedMode = (votes) => { let best = null, w = 0; for (const [v, x] of votes) if (x > w) { w = x; best = v; } return best; };
const weightedMedian = (pairs) => {
  const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
  const half = sorted.reduce((s, p) => s + p[1], 0) / 2;
  let run = 0;
  for (const [v, w] of sorted) { run += w; if (run >= half) return v; }
  return sorted.length ? sorted[sorted.length - 1][0] : null;
};

const drivable = (el) => el.type === 'way' && el.tags?.highway && !NON_DRIVEABLE_HIGHWAYS.has(el.tags.highway)
  && el.tags.highway !== 'service_area' && el.tags.area !== 'yes' && el.geometry?.length >= 2;

const geometryOf = (o) => parseWkt(o?.geometri?.wkt);
const number = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// ---- NVDB points as OSM-style nodes -----------------------------------------

// Skiltplate numbers the app has a use for (the sign's number is the start of "Skiltnummer").
const SIGN_TAGS = { 202: { highway: 'give_way' }, 204: { highway: 'stop' } };
const signCode = (o) => (String(propertyOf(o, 'Skiltnummer') || '').match(/^\s*(\d+)/) || [])[1] || null;

const BUMP = (type) => {
  const t = String(type || '').toLowerCase();
  if (t.includes('pute')) return 'cushion';
  if (t.includes('opphøyd') || t.includes('gangfelt') || t.includes('kryss')) return 'table';
  return 'hump';
};

/** A grid of points: near(lat, lon, metres) -> whether one is that close; add(lat, lon). */
function pointSet(project) {
  const cells = new Map();
  const CELL = 30;
  const key = (x, y) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
  return {
    add(p) { const [x, y] = project(p); const k = key(x, y); if (!cells.has(k)) cells.set(k, []); cells.get(k).push([x, y]); },
    near(p, metres) {
      const [x, y] = project(p);
      const r = Math.ceil(metres / CELL);
      for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
        for (const [px, py] of cells.get(`${Math.floor(x / CELL) + i},${Math.floor(y / CELL) + j}`) || []) if (Math.hypot(px - x, py - y) <= metres) return true;
      }
      return false;
    },
  };
}

/**
 * NVDB road data merged into live OSM `data` ({ elements }):
 * - roads: maxspeed, width and lanes from NVDB on every drivable OSM road NVDB covers
 *   (NVDB's value replaces OSM's; the tags set are listed in mapng:nvdb);
 * - points: give-way and stop signs, traffic signals, speed bumps and street lights added
 *   where OSM has none of that kind nearby; guard rails added as barrier ways.
 * Returns { data, stats }; the input is not mutated.
 */
export function mergeNvdbRoads(data, nvdb, bounds) {
  const elements = [...(data?.elements || [])];
  const project = projector(bounds);
  const inside = (p) => p.lat >= bounds.south && p.lat <= bounds.north && p.lon >= bounds.west && p.lon <= bounds.east;
  const stats = { roads: 0, maxspeed: 0, width: 0, lanes: 0, giveWay: 0, stop: 0, signals: 0, bumps: 0, lights: 0, guardRails: 0 };

  // -- lines
  const speeds = lineIndex((nvdb.speedLimit || []).map((o) => ({ value: number(propertyOf(o, 'Fartsgrense')), geometry: geometryOf(o) })).filter((e) => e.value > 0), project);
  const widthValue = (o) => number(propertyOf(o, 'Kjørebanebredde')) ?? number(propertyOf(o, 'Dekkebredde'));
  const widths = lineIndex((nvdb.widthComputed || []).map((o) => ({ value: widthValue(o), geometry: geometryOf(o) })).filter((e) => e.value >= 2.5 && e.value <= 45), project);
  // (the older measurements, where the computed widths have nothing: carriageway or surface width, else the total)
  const oldWidths = lineIndex((nvdb.widthHistoric || []).map((o) => ({ value: widthValue(o) ?? number(propertyOf(o, 'Vegbredde, totalt')), geometry: geometryOf(o) })).filter((e) => e.value >= 2.5 && e.value <= 45), project);
  const lanes = lineIndex((nvdb.lanes || []).map((o) => ({
    value: { total: number(propertyOf(o, 'Antall kjørefelt')) || 0, along: number(propertyOf(o, 'Antall kjørefelt med metreringsretning')) || 0, against: number(propertyOf(o, 'Antall kjørefelt mot metreringsretning')) || 0 },
    geometry: geometryOf(o),
  })).filter((e) => e.value.total > 0), project);

  elements.forEach((el, index) => {
    if (!drivable(el)) return;
    const samples = samplesAlong(el.geometry, project);
    const total = samples.reduce((s, p) => s + p.weight, 0);
    if (!(total > 0)) return;
    const speedVotes = new Map(), laneVotes = new Map(), widthPairs = [], oldWidthPairs = [];
    let speedW = 0, laneW = 0, widthW = 0, oldWidthW = 0;
    for (const p of samples) {
      const s = speeds(p.x, p.y, p.dx, p.dy);
      if (s) { speedVotes.set(s.value, (speedVotes.get(s.value) || 0) + p.weight); speedW += p.weight; }
      const l = lanes(p.x, p.y, p.dx, p.dy);
      if (l) {
        // (a one-way OSM road on a two-way NVDB line: the lanes of its own direction only)
        const own = l.along ? l.value.along : l.value.against;
        const split = el.tags.oneway === 'yes' && l.value.along > 0 && l.value.against > 0;
        const key = `${split ? own : l.value.total}/${l.value.total}`;
        laneVotes.set(key, (laneVotes.get(key) || 0) + p.weight); laneW += p.weight;
      }
      const w = widths(p.x, p.y, p.dx, p.dy);
      if (w) { widthPairs.push([w.value, p.weight]); widthW += p.weight; }
      const ow = oldWidths(p.x, p.y, p.dx, p.dy);
      if (ow) { oldWidthPairs.push([ow.value, p.weight]); oldWidthW += p.weight; }
    }
    const extra = {};
    if (speedW / total >= MIN_COVER) extra.maxspeed = String(weightedMode(speedVotes));
    let share = 1;
    if (laneW / total >= MIN_COVER) {
      const [own, all] = weightedMode(laneVotes).split('/').map(Number);
      extra.lanes = String(own);
      share = own / all;
    }
    const pairs = widthW / total >= MIN_COVER ? widthPairs : oldWidthW / total >= MIN_COVER ? oldWidthPairs : null;
    if (pairs) {
      const width = weightedMedian(pairs) * share;
      if (width >= 2.5) extra.width = String(Math.round(width * 10) / 10);
    }
    const set = Object.keys(extra);
    if (!set.length) return;
    elements[index] = { ...el, tags: { ...el.tags, ...extra, 'mapng:nvdb': set.join(';') } };
    stats.roads++;
    for (const k of set) stats[k]++;
  });

  // -- points
  let id = NVDB_ID_BASE;
  const existing = (test) => { const set = pointSet(project); for (const el of elements) if (el.type === 'node' && el.tags && test(el.tags)) set.add(el); return set; };
  const addNodes = (objects, tagsFor, near, metres, count) => {
    for (const o of objects || []) {
      const tags = tagsFor(o);
      const p = geometryOf(o)?.lines?.[0]?.[0];
      if (!tags || !p || !inside(p) || near.near(p, metres)) continue;
      near.add(p);
      elements.push({ type: 'node', id: id--, lat: p.lat, lon: p.lon, tags: { ...tags, 'mapng:source': 'nvdb', 'nvdb:id': String(o.id) } });
      count(tags);
    }
  };
  const signsNear = { give_way: existing((t) => t.highway === 'give_way'), stop: existing((t) => t.highway === 'stop') };
  for (const kind of ['give_way', 'stop']) {
    addNodes((nvdb.signPlate || []).filter((o) => SIGN_TAGS[signCode(o)]?.highway === kind),
      (o) => ({ ...SIGN_TAGS[signCode(o)], traffic_sign: `NO:${signCode(o)}` }), signsNear[kind], 12,
      () => { stats[kind === 'stop' ? 'stop' : 'giveWay']++; });
  }
  addNodes(nvdb.signals, (o) => ({ highway: 'traffic_signals', ...(propertyOf(o, 'Bruksområde') === 'Gangfelt' ? { crossing: 'traffic_signals' } : {}) }),
    existing((t) => t.highway === 'traffic_signals'), 30, () => { stats.signals++; });
  addNodes(nvdb.speedBump, (o) => ({ traffic_calming: BUMP(propertyOf(o, 'Type')) }), existing((t) => t.traffic_calming && t.traffic_calming !== 'no'), 10, () => { stats.bumps++; });
  addNodes(nvdb.streetLight, () => ({ highway: 'street_lamp' }), existing((t) => t.highway === 'street_lamp'), 6, () => { stats.lights++; });

  // -- guard rails (their own surveyed line)
  for (const o of nvdb.guardRail || []) {
    const g = geometryOf(o);
    if (g?.kind !== 'line' || !o.geometri?.egengeometri) continue;
    for (const line of g.lines) {
      if (line.length < 2 || !line.some(inside)) continue;
      elements.push({ type: 'way', id: id--, tags: { barrier: 'guard_rail', 'mapng:source': 'nvdb', 'nvdb:id': String(o.id) }, geometry: line.map((p) => ({ lat: p.lat, lon: p.lon })) });
      stats.guardRails++;
    }
  }
  return { data: { ...data, elements }, stats };
}
