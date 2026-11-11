// Road geometry from NVDB's road network (Statens vegvesen) for map areas in
// Norway: the roads run where NVDB surveyed them.
//
// The map's roads are OpenStreetMap ways: they carry what the level is built
// from (class, name, lanes, sidewalks, junctions, bridges, tunnels) and they
// join each other at shared points. NVDB's network is the surveyed centreline
// of the same roads. Here every point of an OSM road that NVDB has a line for
// is moved onto that line, and NVDB's own points between two moved points are
// put in, so the road follows NVDB's curve. A point is moved once, for every
// way and node that shares it: roads that met still meet. A junction lands
// where the NVDB lines of its roads cross. A road NVDB has and OSM lacks is
// added as a new way, joined to the road it ends on.
//
// A one-way OSM carriageway is matched to one-way NVDB lines only (and a
// two-way road to two-way lines): the two carriageways of a divided road are
// never drawn onto the single centreline NVDB keeps for some of them.
//
// API: NVDB API Les v4 (the segments nvdbNetwork.js reads). Licence: NLOD 2.0.

export const NORWAY_ROAD_GEOMETRY_STORAGE_KEY = 'mapng_norwayRoadGeometry';
// Ids stay clear of nvdbRoads.js (-3e12 down) and nvdbNetwork.js (-4e12 down).
export const NVDB_ROAD_ID_BASE = -5e12;

const MATCH_M = 9;             // an NVDB line this close to an OSM road point, running the same way, is that road
const MATCH_COS = 0.8;
const MIN_WAY_SHARE = 0.5;     // a way with fewer of its points on NVDB lines is left where it is
const CELL_M = 40;
const SAMPLE_M = 10;
const NEW_ROAD_MIN_M = 30;     // an NVDB road OSM lacks, at least this long, is added
const NEW_ROAD_SHARE = 0.2;    // "lacks": fewer of its samples than this lie on any OSM way
const NEW_ROAD_REACH_M = 12;
const JOIN_REACH_M = 2;        // a new road's end this close to a road is joined to it
const TIDY_TINY_M = 0.3;       // a leg shorter than this after the move: one of its points goes
const TIDY_LEG_M = 12;         // a turn sharper than TIDY_COS with a leg shorter than this is a leftover, not a hairpin
const TIDY_COS = -0.2;

const CAR_ROADS = new Set(['Enkel bilveg', 'Kanalisert veg', 'Rampe', 'Rundkjøring', 'Gatetun']);

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

/** 'one' (lanes one way only), 'two' (both ways) or null (not said), from a segment's lane list ("1", "2", "3K", "4S"...). */
export function carriagewayKind(lanes) {
  let odd = 0, even = 0;
  for (const code of lanes || []) {
    const m = /^(\d+)([A-Za-z]*)/.exec(String(code));
    if (!m || /S/i.test(m[2])) continue;          // (a cycle lane is not a carriageway's direction)
    if (Number(m[1]) % 2) odd++; else even++;
  }
  if (!odd && !even) return null;
  return odd && even ? 'two' : 'one';
}

const refOf = (s) => {
  const v = s?.vegsystemreferanse?.vegsystem;
  if (!v?.nummer || !/^[ERF]$/.test(v.vegkategori)) return null;
  return v.vegkategori === 'E' ? `E ${v.nummer}` : v.vegkategori === 'R' ? `Rv ${v.nummer}` : `Fv ${v.nummer}`;
};

const highwayOf = (s) => {
  const v = s?.vegsystemreferanse?.vegsystem;
  const link = s.typeVeg === 'Rampe';
  switch (v?.vegkategori) {
    case 'E': return link ? 'trunk_link' : 'trunk';
    case 'R': return link ? 'primary_link' : 'primary';
    case 'F': return v.nummer < 1000 ? (link ? 'secondary_link' : 'secondary') : 'tertiary';
    case 'K': return 'residential';
    case 'P': return 'service';
    case 'S': return 'track';
    default: return 'unclassified';
  }
};

/**
 * The car roads of the network as lines: [{ points: [{ lat, lon }], kind,
 * tags }]. Pieces of one road link sequence that follow on from each other
 * (same carriageway kind) are joined into one line. Planned roads, and the
 * road-level line of a road whose carriageways have their own lines, are left out.
 */
export function roadLines(segments) {
  const bySequence = new Map();
  for (const s of segments || []) {
    if (!CAR_ROADS.has(s?.typeVeg) || s.detaljnivå === 'Vegtrase' || s.detaljnivå === 'Kjørefelt') continue;
    const phase = s.vegsystemreferanse?.vegsystem?.fase;
    if (phase && phase !== 'V') continue;
    const points = parseLine(s.geometri?.wkt);
    if (points.length < 2) continue;
    const kind = carriagewayKind(s.feltoversikt);
    const oneWay = kind === 'one' || s.typeVeg === 'Rundkjøring';
    const tags = {
      highway: highwayOf(s),
      ...(s.adresse?.navn ? { name: s.adresse.navn } : {}),
      ...(refOf(s) ? { ref: refOf(s) } : {}),
      ...(s.typeVeg === 'Rundkjøring' ? { junction: 'roundabout' } : {}),
      ...(oneWay ? { oneway: 'yes' } : {}),
    };
    // (lanes against the metering direction only, even numbers: the line is drawn against the traffic)
    const against = kind === 'one' && s.typeVeg !== 'Rundkjøring'
      && (s.feltoversikt || []).some((c) => !/S/i.test(String(c)) && Number.parseInt(c, 10) % 2 === 0);
    const piece = { points: against ? [...points].reverse() : points, kind, tags, from: Number(s.startposisjon), to: Number(s.sluttposisjon), against };
    const key = s.veglenkesekvensid ?? `x${bySequence.size}`;
    if (!bySequence.has(key)) bySequence.set(key, []);
    bySequence.get(key).push(piece);
  }
  const lines = [];
  const same = (a, b) => Math.abs(a.lat - b.lat) < 5e-6 && Math.abs(a.lon - b.lon) < 1e-5;
  for (const pieces of bySequence.values()) {
    pieces.sort((a, b) => a.from - b.from);
    let line = null;
    for (const p of pieces) {
      const follows = line && !p.against && !line.against && line.kind === p.kind && line.tags.highway === p.tags.highway
        && line.tags.name === p.tags.name && Math.abs(line.to - p.from) < 1e-6 && same(line.points[line.points.length - 1], p.points[0]);
      if (follows) { line.points.push(...p.points.slice(1)); line.to = p.to; continue; }
      line = { points: [...p.points], kind: p.kind, tags: p.tags, to: p.to, against: p.against };
      lines.push(line);
    }
  }
  return lines.map(({ points, kind, tags }) => ({ points, kind, tags }));
}

const projector = (bounds) => {
  const lat0 = (bounds.north + bounds.south) / 2, lon0 = (bounds.east + bounds.west) / 2;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110540;
  const project = (p) => [(p.lon - lon0) * kx, (p.lat - lat0) * ky];
  project.back = (x, y) => ({ lat: lat0 + y / ky, lon: lon0 + x / kx });
  return project;
};

const isHighway = (el) => el?.type === 'way' && el.tags?.highway && el.geometry?.length >= 2;
// (the classes NVDB's car roads can be: a bus platform or a pedestrian street beside a road is not drawn onto it)
const ROAD_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
  'living_street', 'service', 'road', 'track', 'busway', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
const isDrivable = (el) => isHighway(el) && ROAD_CLASSES.has(el.tags.highway) && el.tags.area !== 'yes';
const keyOf = (p) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;

/** A grid over line pieces [{ ax, ay, bx, by, ... }]: near(x, y, reach) -> the pieces around. */
function pieceGrid(reach) {
  const cells = new Map();
  return {
    add(seg) {
      const x0 = Math.floor((Math.min(seg.ax, seg.bx) - reach) / CELL_M), x1 = Math.floor((Math.max(seg.ax, seg.bx) + reach) / CELL_M);
      const y0 = Math.floor((Math.min(seg.ay, seg.by) - reach) / CELL_M), y1 = Math.floor((Math.max(seg.ay, seg.by) + reach) / CELL_M);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const k = `${x},${y}`;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(seg);
      }
    },
    near: (x, y) => cells.get(`${Math.floor(x / CELL_M)},${Math.floor(y / CELL_M)}`) || [],
  };
}

const onPiece = (seg, x, y) => {
  const t = Math.max(0, Math.min(seg.len, (x - seg.ax) * seg.ux + (y - seg.ay) * seg.uy));
  const px = seg.ax + seg.ux * t, py = seg.ay + seg.uy * t;
  return { x: px, y: py, d: Math.hypot(x - px, y - py), s: seg.s0 + t };
};

/**
 * OSM roads moved onto NVDB's lines, NVDB's points between them put in, and
 * NVDB roads OSM lacks added. data: live OSM ({ elements }); segments: the
 * network's segments (fetchNvdbNetwork). Returns { data, stats: { lines, ways,
 * snapped, moved, inserted, added, meanMove, maxMove } }; the input is not mutated.
 */
export function mergeNvdbGeometry(data, segments, bounds) {
  const elements = [...(data?.elements || [])];
  const project = projector(bounds);
  const lines = roadLines(segments);
  const stats = { lines: lines.length, ways: 0, snapped: 0, moved: 0, inserted: 0, added: 0, meanMove: 0, maxMove: 0 };
  if (!lines.length) return { data: { ...data, elements }, stats };

  // -- the NVDB lines in metres, their pieces in a grid
  const grid = pieceGrid(MATCH_M);
  const shapes = lines.map((line, id) => {
    const xy = line.points.map(project);
    const pieces = [];
    let s = 0;
    const at = [0];
    for (let i = 0; i + 1 < xy.length; i++) {
      const [ax, ay] = xy[i], [bx, by] = xy[i + 1];
      const len = Math.hypot(bx - ax, by - ay);
      if (len >= 0.02) {
        const seg = { line: id, ax, ay, bx, by, ux: (bx - ax) / len, uy: (by - ay) / len, len, s0: s };
        pieces.push(seg); grid.add(seg);
      }
      s += len;
      at.push(s);
    }
    return { xy, at, pieces, length: s, kind: line.kind };
  });
  const nearestOn = (id, x, y) => {
    let best = null;
    for (const seg of shapes[id].pieces) { const p = onPiece(seg, x, y); if (!best || p.d < best.d) best = p; }
    return best;
  };

  // -- every drivable way's points matched to a line
  const ways = [];
  elements.forEach((el, index) => {
    if (!isDrivable(el)) return;
    stats.ways++;
    const xy = el.geometry.map(project);
    const oneWay = el.tags.oneway === 'yes' || el.tags.oneway === '-1' || el.tags.junction === 'roundabout';
    const hits = xy.map(([x, y], i) => {
      const a = xy[Math.max(0, i - 1)], b = xy[Math.min(xy.length - 1, i + 1)];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const dx = (b[0] - a[0]) / len, dy = (b[1] - a[1]) / len;
      let best = null;
      for (const seg of grid.near(x, y)) {
        const kind = shapes[seg.line].kind;
        if (kind && (kind === 'one') !== oneWay) continue;
        if (Math.abs(seg.ux * dx + seg.uy * dy) < MATCH_COS) continue;
        const p = onPiece(seg, x, y);
        if (p.d <= MATCH_M && (!best || p.d < best.d)) best = { ...p, line: seg.line };
      }
      return best;
    });
    const share = hits.filter(Boolean).length / hits.length;
    if (share < MIN_WAY_SHARE) return;
    ways.push({ index, el, xy, hits });
  });

  // -- one move per shared point: where the lines of the roads through it meet
  const candidates = new Map();
  for (const w of ways) {
    w.hits.forEach((h, i) => {
      if (!h) return;
      const k = keyOf(w.el.geometry[i]);
      if (!candidates.has(k)) candidates.set(k, []);
      candidates.get(k).push({ ...h, through: i > 0 && i < w.hits.length - 1 });
    });
  }
  const moves = new Map();
  // (places already holding a point: every road point that is not moved, then each move's target)
  const taken = new Set();
  for (const el of elements) if (isHighway(el)) for (const p of el.geometry) { const k = keyOf(p); if (!candidates.has(k)) taken.add(k); }
  let moveSum = 0;
  for (const [k, list] of candidates) {
    list.sort((a, b) => (b.through - a.through) || (a.d - b.d));
    let { x, y } = list[0];
    const others = [...new Set(list.map((c) => c.line))];
    if (others.length > 1) {
      for (let round = 0; round < 3; round++) for (const id of others) { const p = nearestOn(id, x, y); if (p) { x = p.x; y = p.y; } }
    }
    const [ox, oy] = (() => { const [lat, lon] = k.split(',').map(Number); return project({ lat, lon }); })();
    const moved = Math.hypot(x - ox, y - oy);
    if (moved > MATCH_M * 1.5) continue;           // (lines that do not meet near here: the point stays)
    // two points never land on one spot (the two halves of a staggered junction, a few metres apart, both
    // drawn to where the lines cross): roads that did not meet would. The later one takes its own nearest
    // place on its line, or stays.
    let to = project.back(x, y);
    if (taken.has(keyOf(to))) {
      to = project.back(list[0].x, list[0].y);
      if (taken.has(keyOf(to))) continue;
    }
    taken.add(keyOf(to));
    moves.set(k, to);
    moveSum += moved; stats.maxMove = Math.max(stats.maxMove, moved);
  }
  // no leg of a road may turn round: two junction points a few metres apart can swap places along the line
  // when each is drawn to its own crossing. Of such a leg's two points, the one moved farther stays where it was.
  for (let round = 0; round < 4; round++) {
    let undone = 0;
    for (const w of ways) {
      const g = w.el.geometry;
      const at = (i) => { const to = moves.get(keyOf(g[i])); return to ? project(to) : w.xy[i]; };
      for (let i = 0; i + 1 < g.length; i++) {
        const ka = keyOf(g[i]), kb = keyOf(g[i + 1]);
        if (ka === kb || (!moves.has(ka) && !moves.has(kb))) continue;
        const a = at(i), b = at(i + 1);
        const ox = w.xy[i + 1][0] - w.xy[i][0], oy = w.xy[i + 1][1] - w.xy[i][1];
        const mx = b[0] - a[0], my = b[1] - a[1];
        const turned = ox * mx + oy * my < 0;
        const shrunk = Math.hypot(mx, my) < TIDY_TINY_M && Math.hypot(ox, oy) >= TIDY_TINY_M;
        if (!turned && !shrunk) continue;
        const da = moves.has(ka) ? Math.hypot(a[0] - w.xy[i][0], a[1] - w.xy[i][1]) : -1;
        const db = moves.has(kb) ? Math.hypot(b[0] - w.xy[i + 1][0], b[1] - w.xy[i + 1][1]) : -1;
        moves.delete(da >= db ? ka : kb);
        undone++;
      }
    }
    if (!undone) break;
  }
  moveSum = 0; stats.maxMove = 0;
  for (const [k, to] of moves) {
    const [lat, lon] = k.split(',').map(Number);
    const [ox, oy] = project({ lat, lon }), [x, y] = project(to);
    const d = Math.hypot(x - ox, y - oy);
    moveSum += d; stats.maxMove = Math.max(stats.maxMove, d);
  }
  stats.moved = moves.size;
  stats.meanMove = moves.size ? Math.round((moveSum / moves.size) * 100) / 100 : 0;
  stats.maxMove = Math.round(stats.maxMove * 100) / 100;

  // -- the moves, on every road and path and on the nodes at those points
  const snappedWays = new Map(ways.map((w) => [w.index, w]));
  elements.forEach((el, index) => {
    if (el.type === 'node' && Number.isFinite(el.lat) && Number.isFinite(el.lon)) {
      const to = moves.get(keyOf(el));
      if (to) elements[index] = { ...el, lat: to.lat, lon: to.lon };
      return;
    }
    if (!isHighway(el)) return;
    const w = snappedWays.get(index);
    let changed = false;
    const geometry = [];
    for (let i = 0; i < el.geometry.length; i++) {
      const p = el.geometry[i];
      const to = moves.get(keyOf(p));
      if (to) changed = true;
      const q = to ? { ...p, lat: to.lat, lon: to.lon } : p;
      // NVDB's own points between this point and the last, where both lie on the same line
      if (w && i > 0) {
        const a = w.hits[i - 1], b = w.hits[i];
        if (a && b && a.line === b.line) {
          const [px, py] = project(geometry[geometry.length - 1]), [qx, qy] = project(q);
          const sa = nearestOn(a.line, px, py)?.s ?? a.s, sb = nearestOn(b.line, qx, qy)?.s ?? b.s;
          if (Math.abs(sb - sa) <= 2.5 * Math.hypot(qx - px, qy - py) + 10) {
            const shape = shapes[a.line];
            const lo = Math.min(sa, sb) + 0.5, hi = Math.max(sa, sb) - 0.5;
            const between = [];
            for (let j = 0; j < shape.at.length; j++) if (shape.at[j] > lo && shape.at[j] < hi) between.push(j);
            if (sb < sa) between.reverse();
            for (const j of between) { geometry.push(project.back(shape.xy[j][0], shape.xy[j][1])); stats.inserted++; changed = true; }
          }
        }
      }
      // (two points moved onto the same spot: one is enough)
      const last = geometry[geometry.length - 1];
      if (last && Math.abs(last.lat - q.lat) < 1e-8 && Math.abs(last.lon - q.lon) < 1e-8) continue;
      geometry.push(q);
    }
    if (!changed || geometry.length < 2) return;
    elements[index] = { ...el, geometry, ...(w ? { tags: { ...el.tags, 'mapng:nvdb_geometry': 'yes' } } : {}) };
    if (w) stats.snapped++;
  });

  // -- tidying: a junction point slides along its road when it is moved, and the next point of a road ending
  // there can be left behind it (a short leg back on itself), or on top of it. Such a point goes, unless
  // another road or path shares it.
  const usage = new Map();
  for (const el of elements) if (isHighway(el)) for (const k of new Set(el.geometry.map(keyOf))) usage.set(k, (usage.get(k) || 0) + 1);
  for (const index of snappedWays.keys()) {
    const el = elements[index];
    const g = [...el.geometry];
    const free = (j) => j > 0 && j < g.length - 1 && usage.get(keyOf(g[j])) === 1;
    let removed = false;
    for (let pass = 0; pass < 8; pass++) {
      let drop = -1;
      for (let j = 1; j + 1 < g.length && drop < 0; j++) {
        const [px, py] = project(g[j - 1]), [qx, qy] = project(g[j]), [rx, ry] = project(g[j + 1]);
        const la = Math.hypot(qx - px, qy - py), lb = Math.hypot(rx - qx, ry - qy);
        const tiny = la < TIDY_TINY_M || lb < TIDY_TINY_M;
        const back = !tiny && Math.min(la, lb) < TIDY_LEG_M && ((qx - px) * (rx - qx) + (qy - py) * (ry - qy)) / (la * lb) < TIDY_COS;
        if (!tiny && !back) continue;
        // the point itself, else the far end of its shorter leg
        const other = la <= lb ? j - 1 : j + 1;
        drop = free(j) ? j : free(other) ? other : -1;
      }
      if (drop < 0) break;
      g.splice(drop, 1);
      removed = true;
    }
    if (removed && g.length >= 2) { elements[index] = { ...el, geometry: g }; stats.tidied = (stats.tidied || 0) + 1; }
  }

  // -- NVDB roads OSM lacks
  const osmGrid = pieceGrid(NEW_ROAD_REACH_M);
  const addOsmPieces = (el, index) => {
    for (let i = 0; i + 1 < el.geometry.length; i++) {
      const [ax, ay] = project(el.geometry[i]), [bx, by] = project(el.geometry[i + 1]);
      const len = Math.hypot(bx - ax, by - ay);
      if (len >= 0.02) osmGrid.add({ ax, ay, bx, by, ux: (bx - ax) / len, uy: (by - ay) / len, len, s0: 0, index, i, drivable: isDrivable(el) });
    }
  };
  elements.forEach((el, index) => { if (isHighway(el)) addOsmPieces(el, index); });
  const inBox = (p) => p.lat >= bounds.south && p.lat <= bounds.north && p.lon >= bounds.west && p.lon <= bounds.east;
  let id = NVDB_ROAD_ID_BASE;
  const fresh = [];
  shapes.forEach((shape, lineId) => {
    if (shape.length < NEW_ROAD_MIN_M) return;
    let samples = 0, covered = 0;
    for (const seg of shape.pieces) {
      const n = Math.max(1, Math.round(seg.len / SAMPLE_M));
      for (let k = 0; k < n; k++) {
        const x = seg.ax + seg.ux * seg.len * ((k + 0.5) / n), y = seg.ay + seg.uy * seg.len * ((k + 0.5) / n);
        samples++;
        if (osmGrid.near(x, y).some((o) => Math.abs(o.ux * seg.ux + o.uy * seg.uy) >= 0.7 && onPiece(o, x, y).d <= NEW_ROAD_REACH_M)) covered++;
      }
    }
    if (!samples || covered / samples >= NEW_ROAD_SHARE) return;
    const line = lines[lineId];
    if (!line.points.some(inBox)) return;
    fresh.push({ type: 'way', id: id--, tags: { ...line.tags, 'mapng:source': 'nvdb', 'mapng:nvdb_geometry': 'yes' }, geometry: line.points.map((p) => ({ lat: p.lat, lon: p.lon })) });
  });
  // each new road's ends joined to the road they lie on: a shared point, put into that road where it has none there
  for (const way of fresh) {
    for (const end of [0, way.geometry.length - 1]) {
      const [x, y] = project(way.geometry[end]);
      // the roads near the end (from the grid), then the nearest stretch of each as it is now (a road may
      // already have taken a point from another new road)
      const nearby = new Set();
      for (const o of osmGrid.near(x, y)) if (o.drivable && onPiece(o, x, y).d <= JOIN_REACH_M + 1) nearby.add(o.index);
      let best = null;
      for (const index of nearby) {
        const g = elements[index].geometry;
        for (let i = 0; i + 1 < g.length; i++) {
          const [ax, ay] = project(g[i]), [bx, by] = project(g[i + 1]);
          const len = Math.hypot(bx - ax, by - ay);
          if (len < 0.02) continue;
          const p = onPiece({ ax, ay, ux: (bx - ax) / len, uy: (by - ay) / len, len, s0: 0 }, x, y);
          if (p.d <= JOIN_REACH_M && (!best || p.d < best.d)) best = { ...p, index, i, len };
        }
      }
      if (!best) continue;
      const target = elements[best.index];
      const a = target.geometry[best.i], b = target.geometry[best.i + 1];
      const joint = best.s < 0.5 ? a : best.s > best.len - 0.5 ? b : project.back(best.x, best.y);
      way.geometry[end] = { lat: joint.lat, lon: joint.lon };
      if (joint !== a && joint !== b) {
        const geometry = [...target.geometry];
        geometry.splice(best.i + 1, 0, { lat: joint.lat, lon: joint.lon });
        elements[best.index] = { ...target, geometry };
      }
    }
    elements.push(way);
    stats.added++;
  }
  return { data: { ...data, elements }, stats };
}
