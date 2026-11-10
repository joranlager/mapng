import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  utm32ToLatLon, touchesNorway, buildingTagsFor, buildingElements, mergeNorwayBuildings, buildingTypeFor, insideNorway, boxFootprint,
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

test('merge adds buildings with no OSM building, and gives details to ones already mapped', () => {
  const bounds = { south: 63.40, north: 63.42, west: 10.35, east: 10.38 };
  // an existing OSM building right on top of the first point
  const existing = {
    type: 'way', id: 1, tags: { building: 'yes' },
    geometry: boxFootprint(568143.96, 7032384.38, 14, 14),
  };
  const addresses = new Map([[1, { street: 'Rognersvingen', number: '17B', postcode: '7021', city: 'TRONDHEIM' }]]);
  const buildings = [
    { id: 'a', easting: 568143.96, northing: 7032384.38, type: '111', status: 'TB', addressIds: [1] },
    { id: 'b', easting: 568155.58, northing: 7032380.72, type: '111', status: 'TB', addressIds: [] },
  ];
  const out = mergeNorwayBuildings({ elements: [existing] }, buildings, addresses, bounds);
  assert.equal(out.added, 1);
  assert.equal(out.enriched, 1);
  assert.equal(out.skipped, 0);
  assert.equal(out.data.elements.length, 2);
  // the OSM building keeps its outline and id, and gains the Matrikkel type and address
  assert.equal(out.data.elements[0].id, 1);
  assert.equal(out.data.elements[0].geometry, existing.geometry);
  assert.equal(out.data.elements[0].tags.building, 'house');
  assert.equal(out.data.elements[0].tags['addr:housenumber'], '17B');
  assert.equal(out.data.elements[0].tags['kartverket:bygningstype'], '111');
  assert.deepEqual(existing.tags, { building: 'yes' });   // the input element is not changed
});

test('merge keeps what OSM already says about a building', () => {
  const existing = {
    type: 'way', id: 1, tags: { building: 'church', 'addr:housenumber': '2', 'addr:street': 'Kirkegata', 'building:levels': '1' },
    geometry: boxFootprint(568143.96, 7032384.38, 14, 14),
  };
  const addresses = new Map([[1, { street: 'Rognersvingen', number: '17B', postcode: '7021', city: 'TRONDHEIM' }]]);
  const out = mergeNorwayBuildings({ elements: [existing] },
    [{ id: 'a', easting: 568143.96, northing: 7032384.38, type: '142', status: 'TB', addressIds: [1] }], addresses, null);
  const tags = out.data.elements[0].tags;
  assert.equal(tags.building, 'church');
  assert.equal(tags['addr:housenumber'], '2');
  assert.equal(tags['addr:street'], 'Kirkegata');
  assert.equal(tags['building:levels'], '1');
  assert.equal(tags['kartverket:bygningstype'], '142');
  assert.equal(out.added, 0);
});

test('building types follow the national code list', () => {
  assert.equal(buildingTypeFor('111').building, 'house');
  assert.equal(buildingTypeFor('181').building, 'garage');
  assert.equal(buildingTypeFor('231').building, 'warehouse');     // Lagerhall
  assert.equal(buildingTypeFor('311').building, 'office');        // Kontor- og administrasjonsbygning
  assert.equal(buildingTypeFor('322').building, 'retail');        // Butikkbygning
  assert.equal(buildingTypeFor('613').building, 'school');
  assert.equal(buildingTypeFor('671').building, 'church');
  assert.equal(buildingTagsFor({ type: '142' }).building, 'apartments');
  assert.equal(buildingTagsFor({ type: '142' })['building:levels'], '4');   // "på 3 og 4 etasjer"
  assert.equal(buildingTagsFor({ type: '511' }).tourism, 'hotel');
  assert.equal(buildingTagsFor({ type: '111' })['building:levels'], undefined);
});

test('boxes are sized by building type, and monuments are left out', () => {
  const span = (ring) => Math.abs(ring[1].lon - ring[0].lon) * 111320 * Math.cos(ring[0].lat * Math.PI / 180);
  const els = buildingElements([
    { id: 'g', easting: 568143.96, northing: 7032384.38, type: '181', status: 'TB', addressIds: [] },
    { id: 'w', easting: 568243.96, northing: 7032384.38, type: '231', status: 'TB', addressIds: [] },
    { id: 'm', easting: 568343.96, northing: 7032384.38, type: '830', status: 'TB', addressIds: [] },
  ]);
  assert.equal(els.length, 2);
  close(span(els[0].geometry), 6, 0.2);
  close(span(els[1].geometry), 40, 0.5);
});

test('merge leaves the input data unmodified', () => {
  const data = { elements: [] };
  mergeNorwayBuildings(data, [{ id: 'a', easting: 568143.96, northing: 7032384.38, type: '111', status: 'TB', addressIds: [] }], new Map(), null);
  assert.equal(data.elements.length, 0);
});

test('insideNorway: Norwegian towns yes, neighbours no', () => {
  for (const [lat, lng] of [[63.4305, 10.3951], [59.9139, 10.7522], [60.3913, 5.3221], [69.6492, 18.9553], [58.1467, 7.9956], [69.7269, 30.0456], [69.9689, 23.2716]]) {
    assert.equal(insideNorway(lat, lng), true, `${lat}, ${lng}`);
  }
  for (const [lat, lng] of [[59.3293, 18.0686], [57.7089, 11.9746], [60.1699, 24.9384], [55.6761, 12.5683], [68.9585, 33.0827], [67.8558, 20.2253]]) {
    assert.equal(insideNorway(lat, lng), false, `${lat}, ${lng}`);
  }
});
