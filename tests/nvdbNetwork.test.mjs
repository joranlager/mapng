import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWktZ, carRoadLines, mergeNvdbProfiles, decodeProfile, profileIndex, profileIndexFromFeatures,
  nvdbBridgePins, measuredTunnelProfile, fetchNvdbNetwork, norwayRoadHeightsEnabled,
} from '../services/norway/nvdbNetwork.js';
import { solveTunnel } from '../services/beamngTunnels.js';

const bounds = { south: 63.42, north: 63.44, west: 10.38, east: 10.42 };
const seg = (typeVeg, wkt, extra = {}) => ({ typeVeg, detaljnivå: 'Vegtrase og kjørebane', geometri: { wkt }, ...extra });

test('parseWktZ reads lines and multi-lines, dropping points without a height', () => {
  assert.deepEqual(parseWktZ('LINESTRING Z (63.1 10.1 5.5,63.2 10.2 6)'), [[{ lat: 63.1, lon: 10.1, z: 5.5 }, { lat: 63.2, lon: 10.2, z: 6 }]]);
  assert.equal(parseWktZ('MULTILINESTRING Z ((63.1 10.1 5,63.2 10.2 6),(63.3 10.3 7,63.4 10.4 8))').length, 2);
  assert.deepEqual(parseWktZ('LINESTRING (63.1 10.1,63.2 10.2)'), []);
  assert.deepEqual(parseWktZ('POINT Z (63.1 10.1 5)'), []);
});

test('carRoadLines keeps car roads with real heights only', () => {
  const lines = carRoadLines([
    seg('Enkel bilveg', 'LINESTRING Z (63.43 10.40 12,63.431 10.401 13)'),
    seg('Fortau', 'LINESTRING Z (63.43 10.40 12,63.431 10.401 13)'),
    seg('Rampe', 'LINESTRING Z (63.43 10.40 0,63.431 10.401 0)'),
    seg('Kanalisert veg', 'LINESTRING Z (63.43 10.40 12,63.431 10.401 13)', { detaljnivå: 'Kjørefelt' }),
    seg('Rundkjøring', 'LINESTRING Z (63.43 10.40 -9999,63.431 10.401 13)'),
  ]);
  assert.equal(lines.length, 1);
});

test('fetchNvdbNetwork follows the pages', async () => {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    const first = !url.includes('start=');
    return { ok: true, status: 200, json: async () => ({ objekter: first ? [1, 2] : [3], metadata: { sidestørrelse: 2, neste: { start: first ? 'a' : 'b' } } }) };
  };
  assert.deepEqual(await fetchNvdbNetwork(bounds, { fetchImpl, pageSize: 2 }), [1, 2, 3]);
  assert.equal(asked.length, 2);
  assert.ok(asked[0].includes('/vegnett/api/v4/veglenkesekvenser/segmentert?kartutsnitt=10.38%2C63.42%2C10.42%2C63.44'));
  await assert.rejects(fetchNvdbNetwork(bounds, { fetchImpl: async () => ({ ok: false, status: 503 }) }), /503/);
});

test('mergeNvdbProfiles keeps the lines beside bridge and tunnel roads', () => {
  const data = { elements: [
    { type: 'way', id: 1, tags: { highway: 'trunk', tunnel: 'yes' }, geometry: [{ lat: 63.43, lon: 10.40 }, { lat: 63.43, lon: 10.41 }] },
    { type: 'way', id: 2, tags: { highway: 'residential' }, geometry: [{ lat: 63.425, lon: 10.385 }, { lat: 63.425, lon: 10.39 }] },
  ] };
  const segments = [
    seg('Enkel bilveg', 'LINESTRING Z (63.43001 10.40 -3,63.43001 10.405 -8,63.43001 10.41 -4)'),
    seg('Enkel bilveg', 'LINESTRING Z (63.425 10.385 20,63.425 10.39 21)'),
  ];
  const { data: out, stats } = mergeNvdbProfiles(data, segments, bounds);
  assert.deepEqual(stats, { lines: 2, kept: 1, structures: 1 });
  assert.equal(data.elements.length, 2, 'input not mutated');
  const added = out.elements.filter((e) => e.tags['mapng:nvdb_profile']);
  assert.equal(added.length, 1);
  assert.deepEqual(decodeProfile(added[0].tags['mapng:profile']).map((p) => p.z), [-3, -8, -4]);
  assert.equal(mergeNvdbProfiles({ elements: [data.elements[1]] }, segments, bounds).stats.kept, 0);
});

test('profileIndex picks by direction, reach and height', () => {
  const index = profileIndex([
    [[0, 0, 10], [100, 0, 20]],          // a street
    [[0, 3, -5], [100, 3, -15]],         // a tunnel under it
    [[50, -50, 40], [50, 50, 40]],       // a bridge across
  ]);
  assert.equal(index.zAt(50, 1, 1, 0, 'high'), 15);
  assert.equal(index.zAt(50, 1, 1, 0, 'low'), -10);
  assert.equal(index.zAt(50, 1, -1, 0, 14), 15);
  assert.equal(index.zAt(50, 1, 0, 1, 'low'), 40);
  assert.ok(Number.isNaN(index.zAt(20, 30, 1, 0, 'low')));
  const fromFeatures = profileIndexFromFeatures([{ type: 'nvdb_profile', tags: { 'mapng:profile': '0,0,50 0,100,60' } }, { type: 'road' }], (lat, lon) => [lon, lat], -40);
  assert.equal(fromFeatures.zAt(50, 0, 1, 0, 'low'), 15);
  assert.equal(profileIndexFromFeatures([{ type: 'road' }], () => [0, 0]), null);
});

test('nvdbBridgePins pins measured bridges and leaves the rest', () => {
  const edge = (y, extra = {}) => ({ bridge: true, s: Float64Array.from([0, 25, 50, 75, 100]), x: Float64Array.from([0, 25, 50, 75, 100]), y: Float64Array.from([y, y, y, y, y]), ...extra });
  const graph = { edges: [edge(0), edge(500), edge(0, { tunnel: true }), { ...edge(0), bridge: false }] };
  const index = profileIndex([[[0, 0, 30], [100, 0, 34]], [[0, 2, 4], [100, 2, 4]]]);
  const out = nvdbBridgePins(graph, index, () => 5);
  assert.equal(out.bridges, 2);
  assert.equal(out.pinned, 1);
  assert.deepEqual(out.pins.map((p) => p[2]), [30, 31, 32, 33, 34]);
  assert.ok(out.pins.every((p) => p[0] === 0));
  // heights under the ground belong to another road
  assert.equal(nvdbBridgePins({ edges: [edge(0)] }, index, () => 60).pinned, 0);
});

test('measuredTunnelProfile wants cover and coverage, and fills gaps', () => {
  const st = Array.from({ length: 11 }, (_, i) => ({ x: i * 10, y: 0, tx: 1, ty: 0 }));
  const g = st.map(() => 50);
  const index = profileIndex([[[0, 0, 20], [40, 0, 10]], [[60, 0, 10], [100, 0, 20]]]);
  const z = measuredTunnelProfile(st, g, index);
  assert.deepEqual(z, [20, 17.5, 15, 12.5, 10, 10, 10, 12.5, 15, 17.5, 20]);
  assert.equal(measuredTunnelProfile(st, st.map((_, i) => index.zAt(i * 10, 0, 1, 0, 'low') + 1 || 11), index), null, 'a street on the ground is not a tunnel profile');
  assert.equal(measuredTunnelProfile(st, g, profileIndex([[[0, 0, 20], [30, 0, 10]]])), null, 'too little measured');
  assert.equal(measuredTunnelProfile(st, g, null), null);
});

test('a tunnel follows its surveyed profile (a dip under a fjord) and falls back without cover', () => {
  // a hill 60 m high over a 600 m tunnel; the survey dips 30 m below a straight line between the portals
  const groundAt = (x) => (x < 0 || x > 600 ? 5 : 5 + 60 * Math.sin((Math.PI * x) / 600));
  const xy = [[0, 0], [600, 0]];
  const dip = (st) => st.map((p) => 5 - 30 * Math.sin((Math.PI * Math.max(0, Math.min(600, p.x))) / 600));
  const opts = { groundAt: (x) => groundAt(x), approaches: [{ xy: [[0, 0], [-80, 0]] }, { xy: [[600, 0], [680, 0]] }] };
  const plain = solveTunnel({ xy, half: 4 }, opts);
  const surveyed = solveTunnel({ xy, half: 4 }, { ...opts, measuredProfile: dip });
  assert.ok(plain.ok && surveyed.ok);
  assert.equal(surveyed.measured, true);
  assert.equal(plain.measured, false);
  const mid = (t) => t.line.reduce((best, p) => (Math.abs(p.x - 300) < Math.abs(best.x - 300) ? p : best)).z;
  assert.ok(mid(surveyed) < -20, `surveyed mid ${mid(surveyed)}`);
  assert.ok(mid(plain) > -5, `plain mid ${mid(plain)}`);
  // a "survey" over the ground: not used, the tunnel is still built
  const bad = solveTunnel({ xy, half: 4 }, { ...opts, measuredProfile: (st) => st.map((p) => groundAt(p.x) + 3) });
  assert.ok(bad.ok);
  assert.equal(bad.measured, false);
});

test('the switch is on unless set to "0"', () => {
  assert.equal(norwayRoadHeightsEnabled({ getItem: () => null }), true);
  assert.equal(norwayRoadHeightsEnabled({ getItem: () => '0' }), false);
});
