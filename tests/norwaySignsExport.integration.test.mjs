// Norwegian sign plates through the whole level export: the shapes, pictures, materials and objects land in the zip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { exportBeamNGLevel } from '../services/exportBeamNGLevel.js';
import { forgetSignArt, SIGN_ASSET_DIR } from '../services/norway/norwaySigns.js';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const INDEX = { signs: { 202: { file: '202.png', w: 256, h: 224 }, 302: { file: '302.png', w: 256, h: 256 } } };

function install({ art }) {
  const saved = { document: globalThis.document, createImageBitmap: globalThis.createImageBitmap, fetch: globalThis.fetch };
  class FakeCanvas {
    constructor() { this.width = 0; this.height = 0; }
    getContext() {
      return (this._ctx ||= {
        fillStyle: '#000', font: '', textAlign: '', textBaseline: '',
        drawImage() {}, fillRect() {}, clearRect() {}, putImageData() {}, beginPath() {}, arc() {}, fill() {}, fillText() {},
        measureText: (t) => ({ width: String(t).length * 10 }), save() {}, restore() {}, translate() {}, rotate() {}, moveTo() {}, lineTo() {}, closePath() {}, stroke() {},
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      });
    }
    toBlob(cb) { const bytes = new Uint8Array(PNG); bytes.arrayBuffer = async () => PNG.buffer.slice(0); cb(bytes); }
  }
  globalThis.document = { createElement: (tag) => { if (tag !== 'canvas') throw new Error(tag); return new FakeCanvas(); } };
  globalThis.createImageBitmap = async () => ({ width: 64, height: 64, close() {} });
  const asked = [];
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : String(input?.url || '');
    asked.push(url);
    if (url === '/mapng_flag_static.zip') return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([0x50, 0x4b, 5, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer };
    if (/^\/cubemap\//.test(url)) return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([0x44, 0x44, 0x53, 0x20]).buffer };
    if (url === '/beamng_shape_materials.json') return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(new URL('../public/beamng_shape_materials.json', import.meta.url), 'utf8')) };
    if (url === '/norway_signs/index.json') return art ? new Response(JSON.stringify(INDEX)) : new Response(null, { status: 404 });
    if (/^\/norway_signs\/(202|302)\.png$/.test(url) && art) return new Response(PNG);
    if (typeof saved.fetch === 'function' && /^https?:/.test(url)) return saved.fetch(input);
    return new Response(null, { status: 404 });
  };
  forgetSignArt();
  return { asked, restore() { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete globalThis[k]; else globalThis[k] = saved[k]; } forgetSignArt(); } };
}

const terrain = () => ({
  width: 8, height: 8, minHeight: 0, maxHeight: 50, heightMap: new Float32Array(64).fill(10),
  bounds: { north: 1, south: 0, west: 0, east: 1 },
  osmFeatures: [
    { id: 'road_1', type: 'road', tags: { highway: 'primary' }, geometry: [{ lat: 0.8, lng: 0.2 }, { lat: 0.5, lng: 0.5 }, { lat: 0.2, lng: 0.8 }] },
    { id: 'road_2', type: 'road', tags: { highway: 'residential' }, geometry: [{ lat: 0.5, lng: 0.9 }, { lat: 0.5, lng: 0.50014 }, { lat: 0.5, lng: 0.5 }] },
    { id: 'hint', type: 'street_furniture', tags: { highway: 'give_way', 'mapng:sign': '202' }, geometry: [{ lat: 0.5, lng: 0.50014 }] },
    { id: 'sign_a', type: 'road_sign', tags: { 'mapng:sign': '202', 'mapng:sign_facing': 'with' }, geometry: [{ lat: 0.5, lng: 0.50014 }] },
    { id: 'sign_b', type: 'road_sign', tags: { 'mapng:sign': '302' }, geometry: [{ lat: 0.5, lng: 0.6 }] },
    { id: 'sign_c', type: 'road_sign', tags: { 'mapng:sign': '808', 'mapng:sign_text': 'Gjelder ikke buss' }, geometry: [{ lat: 0.5, lng: 0.6 }] },
    { id: 'sign_d', type: 'road_sign', tags: { 'mapng:sign': '777' }, geometry: [{ lat: 0.5, lng: 0.7 }] },
  ],
});

const run = async () => {
  const result = await exportBeamNGLevel(terrain(), { lat: 0.5, lng: 0.5 }, {
    roadType: 'decal', levelName: 'mapng_demo', biomeId: 'west_coast_usa', baseTexture: 'none', pbrSource: 'none',
    includeBuildings: false, includeBackdrop: false, includeWater: false, includeTrees: false, includeRocks: false, includeNativeBarriers: true,
  });
  return JSZip.loadAsync(await result.blob.arrayBuffer());
};
const items = async (zip) => {
  const file = zip.file('levels/mapng_demo/main/MissionGroup/signs/items.level.json');
  return file ? (await file.async('string')).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

test('with sign pictures, the export stands up NVDB\'s plates and ships their shapes, pictures and materials', async () => {
  const env = install({ art: true });
  try {
    const zip = await run();
    const base = `levels/mapng_demo/${SIGN_ASSET_DIR}`;
    for (const path of ['main.materials.json', 'mapng_nosign_post.dae', 'mapng_nosign_art_202.dae', 'mapng_nosign_art_302.dae', 'textures/art_202.png', 'textures/art_302.png']) {
      assert.ok(zip.file(`${base}/${path}`), `missing ${path}`);
    }
    const materials = JSON.parse(await zip.file(`${base}/main.materials.json`).async('string'));
    const signs = await items(zip);
    const plates = signs.filter((o) => /^nosign_\d/.test(o.name));
    const posts = signs.filter((o) => /^nosign_post_/.test(o.name));
    // 202, 302 and the worded plate under it; 777 has no picture
    assert.equal(plates.length, 3);
    assert.equal(posts.length, 2);
    for (const plate of plates) {
      const shape = plate.shapeName.split('/').pop();
      assert.ok(plate.shapeName.startsWith(`/levels/mapng_demo/${SIGN_ASSET_DIR}/`), plate.shapeName);
      assert.ok(zip.file(`${base}/${shape}`), `shape ${shape} is in the zip`);
      assert.ok(materials[shape.replace(/\.dae$/, '')], `material for ${shape}`);
      assert.ok(plate.position[2] > 10 && plate.position[2] < 14, `height ${plate.position[2]}`);
      assert.equal(plate.rotationMatrix.length, 9);
    }
    // every material's picture is in the zip
    for (const def of Object.values(materials)) {
      const map = def.Stages[0].diffuseMap;
      if (map) assert.ok(zip.file(map), `picture ${map}`);
    }
    // the signs worked out from the road layout make way for the real plates
    assert.equal(signs.filter((o) => /^sign_/.test(o.name)).length, 0);
  } finally { env.restore(); }
});

test('without sign pictures, the signs worked out from the roads stay', async () => {
  const env = install({ art: false });
  try {
    const zip = await run();
    assert.equal(Object.keys(zip.files).filter((p) => p.includes(SIGN_ASSET_DIR)).length, 0);
    const signs = await items(zip);
    assert.equal(signs.filter((o) => /^nosign_/.test(o.name)).length, 0);
    assert.ok(signs.some((o) => /^sign_give_way/.test(o.name)), 'the give-way sign from the junction hint');
  } finally { env.restore(); }
});
