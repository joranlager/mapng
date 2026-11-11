// Measured road heights from NVDB's road network (Statens vegvesen) for map
// areas in Norway.
//
// NVDB's network (veglenkesekvenser, segmentert) is surveyed in three
// dimensions: every road line carries its height (NN2000, the datum of
// Kartverket's terrain model). The terrain model has the ground, so a road on
// the ground needs nothing more; a road on a bridge or in a tunnel is not on
// it, and there the app could only guess. Here the network lines beside every
// bridge and tunnel road of the map are kept, and the export hands their
// heights to the solvers: a bridge deck is pinned where NVDB measured it
// (structures/profileSolve.js pins, as US lidar does), a tunnel's road follows
// NVDB's profile (a subsea tunnel dips, a spiral tunnel climbs).
//
// The lines travel with the OSM data as ways tagged mapng:nvdb_profile, their
// points in mapng:profile ("lat,lon,z lat,lon,z ..."); services/osm.js keeps
// them as features of type nvdb_profile.
//
// API: NVDB API Les v4, https://nvdbapiles.atlas.vegvesen.no (no key).
// Licence: NLOD 2.0. Credit: Statens vegvesen, NVDB.
import { NVDB_BASE } from './nvdbRoads.js';

export const NORWAY_ROAD_HEIGHTS_STORAGE_KEY = 'mapng_norwayRoadHeights';
// Ids stay clear of the NVDB nodes and ways of nvdbRoads.js (-3e12 down).
export const NVDB_PROFILE_ID_BASE = -4e12;

const PAGE_SIZE = 1000;
const MAX_PAGES = 200;
const NEAR_M = 30;             // a network line this close to a bridge or tunnel road is kept
const SAMPLE_M = 10;
const REACH_M = 10;            // a line this close to a station, running the same way, is that road
const MATCH_COS = 0.8;
const CELL_M = 40;

// Roads cars drive on (typeVeg). Pavements, cycle tracks, stairs and ferries are left out.
const CAR_ROADS = new Set(['Enkel bilveg', 'Kanalisert veg', 'Rampe', 'Rundkjøring', 'Gatetun']);

/** On unless switched off in settings (localStorage mapng_norwayRoadHeights = "0"). */
export function norwayRoadHeightsEnabled(storage = globalThis.localStorage) {
  try { return storage?.getItem(NORWAY_ROAD_HEIGHTS_STORAGE_KEY) !== '0'; } catch { return true; }
}

/** "LINESTRING Z (lat lon z, ...)" (also MULTILINESTRING) as [[{ lat, lon, z }]]; points without a height are dropped. */
export function parseWktZ(wkt) {
  const m = /^\s*(?:MULTI)?LINESTRING\s*(?:Z|ZM)?\s*\(([\s\S]*)\)\s*$/i.exec(String(wkt || ''));
  if (!m) return [];
  const groups = m[1].includes('(') ? [...m[1].matchAll(/\(([^()]+)\)/g)].map((g) => g[1]) : [m[1]];
  const lines = [];
  for (const group of groups) {
    const points = [];
    for (const part of group.split(',')) {
      const [lat, lon, z] = part.trim().split(/\s+/).map(Number);
      if (Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(z)) points.push({ lat, lon, z });
    }
    if (points.length >= 2) lines.push(points);
  }
  return lines;
}

/** Every segment of the road network in the box (all pages). */
export async function fetchNvdbNetwork(bounds, { fetchImpl = globalThis.fetch, signal, pageSize = PAGE_SIZE, maxPages = MAX_PAGES } = {}) {
  const segments = [];
  let start = null;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ kartutsnitt: `${bounds.west},${bounds.south},${bounds.east},${bounds.north}`, srid: '4326', antall: String(pageSize) });
    if (start) params.set('start', start);
    const res = await fetchImpl(`${NVDB_BASE}/vegnett/api/v4/veglenkesekvenser/segmentert?${params}`, {
      headers: { 'X-Client': 'MapNG', Accept: 'application/json' }, signal,
    });
    if (!res.ok) throw new Error(`NVDB answered ${res.status} for the road network`);
    const body = await res.json();
    const got = body?.objekter || [];
    segments.push(...got);
    const next = body?.metadata?.neste?.start;
    if (!got.length || !next || next === start || got.length < (body?.metadata?.['sidestørrelse'] || pageSize)) return segments;
    start = next;
  }
  console.warn(`[NVDB] Road network: more than ${maxPages} pages here; the rest is left out.`);
  return segments;
}

/**
 * The 3D lines of the roads cars drive on: [[{ lat, lon, z }]]. A line with no
 * real heights (all 0, or far outside what Norway has) is left out.
 */
export function carRoadLines(segments) {
  const out = [];
  for (const s of segments || []) {
    if (!CAR_ROADS.has(s?.typeVeg) || s.detaljnivå === 'Kjørefelt') continue;
    for (const line of parseWktZ(s.geometri?.wkt)) {
      if (line.every((p) => p.z === 0) || line.some((p) => p.z < -400 || p.z > 2600)) continue;
      out.push(line);
    }
  }
  return out;
}

const projector = (bounds) => {
  const lat0 = (bounds.north + bounds.south) / 2, lon0 = (bounds.east + bounds.west) / 2;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110540;
  return (p) => [(p.lon - lon0) * kx, (p.lat - lat0) * ky];
};

const isStructureRoad = (el) => {
  const t = el?.tags;
  if (el?.type !== 'way' || !t?.highway || !(el.geometry?.length >= 2)) return false;
  const tunnel = t.tunnel && t.tunnel !== 'no';
  const bridge = (t.bridge && t.bridge !== 'no') || t.man_made === 'bridge';
  return !!(tunnel || bridge);
};

const encode = (line) => line.map((p) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)},${Math.round(p.z * 100) / 100}`).join(' ');

/** "lat,lon,z lat,lon,z ..." back as [{ lat, lon, z }]. */
export function decodeProfile(text) {
  const out = [];
  for (const part of String(text || '').split(' ')) {
    const [lat, lon, z] = part.split(',').map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(z)) out.push({ lat, lon, z });
  }
  return out;
}

/**
 * The network lines beside the map's bridge and tunnel roads, added to live OSM
 * `data` as ways tagged mapng:nvdb_profile. Returns { data, stats: { lines,
 * kept, structures } }; the input is not mutated.
 */
export function mergeNvdbProfiles(data, segments, bounds) {
  const elements = [...(data?.elements || [])];
  const project = projector(bounds);
  const lines = carRoadLines(segments);
  // the bridge and tunnel roads, as points every SAMPLE_M in a grid
  const cells = new Set();
  let structures = 0;
  for (const el of elements) {
    if (!isStructureRoad(el)) continue;
    structures++;
    for (let i = 0; i + 1 < el.geometry.length; i++) {
      const [ax, ay] = project(el.geometry[i]), [bx, by] = project(el.geometry[i + 1]);
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / SAMPLE_M));
      for (let k = 0; k <= n; k++) cells.add(`${Math.floor((ax + ((bx - ax) * k) / n) / NEAR_M)},${Math.floor((ay + ((by - ay) * k) / n) / NEAR_M)}`);
    }
  }
  const near = (x, y) => {
    const cx = Math.floor(x / NEAR_M), cy = Math.floor(y / NEAR_M);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if (cells.has(`${cx + i},${cy + j}`)) return true;
    return false;
  };
  let id = NVDB_PROFILE_ID_BASE, kept = 0;
  if (structures) {
    for (const line of lines) {
      let hit = false;
      for (let i = 0; i + 1 < line.length && !hit; i++) {
        const [ax, ay] = project(line[i]), [bx, by] = project(line[i + 1]);
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / SAMPLE_M));
        for (let k = 0; k <= n && !hit; k++) hit = near(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n);
      }
      if (!hit) continue;
      elements.push({
        type: 'way', id: id--,
        tags: { 'mapng:nvdb_profile': 'yes', 'mapng:profile': encode(line), 'mapng:source': 'nvdb' },
        geometry: [{ lat: line[0].lat, lon: line[0].lon }, { lat: line[line.length - 1].lat, lon: line[line.length - 1].lon }],
      });
      kept++;
    }
  }
  return { data: { ...data, elements }, stats: { lines: lines.length, kept, structures } };
}

// ---- the export's side: heights by place ----------------------------------------

/**
 * A lookup over 3D lines in the level's frame. lines: [[[x, y, z], ...]].
 * zAt(x, y, tx, ty, pick): the height of the line within REACH_M of (x, y)
 * running along (tx, ty) (either way), or NaN. Where several lie there (a
 * street over a tunnel, a ramp over a ramp) `pick` chooses: 'low' the lowest,
 * 'high' the highest, a number the one nearest that height.
 */
export function profileIndex(lines) {
  const cells = new Map();
  let count = 0;
  for (const line of lines || []) {
    for (let i = 0; i + 1 < line.length; i++) {
      const [ax, ay, az] = line[i], [bx, by, bz] = line[i + 1];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 0.05) continue;
      const seg = { ax, ay, az, bz, ux: (bx - ax) / len, uy: (by - ay) / len, len };
      count++;
      const x0 = Math.floor((Math.min(ax, bx) - REACH_M) / CELL_M), x1 = Math.floor((Math.max(ax, bx) + REACH_M) / CELL_M);
      const y0 = Math.floor((Math.min(ay, by) - REACH_M) / CELL_M), y1 = Math.floor((Math.max(ay, by) + REACH_M) / CELL_M);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const k = `${x},${y}`;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(seg);
      }
    }
  }
  const zAt = (x, y, tx, ty, pick = 'low', reach = REACH_M) => {
    let best = NaN, bestScore = Infinity;
    for (const seg of cells.get(`${Math.floor(x / CELL_M)},${Math.floor(y / CELL_M)}`) || []) {
      if (Math.abs(seg.ux * tx + seg.uy * ty) < MATCH_COS) continue;
      const t = Math.max(0, Math.min(seg.len, (x - seg.ax) * seg.ux + (y - seg.ay) * seg.uy));
      const d = Math.hypot(x - (seg.ax + seg.ux * t), y - (seg.ay + seg.uy * t));
      if (d > reach) continue;
      const z = seg.az + ((seg.bz - seg.az) * t) / seg.len;
      // (lines of one road lie within a metre of each other in height: of those, the nearest in plan)
      const score = (pick === 'low' ? z : pick === 'high' ? -z : Math.abs(z - pick)) + d * 0.05;
      if (score < bestScore) { bestScore = score; best = z; }
    }
    return best;
  };
  return { zAt, segments: count };
}

/**
 * The lookup for a level from its features (type nvdb_profile). toWorld(lat,
 * lng) -> [x, y]; zOffset is added to NVDB's heights (minus the level's lowest
 * height: the level's z starts there). Returns null when the map has none.
 */
export function profileIndexFromFeatures(features, toWorld, zOffset = 0) {
  const lines = [];
  for (const f of features || []) {
    if (f?.type !== 'nvdb_profile') continue;
    const points = decodeProfile(f.tags?.['mapng:profile']);
    if (points.length < 2) continue;
    lines.push(points.map((p) => { const w = toWorld(p.lat, p.lon); return [w[0], w[1], p.z + zOffset]; }));
  }
  if (!lines.length) return null;
  return { ...profileIndex(lines), lines: lines.length };
}

const BRIDGE_MIN_COVER = 0.6;  // a bridge measured at fewer of its stations keeps the inferred profile
const UNDER_GROUND_M = 1.5;    // a "bridge" height this far under the ground is another road's: not used

/**
 * Pins for the structure solver: every bridge edge of the graph (not a movable
 * span's raised leaf; NVDB has it closed, so those are pinned too) measured at
 * BRIDGE_MIN_COVER of its stations or more is pinned at NVDB's heights.
 * index: profileIndex in the level's frame; groundAt(x, y): the level's
 * ground. Returns { pins: [[k, i, z]], bridges: n, pinned: n }.
 */
export function nvdbBridgePins(graph, index, groundAt) {
  const pins = [];
  let bridges = 0, pinned = 0;
  (graph?.edges || []).forEach((e, k) => {
    if (!e.bridge || e.tunnel || e.external || e.s.length < 2) return;
    bridges++;
    const n = e.s.length;
    const z = new Float64Array(n).fill(NaN);
    let measured = 0, prev = NaN;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      const len = Math.hypot(e.x[b] - e.x[a], e.y[b] - e.y[a]) || 1;
      // (the highest line there to start with, then the one that carries on from the last station: a
      // ramp beside the deck at another height is not jumped to)
      const v = index.zAt(e.x[i], e.y[i], (e.x[b] - e.x[a]) / len, (e.y[b] - e.y[a]) / len, Number.isFinite(prev) ? prev : 'high');
      if (!Number.isFinite(v) || v < groundAt(e.x[i], e.y[i]) - UNDER_GROUND_M) continue;
      z[i] = v; prev = v; measured++;
    }
    if (measured < BRIDGE_MIN_COVER * n) return;
    pinned++;
    for (let i = 0; i < n; i++) if (Number.isFinite(z[i])) pins.push([k, i, z[i]]);
  });
  return { pins, bridges, pinned };
}

const TUNNEL_MIN_COVER = 0.7;  // a tunnel measured at fewer of its stations keeps the inferred profile
const TUNNEL_DEEP_M = 4;       // "under ground": this far under it ...
const TUNNEL_DEEP_SHARE = 0.4; // ... at this share of the measured stations, or the heights are a street's over it

/**
 * NVDB's heights along a tunnel's stations ([{ x, y, tx, ty }], tx/ty the
 * direction), gaps filled along the line, or null when NVDB has too little
 * there or what it has is not under the ground (g: the ground per station).
 */
export function measuredTunnelProfile(stations, g, index) {
  const n = stations.length;
  if (!index || n < 2) return null;
  const z = new Array(n).fill(NaN);
  let measured = 0, deep = 0, prev = NaN;
  for (let i = 0; i < n; i++) {
    const p = stations[i];
    // (the lowest line there to start with, then the one that carries on from the last station: the
    // other tube or a ramp beside it at another height is not jumped to)
    const v = index.zAt(p.x, p.y, p.tx, p.ty, Number.isFinite(prev) ? prev : 'low');
    if (!Number.isFinite(v)) continue;
    z[i] = v; prev = v; measured++;
    if (g[i] - v >= TUNNEL_DEEP_M) deep++;
  }
  if (measured < TUNNEL_MIN_COVER * n || deep < TUNNEL_DEEP_SHARE * measured) return null;
  // gaps: the straight line between their measured ends; past the last measured station, level
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(z[i])) continue;
    if (last < 0) for (let k = 0; k < i; k++) z[k] = z[i];
    else for (let k = last + 1; k < i; k++) z[k] = z[last] + ((z[i] - z[last]) * (k - last)) / (i - last);
    last = i;
  }
  for (let k = last + 1; k < n; k++) z[k] = z[last];
  return z;
}
