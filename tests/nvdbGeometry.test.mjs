import test from 'node:test';
import assert from 'node:assert/strict';
import { carriagewayKind, roadLines, mergeNvdbGeometry, norwayRoadGeometryEnabled } from '../services/norway/nvdbGeometry.js';

const bounds = { south: 63.42, north: 63.44, west: 10.38, east: 10.42 };
const LAT0 = 63.43, LON0 = 10.40;
const KX = 111320 * Math.cos((LAT0 * Math.PI) / 180), KY = 110540;
// metres from the middle of the box, as { lat, lon }
const at = (x, y) => ({ lat: LAT0 + y / KY, lon: LON0 + x / KX });
const xy = (p) => [(p.lon - LON0) * KX, (p.lat - LAT0) * KY];
const wkt = (pts) => `LINESTRING Z (${pts.map(([x, y]) => { const p = at(x, y); return `${p.lat} ${p.lon} 10`; }).join(',')})`;
const seg = (id, pts, extra = {}) => ({
  veglenkesekvensid: id, startposisjon: 0, sluttposisjon: 1, typeVeg: 'Enkel bilveg', detaljnivå: 'Vegtrase og kjørebane',
  feltoversikt: ['1', '2'], geometri: { wkt: wkt(pts) }, vegsystemreferanse: { vegsystem: { vegkategori: 'K', fase: 'V', nummer: 1 } }, ...extra,
});
const way = (id, tags, pts) => ({ type: 'way', id, tags, geometry: pts.map(([x, y]) => at(x, y)) });
const near = (p, x, y, tol = 0.05) => { const [px, py] = xy(p); return Math.hypot(px - x, py - y) <= tol; };

test('carriagewayKind reads the lane list', () => {
  assert.equal(carriagewayKind(['1', '2']), 'two');
  assert.equal(carriagewayKind(['1', '3K']), 'one');
  assert.equal(carriagewayKind(['2', '4H1']), 'one');
  assert.equal(carriagewayKind(['1', '2S']), 'one', 'a cycle lane the other way does not make it two-way');
  assert.equal(carriagewayKind([]), null);
  assert.equal(carriagewayKind(['1S', '2S']), null);
});

test('roadLines joins pieces that follow on, and leaves out paths, planned roads and road-level duplicates', () => {
  const lines = roadLines([
    seg(1, [[0, 0], [50, 0]], { startposisjon: 0, sluttposisjon: 0.5 }),
    seg(1, [[50, 0], [100, 0]], { startposisjon: 0.5, sluttposisjon: 1 }),
    seg(2, [[0, 50], [100, 50]], { typeVeg: 'Fortau' }),
    seg(3, [[0, 60], [100, 60]], { detaljnivå: 'Vegtrase' }),
    seg(4, [[0, 70], [100, 70]], { vegsystemreferanse: { vegsystem: { vegkategori: 'K', fase: 'P', nummer: 2 } } }),
    seg(5, [[0, 80], [100, 80]], { feltoversikt: ['2'], adresse: { navn: 'Enveien' }, vegsystemreferanse: { vegsystem: { vegkategori: 'F', fase: 'V', nummer: 706 } } }),
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].points.length, 3);
  assert.equal(lines[0].kind, 'two');
  assert.deepEqual(lines[1].tags, { highway: 'secondary', name: 'Enveien', ref: 'Fv 706', oneway: 'yes' });
  assert.ok(near(lines[1].points[0], 100, 80, 0.5), 'lanes against the metering direction: drawn the way the traffic runs');
});

test('roads are moved onto the NVDB line, with its points between, and stay joined', () => {
  // NVDB: a street along y = 0 with a bend in it, and a side street up from x = 100
  const segments = [
    seg(1, [[0, 0], [60, 0], [100, 2], [140, 0], [200, 0]]),
    seg(2, [[100, 2], [100, 100]]),
  ];
  // OSM: the same streets drawn 3 m off, the side street joined at a shared point; a footway shares it too
  const data = { elements: [
    way(1, { highway: 'residential', name: 'Storgata' }, [[0, 3], [100, 3], [200, 3]]),
    way(2, { highway: 'residential' }, [[100, 3], [103, 50], [103, 100]]),
    way(3, { highway: 'footway' }, [[100, 3], [100, -20]]),
    { type: 'node', id: 9, ...at(100, 3), tags: { highway: 'traffic_signals' } },
    way(4, { highway: 'service' }, [[300, 300], [350, 300]]),
  ] };
  const { data: out, stats } = mergeNvdbGeometry(data, segments, bounds);
  const [main, side, foot, signal, far] = out.elements;
  assert.equal(stats.snapped, 2);
  assert.equal(stats.added, 0);
  assert.ok(near(main.geometry[0], 0, 0) && near(main.geometry[main.geometry.length - 1], 200, 0));
  assert.ok(main.geometry.length > 3, 'NVDB points put in');
  assert.ok(main.geometry.some((p) => near(p, 60, 0)) && main.geometry.some((p) => near(p, 140, 0)));
  assert.equal(main.tags.name, 'Storgata');
  assert.equal(main.tags['mapng:nvdb_geometry'], 'yes');
  // the junction: one place for the street, the side street, the footway and the signal
  const joint = side.geometry[0];
  assert.ok(near(joint, 100, 2, 0.6), `junction at ${xy(joint)}`);
  assert.ok(main.geometry.some((p) => p.lat === joint.lat && p.lon === joint.lon));
  assert.ok(foot.geometry[0].lat === joint.lat && foot.geometry[0].lon === joint.lon);
  assert.ok(signal.lat === joint.lat && signal.lon === joint.lon);
  assert.ok(near(side.geometry[side.geometry.length - 1], 100, 100));
  assert.equal(foot.tags['mapng:nvdb_geometry'], undefined);
  assert.equal(far, data.elements[4], 'a road NVDB has nothing for is left alone');
  assert.ok(near(data.elements[0].geometry[0], 0, 3), 'input not mutated');
});

test('a one-way carriageway is not drawn onto a two-way centreline', () => {
  const segments = [seg(1, [[0, 0], [200, 0]])];
  const data = { elements: [
    way(1, { highway: 'primary', oneway: 'yes' }, [[0, 4], [200, 4]]),
    way(2, { highway: 'primary', oneway: 'yes' }, [[200, -4], [0, -4]]),
  ] };
  const { data: out, stats } = mergeNvdbGeometry(data, segments, bounds);
  assert.equal(stats.snapped, 0);
  assert.ok(near(out.elements[0].geometry[0], 0, 4) && near(out.elements[1].geometry[0], 200, -4));
});

test('a bus platform beside the road stays beside it', () => {
  const { data: out } = mergeNvdbGeometry({ elements: [way(1, { highway: 'platform' }, [[20, 4], [60, 4]])] }, [seg(1, [[0, 0], [200, 0]])], bounds);
  assert.ok(near(out.elements[0].geometry[0], 20, 4));
});

test('a road NVDB has and OSM lacks is added, joined to the road it ends on', () => {
  const segments = [
    seg(1, [[0, 0], [200, 0]]),
    seg(2, [[100, 0], [100, 80]], { adresse: { navn: 'Nyveien' } }),
    seg(3, [[0, 300], [10, 300]]),            // too short to add
  ];
  const data = { elements: [way(1, { highway: 'residential' }, [[0, 0], [200, 0]])] };
  const { data: out, stats } = mergeNvdbGeometry(data, segments, bounds);
  assert.equal(stats.added, 1);
  const added = out.elements[out.elements.length - 1];
  assert.equal(added.tags.highway, 'residential');
  assert.equal(added.tags.name, 'Nyveien');
  assert.equal(added.tags['mapng:source'], 'nvdb');
  const joint = added.geometry[0];
  assert.ok(near(joint, 100, 0, 0.1));
  assert.ok(out.elements[0].geometry.some((p) => p.lat === joint.lat && p.lon === joint.lon), 'the road it ends on has the point too');
  // with the road already in OSM (as a track here), nothing is added
  const both = { elements: [...data.elements, way(2, { highway: 'track' }, [[101, 0], [101, 80]])] };
  assert.equal(mergeNvdbGeometry(both, segments, bounds).stats.added, 0);
});

test('no segments: the data comes back as it was; the switch is on unless set to "0"', () => {
  const data = { elements: [way(1, { highway: 'residential' }, [[0, 0], [200, 0]])] };
  const out = mergeNvdbGeometry(data, [], bounds);
  assert.deepEqual(out.data.elements, data.elements);
  assert.equal(out.stats.snapped, 0);
  assert.equal(norwayRoadGeometryEnabled({ getItem: () => null }), true);
  assert.equal(norwayRoadGeometryEnabled({ getItem: () => '0' }), false);
});
