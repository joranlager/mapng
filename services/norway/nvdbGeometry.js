// The road network from NVDB (Statens vegvesen) for map areas in Norway: every
// road, path, junction, bridge and tunnel of the map comes from NVDB's surveyed
// network, and OpenStreetMap's are left out.
//
// NVDB's network (veglenkesekvenser, segmentert) is the centreline of every
// public road, and of the pavements, cycle tracks, footpaths, crossings and
// stairs beside them, as surveyed. Its pieces become the ways the app builds a
// level from, tagged in OSM's terms (highway class, name, ref, lanes, oneway,
// roundabout). Where a bridge (NVDB object 60) or a tunnel bore (67) is placed
// on a stretch of the network, the piece is cut there and that part tagged
// bridge or tunnel; a motorway (595) sets the class. Pieces that follow on from
// each other with the same tags are joined into one way.
//
// Junctions: roads that meet in NVDB end on the same point, and the app joins
// ways at shared points. Ends that lie within WELD_M of another way's point
// are given exactly that point, and an end lying on another way between two of
// its points puts a point into that way.
//
// From OSM's data every road and path way, every road area and bridge outline,
// and the junction nodes (signals, crossings, stop and give-way, turning
// circles, speed bumps, street lamps) are taken out. Speed limits, widths,
// surface, signs, signals, crossings and the rest are then put on by
// nvdbRoads.js, as before, from NVDB.
//
// API: NVDB API Les v4 (segments from nvdbNetwork.js). Licence: NLOD 2.0.
import { fetchNvdbObjects, propertyOf } from './nvdbRoads.js';

export const NORWAY_ROAD_GEOMETRY_STORAGE_KEY = 'mapng_norwayRoadGeometry';
// Ids stay clear of nvdbRoads.js (-3e12 down) and nvdbNetwork.js (-4e12 down).
export const NVDB_ROAD_ID_BASE = -5e12;

const WELD_M = 0.5;            // ends this close to another way's point, or to its line, are joined to it
const MIN_PART_M = 0.2;        // a cut leaving less than this is not made
const CELL_M = 20;

export const NVDB_STRUCTURE_TYPES = { bridge: 60, tunnel: 67, motorway: 595 };

// typeVeg -> what the way is. `car`: a road cars drive on (its class comes from the road category).
const ROAD_TYPES = {
  'Enkel bilveg': { car: true },
  'Kanalisert veg': { car: true },
  Rampe: { car: true, link: true },
  'Rundkjøring': { car: true, roundabout: true },
  Gatetun: { tags: { highway: 'living_street' }, car: true, fixed: true },
  'Gågate': { tags: { highway: 'pedestrian' } },
  Sykkelveg: { tags: { highway: 'cycleway' } },
  'Gang- og sykkelveg': { tags: { highway: 'cycleway', foot: 'designated', segregated: 'no' } },
  Gangveg: { tags: { highway: 'footway' } },
  Fortau: { tags: { highway: 'footway', footway: 'sidewalk' } },
  Gangfelt: { tags: { highway: 'footway', footway: 'crossing', crossing: 'marked', 'crossing:markings': 'zebra' } },
  Trapp: { tags: { highway: 'steps' } },
  Traktorveg: { tags: { highway: 'track' } },
  Sti: { tags: { highway: 'path' } },
};

// OSM nodes that say something about a road or a junction: NVDB's are used instead.
const ROAD_NODES = new Set(['traffic_signals', 'crossing', 'stop', 'give_way', 'mini_roundabout', 'turning_circle',
  'turning_loop', 'motorway_junction', 'passing_place', 'street_lamp', 'speed_camera']);

/** On unless switched off in settings (localStorage mapng_norwayRoadGeometry = "0"). */
export function norwayRoadGeometryEnabled(storage = globalThis.localStorage) {
  try { return storage?.getItem(NORWAY_ROAD_GEOMETRY_STORAGE_KEY) !== '0'; } catch { return true; }
}

const parseLine = (wkt) => {
  const m = /^\s*LINESTRING\s*(?:Z|ZM)?\s*\(([^()]*)\)\s*$/i.exec(String(wkt || ''));
  if (!m) return [];
  const out = [];
  for (const part of m[1].split(',')) {
    const [lat, lon] = part.trim().split(/\s+/).map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon)) out.push({ lat, lon });
  }
  return out;
};

/** Car lanes of a segment's lane list ("1", "2", "3K", "4S"...): { with, against } (cycle lanes left out). */
export function carLanes(lanes) {
  let odd = 0, even = 0;
  for (const code of lanes || []) {
    const m = /^(\d+)([A-Za-z]*)/.exec(String(code));
    if (!m || /S/i.test(m[2])) continue;
    if (Number(m[1]) % 2) odd++; else even++;
  }
  return { with: odd, against: even };
}

/** 'one' (lanes one way only), 'two' (both ways) or null (not said). */
export function carriagewayKind(lanes) {
  const n = carLanes(lanes);
  if (!n.with && !n.against) return null;
  return n.with && n.against ? 'two' : 'one';
}

const refOf = (v) => (!v?.nummer || !/^[ERF]$/.test(v.vegkategori) ? null
  : v.vegkategori === 'E' ? `E ${v.nummer}` : v.vegkategori === 'R' ? `Rv ${v.nummer}` : `Fv ${v.nummer}`);

const classOf = (v, link) => {
  switch (v?.vegkategori) {
    case 'E': return link ? 'trunk_link' : 'trunk';
    case 'R': return link ? 'primary_link' : 'primary';
    case 'F': return v.nummer < 1000 ? (link ? 'secondary_link' : 'secondary') : (link ? 'tertiary_link' : 'tertiary');
    case 'K': return 'residential';
    case 'P': return 'service';
    case 'S': return 'track';
    default: return 'unclassified';
  }
};

/**
 * Where bridges, tunnels and motorways lie on the network: Map(road link
 * sequence id -> [{ from, to, kind }]), kind 'bridge' | 'tunnel' | 'motorway'
 * | 'motorroad'. objects: { bridge: [...], tunnel: [...], motorway: [...] }
 * (NVDB objects with their lokasjon).
 */
export function structureSpans(objects) {
  const spans = new Map();
  const put = (o, kind) => {
    for (const s of o?.lokasjon?.stedfestinger || []) {
      const from = Number(s.startposisjon), to = Number(s.sluttposisjon);
      if (s.veglenkesekvensid == null || !(to > from)) continue;
      const key = String(s.veglenkesekvensid);
      if (!spans.has(key)) spans.set(key, []);
      spans.get(key).push({ from, to, kind });
    }
  };
  for (const o of objects?.bridge || []) {
    // (a road or footbridge; not a culvert under a fill, a quay, a ferry berth or a retaining wall)
    if (/^(vegbru|g\/s-bru)/i.test(String(propertyOf(o, 'Brukategori') || '').trim())) put(o, 'bridge');
  }
  for (const o of objects?.tunnel || []) put(o, 'tunnel');
  for (const o of objects?.motorway || []) put(o, /motortrafikk/i.test(String(propertyOf(o, 'Motorvegtype') || '')) ? 'motorroad' : 'motorway');
  return spans;
}

/** The bridges, tunnel bores and motorways in the box, with where they lie on the network. */
export async function fetchNvdbStructures(bounds, opts = {}) {
  const kinds = Object.keys(NVDB_STRUCTURE_TYPES);
  const lists = await Promise.all(kinds.map((kind) => fetchNvdbObjects(NVDB_STRUCTURE_TYPES[kind], bounds, { ...opts, include: 'egenskaper,lokasjon' })));
  return Object.fromEntries(kinds.map((kind, i) => [kind, lists[i]]));
}

const projector = (bounds) => {
  const lat0 = (bounds.north + bounds.south) / 2, lon0 = (bounds.east + bounds.west) / 2;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110540;
  const project = (p) => [(p.lon - lon0) * kx, (p.lat - lat0) * ky];
  project.back = (x, y) => ({ lat: lat0 + y / ky, lon: lon0 + x / kx });
  return project;
};

/** The part of a line between two shares of its length (0..1), end points worked out on the line. */
function partOfLine(points, project, f0, f1) {
  const xy = points.map(project);
  const at = [0];
  for (let i = 1; i < xy.length; i++) at.push(at[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  const total = at[at.length - 1];
  const s0 = f0 * total, s1 = f1 * total;
  if (!(total > 0) || s1 - s0 < MIN_PART_M) return null;
  const pointAt = (s) => {
    let i = 1;
    while (i < at.length - 1 && at[i] < s) i++;
    const t = at[i] > at[i - 1] ? (s - at[i - 1]) / (at[i] - at[i - 1]) : 0;
    return project.back(xy[i - 1][0] + (xy[i][0] - xy[i - 1][0]) * t, xy[i - 1][1] + (xy[i][1] - xy[i - 1][1]) * t);
  };
  const out = [f0 <= 0 ? points[0] : pointAt(s0)];
  for (let i = 1; i < points.length - 1; i++) if (at[i] > s0 + 0.05 && at[i] < s1 - 0.05) out.push(points[i]);
  out.push(f1 >= 1 ? points[points.length - 1] : pointAt(s1));
  return out;
}

/**
 * The network as ways in OSM's terms: [{ type: 'way', id, tags, geometry:
 * [{ lat, lon }] }]. segments: fetchNvdbNetwork's; spans: structureSpans's.
 * Planned roads, and the road-level line of a road whose carriageways have
 * their own lines, are left out.
 */
export function nvdbRoadWays(segments, spans = new Map(), bounds) {
  const project = projector(bounds);
  const bySequence = new Map();
  for (const s of segments || []) {
    const type = ROAD_TYPES[s?.typeVeg];
    if (!type || s.detaljnivå === 'Vegtrase' || s.detaljnivå === 'Kjørefelt') continue;
    const system = s.vegsystemreferanse?.vegsystem;
    if (system?.fase && system.fase !== 'V') continue;
    const points = parseLine(s.geometri?.wkt);
    if (points.length < 2) continue;
    const from = Number(s.startposisjon), to = Number(s.sluttposisjon);
    const lanes = carLanes(s.feltoversikt);
    const oneWay = type.car && (type.roundabout || (lanes.with > 0) !== (lanes.against > 0));
    const base = type.car ? {
      highway: type.fixed ? type.tags.highway : classOf(system, type.link),
      ...(s.adresse?.navn ? { name: s.adresse.navn } : {}),
      ...(refOf(system) ? { ref: refOf(system) } : {}),
      ...(type.roundabout ? { junction: 'roundabout' } : {}),
      ...(oneWay ? { oneway: 'yes' } : {}),
      ...(lanes.with + lanes.against > 0 ? { lanes: String(lanes.with + lanes.against) } : {}),
    } : { ...type.tags, ...(s.adresse?.navn && type.tags.highway === 'pedestrian' ? { name: s.adresse.navn } : {}) };
    // (lanes against the metering direction only, even numbers: the line is drawn against the traffic)
    const against = !!type.car && lanes.against > 0 && !lanes.with;

    // cut where a bridge, tunnel or motorway starts or ends on this piece
    const here = (spans.get(String(s.veglenkesekvensid)) || []).filter((sp) => sp.to > from + 1e-9 && sp.from < to - 1e-9);
    const cuts = [from, to];
    if (to > from) for (const sp of here) for (const c of [sp.from, sp.to]) if (c > from + 1e-9 && c < to - 1e-9) cuts.push(c);
    cuts.sort((a, b) => a - b);
    const key = s.veglenkesekvensid ?? `x${bySequence.size}`;
    if (!bySequence.has(key)) bySequence.set(key, []);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const a = cuts[i], b = cuts[i + 1];
      if (b - a < 1e-9 && cuts.length > 2) continue;
      const part = cuts.length === 2 ? points : partOfLine(points, project, (a - from) / (to - from), (b - from) / (to - from));
      if (!part || part.length < 2) continue;
      const mid = (a + b) / 2;
      const on = (kind) => here.some((sp) => sp.kind === kind && sp.from <= mid && sp.to >= mid);
      const tags = { ...base };
      if (type.car && !type.fixed && !type.link && !type.roundabout) {
        if (on('motorway')) tags.highway = 'motorway';
        else if (on('motorroad')) { tags.highway = 'trunk'; tags.motorroad = 'yes'; }
      } else if (type.link && on('motorway')) tags.highway = 'motorway_link';
      if (on('tunnel')) { tags.tunnel = 'yes'; tags.layer = '-1'; }
      else if (on('bridge')) { tags.bridge = 'yes'; tags.layer = '1'; }
      bySequence.get(key).push({ points: part, tags, from: a, to: b, against, sign: `${against}|${JSON.stringify(tags)}` });
    }
  }
  // pieces that follow on with the same tags: one way
  const same = (a, b) => Math.abs(a.lat - b.lat) < 5e-6 && Math.abs(a.lon - b.lon) < 1e-5;
  const ways = [];
  let id = NVDB_ROAD_ID_BASE;
  for (const pieces of bySequence.values()) {
    pieces.sort((a, b) => a.from - b.from);
    let line = null;
    const close = () => {
      // (a way turned round to run with its traffic no longer runs in NVDB's metering direction: said, for what
      // NVDB places by the side of that direction)
      if (line) ways.push({ type: 'way', id: id--, tags: { ...line.tags, 'mapng:source': 'nvdb', ...(line.against ? { 'mapng:nvdb_reversed': 'yes' } : {}) }, geometry: (line.against ? [...line.points].reverse() : line.points).map((p) => ({ lat: p.lat, lon: p.lon })) });
    };
    for (const p of pieces) {
      if (line && line.sign === p.sign && Math.abs(line.to - p.from) < 1e-6 && same(line.points[line.points.length - 1], p.points[0])) {
        line.points.push(...p.points.slice(1)); line.to = p.to;
        continue;
      }
      close();
      line = { points: [...p.points], tags: p.tags, to: p.to, against: p.against, sign: p.sign };
    }
    close();
  }
  return ways;
}

/**
 * Ways joined where they meet: an end within WELD_M of another way's point
 * takes exactly that point; an end on another way's line between two of its
 * points puts a point into that way. Mutates the ways' geometry. Returns
 * { welded, spliced }.
 */
export function weldWays(ways, bounds) {
  const project = projector(bounds);
  const cellOf = (x, y) => `${Math.floor(x / CELL_M)},${Math.floor(y / CELL_M)}`;
  const points = new Map();     // cell -> [{ x, y, p }]: every point, the first at a spot being the one others take
  const lines = new Map();      // cell -> Set(way index)
  const addPoint = (p) => {
    const [x, y] = project(p);
    const k = cellOf(x, y);
    if (!points.has(k)) points.set(k, []);
    points.get(k).push({ x, y, p });
  };
  ways.forEach((w, index) => {
    w.geometry.forEach(addPoint);
    for (let i = 0; i + 1 < w.geometry.length; i++) {
      const [ax, ay] = project(w.geometry[i]), [bx, by] = project(w.geometry[i + 1]);
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (CELL_M / 2)));
      for (let k = 0; k <= n; k++) {
        const c = cellOf(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n);
        if (!lines.has(c)) lines.set(c, new Set());
        lines.get(c).add(index);
      }
    }
  });
  const around = (map, x, y) => {
    const out = [];
    const cx = Math.floor(x / CELL_M), cy = Math.floor(y / CELL_M);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const v = map.get(`${cx + i},${cy + j}`); if (v) out.push(v); }
    return out;
  };
  const stats = { welded: 0, spliced: 0 };
  ways.forEach((w, index) => {
    for (const end of [0, w.geometry.length - 1]) {
      const e = w.geometry[end];
      const [x, y] = project(e);
      // another point there already (not this end itself)
      let best = null;
      for (const list of around(points, x, y)) for (const q of list) {
        if (q.p === e) continue;
        const d = Math.hypot(q.x - x, q.y - y);
        if (d <= WELD_M && (!best || d < best.d)) best = { d, q };
      }
      if (best) {
        if (best.q.p.lat !== e.lat || best.q.p.lon !== e.lon) { e.lat = best.q.p.lat; e.lon = best.q.p.lon; stats.welded++; }
        continue;
      }
      // on another way's line, between two of its points
      let hit = null;
      for (const set of around(lines, x, y)) for (const other of set) {
        if (other === index) continue;
        const g = ways[other].geometry;
        for (let i = 0; i + 1 < g.length; i++) {
          const [ax, ay] = project(g[i]), [bx, by] = project(g[i + 1]);
          const len = Math.hypot(bx - ax, by - ay);
          if (len < 0.02) continue;
          const t = Math.max(0, Math.min(len, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len));
          const d = Math.hypot(x - (ax + ((bx - ax) * t) / len), y - (ay + ((by - ay) * t) / len));
          if (d <= WELD_M && (!hit || d < hit.d)) hit = { d, other, i };
        }
      }
      if (!hit) continue;
      const joint = { lat: e.lat, lon: e.lon };
      ways[hit.other].geometry.splice(hit.i + 1, 0, joint);
      addPoint(joint);
      stats.spliced++;
    }
  });
  return stats;
}

const isOsmRoad = (el) => {
  const t = el?.tags;
  if (!t || t['mapng:source'] === 'nvdb') return false;
  if (el.type === 'way' || el.type === 'relation') return !!(t.highway || t['area:highway'] || t.man_made === 'bridge');
  if (el.type === 'node') return ROAD_NODES.has(t.highway) || (!!t.traffic_calming && t.traffic_calming !== 'no');
  return false;
};

/**
 * Live OSM `data` with its roads, paths, bridges and junction nodes replaced
 * by NVDB's network. structures: fetchNvdbStructures's objects. When NVDB has
 * no car road in the box (outside its cover) the data is returned as it was.
 * Returns { data, stats: { roads, paths, bridges, tunnels, welded, spliced,
 * osmWays, osmNodes } }; the input is not mutated.
 */
export function replaceRoadsWithNvdb(data, segments, structures, bounds) {
  const ways = nvdbRoadWays(segments, structureSpans(structures), bounds);
  const car = (w) => !['footway', 'cycleway', 'steps', 'path', 'pedestrian'].includes(w.tags.highway);
  const stats = {
    roads: ways.filter(car).length, paths: ways.filter((w) => !car(w)).length,
    bridges: ways.filter((w) => w.tags.bridge).length, tunnels: ways.filter((w) => w.tags.tunnel).length,
    welded: 0, spliced: 0, osmWays: 0, osmNodes: 0,
  };
  if (!stats.roads) return { data, stats };
  Object.assign(stats, weldWays(ways, bounds));
  const elements = [];
  for (const el of data?.elements || []) {
    if (isOsmRoad(el)) { if (el.type === 'node') stats.osmNodes++; else stats.osmWays++; continue; }
    elements.push(el);
  }
  elements.push(...ways);
  return { data: { ...data, elements }, stats };
}
