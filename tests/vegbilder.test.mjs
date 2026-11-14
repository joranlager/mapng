// Building wall colours from Vegbilder's 360° images.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  equirectPixel, wallsOf, planViews, wallColour, agreeingColour, plausibleWall, hex, fetchVegbilder360,
  applyVegbilder360, proxyUrl, norwayVegbilderEnabled, VEGBILDER_WFS,
} from '../services/norway/vegbilder.js';

const W = 720, H = 360;   // 2 pixels a degree
// an equirectangular picture of sky with a block of `wall` colour over yaw +-25 degrees, pitch -10 to +25 degrees
const picture = (wall, { sky = [200, 205, 210], patch = null } = {}) => {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const yaw = (x / W - 0.5) * 360, pitch = (0.5 - y / H) * 180;
    const inWall = Math.abs(yaw) <= 25 && pitch >= -10 && pitch <= 25;
    const c = patch && Math.abs(yaw) <= 25 && pitch >= patch.from && pitch <= patch.to ? patch.rgb : inWall ? wall : sky;
    data.set([c[0], c[1], c[2], 255], (y * W + x) * 4);
  }
  return { width: W, height: H, data };
};
// a wall 30 m north of the camera, 20 m long, facing south
const ring = [[-10, 30], [10, 30], [10, 40], [-10, 40]];
const cam = { x: 0, y: 0, z: 2.8, heading: 0 };

test('equirectPixel: the middle is the direction of travel, a quarter turn is a quarter of the width', () => {
  const [u0, v0] = equirectPixel(0, 10, 0, 0, W, H);
  assert.ok(Math.abs(u0 - W / 2) < 1e-9 && Math.abs(v0 - H / 2) < 1e-9);
  assert.ok(Math.abs(equirectPixel(10, 0, 0, 0, W, H)[0] - 0.75 * W) < 1e-9, 'east of a northbound camera: right');
  assert.ok(Math.abs(equirectPixel(-10, 0, 0, 0, W, H)[0] - 0.25 * W) < 1e-9);
  assert.ok(Math.abs(equirectPixel(10, 0, 0, 90, W, H)[0] - W / 2) < 1e-9, 'heading east: east is ahead');
  assert.ok(Math.abs(equirectPixel(0, -10, 0, 0, W, H)[0]) < 1e-9 || Math.abs(equirectPixel(0, -10, 0, 0, W, H)[0] - W) < 1e-9, 'behind: the edge');
  assert.ok(equirectPixel(0, 10, 5, 0, W, H)[1] < H / 2, 'above the horizon: up');
  assert.ok(Math.abs(equirectPixel(0, 10, 10, 0, W, H)[2] - Math.PI / 4) < 1e-9);
});

test('wallsOf: the outward normal, for a ring either way round', () => {
  const ccw = wallsOf(ring)[0];
  assert.deepEqual([ccw.nx, ccw.ny], [0, -1]);
  const cw = wallsOf([...ring].reverse());
  const south = cw.find((w) => Math.abs(w.ay - 30) < 1e-9 && Math.abs(w.by - 30) < 1e-9);
  assert.deepEqual([south.nx + 0, south.ny + 0], [0, -1]);
  assert.equal(wallsOf(ring).length, 4);
  assert.equal(wallsOf([[0, 0], [0, 0], [5, 0], [5, 5]]).length, 3, 'a zero-length edge is left out');
});

test('wallColour reads the wall, leaving out sky, green and the dark', () => {
  const wall = { ax: -10, ay: 30, bx: 10, by: 30 };
  const read = wallColour(picture([200, 170, 140]), cam, wall, 0, 9);
  assert.deepEqual(read.rgb, [200, 170, 140]);
  assert.ok(read.share > 0.9);
  // the upper floors only: a band of green over the lower half of the wall changes nothing
  const lowGreen = picture([200, 170, 140], { patch: { from: -10, to: 3, rgb: [60, 110, 50] } });
  assert.deepEqual(wallColour(lowGreen, cam, wall, 0, 9).rgb, [200, 170, 140]);
  // a wall wholly behind trees: nothing
  assert.equal(wallColour(picture([60, 110, 50]), cam, wall, 0, 9), null);
  assert.equal(wallColour(picture([70, 60, 25]), cam, wall, 0, 9), null, 'dark olive foliage');
  assert.equal(wallColour(picture([40, 38, 36]), cam, wall, 0, 9), null, 'as dark as a tree in shade');
  assert.equal(wallColour(picture([200, 205, 210]), cam, wall, 0, 30), null, 'sky where the wall should be');
  // the heading turns the picture: a wall to the south is ahead of a camera heading south, behind one heading north
  const south = { ax: -10, ay: -30, bx: 10, by: -30 };
  assert.deepEqual(wallColour(picture([200, 170, 140]), { ...cam, heading: 180 }, south, 0, 9).rgb, [200, 170, 140]);
  assert.equal(wallColour(picture([200, 170, 140], { sky: [60, 110, 50] }), cam, south, 0, 9), null, 'behind the camera the picture shows something else');
});

test('planViews: a wall is seen from outside, near, and not from behind another building', () => {
  const buildings = [{ id: 'b', ring, base: 0, height: 9 }];
  const images = [
    { id: 'front', x: 0, y: 0, heading: 0, year: 2025 },          // 30 m south of the wall, outside
    { id: 'behind', x: 0, y: 80, heading: 0, year: 2025 },        // beyond the building: sees the far wall from outside, 40 m
    { id: 'far', x: 0, y: -60, heading: 0, year: 2025 },          // 90 m: too far
    { id: 'inside', x: 0, y: 35, heading: 0, year: 2025 },        // inside the footprint
    { id: 'side', x: -40, y: 35, heading: 0, year: 2025 },        // beside the west wall
  ];
  const out = planViews(buildings, images);
  assert.ok(out.views.has('front'));
  assert.ok(!out.views.has('far'));
  assert.ok(!out.views.has('inside'));
  assert.ok(out.views.get('behind').every((v) => v.wall === 2), 'from the north only the north wall');
  assert.ok(out.views.get('side').every((v) => v.wall === 3), 'from the west only the west wall');
  assert.equal(out.views.get('front')[0].wall, 0);
  // a building in the way: the south wall is not seen through it
  const blocker = { id: 'x', ring: [[-5, 10], [5, 10], [5, 15], [-5, 15]], base: 0, height: 9 };
  const blocked = planViews([...buildings, blocker], [images[0]]);
  assert.ok(!(blocked.views.get('front') || []).some((v) => v.building === 'b'));
  assert.ok((blocked.views.get('front') || []).some((v) => v.building === 'x'));
});

test('planViews keeps only the images that carry the most', () => {
  const buildings = Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, ring: [[-10 + i * 40, 30], [10 + i * 40, 30], [10 + i * 40, 40], [-10 + i * 40, 40]], base: 0, height: 9 }));
  const images = Array.from({ length: 6 }, (_, i) => ({ id: `i${i}`, x: i * 40, y: 0, heading: 0, year: 2025 }));
  const out = planViews(buildings, images, { maxImages: 3 });
  assert.equal(out.images, 3);
  assert.equal(out.views.size, 3);
});

test('agreeingColour drops the view that disagrees and keeps a strong lone view', () => {
  assert.deepEqual(agreeingColour([{ rgb: [200, 170, 140], weight: 1 }, { rgb: [196, 168, 136], weight: 1 }, { rgb: [20, 90, 200], weight: 0.5 }]), [198, 169, 138]);
  assert.equal(agreeingColour([]), null);
  assert.deepEqual(agreeingColour([{ rgb: [10, 20, 30], weight: 0.3 }]), [10, 20, 30]);
  assert.equal(agreeingColour([{ rgb: [10, 20, 30], weight: 0.02 }]), null, 'one weak view is not enough');
});

test('plausibleWall holds the lightness in a wall\'s range; hex writes it', () => {
  const dark = plausibleWall([40, 40, 40]);
  assert.ok(dark[0] > 40 && dark[0] === dark[1]);
  const bright = plausibleWall([255, 255, 255]);
  assert.ok(bright[0] < 255 && bright[0] > 220);
  assert.deepEqual(plausibleWall([150, 120, 100]), [150, 120, 100]);
  assert.equal(hex([255, 0, 16]), '#ff0010');
});

test('fetchVegbilder360 asks each year layer for the box and reads position, heading and road', async () => {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    if (url.includes('Vegbilder_360_2023')) return { ok: false, status: 500 };
    return { ok: true, status: 200, json: async () => ({ features: [
      { id: `img_${asked.length}`, geometry: { type: 'Point', coordinates: [10.69, 59.917] }, properties: { RETNING: 149.2, TIDSPUNKT: '2025-06-01T03:43:01+02:00', VEGKATEGORI: 'E', VEGNUMMER: 18, FELTKODE: '4' } },
      { id: 'bad', geometry: { type: 'Point', coordinates: [10.69, 59.917] }, properties: { RETNING: null } },
    ] }) };
  };
  const out = await fetchVegbilder360({ south: 59.9, north: 59.93, west: 10.68, east: 10.7 }, { fetchImpl, years: [2025, 2024, 2023] });
  assert.equal(out.length, 2, 'the failing year is left out, the record without a heading too');
  assert.deepEqual(out.map((r) => r.year).sort(), [2024, 2025]);
  assert.equal(out[0].road, 'E18');
  assert.ok(asked.every((u) => u.startsWith(`${VEGBILDER_WFS}?`)));
  assert.ok(asked[0].includes('typeNames=vegbilder_1_0%3AVegbilder_360_2025'));
  assert.ok(asked[0].includes('bbox=59.9%2C10.68%2C59.93%2C10.7%2Curn%3Aogc%3Adef%3Acrs%3AEPSG%3A%3A4326'));
  await assert.rejects(fetchVegbilder360({ south: 0, north: 1, west: 0, east: 1 }, { fetchImpl: async () => ({ ok: false, status: 503 }), years: [2025] }), /did not answer/);
});

test('applyVegbilder360 colours the buildings it sees and leaves the rest', async () => {
  const bounds = { south: 59.9, north: 59.9027, west: 10.68, east: 10.6853 };
  const LAT0 = (bounds.north + bounds.south) / 2, LON0 = (bounds.east + bounds.west) / 2;
  const kx = 111320 * Math.cos((LAT0 * Math.PI) / 180), ky = 110540;
  const at = (x, y) => ({ lat: LAT0 + y / ky, lng: LON0 + x / kx });
  const shape = (pts) => pts.map(([x, y]) => at(x, y));
  const features = [
    { type: 'building', id: 'seen', tags: { building: 'yes', height: '9' }, geometry: shape(ring) },
    { type: 'building', id: 'tagged', tags: { building: 'yes', height: '9', 'building:colour': 'red' }, geometry: shape(ring.map(([x, y]) => [x + 60, y])) },
    { type: 'building', id: 'unseen', tags: { building: 'yes', height: '9' }, geometry: shape(ring.map(([x, y]) => [x - 300, y + 400])) },
    { type: 'road', id: 'r', tags: { highway: 'primary' }, geometry: shape([[0, 0], [10, 10]]) },
  ];
  const p = at(0, 0);
  const records = [{ id: 'Vegbilder_360_2025.test', year: 2025, lat: p.lat, lon: p.lng, heading: 0, road: 'E18', lane: '1' }];
  const asked = [];
  const fetchImpl = async (url) => { asked.push(url); return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }; };
  const out = await applyVegbilder360(features, bounds, { records, fetchImpl, decode: async () => picture([200, 170, 140]) });
  assert.deepEqual(asked, [proxyUrl('Vegbilder_360_2025.test')]);
  assert.equal(out.stats.coloured, 1);
  assert.equal(out.features[0].tags['building:colour'], '#c8aa8c');
  assert.equal(out.features[0].tags['mapng:colour_source'], 'vegbilder');
  assert.equal(out.features[1], features[1], 'a colour OSM gives stays');
  assert.equal(out.features[2], features[2]);
  assert.equal(out.features[3], features[3]);
  assert.equal(features[0].tags['building:colour'], undefined, 'input not mutated');
  // no images here: the features as they were
  const none = await applyVegbilder360(features, bounds, { records: [], fetchImpl });
  assert.equal(none.features, features);
  // an image that does not download: nothing coloured, no error
  const down = await applyVegbilder360(features, bounds, { records, fetchImpl: async () => ({ ok: false, status: 404 }), decode: async () => picture([200, 170, 140]) });
  assert.equal(down.stats.coloured, 0);
});

test('the switch is on unless set to "0"', () => {
  assert.equal(norwayVegbilderEnabled({ getItem: () => null }), true);
  assert.equal(norwayVegbilderEnabled({ getItem: () => '0' }), false);
});
