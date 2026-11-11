// The sea on a map whose elevation records the sea's surface at exactly sea level (Kartverket's 1 m model
// holds 0.0 over the sea): the export lowers the sea floor under it and still builds the sea.
// Before the fix the lowered sea floor counted as ground "cut below sea level", the sea was then built as
// blocks over ground that had been below sea level, there was none, and the level had no sea.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { exportBeamNGLevel } from '../services/exportBeamNGLevel.js';

const N = 64;
const install = () => {
  const saved = { fetch: globalThis.fetch, document: globalThis.document, createImageBitmap: globalThis.createImageBitmap };
  const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  class FakeCanvas {
    constructor() { this.width = 0; this.height = 0; }
    getContext() {
      return (this._ctx ||= new Proxy({ createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }), getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }), measureText: (t) => ({ width: String(t).length * 10 }) },
        { get: (t, k) => (k in t ? t[k] : () => {}), set: () => true }));
    }
    toBlob(cb) { const bytes = new Uint8Array(PNG); bytes.arrayBuffer = async () => PNG.buffer.slice(0); cb(bytes); }
  }
  globalThis.document = { createElement: () => new FakeCanvas() };
  globalThis.createImageBitmap = async () => ({ width: 64, height: 64, close() {} });
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : String(input?.url || '');
    if (url === '/mapng_flag_static.zip') return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([0x50, 0x4b, 5, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer };
    if (/^\/cubemap\//.test(url)) return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([0x44, 0x44, 0x53, 0x20]).buffer };
    if (url === '/beamng_shape_materials.json') return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(new URL('../public/beamng_shape_materials.json', import.meta.url), 'utf8')) };
    return new Response(null, { status: 404 });
  };
  return () => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete globalThis[k]; else globalThis[k] = saved[k]; } };
};

// the western half sea (exactly 0), the land rising east of it; land cover: water (80) over the sea, grass (30) on land
const terrain = () => {
  const heightMap = new Float32Array(N * N);
  const cover = new Uint8Array(N * N);
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const sea = c < N / 2;
    heightMap[r * N + c] = sea ? 0 : 2 + (c - N / 2) * 0.5;
    cover[r * N + c] = sea ? 80 : 30;
  }
  return {
    width: N, height: N, minHeight: 0, maxHeight: 20, heightMap,
    bounds: { north: 63.4403, south: 63.44, west: 10.4, east: 10.4007 },
    osmFeatures: [], landCover: { grid: cover, n: N },
  };
};

const waterOf = async (options = {}) => {
  const result = await exportBeamNGLevel(terrain(), { lat: 63.44015, lng: 10.40035 }, {
    roadType: 'none', levelName: 'mapng_sea', biomeId: 'west_coast_usa', baseTexture: 'none', pbrSource: 'none',
    includeBuildings: false, includeBackdrop: false, includeWater: true, includeTrees: false, includeRocks: false, ...options,
  });
  const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
  const path = Object.keys(zip.files).find((p) => /MissionGroup\/Water\/items\.level\.json$/.test(p));
  assert.ok(path, 'the level has a Water group');
  return (await zip.file(path).async('string')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

test('a sea recorded at exactly sea level still gets its sea', async () => {
  const restore = install();
  try {
    const water = await waterOf();
    const plane = water.find((o) => o.class === 'WaterPlane');
    const blocks = water.filter((o) => o.class === 'WaterBlock' && /^sea_/.test(o.name));
    assert.ok(plane || blocks.length, `no sea in the level: ${JSON.stringify(water.map((o) => `${o.class} ${o.name}`))}`);
    // nothing was cut below the sea here: one plane, at sea level
    assert.ok(plane, 'the sea is the sea-level plane');
    assert.equal(plane.position[2], 0);
  } finally { restore(); }
});
