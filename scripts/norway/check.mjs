#!/usr/bin/env node
// Checks the app's Norwegian data paths against Kartverket's live servers,
// with the same code the app runs: address search, elevation (DTM1) and
// buildings (Matrikkel), for a 1 km square in central Trondheim.
//
//   node scripts/norway/check.mjs [lat lng] [sizeMetres]
//
// Read-only. Downloads about 20 MB (the municipality's Matrikkel files) and a
// few MB of elevation.
import { buildAddressSearchParams, parseAddressResponse } from '../../services/kartverketAddress.js';
import { fetchKartverketDtmRaw } from '../../services/norway/kartverketDtm.js';
import { norwayBuildingsForArea } from '../../services/norway/matrikkelFiles.js';
import { mergeNorwayBuildings } from '../../services/norway/matrikkelBuildings.js';

const lat = Number(process.argv[2]) || 63.4305;
const lng = Number(process.argv[3]) || 10.3951;
const size = Number(process.argv[4]) || 1000;
const dLat = size / 2 / 111320, dLng = size / 2 / (111320 * Math.cos((lat * Math.PI) / 180));
const bounds = { south: lat - dLat, north: lat + dLat, west: lng - dLng, east: lng + dLng };

// every request counted (and named), so the output shows what was downloaded
const stats = { requests: 0, bytes: 0, hosts: new Map() };
const plainFetch = globalThis.fetch;
const countingFetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const headers = new Headers(init.headers || {});
  if (!headers.has('user-agent')) headers.set('user-agent', 'MapNG-Norway-check/1.0');
  const res = await plainFetch(input, { ...init, headers });
  const body = new Uint8Array(await res.arrayBuffer());
  stats.requests++; stats.bytes += body.length;
  const host = new URL(url).host;
  stats.hosts.set(host, (stats.hosts.get(host) || 0) + body.length);
  return new Response(res.status === 204 || res.status === 304 ? null : body, { status: res.status, statusText: res.statusText, headers: res.headers });
};
const reset = () => { stats.requests = 0; stats.bytes = 0; stats.hosts.clear(); };
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
const results = [];
const section = async (name, fn) => {
  console.log(`\n=== ${name} ===`);
  reset();
  const t0 = Date.now();
  try {
    const note = await fn();
    console.log(`requests: ${stats.requests}, downloaded: ${mb(stats.bytes)}, time: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    results.push([name, note === false ? 'NO DATA' : 'OK']);
  } catch (error) {
    console.log(`FAILED: ${error?.message || error}`);
    if (error?.cause) console.log(`cause: ${error.cause?.message || error.cause}`);
    console.log(`requests before the failure: ${stats.requests}, downloaded: ${mb(stats.bytes)}`);
    results.push([name, 'FAILED']);
  }
};

console.log(`Node ${process.version}. Area: ${size} m square at ${lat}, ${lng}`);
console.log(`bounds: ${JSON.stringify(bounds)}`);

await section('1. Address search (Kartverket)', async () => {
  const res = await countingFetch(`https://ws.geonorge.no/adresser/v1/sok?${buildAddressSearchParams('Kongens gate 1', 5)}`);
  console.log(`status ${res.status}`);
  const found = parseAddressResponse(await res.json());
  console.log(`addresses: ${found.length}`);
  for (const a of found.slice(0, 3)) console.log(`  ${a.displayName}  (${a.lat}, ${a.lng})`);
  return found.length > 0;
});

await section('2. Elevation (Kartverket Høydedata DTM1)', async () => {
  const result = await fetchKartverketDtmRaw(bounds, { metersPerPixel: 1, fetchImpl: countingFetch, onProgress: (m) => console.log(`  ${m}`) });
  if (!result) { console.log('no heights for this area'); return false; }
  let min = Infinity, max = -Infinity, cells = 0, valid = 0;
  for (const t of result.tiles) for (const v of t.raster) { cells++; if (v !== t.noData) { valid++; if (v < min) min = v; if (v > max) max = v; } }
  console.log(`source tiles: ${result.sourceTiles.join(', ')}`);
  console.log(`resolution: ${result.metersPerPixel} m, chunks: ${result.tiles.length}, first chunk: ${result.tiles[0].width} x ${result.tiles[0].height} px, EPSG:${result.tiles[0].epsgCode}`);
  console.log(`heights: ${min.toFixed(2)} to ${max.toFixed(2)} m, valid: ${Math.round(result.validFraction * 100)}% of the area`);
  return true;
});

await section('3. Buildings (Kartverket Matrikkel)', async () => {
  const area = await norwayBuildingsForArea(bounds, { fetchImpl: countingFetch, onStatus: (m) => console.log(`  ${m}`) });
  console.log(`municipalities: ${area.kommuner.join(', ') || 'none'}`);
  console.log(`buildings in the area: ${area.buildings.length}, addresses loaded: ${area.addresses.size}`);
  const merged = mergeNorwayBuildings({ elements: [] }, area.buildings, area.addresses, bounds);
  console.log(`as map buildings (no OSM data in this check): ${merged.added} added, ${merged.skipped} skipped`);
  const byType = new Map();
  for (const el of merged.data.elements) byType.set(el.tags.building, (byType.get(el.tags.building) || 0) + 1);
  console.log(`types: ${[...byType].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  const withAddress = merged.data.elements.filter((el) => el.tags['addr:housenumber']);
  console.log(`with a street address: ${withAddress.length}`);
  for (const el of withAddress.slice(0, 5)) console.log(`  ${el.tags['addr:street']} ${el.tags['addr:housenumber']}, ${el.tags['addr:postcode']} ${el.tags['addr:city']}: ${el.tags.building} (type ${el.tags['kartverket:bygningstype']})`);
  return area.buildings.length > 0;
});

console.log('\n=== Summary ===');
for (const [name, state] of results) console.log(`${state.padEnd(8)} ${name}`);
console.log('\nDone.');
