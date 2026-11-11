import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWkt, propertyOf, fetchNvdbObjects, fetchNvdbRoadData, mergeNvdbRoads, norwayRoadsEnabled, surfaceFromMassetype, signCode, NVDB_TYPES, NVDB_BASE,
} from '../services/norway/nvdbRoads.js';

// A small area in Trondheim. One street runs north along lon 10.3940, a side street runs east along lat 63.4250.
const bounds = { south: 63.4240, north: 63.4270, west: 10.3900, east: 10.3990 };
const M_LAT = 1 / 110540, M_LON = 1 / (111320 * Math.cos((63.4255 * Math.PI) / 180));
const line = (points) => `LINESTRING Z (${points.map(([lat, lon]) => `${lat} ${lon} 12.5`).join(',')})`;
const prop = (navn, verdi) => ({ id: 1, navn, verdi, egenskapstype: 'Tekst' });
const obj = (id, egenskaper, wkt, egengeometri = false) => ({ id, egenskaper, geometri: { wkt, srid: '4326', egengeometri } });

const mainStreet = { type: 'way', id: 10, tags: { highway: 'secondary', maxspeed: '50' }, geometry: [{ lat: 63.4242, lon: 10.3940 }, { lat: 63.4268, lon: 10.3940 }] };
const sideStreet = { type: 'way', id: 11, tags: { highway: 'residential' }, geometry: [{ lat: 63.4250, lon: 10.3942 }, { lat: 63.4250, lon: 10.3985 }] };
const footway = { type: 'way', id: 12, tags: { highway: 'footway' }, geometry: [{ lat: 63.4242, lon: 10.39405 }, { lat: 63.4268, lon: 10.39405 }] };
const osm = () => ({ elements: [mainStreet, sideStreet, footway] });
// NVDB's centre line of the main street, 2 m east of OSM's
const nvdbMain = (from = 63.4242, to = 63.4268) => line([[from, 10.3940 + 2 * M_LON], [to, 10.3940 + 2 * M_LON]]);
const nvdbSide = line([[63.4250 + 1.5 * M_LAT, 10.3942], [63.4250 + 1.5 * M_LAT, 10.3985]]);

test('parseWkt reads NVDB geometry (latitude first, with or without height)', () => {
  assert.deepEqual(parseWkt('POINT Z (63.42808415 10.40278516 4.38866281)'), { kind: 'point', lines: [[{ lat: 63.42808415, lon: 10.40278516 }]] });
  assert.deepEqual(parseWkt('POINT(63.43060914 10.39215074)').lines[0][0], { lat: 63.43060914, lon: 10.39215074 });
  const l = parseWkt('LINESTRING Z (63.41395208 10.39868166 24.937,63.41396208 10.39867677 24.937)');
  assert.equal(l.kind, 'line'); assert.equal(l.lines[0].length, 2); assert.equal(l.lines[0][1].lon, 10.39867677);
  const ml = parseWkt('MULTILINESTRING Z ((63.1 10.1 1,63.2 10.2 1),(63.3 10.3 1,63.4 10.4 1))');
  assert.equal(ml.kind, 'line'); assert.equal(ml.lines.length, 2); assert.equal(ml.lines[1][0].lat, 63.3);
  const poly = parseWkt('POLYGON((63.42573667 10.39374675,63.42571823 10.39374341,63.42571808 10.39377694,63.42573667 10.39374675))');
  assert.equal(poly.kind, 'polygon'); assert.equal(poly.lines[0].length, 4);
  assert.equal(parseWkt('nonsense'), null);
  assert.equal(parseWkt(undefined), null);
});

test('propertyOf finds a property by its name', () => {
  const o = obj(1, [prop('Fartsgrense', 40), prop('Vedtaksnummer', 'V-1')], 'POINT(63 10)');
  assert.equal(propertyOf(o, 'Fartsgrense'), 40);
  assert.equal(propertyOf(o, 'Mangler'), undefined);
});

test('fetchNvdbObjects asks for the box west,south,east,north and follows pages until one is not full', async () => {
  const urls = [];
  const pages = { '': { objekter: [{ id: 1 }, { id: 2 }], next: 'A' }, A: { objekter: [{ id: 3 }, { id: 4 }], next: 'B' }, B: { objekter: [{ id: 5 }], next: 'C' } };
  const fetchImpl = async (url, init) => {
    urls.push(url);
    assert.equal(init.headers['X-Client'], 'MapNG');
    const page = pages[new URL(url).searchParams.get('start') || ''];
    return new Response(JSON.stringify({ objekter: page.objekter, metadata: { returnert: page.objekter.length, 'sidestørrelse': 2, neste: { start: page.next, href: 'x' } } }));
  };
  const got = await fetchNvdbObjects(105, bounds, { fetchImpl, pageSize: 2 });
  assert.deepEqual(got.map((o) => o.id), [1, 2, 3, 4, 5]);
  assert.equal(urls.length, 3);
  const first = new URL(urls[0]);
  assert.ok(urls[0].startsWith(`${NVDB_BASE}/vegobjekter/api/v4/vegobjekter/105?`));
  assert.equal(first.searchParams.get('kartutsnitt'), '10.39,63.424,10.399,63.427');
  assert.equal(first.searchParams.get('srid'), '4326');
  assert.equal(first.searchParams.get('inkluder'), 'egenskaper,geometri');
});

test('fetchNvdbObjects reports a failing answer', async () => {
  await assert.rejects(fetchNvdbObjects(105, bounds, { fetchImpl: async () => new Response('no', { status: 503 }) }), /503/);
});

test('fetchNvdbRoadData reads every object type once', async () => {
  const asked = [];
  const fetchImpl = async (url) => { asked.push(Number(new URL(url).pathname.split('/').pop())); return new Response(JSON.stringify({ objekter: [], metadata: { returnert: 0 } })); };
  const data = await fetchNvdbRoadData(bounds, { fetchImpl });
  assert.deepEqual(asked.sort((a, b) => a - b), Object.values(NVDB_TYPES).sort((a, b) => a - b));
  assert.deepEqual(Object.keys(data).sort(), Object.keys(NVDB_TYPES).sort());
});

test('speed limit, width and lanes from NVDB land on the OSM road they follow', () => {
  const nvdb = {
    speedLimit: [obj(1, [prop('Fartsgrense', 40)], nvdbMain()), obj(2, [prop('Fartsgrense', 30)], nvdbSide)],
    widthComputed: [obj(3, [prop('Kjørebanebredde', 12.34), prop('Dekkebredde', 14)], nvdbMain())],
    widthHistoric: [obj(4, [prop('Vegbredde, totalt', 6.5)], nvdbSide), obj(5, [prop('Vegbredde, totalt', 20)], nvdbMain())],
    lanes: [obj(6, [prop('Antall kjørefelt', 4), prop('Antall kjørefelt med metreringsretning', 2), prop('Antall kjørefelt mot metreringsretning', 2)], nvdbMain())],
  };
  const input = osm();
  const { data, stats } = mergeNvdbRoads(input, nvdb, bounds);
  const [main, side, foot] = data.elements;
  assert.equal(main.tags.maxspeed, '40');           // NVDB replaces OSM's 50
  assert.equal(main.tags.width, '12.3');            // the computed carriageway width, not the older total
  assert.equal(main.tags.lanes, '4');
  assert.equal(main.tags['mapng:nvdb'], 'maxspeed;lanes;width');
  assert.equal(side.tags.maxspeed, '30');
  assert.equal(side.tags.width, '6.5');             // only the older measurement exists here
  assert.equal(side.tags.lanes, undefined);
  assert.deepEqual(foot.tags, { highway: 'footway' });   // paths are left alone, even right beside the road
  assert.deepEqual(stats.roads, 2);
  assert.equal(stats.maxspeed, 2); assert.equal(stats.width, 2); assert.equal(stats.lanes, 1);
  assert.deepEqual(mainStreet.tags, { highway: 'secondary', maxspeed: '50' });   // the input is not changed
});

test('a limit that covers only a short part of a road does not set it, and the longer one wins', () => {
  const short = { speedLimit: [obj(1, [prop('Fartsgrense', 30)], nvdbMain(63.4242, 63.4248))] };   // about a quarter of the road
  assert.equal(mergeNvdbRoads(osm(), short, bounds).data.elements[0].tags.maxspeed, '50');
  const two = { speedLimit: [obj(1, [prop('Fartsgrense', 30)], nvdbMain(63.4242, 63.4250)), obj(2, [prop('Fartsgrense', 60)], nvdbMain(63.4250, 63.4268))] };
  assert.equal(mergeNvdbRoads(osm(), two, bounds).data.elements[0].tags.maxspeed, '60');
});

test('NVDB lines far from a road or crossing it do not set it', () => {
  const far = line([[63.4242, 10.3940 + 25 * M_LON], [63.4268, 10.3940 + 25 * M_LON]]);
  const crossing = line([[63.4255, 10.3930], [63.4255, 10.3950]]);
  const out = mergeNvdbRoads(osm(), { speedLimit: [obj(1, [prop('Fartsgrense', 80)], far), obj(2, [prop('Fartsgrense', 20)], crossing)] }, bounds);
  assert.equal(out.data.elements[0].tags.maxspeed, '50');
  assert.equal(out.stats.roads, 0);
});

test('a one-way OSM road on a two-way NVDB line takes its own direction\'s lanes and share of the width', () => {
  const oneway = { ...mainStreet, tags: { highway: 'primary', oneway: 'yes' } };
  const nvdb = {
    lanes: [obj(6, [prop('Antall kjørefelt', 3), prop('Antall kjørefelt med metreringsretning', 2), prop('Antall kjørefelt mot metreringsretning', 1)], nvdbMain())],
    widthComputed: [obj(3, [prop('Kjørebanebredde', 12)], nvdbMain())],
  };
  const tags = mergeNvdbRoads({ elements: [oneway] }, nvdb, bounds).data.elements[0].tags;
  assert.equal(tags.lanes, '2');      // the OSM road runs the way NVDB measures
  assert.equal(tags.width, '8');      // two of the three lanes
  const reversed = { ...oneway, geometry: [...oneway.geometry].reverse() };
  assert.equal(mergeNvdbRoads({ elements: [reversed] }, nvdb, bounds).data.elements[0].tags.lanes, '1');
});

test('signs, signals, speed bumps, lights and guard rails are added where OSM has none', () => {
  const point = (lat, lon) => `POINT Z (${lat} ${lon} 10)`;
  const nvdb = {
    signPlate: [
      obj(20, [prop('Skiltnummer', '202 - Vikeplikt')], point(63.42498, 10.39425)),
      obj(21, [prop('Skiltnummer', '204 - Stopp')], point(63.4260, 10.3941)),
      obj(22, [prop('Skiltnummer', '372 - Parkering forbudt')], point(63.4255, 10.3941)),
      obj(23, [prop('Skiltnummer', '202 - Vikeplikt')], point(63.42499, 10.39426)),     // a second plate on the same post
      obj(24, [prop('Skiltnummer', '202 - Vikeplikt')], point(63.4300, 10.3941)),        // outside the map
    ],
    signals: [obj(30, [prop('Bruksområde', 'Vegkryss')], 'POINT(63.4265 10.3940)'), obj(31, [prop('Bruksområde', 'Gangfelt')], 'POINT(63.4245 10.3940)')],
    speedBump: [obj(40, [prop('Type', 'Fartshump')], point(63.4250, 10.3960))],
    streetLight: [obj(50, [prop('Plassering', 'Lysmast')], point(63.4252, 10.3941)), obj(51, [], point(63.4254, 10.3941))],
    guardRail: [
      obj(60, [prop('Rekkverkstype', 'Brurekkverk')], line([[63.4262, 10.3950], [63.4263, 10.3955]]), true),
      obj(61, [], line([[63.4262, 10.3960], [63.4263, 10.3965]]), false),   // only its place on the road network: no surveyed line
    ],
  };
  // OSM already has the signals at the northern junction and one of the two lights
  const osmSignal = { type: 'node', id: 100, lat: 63.42651, lon: 10.39402, tags: { highway: 'traffic_signals' } };
  const osmLamp = { type: 'node', id: 101, lat: 63.42521, lon: 10.39411, tags: { highway: 'street_lamp' } };
  const { data, stats } = mergeNvdbRoads({ elements: [...osm().elements, osmSignal, osmLamp] }, nvdb, bounds);
  assert.deepEqual({ giveWay: stats.giveWay, stop: stats.stop, signals: stats.signals, bumps: stats.bumps, lights: stats.lights, guardRails: stats.guardRails },
    { giveWay: 1, stop: 1, signals: 1, bumps: 1, lights: 1, guardRails: 1 });
  const added = data.elements.filter((e) => e.tags?.['mapng:source'] === 'nvdb');
  const giveWay = added.find((e) => e.tags.highway === 'give_way');
  assert.equal(giveWay.type, 'node'); assert.equal(giveWay.lat, 63.42498); assert.equal(giveWay.tags.traffic_sign, 'NO:202'); assert.equal(giveWay.tags['nvdb:id'], '20');
  assert.equal(added.find((e) => e.tags.highway === 'stop').tags.traffic_sign, 'NO:204');
  assert.equal(added.find((e) => e.tags.highway === 'traffic_signals').tags.crossing, 'traffic_signals');   // the crossing's signal; the junction's was already mapped
  assert.equal(added.find((e) => e.tags.traffic_calming).tags.traffic_calming, 'hump');
  const rail = added.find((e) => e.tags.barrier === 'guard_rail');
  assert.equal(rail.type, 'way'); assert.equal(rail.geometry.length, 2);
  assert.ok(added.every((e) => e.id < -2.9e12));
  assert.equal(new Set(added.map((e) => e.id)).size, added.length);
});

test('norwayRoadsEnabled is on unless switched off', () => {
  assert.equal(norwayRoadsEnabled({ getItem: () => null }), true);
  assert.equal(norwayRoadsEnabled({ getItem: () => '0' }), false);
});

test('every sign plate is kept as a node with its number, wording and facing', () => {
  const point = (lat, lon) => `POINT Z (${lat} ${lon} 10)`;
  const plate = (id, nr, extra = []) => obj(id, [prop('Skiltnummer', nr), ...extra], point(63.4250 + id * 0.0001, 10.3945));
  const nvdb = { signPlate: [
    plate(1, '372 - Parkering forbudt', [prop('Ansiktsside, rettet mot', 'Trafikk mot metreringsretning')]),
    plate(2, '808 - Underskilt med annen tekst', [prop('Tekst', 'Gjelder ikke buss'), prop('Ansiktsside, rettet mot', 'Parallelt mot veg')]),
    plate(3, '526.2 - Envegskjøring, plassert parallelt'),
    plate(4, '906V - Hindermarkering, hinder til venstre'),
    plate(5, '202 - Vikeplikt', [prop('Ansiktsside, rettet mot', 'Trafikk i metreringsretning')]),
    obj(6, [prop('Ansiktsside, rettet mot', 'Tosidig')], point(63.4255, 10.3945)),   // no number: nothing to show
  ] };
  const { data, stats } = mergeNvdbRoads(osm(), nvdb, bounds);
  const nodes = data.elements.filter((e) => e.tags?.['mapng:sign']);
  assert.equal(stats.signs, 5);
  assert.deepEqual(nodes.map((n) => n.tags['mapng:sign']), ['372', '808', '526.2', '906V', '202']);
  assert.equal(nodes[0].tags['mapng:sign_name'], 'Parkering forbudt');
  assert.equal(nodes[0].tags['mapng:sign_facing'], 'against');
  assert.equal(nodes[0].tags.highway, undefined);
  assert.equal(nodes[1].tags['mapng:sign_text'], 'Gjelder ikke buss');
  assert.equal(nodes[1].tags['mapng:sign_facing'], 'toward');
  assert.equal(nodes[4].tags.highway, 'give_way');   // also the junction hint
  assert.equal(signCode(nvdb.signPlate[3]), '906V');
});

test('surface: NVDB\'s material becomes the OSM surface, the newest wearing course wins, stone paving in OSM stays', () => {
  assert.equal(surfaceFromMassetype('Asfaltgrusbetong'), 'asphalt');
  assert.equal(surfaceFromMassetype('Grus'), 'gravel');
  assert.equal(surfaceFromMassetype('Asfaltert grus (Ag)'), 'asphalt');
  assert.equal(surfaceFromMassetype('Betong'), 'concrete');
  assert.equal(surfaceFromMassetype('Brostein'), 'sett');
  assert.equal(surfaceFromMassetype('Belegningsstein, betong'), 'paving_stones');
  assert.equal(surfaceFromMassetype('Ukjent'), null);
  const nvdb = { surface: [
    obj(1, [prop('Massetype', 'Grus'), prop('Dekkeleggingsdato', '1970-01-01')], nvdbMain()),
    obj(2, [prop('Massetype', 'Asfaltgrusbetong'), prop('Dekkeleggingsdato', '2015-08-15'), prop('Lagtype', 'Slitelag')], nvdbMain()),
    obj(3, [prop('Massetype', 'Grus'), prop('Dekkeleggingsdato', '2020-01-01'), prop('Lagtype', 'Bærelag')], nvdbMain()),   // not the top layer
    obj(4, [prop('Massetype', 'Grus'), prop('Dekkeleggingsdato', '2001-01-01')], nvdbSide),
  ] };
  const { data, stats } = mergeNvdbRoads(osm(), nvdb, bounds);
  assert.equal(data.elements[0].tags.surface, 'asphalt');
  assert.equal(data.elements[1].tags.surface, 'gravel');
  assert.equal(data.elements[2].tags.surface, 'asphalt');     // the footway beside the main street
  assert.equal(stats.surface, 3);
  const cobbled = { elements: [{ ...mainStreet, tags: { highway: 'secondary', surface: 'sett' } }] };
  assert.equal(mergeNvdbRoads(cobbled, nvdb, bounds).data.elements[0].tags.surface, 'sett');
});

test('a pedestrian crossing becomes a way straight across its road, unless OSM has one there', () => {
  const nvdb = { crossing: [
    obj(1, [prop('Lysregulert', 'Nei'), prop('Hevet', 'Ja'), prop('Markering av striper', 'Malte striper')], 'POINT Z (63.4255 10.39405 -999999)'),
    obj(2, [prop('Lysregulert', 'Ja'), prop('Hevet', 'Nei')], `POLYGON((63.42600 10.39395,63.42600 10.39405,63.42603 10.39405,63.42603 10.39395,63.42600 10.39395))`, true),
    obj(3, [prop('Lysregulert', 'Nei')], 'POINT(63.4263 10.3940)'),             // OSM has this one (below)
    obj(4, [prop('Lysregulert', 'Nei')], 'POINT(63.4255 10.3970)'),             // 150 m from any road
  ] };
  const osmCrossing = { type: 'node', id: 200, lat: 63.42631, lon: 10.3940, tags: { highway: 'crossing' } };
  const { data, stats } = mergeNvdbRoads({ elements: [mainStreet, osmCrossing] }, nvdb, bounds);
  const ways = data.elements.filter((e) => e.tags?.footway === 'crossing');
  assert.equal(stats.crossings, 2);
  assert.equal(ways.length, 2);
  const [a, b] = ways;
  assert.equal(a.tags.highway, 'footway'); assert.equal(a.tags.crossing, 'marked'); assert.equal(a.tags['crossing:markings'], 'zebra');
  assert.equal(b.tags.crossing, 'traffic_signals');
  // straight across a north-south road: constant latitude, spanning the road (7 m default) and 2.5 m past each edge
  assert.equal(a.geometry.length, 3);
  assert.ok(Math.abs(a.geometry[0].lat - a.geometry[2].lat) < 1e-7);
  const span = Math.abs(a.geometry[0].lon - a.geometry[2].lon) / M_LON;
  assert.ok(Math.abs(span - 12) < 0.05, `span ${span}`);
  assert.ok(Math.abs(a.geometry[1].lon - 10.3940) < 1e-7);                        // its middle on the road's centre line
  // the raised one is also a speed table
  assert.equal(data.elements.filter((e) => e.tags?.traffic_calming === 'table').length, 1);
  assert.equal(stats.bumps, 1);
});

test('a sign number keeps the letters that say which way it points', async () => {
  const { signCode } = await import('../services/norway/nvdbRoads.js');
  const of = (text) => signCode({ egenskaper: [{ navn: 'Skiltnummer', verdi: text }] });
  assert.equal(of('713.V - Vanlig vegviser, Venstre'), '713.V');
  assert.equal(of('711.H90 - Tabellvegviser, Høyre, 90 grader'), '711.H90');
  assert.equal(of('711.R - Tabellvegviser, Rett fram'), '711.R');
  assert.equal(of('711.V135 - Tabellvegviser'), '711.V135');
  assert.equal(of('570.2V - Nødutgang'), '570.2V');
  assert.equal(of('906V - Hindermarkering'), '906V');
  assert.equal(of('727.3K - Administrativ grense'), '727.3K');
  assert.equal(of('362.40 - Fartsgrense 40 km/t'), '362.40');
  assert.equal(of('202 - Vikeplikt'), '202');
  assert.equal(of('526.2 - Envegskjøring'), '526.2');
});
