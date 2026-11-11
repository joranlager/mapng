import test from 'node:test';
import assert from 'node:assert/strict';
import {
  carLanes, carriagewayKind, structureSpans, nvdbRoadWays, weldWays, replaceRoadsWithNvdb, fetchNvdbStructures,
  norwayRoadGeometryEnabled,
} from '../services/norway/nvdbGeometry.js';
import { roundRoadCorners } from '../services/roadCurves.js';

const bounds = { south: 63.42, north: 63.44, west: 10.38, east: 10.42 };
const LAT0 = 63.43, LON0 = 10.40;
const KX = 111320 * Math.cos((LAT0 * Math.PI) / 180), KY = 110540;
// metres from the middle of the box, as { lat, lon }
const at = (x, y) => ({ lat: LAT0 + y / KY, lon: LON0 + x / KX });
const xy = (p) => [(p.lon - LON0) * KX, (p.lat - LAT0) * KY];
const wkt = (pts) => `LINESTRING Z (${pts.map(([x, y]) => { const p = at(x, y); return `${p.lat} ${p.lon} 10`; }).join(',')})`;
const system = (vegkategori, nummer, fase = 'V') => ({ vegsystem: { vegkategori, fase, nummer } });
const seg = (id, pts, extra = {}) => ({
  veglenkesekvensid: id, startposisjon: 0, sluttposisjon: 1, typeVeg: 'Enkel bilveg', detaljnivå: 'Vegtrase og kjørebane',
  feltoversikt: ['1', '2'], geometri: { wkt: wkt(pts) }, vegsystemreferanse: system('K', 1), ...extra,
});
const near = (p, x, y, tol = 0.05) => { const [px, py] = xy(p); return Math.hypot(px - x, py - y) <= tol; };
const placed = (id, from, to) => ({ lokasjon: { stedfestinger: [{ veglenkesekvensid: id, startposisjon: from, sluttposisjon: to }] } });
const bridge = (id, from, to, category = 'Vegbru') => ({ ...placed(id, from, to), egenskaper: [{ navn: 'Brukategori', verdi: category }] });

test('lane lists: car lanes each way, cycle lanes left out', () => {
  assert.deepEqual(carLanes(['1', '2', '3K', '4S']), { with: 2, against: 1 });
  assert.equal(carriagewayKind(['1', '2']), 'two');
  assert.equal(carriagewayKind(['2', '4H1']), 'one');
  assert.equal(carriagewayKind(['1S', '2S']), null);
});

test('structureSpans keeps road and foot bridges, tunnels and motorways', () => {
  const spans = structureSpans({
    bridge: [bridge(1, 0.2, 0.4), bridge(1, 0.6, 0.7, 'Bru i fylling'), bridge(2, 0, 1, 'G/S-bru')],
    tunnel: [placed(3, 0.1, 0.9)],
    motorway: [{ ...placed(4, 0, 1), egenskaper: [{ navn: 'Motorvegtype', verdi: 'Motortrafikkveg' }] }, { ...placed(5, 0, 1), egenskaper: [{ navn: 'Motorvegtype', verdi: 'Motorveg' }] }],
  });
  assert.deepEqual(spans.get('1'), [{ from: 0.2, to: 0.4, kind: 'bridge' }]);
  assert.equal(spans.get('2')[0].kind, 'bridge');
  assert.equal(spans.get('3')[0].kind, 'tunnel');
  assert.equal(spans.get('4')[0].kind, 'motorroad');
  assert.equal(spans.get('5')[0].kind, 'motorway');
});

test('fetchNvdbStructures asks for the three kinds with where they lie', async () => {
  const asked = [];
  const fetchImpl = async (url) => { asked.push(url); return { ok: true, status: 200, json: async () => ({ objekter: [], metadata: {} }) }; };
  const out = await fetchNvdbStructures(bounds, { fetchImpl });
  assert.deepEqual(Object.keys(out), ['bridge', 'tunnel', 'motorway']);
  assert.ok(asked.some((u) => u.includes('/vegobjekter/60?')) && asked.some((u) => u.includes('/vegobjekter/67?')) && asked.some((u) => u.includes('/vegobjekter/595?')));
  assert.ok(asked.every((u) => u.includes('inkluder=egenskaper%2Clokasjon')));
});

test('the network becomes ways in OSM terms', () => {
  const ways = nvdbRoadWays([
    seg(1, [[0, 0], [50, 0]], { startposisjon: 0, sluttposisjon: 0.5, adresse: { navn: 'Storgata' } }),
    seg(1, [[50, 0], [100, 0]], { startposisjon: 0.5, sluttposisjon: 1, adresse: { navn: 'Storgata' } }),
    seg(2, [[0, 20], [100, 20]], { typeVeg: 'Fortau', feltoversikt: [] }),
    seg(3, [[0, 30], [100, 30]], { typeVeg: 'Gangfelt', feltoversikt: [] }),
    seg(4, [[0, 40], [100, 40]], { detaljnivå: 'Vegtrase' }),
    seg(5, [[0, 50], [100, 50]], { vegsystemreferanse: system('K', 2, 'P') }),
    seg(6, [[0, 60], [100, 60]], { feltoversikt: ['2', '4'], vegsystemreferanse: system('F', 706) }),
    seg(7, [[0, 70], [10, 75], [0, 80]], { typeVeg: 'Rundkjøring', feltoversikt: ['1'], vegsystemreferanse: system('E', 6) }),
    seg(8, [[0, 90], [100, 90]], { typeVeg: 'Rampe', feltoversikt: ['1'], vegsystemreferanse: system('E', 6) }),
    seg(9, [[0, 95], [100, 95]], { typeVeg: 'Bilferje' }),
  ], new Map(), bounds);
  assert.equal(ways.length, 6);
  const [street, sidewalk, crossing, oneway, roundabout, ramp] = ways;
  assert.deepEqual(street.tags, { highway: 'residential', name: 'Storgata', lanes: '2', 'mapng:source': 'nvdb' });
  assert.equal(street.geometry.length, 3, 'the two pieces are one way');
  assert.deepEqual(sidewalk.tags, { highway: 'footway', footway: 'sidewalk', 'mapng:source': 'nvdb' });
  assert.equal(crossing.tags.footway, 'crossing');
  assert.deepEqual(oneway.tags, { highway: 'secondary', ref: 'Fv 706', oneway: 'yes', lanes: '2', 'mapng:source': 'nvdb' });
  assert.ok(near(oneway.geometry[0], 100, 60, 0.5), 'lanes against the metering direction: drawn the way the traffic runs');
  assert.equal(roundabout.tags.junction, 'roundabout');
  assert.equal(roundabout.tags.highway, 'trunk');
  assert.equal(roundabout.tags.oneway, 'yes');
  assert.equal(ramp.tags.highway, 'trunk_link');
  assert.ok(ways.every((w) => w.id < -4e12 && w.type === 'way'));
});

test('a piece is cut where a bridge and a tunnel lie on it', () => {
  const spans = structureSpans({ bridge: [bridge(1, 0.2, 0.4)], tunnel: [placed(1, 0.6, 1)], motorway: [{ ...placed(1, 0, 1), egenskaper: [{ navn: 'Motorvegtype', verdi: 'Motorveg' }] }] });
  const ways = nvdbRoadWays([seg(1, [[0, 0], [500, 0], [1000, 0]], { vegsystemreferanse: system('E', 6) })], spans, bounds);
  assert.equal(ways.length, 4);
  const kinds = ways.map((w) => (w.tags.bridge ? 'bridge' : w.tags.tunnel ? 'tunnel' : 'ground'));
  assert.deepEqual(kinds, ['ground', 'bridge', 'ground', 'tunnel']);
  assert.ok(ways.every((w) => w.tags.highway === 'motorway'));
  assert.equal(ways[1].tags.layer, '1');
  assert.equal(ways[3].tags.layer, '-1');
  assert.ok(near(ways[1].geometry[0], 200, 0, 0.5) && near(ways[1].geometry[ways[1].geometry.length - 1], 400, 0, 0.5));
  // the parts meet end to end, on the same points
  for (let i = 0; i + 1 < ways.length; i++) assert.deepEqual(ways[i].geometry[ways[i].geometry.length - 1], ways[i + 1].geometry[0]);
  assert.ok(ways[2].geometry.some((p) => near(p, 500, 0)), 'the line\'s own point is kept');
});

test('weldWays joins ends to points and to lines', () => {
  const way = (pts) => ({ geometry: pts.map(([x, y]) => at(x, y)) });
  const ways = [way([[0, 0], [100, 0], [200, 0]]), way([[100, 0.3], [100, 80]]), way([[150, 0.2], [150, 60]]), way([[50, 5], [50, 60]])];
  const stats = weldWays(ways, bounds);
  assert.deepEqual(stats, { welded: 1, spliced: 1 });
  assert.deepEqual(ways[1].geometry[0], ways[0].geometry[1], 'an end takes the point that is there');
  assert.equal(ways[0].geometry.length, 4, 'an end on the line puts a point into it');
  assert.deepEqual(ways[0].geometry[2], ways[2].geometry[0]);
  assert.ok(near(ways[3].geometry[0], 50, 5), 'an end 5 m off is not joined');
});

test('OSM roads, bridges and junction nodes go; NVDB\'s network comes in', () => {
  const data = { elements: [
    { type: 'way', id: 1, tags: { highway: 'residential' }, geometry: [at(0, 3), at(200, 3)] },
    { type: 'way', id: 2, tags: { highway: 'footway' }, geometry: [at(0, 9), at(200, 9)] },
    { type: 'way', id: 3, tags: { man_made: 'bridge' }, geometry: [at(0, 0), at(10, 0), at(10, 10)] },
    { type: 'relation', id: 4, tags: { highway: 'pedestrian', type: 'multipolygon' }, members: [] },
    { type: 'node', id: 5, ...at(100, 3), tags: { highway: 'traffic_signals' } },
    { type: 'node', id: 6, ...at(120, 3), tags: { traffic_calming: 'hump' } },
    { type: 'node', id: 7, ...at(50, 8), tags: { highway: 'bus_stop' } },
    { type: 'way', id: 8, tags: { building: 'yes' }, geometry: [at(0, 20), at(10, 20), at(10, 30)] },
    { type: 'way', id: 9, tags: { railway: 'rail', bridge: 'yes' }, geometry: [at(0, 40), at(100, 40)] },
  ] };
  const segments = [seg(1, [[0, 0], [200, 0]]), seg(2, [[100, 0], [100, 80]]), seg(3, [[0, 6], [200, 6]], { typeVeg: 'Fortau', feltoversikt: [] })];
  const { data: out, stats } = replaceRoadsWithNvdb(data, segments, { bridge: [bridge(2, 0.5, 1)], tunnel: [], motorway: [] }, bounds);
  assert.deepEqual(stats, { roads: 3, paths: 1, bridges: 1, tunnels: 0, welded: 0, spliced: 1, osmWays: 4, osmNodes: 2 });
  assert.deepEqual(out.elements.filter((e) => e.tags['mapng:source'] !== 'nvdb').map((e) => e.id), [7, 8, 9]);
  assert.equal(data.elements.length, 9, 'input not mutated');
  const roads = out.elements.filter((e) => e.tags['mapng:source'] === 'nvdb');
  assert.ok(roads[0].geometry.some((p) => near(p, 100, 0)), 'the side street\'s end is a point of the street');
  // NVDB has nothing here (outside its cover, or it answered nothing): OSM's roads stay
  const none = replaceRoadsWithNvdb(data, [], {}, bounds);
  assert.equal(none.data, data);
  assert.equal(none.stats.roads, 0);
});

test('a surveyed road is not rounded at its corners', () => {
  const corner = [{ lat: 63.43, lng: 10.40 }, { lat: 63.43, lng: 10.402 }, { lat: 63.431, lng: 10.402 }];
  const road = (tags) => ({ type: 'road', id: '1', geometry: corner.map((p) => ({ ...p })), tags });
  const kept = roundRoadCorners([road({ highway: 'residential', 'mapng:source': 'nvdb' })]).features[0];
  assert.deepEqual(kept.geometry, corner);
  assert.ok(roundRoadCorners([road({ highway: 'residential' })]).features[0].geometry.length > 3, 'an OSM road still is');
});

test('the switch is on unless set to "0"', () => {
  assert.equal(norwayRoadGeometryEnabled({ getItem: () => null }), true);
  assert.equal(norwayRoadGeometryEnabled({ getItem: () => '0' }), false);
});
