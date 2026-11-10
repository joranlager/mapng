// Kartverket DTM1 chunks (EPSG:25833) through the app's own resampler: the heights land where they belong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import proj4 from 'proj4';
import { writeArrayBuffer } from 'geotiff';
import { fetchKartverketDtmRaw, parseDtmFeed } from '../services/norway/kartverketDtm.js';
import { resampleToMeterGrid } from '../services/terrainResampler.js';
import { getBuiltInProj4 } from '../services/uploadGeoMetadata.js';

const UTM33 = '+proj=utm +zone=33 +ellps=GRS80 +units=m +no_defs';
const toLatLng = (e, n) => { const [lng, lat] = proj4(UTM33, 'EPSG:4326').forward([e, n]); return { lat, lng }; };

test('ETRS89 UTM zones used in Norway are built in (no lookup online)', () => {
  assert.match(getBuiltInProj4(25833), /\+proj=utm \+zone=33 \+ellps=GRS80/);
  assert.match(getBuiltInProj4(25832), /\+zone=32/);
  assert.match(getBuiltInProj4(25835), /\+zone=35/);
});

test('a Kartverket tile resampled to the map grid keeps its heights in place', async () => {
  // a tilted plane, 1 m per metre east and 0.5 m per metre south, on a 1500 m tile at 1 m
  const SIZE = 1500, ox = 270000, oy = 7041500;
  const plane = (e, n) => (e - ox) + (oy - n) * 0.5;
  const values = new Float32Array(SIZE * SIZE);
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) values[r * SIZE + c] = plane(ox + c + 0.5, oy - r - 0.5);
  const bytes = new Uint8Array(await writeArrayBuffer(values, {
    width: SIZE, height: SIZE, ModelPixelScale: [1, 1, 0], ModelTiepoint: [0, 0, 0, ox, oy, 0],
    ProjectedCSTypeGeoKey: 25833, GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1,
  }));
  const outline = [[ox, oy - SIZE], [ox, oy], [ox + SIZE, oy], [ox + SIZE, oy - SIZE], [ox, oy - SIZE]]
    .map(([e, n]) => { const p = toLatLng(e, n); return `${p.lat} ${p.lng}`; }).join(' ');
  const feed = `<feed><entry><georss:polygon>${outline}</georss:polygon><link href="https://tiles.test/33-1-1.tif"/></entry></feed>`;
  const fetchImpl = async (url, init = {}) => {
    const m = /bytes=(\d+)-(\d+)/.exec(new Headers(init.headers || {}).get('range') || '');
    const start = Number(m[1]), end = Math.min(Number(m[2]), bytes.length - 1);
    if (start >= bytes.length) return new Response(null, { status: 416 });
    return new Response(bytes.slice(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}` } });
  };

  const centre = toLatLng(ox + 750, oy - 750);
  const dLat = 282 / 111320, dLng = 282 / (111320 * Math.cos((centre.lat * Math.PI) / 180));
  const bounds = { south: centre.lat - dLat, north: centre.lat + dLat, west: centre.lng - dLng, east: centre.lng + dLng };
  const kv = await fetchKartverketDtmRaw(bounds, { metersPerPixel: 1, fetchImpl, loadFeed: async () => parseDtmFeed(feed) });
  assert.equal(kv.validFraction, 1);

  const N = 512;
  const { heightMap } = await resampleToMeterGrid({ type: 'grid', data: { tiles: kv.tiles } }, centre, N, N, 'bilinear', false, false);
  const at = (x, y) => heightMap[y * N + x];
  // the map's centre pixel is the tile's centre point
  assert.ok(Math.abs(at(N / 2, N / 2) - plane(ox + 750, oy - 750)) < 0.02, `centre ${at(N / 2, N / 2)}`);
  // 100 m east and 100 m south (the map points true north; UTM 33 is turned about 4 degrees here)
  const east = at(N / 2 + 100, N / 2) - at(N / 2, N / 2), south = at(N / 2, N / 2 + 100) - at(N / 2, N / 2);
  assert.ok(east > 95 && east < 105, `east ${east}`);
  assert.ok(south > 42 && south < 58, `south ${south}`);
  // no holes anywhere on the map
  assert.ok(heightMap.every((v) => Number.isFinite(v) && v > 0 && v < 3000));
});
