import { test } from 'node:test';
import assert from 'node:assert/strict';
import proj4 from 'proj4';
import { writeArrayBuffer } from 'geotiff';
import {
  parseDtmFeed, tilesForBox, utm33Box, rangeSource, fetchKartverketDtmRaw, norwayElevationEnabled,
  KARTVERKET_DTM_EPSG,
} from '../services/norway/kartverketDtm.js';

const UTM33 = '+proj=utm +zone=33 +ellps=GRS80 +units=m +no_defs';
const toLatLng = (e, n) => { const [lng, lat] = proj4(UTM33, 'EPSG:4326').forward([e, n]); return { lat, lng }; };

// Two small "15 km tiles" side by side: 300 x 300 px at 1 m, west tile then east tile.
const SIZE = 300;
const WEST = { id: '33-1-1', ox: 270000, oy: 7040300 };
const EAST = { id: '33-2-1', ox: 270300, oy: 7040300 };
const NODATA = -32767;
// height = easting - 270000 + (7040300 - northing) / 1000, at pixel centres
const heightAt = (e, n) => (e - 270000) + (7040300 - n) / 1000;

const tileTiff = (tile, { hole = false } = {}) => {
  const values = new Float32Array(SIZE * SIZE);
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    values[r * SIZE + c] = hole && r < 10 ? NODATA : heightAt(tile.ox + c + 0.5, tile.oy - r - 0.5);
  }
  return writeArrayBuffer(values, {
    width: SIZE, height: SIZE,
    ModelPixelScale: [1, 1, 0], ModelTiepoint: [0, 0, 0, tile.ox, tile.oy, 0],
    ProjectedCSTypeGeoKey: KARTVERKET_DTM_EPSG, GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1,
    GDAL_NODATA: String(NODATA),
  });
};

const outline = (tile) => {
  const corners = [[tile.ox, tile.oy - SIZE], [tile.ox, tile.oy], [tile.ox + SIZE, tile.oy], [tile.ox + SIZE, tile.oy - SIZE], [tile.ox, tile.oy - SIZE]];
  return corners.map(([e, n]) => { const p = toLatLng(e, n); return `${p.lat} ${p.lng}`; }).join(' ');
};

const feedXml = (tiles) => `<?xml version="1.0"?><feed xmlns:georss="http://www.georss.org/georss">
${tiles.map((t) => `<entry><title>Høydedata DTM1 ${t.id}</title>
  <id>https://nedlasting.geonorge.no/geonorge/ATOM/hoydedata/DTM1/${t.id}.tif</id>
  <georss:polygon>${outline(t)}</georss:polygon>
  <link href="https://nedlasting.geonorge.no/hoydedata/DTM1/${t.id}.tif" rel="alternate"/></entry>`).join('\n')}
</feed>`;

/** A fetch that serves the feed and the tiles, with HTTP range support. */
const server = (files, { ranges = true } = {}) => {
  const log = [];
  const fetchImpl = async (url, init = {}) => {
    const range = new Headers(init.headers || {}).get('range');
    log.push({ url, range });
    const body = files[url];
    if (body == null) return new Response(null, { status: 404 });
    if (typeof body === 'string') return new Response(body, { status: 200 });
    const bytes = new Uint8Array(body);
    const m = range && /bytes=(\d+)-(\d+)/.exec(range);
    if (!m || !ranges) return new Response(bytes, { status: 200 });
    const start = Number(m[1]), end = Math.min(Number(m[2]), bytes.length - 1);
    if (start >= bytes.length) return new Response(null, { status: 416 });
    return new Response(bytes.slice(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}` } });
  };
  return { fetchImpl, log };
};

const FEED_URL = 'https://feed.test/DTM1.atom';
const tileUrl = (t) => `https://nedlasting.geonorge.no/hoydedata/DTM1/${t.id}.tif`;
const loadFeedFrom = (fetchImpl) => async () => parseDtmFeed(await (await fetchImpl(FEED_URL)).text());

/** Bounds (lat/lng) of a UTM33 box. */
const boundsOf = (w, s, e, n) => {
  const a = toLatLng(w, s), b = toLatLng(e, n), c = toLatLng(w, n), d = toLatLng(e, s);
  return { south: Math.max(a.lat, d.lat), north: Math.min(b.lat, c.lat), west: Math.max(a.lng, c.lng), east: Math.min(b.lng, d.lng) };
};

/** The height a result holds at a UTM33 point (nearest pixel centre), or null. */
const sample = (result, e, n) => {
  for (const t of result.tiles) {
    const x = Math.round((e - t.originX) / t.resX), y = Math.round((n - t.originY) / t.resY);
    if (x >= 0 && x < t.width && y >= 0 && y < t.height) { const v = t.raster[y * t.width + x]; return v === t.noData ? null : v; }
  }
  return null;
};

test('parseDtmFeed reads tile ids, file links and outlines in EPSG:25833', () => {
  const tiles = parseDtmFeed(feedXml([WEST, EAST]));
  assert.equal(tiles.length, 2);
  assert.equal(tiles[0].id, '33-1-1');
  assert.equal(tiles[0].url, tileUrl(WEST));
  assert.deepEqual(tiles[0].utm, { west: 270000, east: 270300, south: 7040000, north: 7040300 });
});

test('parseDtmFeed skips entries without a file link or outline', () => {
  assert.equal(parseDtmFeed('<feed><entry><title>x</title></entry><entry><link href="a.tif"/></entry></feed>').length, 0);
});

test('tilesForBox picks the tiles under the box, not ones that only touch it', () => {
  const tiles = parseDtmFeed(feedXml([WEST, EAST]));
  assert.deepEqual(tilesForBox(tiles, { west: 270050, east: 270150, south: 7040050, north: 7040150 }).map((t) => t.id), ['33-1-1']);
  assert.deepEqual(tilesForBox(tiles, { west: 270250, east: 270350, south: 7040050, north: 7040150 }).map((t) => t.id), ['33-1-1', '33-2-1']);
  assert.deepEqual(tilesForBox(tiles, { west: 270300, east: 270400, south: 7040050, north: 7040150 }).map((t) => t.id), ['33-2-1']);
  assert.equal(tilesForBox(tiles, { west: 280000, east: 280100, south: 7040050, north: 7040150 }).length, 0);
});

test('utm33Box holds the whole map area', () => {
  const b = boundsOf(270050, 7040050, 270150, 7040150);
  const box = utm33Box(b);
  for (const [lat, lng] of [[b.south, b.west], [b.north, b.east], [b.south, b.east], [b.north, b.west]]) {
    const [e, n] = proj4('EPSG:4326', UTM33).forward([lng, lat]);
    assert.ok(e >= box.west - 1e-6 && e <= box.east + 1e-6 && n >= box.south - 1e-6 && n <= box.north + 1e-6);
  }
});

test('rangeSource asks for fixed blocks and returns the requested bytes', async () => {
  const bytes = new Uint8Array(5000).map((_, i) => i % 251);
  const { fetchImpl, log } = server({ 'https://x.test/f.bin': bytes.buffer });
  const source = rangeSource('https://x.test/f.bin', { fetchImpl, blockBytes: 1024 });
  const [a, b] = await source.fetch([{ offset: 1000, length: 100 }, { offset: 4990, length: 50 }]);
  assert.deepEqual([...new Uint8Array(a)], [...bytes.slice(1000, 1100)]);
  assert.deepEqual([...new Uint8Array(b).slice(0, 10)], [...bytes.slice(4990, 5000)]);
  assert.equal(source.fileSize, 5000);
  assert.deepEqual(log.map((l) => l.range).sort(), ['bytes=0-1023', 'bytes=1024-2047', 'bytes=4096-5119']);
  await source.fetch([{ offset: 1000, length: 100 }]);
  assert.equal(log.length, 3, 'blocks are fetched once');
});

test('rangeSource refuses a server that ignores the range', async () => {
  const { fetchImpl } = server({ 'https://x.test/f.bin': new Uint8Array(5000).buffer }, { ranges: false });
  const source = rangeSource('https://x.test/f.bin', { fetchImpl, blockBytes: 1024 });
  await assert.rejects(source.fetch([{ offset: 0, length: 10 }]), /range requests/);
});

test('fetchKartverketDtmRaw reads the map window at 1 m, across two tiles', async () => {
  const { fetchImpl, log } = server({ [FEED_URL]: feedXml([WEST, EAST]), [tileUrl(WEST)]: await tileTiff(WEST), [tileUrl(EAST)]: await tileTiff(EAST) });
  const result = await fetchKartverketDtmRaw(boundsOf(270250, 7040100, 270350, 7040200), { metersPerPixel: 1, fetchImpl, loadFeed: loadFeedFrom(fetchImpl) });
  assert.deepEqual(result.sourceTiles, ['33-1-1', '33-2-1']);
  assert.equal(result.metersPerPixel, 1);
  assert.equal(result.tiles[0].epsgCode, 25833);
  assert.equal(result.validFraction, 1);
  for (const [e, n] of [[270260.5, 7040150.5], [270299.5, 7040120.5], [270300.5, 7040120.5], [270340.5, 7040190.5]]) {
    assert.ok(Math.abs(sample(result, e, n) - heightAt(e, n)) < 1e-3, `height at ${e}, ${n}`);
  }
  assert.ok(log.filter((l) => l.url.endsWith('.tif')).every((l) => /^bytes=\d+-\d+$/.test(l.range)), 'tiles are read by range requests only');
});

test('fetchKartverketDtmRaw averages to the map resolution when the map is coarser', async () => {
  const { fetchImpl } = server({ [FEED_URL]: feedXml([WEST]), [tileUrl(WEST)]: await tileTiff(WEST) });
  const result = await fetchKartverketDtmRaw(boundsOf(270050, 7040050, 270250, 7040250), { metersPerPixel: 4, fetchImpl, loadFeed: loadFeedFrom(fetchImpl) });
  assert.equal(result.metersPerPixel, 4);
  // a 4 m cell centred at (270102, 7040150): the mean of its sixteen 1 m pixels is the plane's value at the centre
  assert.ok(Math.abs(sample(result, 270102, 7040150) - heightAt(270102, 7040150)) < 1e-2);
});

test('fetchKartverketDtmRaw keeps no-data as holes and reports the valid share', async () => {
  const { fetchImpl } = server({ [FEED_URL]: feedXml([WEST]), [tileUrl(WEST)]: await tileTiff(WEST, { hole: true }) });
  const result = await fetchKartverketDtmRaw(boundsOf(270050, 7040200, 270150, 7040299), { metersPerPixel: 1, fetchImpl, loadFeed: loadFeedFrom(fetchImpl) });
  assert.ok(result.validFraction < 1 && result.validFraction > 0.5);
  assert.equal(sample(result, 270100.5, 7040295.5), null);          // inside the hole (the tile's top ten rows)
  assert.ok(Math.abs(sample(result, 270100.5, 7040250.5) - heightAt(270100.5, 7040250.5)) < 1e-3);
});

test('fetchKartverketDtmRaw returns null outside the tiles', async () => {
  const { fetchImpl, log } = server({ [FEED_URL]: feedXml([WEST]), [tileUrl(WEST)]: await tileTiff(WEST) });
  assert.equal(await fetchKartverketDtmRaw(boundsOf(290000, 7040050, 290100, 7040150), { fetchImpl, loadFeed: loadFeedFrom(fetchImpl) }), null);
  assert.ok(log.every((l) => !l.url.endsWith('.tif')), 'no tile is opened');
});

test('fetchKartverketDtmRaw fails (for the fallback) when the server has no range support', async () => {
  const { fetchImpl } = server({ [FEED_URL]: feedXml([WEST]), [tileUrl(WEST)]: await tileTiff(WEST) }, { ranges: false });
  await assert.rejects(fetchKartverketDtmRaw(boundsOf(270050, 7040050, 270150, 7040150), { fetchImpl, loadFeed: loadFeedFrom(fetchImpl) }), /range requests/);
});

test('norwayElevationEnabled is on unless switched off', () => {
  assert.equal(norwayElevationEnabled({ getItem: () => null }), true);
  assert.equal(norwayElevationEnabled({ getItem: () => '0' }), false);
  assert.equal(norwayElevationEnabled(undefined), true);
});
