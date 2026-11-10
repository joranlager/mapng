import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  utm32ToLatLon, touchesNorway, buildingTagsFor, buildingElements, mergeNorwayBuildings, boxFootprint,
} from '../services/norway/matrikkelBuildings.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('UTM 32N -> WGS84 matches pyproj reference values', () => {
  const p = utm32ToLatLon(568143.96, 7032384.38);
  close(p.lat, 63.41347356, 1e-7); close(p.lon, 10.36473551, 1e-7);
  const q = utm32ToLatLon(572011.0, 7020685.0);
  close(q.lat, 63.30774667, 1e-7); close(q.lon, 10.43690169, 1e-7);
});

test('touchesNorway: Trondheim yes, Denmark and Russia no', () => {
  assert.equal(touchesNorway({ south: 63.3, north: 63.5, west: 10.2, east: 10.6 }), true);
  assert.equal(touchesNorway({ south: 55.0, north: 55.2, west: 12.0, east: 12.2 }), false); // Denmark
  assert.equal(touchesNorway({ south: 60.0, north: 60.2, west: 35.0, east: 35.2 }), false); // Russia
  assert.equal(touchesNorway(null), false);
});

test('building tags: type mapping and address tags', () => {
  const tags = buildingTagsFor({ type: '111' }, { street: 'Rognersvingen', number: '17B', postcode: '7021', city: 'TRONDHEIM' });
  assert.equal(tags.building, 'house');
  assert.equal(tags['addr:street'], 'Rognersvingen');
  assert.equal(tags['addr:housenumber'], '17B');
  assert.equal(tags['addr:postcode'], '7021');
  assert.equal(tags['addr:city'], 'Trondheim');
  assert.equal(tags['mapng:source'], 'norway-matrikkel');
  assert.equal(buildingTagsFor({ type: '999' }).building, 'yes');
});

test('buildingElements keeps only buildings in use and links addresses', () => {
  const addresses = new Map([[276430848, { street: 'Rognersvingen', number: '17B', postcode: '7021', city: 'TRONDHEIM' }]]);
  const els = buildingElements([
    { id: 'a', easting: 568143.96, northing: 7032384.38, type: '111', status: 'TB', addressIds: [276430848] },
    { id: 'b', easting: 568172.34, northing: 7032387.23, type: '161', status: 'IG', addressIds: [] },
    { id: 'c', easting: 568155.58, northing: 7032380.72, type: '111', status: 'TB', addressIds: [999] },
  ], addresses);
  assert.equal(els.length, 2);
  assert.equal(els[0].type, 'way');
  assert.equal(els[0].tags['addr:housenumber'], '17B');
  assert.equal(els[1].tags['addr:housenumber'], undefined);
  assert.equal(els[0].geometry.length, 5);
  assert.deepEqual(els[0].geometry[0], els[0].geometry[4]);
  assert.ok(els[0].id < 0 && els[1].id < els[0].id);
});

test('box footprint is about 10 m across', () => {
  const ring = boxFootprint(568143.96, 7032384.38, 10, 10);
  const lonSpan = Math.abs(ring[1].lon - ring[0].lon) * 111320 * Math.cos(ring[0].lat * Math.PI / 180);
  const latSpan = Math.abs(ring[2].lat - ring[1].lat) * 111320;
  close(lonSpan, 10, 0.2); close(latSpan, 10, 0.2);
});

test('merge adds buildings with no OSM building, skips ones already mapped', () => {
  const bounds = { south: 63.40, north: 63.42, west: 10.35, east: 10.38 };
  // an existing OSM building right on top of the first point
  const existing = {
    type: 'way', id: 1, tags: { building: 'yes' },
    geometry: boxFootprint(568143.96, 7032384.38, 14, 14),
  };
  const buildings = [
    { id: 'a', easting: 568143.96, northing: 7032384.38, type: '111', status: 'TB', addressIds: [] },
    { id: 'b', easting: 568155.58, northing: 7032380.72, type: '111', status: 'TB', addressIds: [] },
  ];
  const out = mergeNorwayBuildings({ elements: [existing] }, buildings, new Map(), bounds);
  assert.equal(out.added, 1);
  assert.equal(out.skipped, 1);
  assert.equal(out.data.elements.length, 2);
  assert.equal(out.data.elements[0], existing);      // input elements untouched and kept
});

test('merge leaves the input data unmodified', () => {
  const data = { elements: [] };
  mergeNorwayBuildings(data, [{ id: 'a', easting: 568143.96, northing: 7032384.38, type: '111', status: 'TB', addressIds: [] }], new Map(), null);
  assert.equal(data.elements.length, 0);
});
