import test from 'node:test';
import assert from 'node:assert/strict';
import proj4 from 'proj4';
import {
  chunkSampler, heightInOutline, measureNorwayBuildingHeights, norwayBuildingHeightsEnabled, KARTVERKET_DOM_FEED,
} from '../services/norway/buildingHeights.js';

const UTM33 = '+proj=utm +zone=33 +ellps=GRS80 +units=m +no_defs';
const NO = -99999;

// a 100 m square of ground at 10 m; the surface has a 12 m block on x 20..40, y 20..40 (metres from the corner)
const chunk = (west, north, surface) => {
  const raster = new Float32Array(100 * 100);
  for (let r = 0; r < 100; r++) for (let c = 0; c < 100; c++) {
    const x = c + 0.5, y = 100 - (r + 0.5);
    raster[r * 100 + c] = 10 + (surface && x > 20 && x < 40 && y > 20 && y < 40 ? 12 : 0);
  }
  return { raster, width: 100, height: 100, originX: west + 0.5, originY: north - 0.5, resX: 1, resY: -1, noData: NO, epsgCode: 25833 };
};

test('chunkSampler reads the pixel a point lies in and NaN outside', () => {
  const at = chunkSampler([chunk(1000, 2100, true)]);
  assert.equal(at(1030, 2030), 22);
  assert.equal(at(1060, 2030), 10);
  assert.ok(Number.isNaN(at(900, 2030)));
  const hole = chunk(1000, 2100, false); hole.raster[0] = NO;
  assert.ok(Number.isNaN(chunkSampler([hole])(1000.5, 2099.5)));
});

test('heightInOutline measures the roof over the ground', () => {
  const surfaceAt = chunkSampler([chunk(1000, 2000 + 100, true)]), groundAt = chunkSampler([chunk(1000, 2100, false)]);
  assert.equal(heightInOutline([[1020, 2020], [1040, 2020], [1040, 2040], [1020, 2040]], surfaceAt, groundAt), 12);
  assert.equal(heightInOutline([[1060, 2060], [1080, 2060], [1080, 2080], [1060, 2080]], surfaceAt, groundAt), null, 'nothing stands there');
  assert.equal(heightInOutline([[1020, 2020], [1021, 2020], [1021, 2021]], surfaceAt, groundAt), null, 'too small to measure');
  assert.equal(heightInOutline([[1020, 2020], [1020, 2020]], surfaceAt, groundAt), null);
});

test('measureNorwayBuildingHeights tags outlines without a height and keeps the rest', async () => {
  const [e0, n0] = proj4('EPSG:4326', UTM33).forward([10.4, 63.43]);
  const west = Math.floor(e0), north = Math.floor(n0) + 100;
  const ll = (dx, dy) => { const [lng, lat] = proj4(UTM33, 'EPSG:4326').forward([west + dx, north - 100 + dy]); return { lat, lng }; };
  const block = [ll(20, 20), ll(40, 20), ll(40, 40), ll(20, 40)];
  const features = [
    { type: 'building', geometry: block, tags: { building: 'yes', 'building:levels': '2' } },
    { type: 'building', geometry: block, tags: { building: 'yes', height: '30' } },
    { type: 'building', geometry: block, tags: { 'building:part': 'yes' } },
    { type: 'building', geometry: [ll(60, 60), ll(80, 60), ll(80, 80), ll(60, 80)], tags: { building: 'yes' } },
    { type: 'road', geometry: block, tags: { highway: 'residential' } },
  ];
  const feeds = [];
  const fetchModel = async (bounds, opts) => {
    const tiles = await opts.loadFeed?.({});
    const isSurface = tiles === 'surface';
    return { tiles: [chunk(west, north, isSurface)], metersPerPixel: 1 };
  };
  const loadFeed = async ({ url } = {}) => { feeds.push(url); return url === KARTVERKET_DOM_FEED ? 'surface' : 'ground'; };
  const out = await measureNorwayBuildingHeights(features, {}, { fetchModel, loadFeed });
  assert.deepEqual(out.stats, { buildings: 2, measured: 1, metersPerPixel: 1 });
  assert.equal(out.features[0].tags.height, '12');
  assert.equal(out.features[0].tags['mapng:height_source'], 'kartverket_dom');
  assert.equal(features[0].tags.height, undefined, 'input not mutated');
  assert.equal(out.features[1], features[1]);
  assert.equal(out.features[2], features[2]);
  assert.equal(out.features[3], features[3]);
  assert.ok(feeds.includes(KARTVERKET_DOM_FEED));
  // no outlines: nothing fetched
  let asked = 0;
  const none = await measureNorwayBuildingHeights([features[4]], {}, { fetchModel: async () => { asked++; return null; } });
  assert.equal(asked, 0);
  assert.equal(none.stats.measured, 0);
  // no surface model there: features as they were
  const missing = await measureNorwayBuildingHeights(features, {}, { fetchModel: async () => null });
  assert.equal(missing.features, features);
});

test('the switch is on unless set to "0"', () => {
  assert.equal(norwayBuildingHeightsEnabled({ getItem: () => null }), true);
  assert.equal(norwayBuildingHeightsEnabled({ getItem: () => '0' }), false);
});
