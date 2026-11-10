import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveArt, faceFor, signWidthMetres, planNorwaySigns, buildSignPlateDAE, buildSignPostDAE, signMaterialDefs,
  buildNorwaySignAssets, loadSignArt, forgetSignArt, norwaySignsEnabled, faceMaterialName, SIGN_BACK_MATERIAL, SIGN_ASSET_DIR,
} from '../services/norway/norwaySigns.js';
import { parseOverpassResponse } from '../services/osm.js';

const signs = {
  202: { file: '202.png', w: 256, h: 224 }, 204: { file: '204.png', w: 256, h: 256 }, 302: { file: '302.png', w: 256, h: 256 },
  526: { file: '526.png', w: 256, h: 256 }, '526.2': { file: '526.2.png', w: 256, h: 80 }, 808: { file: '808.png', w: 256, h: 128 },
  906: { file: '906.png', w: 64, h: 256 }, '362.50': { file: '362.50.png', w: 256, h: 256 },
};
const sign = (lat, lng, code, extra = {}) => ({ id: `s${code}${lat}${lng}`, type: 'road_sign', geometry: [{ lat, lng }], tags: { 'mapng:sign': code, ...extra } });
// world metres straight from "lat/lng" here: x = lng, y = lat
const toWorld = (lat, lng) => [lng, lat];
// a road running north along x = 0, 3 m to each side
const roads = [{ nodes: [[0, -100], [0, 100]], half: 3 }];
const plan = (features, opts = {}) => planNorwaySigns(features, { toWorld, groundAt: () => 10, roads, signs, ...opts });
const facingOf = (yaw) => [Math.sin(yaw), -Math.cos(yaw)].map((v) => Math.round(v * 1000) / 1000 + 0);   // a plate's face normal (local -Y turned by yaw)

test('resolveArt falls back to plainer numbers', () => {
  assert.equal(resolveArt('202', signs), '202');
  assert.equal(resolveArt('526.2', signs), '526.2');
  assert.equal(resolveArt('526.1', signs), '526');
  assert.equal(resolveArt('808.319', signs), '808');
  assert.equal(resolveArt('906V', signs), '906');
  assert.equal(resolveArt('999', signs), null);
  assert.equal(resolveArt('202', null), null);
});

test('faceFor: pictures, worded plates and speed limits', () => {
  assert.deepEqual(faceFor('202', undefined, signs), { key: 'art_202', kind: 'art', file: '202.png', aspect: 224 / 256 });
  assert.equal(faceFor('808', 'Gjelder ikke buss', signs).kind, 'text');             // its own wording, not the blank plate
  assert.equal(faceFor('808', undefined, signs).kind, 'art');
  assert.equal(faceFor('362', '50', signs).file, '362.50.png');                       // the picture with that number
  assert.deepEqual(faceFor('362', '40', signs), { key: 'speed_40', kind: 'speed', value: 40, aspect: 1 });   // none: drawn
  assert.equal(faceFor('999', undefined, signs), null);
  assert.equal(faceFor('999', 'Skole', signs).kind, 'text');
  assert.equal(faceFor('808', 'Gjelder ikke buss', signs).key, faceFor('808.319', 'Gjelder ikke buss', signs).key);   // same wording, one face
});

test('sign widths follow the kind of sign', () => {
  assert.equal(signWidthMetres('110'), 0.9);
  assert.equal(signWidthMetres('302'), 0.6);
  assert.equal(signWidthMetres('206'), 0.7);
  assert.equal(signWidthMetres('808.319'), 0.6);
  assert.equal(signWidthMetres('906V', 4), 0.25);
});

test('a sign beside the road faces the traffic on its side', () => {
  // east of a north-running road: the right-hand side of northbound traffic, so it faces south
  const east = plan([sign(20, 6, '202')]);
  assert.equal(east.plates.length, 1);
  assert.deepEqual(facingOf(east.plates[0].yaw), [0, -1]);
  // west of it: southbound traffic's side, so it faces north
  assert.deepEqual(facingOf(plan([sign(20, -6, '202')]).plates[0].yaw), [0, 1]);
  // left-hand traffic turns both round
  assert.deepEqual(facingOf(plan([sign(20, 6, '202')], { leftHandTraffic: true }).plates[0].yaw), [0, 1]);
});

test('plates parallel to the road face it or face away', () => {
  assert.deepEqual(facingOf(plan([sign(20, 6, '526.2', { 'mapng:sign_facing': 'toward' })]).plates[0].yaw), [-1, 0]);
  assert.deepEqual(facingOf(plan([sign(20, 6, '526.2', { 'mapng:sign_facing': 'away' })]).plates[0].yaw), [1, 0]);
});

test('a sign recorded on the carriageway is moved to the roadside', () => {
  const on = plan([sign(20, 0, '204')]).plates[0];
  assert.ok(Math.abs(Math.abs(on.x - on.dx) - 4) < 0.01, `x ${on.x}`);          // 3 m half width + 1 m
  const near = plan([sign(20, 1.5, '204')]).plates[0];
  assert.ok(Math.abs(near.x - near.dx - 4) < 0.01);
  const far = plan([sign(20, 9, '204')]).plates[0];
  assert.ok(Math.abs(far.x - far.dx - 9) < 0.01);                                 // already clear: left where it is
});

test('plates on one post stack, the worded plate under its sign, on one post', () => {
  const p = plan([sign(20, 6, '808', { 'mapng:sign_text': '0 - 50 m' }), sign(20, 6.1, '302'), sign(60, 6, '202')]);
  assert.equal(p.posts.length, 2);
  const stack = p.plates.filter((x) => Math.abs(x.y - 20) < 1).sort((a, b) => b.z - a.z);
  assert.deepEqual(stack.map((x) => x.code), ['302', '808']);
  assert.ok(Math.abs((stack[0].z + stack[0].height / 2) - 13) < 1e-6);            // top of the stack 3 m above the ground (10)
  assert.ok(stack[0].z - stack[0].height / 2 > stack[1].z + stack[1].height / 2);   // no overlap
  assert.equal(p.faces.size, 3);
});

test('plates recorded as facing opposite ways stand back to back', () => {
  const p = plan([sign(20, 6, '302', { 'mapng:sign_facing': 'against' }), sign(20, 6, '526', { 'mapng:sign_facing': 'with' }), sign(20, 6, '202', { 'mapng:sign_facing': 'with' })]);
  const dir = (code) => facingOf(p.plates.find((x) => x.code === code).yaw);
  assert.deepEqual(dir('202'), dir('526'));
  assert.deepEqual(dir('302'), dir('202').map((v) => -v + 0));
  assert.equal(p.posts.length, 1);
});

test('sign numbers with no picture are left out and counted', () => {
  const p = plan([sign(20, 6, '777'), sign(30, 6, '777'), sign(40, 6, '202'), { type: 'road', geometry: [], tags: {} }]);
  assert.equal(p.total, 3);
  assert.equal(p.plates.length, 1);
  assert.deepEqual([...p.missing], [['777', 2]]);
});

const textOf = async (dae) => (typeof dae === 'string' ? dae : dae.text());

test('shapes: a plate with its material and a plain back, and a post', async () => {
  const dae = await textOf(buildSignPlateDAE('mapng_nosign_art_202'));
  assert.match(dae, /<COLLADA/);
  assert.match(dae, /mapng_nosign_art_202/);
  assert.match(dae, new RegExp(SIGN_BACK_MATERIAL));
  assert.match(dae, /TEXCOORD/);
  assert.match(dae, /base00/);
  assert.match(await textOf(buildSignPostDAE()), /posta2/);
});

test('materials name each face\'s picture inside the level', () => {
  const face = faceFor('202', undefined, signs);
  const defs = signMaterialDefs('trondheim', [face]);
  const def = defs[faceMaterialName(face)];
  assert.equal(def.mapTo, 'mapng_nosign_art_202');
  assert.equal(def.Stages[0].diffuseMap, `levels/trondheim/${SIGN_ASSET_DIR}/textures/art_202.png`);
  assert.equal(def.alphaTest, true);
  assert.ok(defs[SIGN_BACK_MATERIAL]);
});

test('buildNorwaySignAssets writes shapes, pictures, materials and objects for the faces it could get', async () => {
  const p = plan([sign(20, 6, '202'), sign(60, 6, '302'), sign(90, 6, '808', { 'mapng:sign_text': 'Skole' })]);
  const png = new Uint8Array([137, 80, 78, 71]);
  const fetchImpl = async (url) => (url === '/norway_signs/202.png' ? new Response(png) : new Response(null, { status: 404 }));
  let n = 0;
  const out = await buildNorwaySignAssets(p, { levelName: 'trondheim', fetchImpl, persistentId: () => `id${n++}`, rotationMatrixFromYaw: (yaw) => [yaw] });
  const paths = out.files.map((f) => f.path).sort();
  assert.deepEqual(paths, [
    `${SIGN_ASSET_DIR}/main.materials.json`, `${SIGN_ASSET_DIR}/mapng_nosign_art_202.dae`, `${SIGN_ASSET_DIR}/mapng_nosign_post.dae`, `${SIGN_ASSET_DIR}/textures/art_202.png`,
  ]);
  // (302's picture is missing, and worded plates need a canvas, which a plain Node test has not)
  assert.equal(out.left.length, 2);
  const plates = out.objects.filter((o) => /^nosign_202/.test(o.name));
  assert.equal(plates.length, 1);
  assert.equal(plates[0].shapeName, `/levels/trondheim/${SIGN_ASSET_DIR}/mapng_nosign_art_202.dae`);
  assert.equal(plates[0].class, 'TSStatic');
  assert.deepEqual(plates[0].scale, [0.9, 1, 0.788]);
  assert.equal(out.objects.filter((o) => /^nosign_post/.test(o.name)).length, 3);
  assert.deepEqual(Object.keys(JSON.parse(out.files.find((f) => f.path.endsWith('main.materials.json')).data)).sort(), ['mapng_nosign_art_202', SIGN_BACK_MATERIAL].sort());
});

test('loadSignArt: the index when there is one, null when there is not', async () => {
  forgetSignArt();
  assert.equal(await loadSignArt({ fetchImpl: async () => new Response(null, { status: 404 }) }), null);
  forgetSignArt();
  assert.equal(await loadSignArt({ fetchImpl: async () => new Response(JSON.stringify({ signs: {} })) }), null);
  forgetSignArt();
  assert.deepEqual((await loadSignArt({ fetchImpl: async () => new Response(JSON.stringify({ signs })) })).signs[202], signs[202]);
  forgetSignArt();
});

test('norwaySignsEnabled is on unless switched off', () => {
  assert.equal(norwaySignsEnabled({ getItem: () => null }), true);
  assert.equal(norwaySignsEnabled({ getItem: () => '0' }), false);
});

test('the map data parser keeps sign plates as their own features, and a give-way plate also as a junction hint', () => {
  const bounds = { south: 63.42, north: 63.43, west: 10.38, east: 10.40 };
  const data = { elements: [
    { type: 'node', id: -3000000000001, lat: 63.425, lon: 10.39, tags: { 'mapng:sign': '372', 'mapng:sign_name': 'Parkering forbudt' } },
    { type: 'node', id: -3000000000002, lat: 63.426, lon: 10.39, tags: { 'mapng:sign': '202', highway: 'give_way', traffic_sign: 'NO:202' } },
  ] };
  const features = parseOverpassResponse(data, bounds);
  assert.equal(features.filter((f) => f.type === 'road_sign').length, 2);
  const hints = features.filter((f) => f.type === 'street_furniture');
  assert.equal(hints.length, 1);
  assert.equal(hints[0].tags.highway, 'give_way');
});
