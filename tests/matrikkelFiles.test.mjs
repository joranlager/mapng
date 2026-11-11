import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import JSZip from 'jszip';
import {
  kommunerInBox, findKommuneLink, parseBuildingsGml, parseAddressesGml,
  loadKommune, norwayBuildingsForArea, MATRIKKEL_ATOM, KOMMUNEINFO_BASE,
} from '../services/norway/matrikkelFiles.js';

const here = dirname(fileURLToPath(import.meta.url));
const bygningGml = readFileSync(join(here, 'fixtures', 'matrikkel-bygning-sample.gml'), 'utf8');
const adresseGml = readFileSync(join(here, 'fixtures', 'matrikkel-adresse-sample.gml'), 'utf8');

const response = (body, { ok = true, status = 200 } = {}) => ({
  ok, status,
  text: async () => (typeof body === 'string' ? body : Buffer.from(body).toString('utf8')),
  arrayBuffer: async () => (typeof body === 'string' ? new TextEncoder().encode(body) : body).buffer,
});

const zipOf = async (name, text) => {
  const z = new JSZip();
  z.file(name, text);
  return new Uint8Array(await z.generateAsync({ type: 'uint8array' }));
};

const BYG_ATOM = `<?xml version="1.0"?><feed>
  <entry><title>GML-format, 5001, Trondheim</title>
    <link href="https://nedlasting.geonorge.no/geonorge/Basisdata/MatrikkelenBygning/GML/Basisdata_5001_Trondheim_25833_MatrikkelenBygning_GML.zip"/></entry>
  <entry><title>GML-format, 5001, Trondheim</title>
    <link href="https://nedlasting.geonorge.no/geonorge/Basisdata/MatrikkelenBygning/GML/Basisdata_5001_Trondheim_25832_MatrikkelenBygning_GML.zip"/></entry>
  <entry><title>GML-format, 03 Oslo</title>
    <link href="https://nedlasting.geonorge.no/geonorge/Basisdata/MatrikkelenBygning/GML/Basisdata_03_Oslo_25832_MatrikkelenBygning_GML.zip"/></entry>
</feed>`;
const ADR_ATOM = BYG_ATOM.replaceAll('MatrikkelenBygning', 'MatrikkelenAdresse');
const BYG_ZIP = 'https://nedlasting.geonorge.no/geonorge/Basisdata/MatrikkelenBygning/GML/Basisdata_5001_Trondheim_25832_MatrikkelenBygning_GML.zip';
const ADR_ZIP = 'https://nedlasting.geonorge.no/geonorge/Basisdata/MatrikkelenAdresse/GML/Basisdata_5001_Trondheim_25832_MatrikkelenAdresse_GML.zip';

test('parses building records with EPSG:25832 positions and address links', () => {
  const b = parseBuildingsGml(bygningGml);
  assert.equal(b.length, 3);
  assert.equal(b[0].id, 'uuid-1');
  assert.equal(b[0].type, '111');
  assert.equal(b[0].status, 'TB');
  assert.equal(b[0].easting, 568143.96);
  assert.equal(b[0].northing, 7032384.38);
  assert.deepEqual(b[0].addressIds, [276430848]);
  assert.deepEqual(b[1].addressIds, []);
  assert.equal(b[1].status, 'IG');
});

test('parses address records keyed by adresseId', () => {
  const a = parseAddressesGml(adresseGml);
  assert.deepEqual(a.get(276430848), { street: 'Rognersvingen', number: '17B', postcode: '7021', city: 'TRONDHEIM' });
  assert.equal(a.size, 1);
});

test('finds the 25832 zip for a municipality in the Atom feed', () => {
  assert.equal(findKommuneLink(BYG_ATOM, '5001'), BYG_ZIP);
  assert.equal(findKommuneLink(ADR_ATOM, '5001'), ADR_ZIP);
  assert.equal(findKommuneLink(BYG_ATOM, '0301'), 'https://nedlasting.geonorge.no/geonorge/Basisdata/MatrikkelenBygning/GML/Basisdata_03_Oslo_25832_MatrikkelenBygning_GML.zip');
  assert.equal(findKommuneLink(BYG_ATOM, '9999'), null);
});

test('kommunerInBox asks kommuneinfo at a grid of points and skips points outside Norway', async () => {
  let asked = 0;
  const fetchImpl = async (url) => {
    assert.ok(url.startsWith(`${KOMMUNEINFO_BASE}/punkt?nord=`));
    assert.ok(url.includes('koordsys=4258'));
    asked++;
    const east = Number(/ost=([\d.]+)/.exec(url)[1]);
    if (east > 10.395) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ kommunenummer: east < 10.385 ? '5001' : '5028' }) };
  };
  assert.deepEqual(await kommunerInBox({ south: 63.4, north: 63.43, west: 10.38, east: 10.40 }, { fetchImpl }), ['5001', '5028']);
  assert.equal(asked, 25);
});

test('kommunerInBox throws when the service fails everywhere', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(kommunerInBox({ south: 63.4, north: 63.43, west: 10.38, east: 10.40 }, { fetchImpl }), /503/);
});

test('loadKommune downloads each zip once and serves repeats from the cache', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === MATRIKKEL_ATOM.buildings) return response(BYG_ATOM);
    if (url === MATRIKKEL_ATOM.addresses) return response(ADR_ATOM);
    if (url === BYG_ZIP) return response(await zipOf('b.gml', bygningGml));
    if (url === ADR_ZIP) return response(await zipOf('a.gml', adresseGml));
    return response('', { ok: false, status: 404 });
  };
  const cache = (() => { const s = new Map(); return { get: async (k) => s.get(k) ?? null, put: async (k, v) => { s.set(k, v); } }; })();
  const first = await loadKommune('5001', { fetchImpl, cache });
  assert.equal(first.buildings.length, 3);
  assert.equal(first.addresses.size, 1);
  const before = calls.length;
  await loadKommune('5001', { fetchImpl, cache });
  assert.equal(calls.length, before, 'second load makes no network calls');
});

test('norwayBuildingsForArea keeps only buildings inside the box', async () => {
  const bounds = { south: 63.40, north: 63.42, west: 10.35, east: 10.38 };
  const fetchImpl = async (url) => {
    if (url.startsWith(KOMMUNEINFO_BASE)) return { ok: true, status: 200, json: async () => ({ kommunenummer: '5001' }) };
    if (url === MATRIKKEL_ATOM.buildings) return response(BYG_ATOM);
    if (url === MATRIKKEL_ATOM.addresses) return response(ADR_ATOM);
    if (url === BYG_ZIP) return response(await zipOf('b.gml', bygningGml));
    if (url === ADR_ZIP) return response(await zipOf('a.gml', adresseGml));
    return response('', { ok: false, status: 404 });
  };
  const out = await norwayBuildingsForArea(bounds, { fetchImpl });
  assert.deepEqual(out.kommuner, ['5001']);
  assert.equal(out.buildings.length, 3);
  const tiny = await norwayBuildingsForArea({ south: 63.40, north: 63.401, west: 10.35, east: 10.351 }, { fetchImpl });
  assert.equal(tiny.buildings.length, 0);
  assert.equal(out.addresses.get(276430848).street, 'Rognersvingen');
});

test('a failing download reports the status instead of returning partial data', async () => {
  const fetchImpl = async (url) => response('', { ok: false, status: 503 });
  await assert.rejects(() => loadKommune('5001', { fetchImpl, cache: undefined }), /503/);
});

test('GML given as bytes parses the same as text', () => {
  const bytes = new TextEncoder().encode(bygningGml);
  assert.deepEqual(parseBuildingsGml(bytes), parseBuildingsGml(bygningGml));
  assert.deepEqual([...parseAddressesGml(new TextEncoder().encode(adresseGml))], [...parseAddressesGml(adresseGml)]);
});
