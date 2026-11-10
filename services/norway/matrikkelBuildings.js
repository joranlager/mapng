// Kartverket Matrikkel buildings (Matrikkelen - Bygningspunkt) and addresses,
// turned into OpenStreetMap-style building features and merged into live OSM
// data, the same way the Overture buildings are (overtureTiles.js).
//
// Source licence: CC BY 4.0, Kartverket. Credit: "Kartverket Matrikkel".
// Coordinates arrive in EPSG:25832 (UTM zone 32N, WGS84 datum); they are
// converted to lon/lat here (Krueger series; checked against pyproj).
import { osmBuildingRings, overlapIndex } from '../overtureTiles.js';

export const NORWAY_BUILDINGS_STORAGE_KEY = 'mapng_norwayBuildings';
export const NORWAY_BUILDINGS_ATTRIBUTION = 'Kartverket Matrikkel (CC BY 4.0)';

// Ids stay clear of OSM ids (positive) and of Overture's extra footprints (-1e12 and below).
export const NORWAY_ID_BASE = -2e12;

// Mainland Norway, roughly. A coarse gate only: the rectangle includes parts of Sweden, which
// is harmless because the Matrikkel service has no data there and returns nothing.
const NORWAY_BOX = { south: 57.9, north: 71.3, west: 4.0, east: 31.5 };

const _A = 6378137.0;
const _F = 1 / 298.257223563;
const _K0 = 0.9996;
const _N = _F / (2 - _F);
const _AA = (_A / (1 + _N)) * (1 + (_N ** 2) / 4 + (_N ** 4) / 64);
const _B1 = _N / 2 - (2 * _N ** 2) / 3 + (37 * _N ** 3) / 96;
const _B2 = _N ** 2 / 48 + _N ** 3 / 15;
const _B3 = (17 * _N ** 3) / 480;
const _D1 = 2 * _N - (2 * _N ** 2) / 3 - 2 * _N ** 3;
const _D2 = (7 * _N ** 2) / 3 - (8 * _N ** 3) / 5;
const _D3 = (56 * _N ** 3) / 15;
const _LON0 = (9 * Math.PI) / 180;

/** UTM zone 32N metres -> { lat, lon } (WGS84). */
export const utm32ToLatLon = (easting, northing) => {
  const x = easting - 500000;
  const xi = northing / (_K0 * _AA);
  const eta = x / (_K0 * _AA);
  const xi2 = xi - (_B1 * Math.sin(2 * xi) * Math.cosh(2 * eta)
    + _B2 * Math.sin(4 * xi) * Math.cosh(4 * eta)
    + _B3 * Math.sin(6 * xi) * Math.cosh(6 * eta));
  const eta2 = eta - (_B1 * Math.cos(2 * xi) * Math.sinh(2 * eta)
    + _B2 * Math.cos(4 * xi) * Math.sinh(4 * eta)
    + _B3 * Math.cos(6 * xi) * Math.sinh(6 * eta));
  const chi = Math.asin(Math.sin(xi2) / Math.cosh(eta2));
  const phi = chi + _D1 * Math.sin(2 * chi) + _D2 * Math.sin(4 * chi) + _D3 * Math.sin(6 * chi);
  const lam = _LON0 + Math.atan2(Math.sinh(eta2), Math.cos(xi2));
  return { lat: (phi * 180) / Math.PI, lon: (lam * 180) / Math.PI };
};

/** True when the box { south, west, north, east } touches mainland Norway. */
export const touchesNorway = (bounds) => !!bounds
  && !(bounds.east < NORWAY_BOX.west || bounds.west > NORWAY_BOX.east
    || bounds.north < NORWAY_BOX.south || bounds.south > NORWAY_BOX.north);

// Mainland Norway's outline, roughly ([lat, lng]; the land border within a few tens of km, the coast well out
// to sea). For telling the user what a map here uses, not for deciding what to download.
const NORWAY_OUTLINE = [
  [57.8, 6.0], [57.8, 8.5], [58.8, 10.6], [59.1, 11.45], [59.9, 12.4], [61.0, 12.8], [62.0, 12.3], [63.3, 12.2],
  [64.0, 14.1], [65.0, 14.4], [66.1, 15.4], [67.0, 16.4], [68.45, 18.1], [69.06, 20.55], [69.3, 21.6], [68.6, 23.0],
  [68.6, 25.0], [69.4, 25.85], [70.08, 27.9], [69.05, 28.93], [69.79, 30.82], [70.0, 31.5], [71.4, 31.5], [71.4, 20.0],
  [70.0, 17.0], [68.5, 12.0], [66.0, 11.0], [63.5, 7.0], [62.0, 4.2], [59.0, 4.4],
];

/** True when the point is in mainland Norway (rough outline). */
export const insideNorway = (lat, lng) => {
  let inside = false;
  for (let i = 0, j = NORWAY_OUTLINE.length - 1; i < NORWAY_OUTLINE.length; j = i++) {
    const [ai, oi] = NORWAY_OUTLINE[i], [aj, oj] = NORWAY_OUTLINE[j];
    if ((ai > lat) !== (aj > lat) && lng < ((oj - oi) * (lat - ai)) / (aj - ai) + oi) inside = !inside;
  }
  return inside;
};

/** Whether the user has the feature on (on unless turned off, as Overture is). */
export const norwayBuildingsEnabled = () => {
  try {
    return globalThis.localStorage?.getItem(NORWAY_BUILDINGS_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
};

// Building type codes (Matrikkel bygningstype, the national standard; code list checked against SSB's
// "Bygningstype" list, Nov 2026). The open Matrikkel data holds a point per building, no outline and no
// height, so each type also carries a typical footprint in metres and, where the type itself says it
// ("på 3 og 4 etasjer"), a storey count. [building value, width, depth, levels, extra tags]
const T = (building, width, depth, levels = null, extra = null) => ({ building, width, depth, levels, extra });
const BUILDING_TYPES = {
  // homes
  111: T('house', 10, 8), 112: T('house', 11, 8), 113: T('farm', 12, 8),
  121: T('semidetached_house', 8, 9), 122: T('house', 11, 9, 2), 123: T('farm', 8, 9), 124: T('farm', 12, 8, 2),
  131: T('terrace', 7, 9), 132: T('terrace', 7, 9), 133: T('terrace', 8, 9), 134: T('terrace', 8, 9),
  135: T('apartments', 20, 12, 3), 136: T('apartments', 16, 10, 2),
  141: T('apartments', 24, 12, 2), 142: T('apartments', 30, 14, 4), 143: T('apartments', 30, 16, 6),
  144: T('apartments', 36, 12, 2), 145: T('apartments', 40, 14, 4), 146: T('apartments', 40, 16, 6),
  151: T('residential', 30, 14, 2), 152: T('dormitory', 30, 14, 4), 159: T('residential', 16, 10),
  161: T('cabin', 8, 6), 162: T('house', 10, 8), 163: T('farm', 12, 8), 171: T('cabin', 6, 5), 172: T('hut', 4, 4),
  181: T('garage', 6, 5), 182: T('shed', 5, 4), 183: T('boathouse', 8, 5), 193: T('residential', 12, 5), 199: T('residential', 10, 8),
  // industry, energy, storage, farming and fishing
  211: T('industrial', 40, 25), 212: T('industrial', 25, 15), 213: T('industrial', 40, 25), 214: T('industrial', 20, 12),
  215: T('industrial', 20, 12), 216: T('service', 6, 5), 219: T('industrial', 30, 20),
  221: T('industrial', 30, 15), 222: T('service', 12, 8), 223: T('service', 8, 6), 224: T('service', 3, 3), 229: T('service', 8, 6),
  231: T('warehouse', 40, 25), 232: T('warehouse', 40, 25), 233: T('silo', 10, 10), 239: T('warehouse', 25, 15), 290: T('industrial', 30, 20),
  241: T('barn', 25, 12), 242: T('farm_auxiliary', 15, 8), 243: T('greenhouse', 20, 8), 244: T('industrial', 25, 12),
  245: T('boathouse', 10, 6), 248: T('farm_auxiliary', 12, 8), 249: T('farm_auxiliary', 15, 8),
  // offices and shops
  311: T('office', 30, 18, 3), 312: T('commercial', 20, 15, 2), 313: T('office', 30, 18, 3), 319: T('office', 25, 15, 2),
  321: T('retail', 60, 40, 2, { shop: 'mall' }), 322: T('retail', 25, 18, 1), 323: T('retail', 14, 10, 1),
  329: T('retail', 20, 15, 1), 330: T('commercial', 60, 40, 2), 390: T('commercial', 25, 15, 2),
  // transport and communication
  411: T('transportation', 40, 20, 2), 412: T('train_station', 40, 12), 413: T('transportation', 30, 15), 414: T('transportation', 30, 15),
  415: T('warehouse', 50, 30), 416: T('warehouse', 50, 30), 419: T('transportation', 25, 15),
  421: T('service', 6, 5), 422: T('service', 5, 4), 423: T('service', 8, 6), 424: T('service', 8, 6), 429: T('service', 6, 5),
  431: T('parking', 40, 30, 3), 432: T('industrial', 40, 20), 433: T('hangar', 40, 30), 439: T('garage', 15, 10),
  441: T('commercial', 20, 12), 442: T('commercial', 20, 12), 443: T('service', 6, 4), 449: T('commercial', 20, 12), 490: T('commercial', 20, 12),
  // hotels and restaurants
  511: T('hotel', 35, 16, 4, { tourism: 'hotel' }), 512: T('hotel', 30, 10, 2, { tourism: 'motel' }), 519: T('hotel', 25, 14, 3, { tourism: 'hotel' }),
  521: T('hotel', 20, 12, 2, { tourism: 'guest_house' }), 522: T('hotel', 20, 12, 2, { tourism: 'hostel' }),
  523: T('apartments', 20, 12, 2, { tourism: 'apartment' }), 524: T('cabin', 6, 5), 529: T('hotel', 20, 12, 2, { tourism: 'guest_house' }),
  531: T('commercial', 18, 12, 1, { amenity: 'restaurant' }), 532: T('commercial', 20, 15, 1), 533: T('kiosk', 5, 4, 1, { amenity: 'fast_food' }),
  539: T('commercial', 18, 12, 1, { amenity: 'restaurant' }), 590: T('commercial', 20, 12, 2),
  // schools, culture, sport, religion
  611: T('shed', 6, 5), 612: T('kindergarten', 25, 12, 1, { amenity: 'kindergarten' }),
  613: T('school', 50, 20, 2, { amenity: 'school' }), 614: T('school', 50, 20, 2, { amenity: 'school' }), 615: T('school', 50, 20, 2, { amenity: 'school' }),
  616: T('school', 60, 25, 3, { amenity: 'school' }), 619: T('school', 30, 15, 2, { amenity: 'school' }),
  621: T('university', 60, 25, 3, { amenity: 'university' }), 622: T('university', 40, 20, 2), 623: T('university', 40, 20, 2),
  629: T('university', 40, 20, 2), 630: T('university', 40, 20, 2),
  641: T('public', 40, 20, 2, { tourism: 'museum' }), 642: T('public', 30, 20, 2, { amenity: 'library' }), 643: T('public', 20, 12), 649: T('public', 30, 20, 2),
  651: T('sports_hall', 45, 25), 652: T('sports_hall', 60, 30), 653: T('sports_hall', 50, 25), 654: T('grandstand', 30, 8),
  655: T('commercial', 25, 15, 1), 659: T('sports_hall', 30, 20),
  661: T('civic', 35, 25, 2), 662: T('civic', 25, 12, 1, { amenity: 'community_centre' }), 663: T('commercial', 20, 15, 1), 669: T('civic', 30, 18, 2),
  671: T('church', 30, 14, null, { amenity: 'place_of_worship' }), 672: T('civic', 18, 10, 1), 673: T('chapel', 15, 10),
  674: T('religious', 20, 15, null, { amenity: 'place_of_worship' }), 675: T('monastery', 30, 20, 2), 679: T('religious', 18, 12), 690: T('civic', 30, 18, 2),
  // health
  711: T('hospital', 60, 25, 4, { amenity: 'hospital' }), 712: T('hospital', 80, 30, 5, { amenity: 'hospital' }), 713: T('hospital', 90, 35, 6, { amenity: 'hospital' }),
  714: T('hospital', 50, 22, 3, { amenity: 'hospital' }), 719: T('hospital', 50, 22, 3, { amenity: 'hospital' }),
  721: T('residential', 45, 16, 2), 722: T('residential', 45, 16, 2), 723: T('hospital', 40, 20, 2), 729: T('residential', 35, 15, 2),
  731: T('civic', 20, 14, 2, { amenity: 'clinic' }), 732: T('civic', 25, 15, 2), 739: T('civic', 20, 14, 2), 790: T('civic', 25, 15, 2),
  // prisons and emergency services
  811: T('public', 60, 25, 3), 812: T('public', 50, 20, 3), 813: T('public', 40, 20, 2), 819: T('public', 50, 20, 3),
  821: T('public', 30, 18, 2, { amenity: 'police' }), 822: T('fire_station', 30, 15, 1, { amenity: 'fire_station' }), 823: T('service', 8, 8),
  824: T('service', 8, 8), 825: T('bunker', 8, 8), 829: T('public', 20, 12), 840: T('toilets', 4, 3, 1), 890: T('public', 20, 12),
};
// (830, monuments, are not buildings: left out)
const NOT_A_BUILDING = new Set(['830']);
const DEFAULT_TYPE = T('yes', 10, 10);

/** What a type code builds: { building, width, depth, levels, extra }; unknown codes are a plain 10 m building. */
export const buildingTypeFor = (code) => BUILDING_TYPES[code] || DEFAULT_TYPE;

const titleCase = (s) => String(s).toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, sep, ch) => sep + ch.toLocaleUpperCase('nb-NO'));

/** The address tags of one Matrikkel address ({ street, number, postcode, city }). */
export const addressTagsFor = (address) => {
  const tags = {};
  if (!address) return tags;
  if (address.street && address.number) {
    tags['addr:street'] = address.street;
    tags['addr:housenumber'] = address.number;
  }
  if (address.postcode) tags['addr:postcode'] = address.postcode;
  if (address.city) tags['addr:city'] = titleCase(address.city);
  return tags;
};

/** OSM tags for one building point (and its linked address, if any). */
export const buildingTagsFor = (building, address) => {
  const type = buildingTypeFor(building.type);
  return {
    building: type.building,
    ...(type.levels ? { 'building:levels': String(type.levels) } : {}),
    ...(type.extra || {}),
    'mapng:source': 'norway-matrikkel',
    'kartverket:bygningstype': String(building.type ?? ''),
    ...addressTagsFor(address),
  };
};

/** Box footprint (closed ring of { lat, lon }) around a point, sized in metres. */
export const boxFootprint = (easting, northing, width = 10, height = 10) => {
  const corners = [
    [easting - width / 2, northing - height / 2],
    [easting + width / 2, northing - height / 2],
    [easting + width / 2, northing + height / 2],
    [easting - width / 2, northing + height / 2],
  ].map(([e, n]) => utm32ToLatLon(e, n));
  return [...corners, corners[0]];
};

const inUse = (b) => (!b.status || b.status === 'TB') && !NOT_A_BUILDING.has(String(b.type));
const addressOf = (b, addresses) => (b.addressIds || []).map((i) => addresses.get(i)).find(Boolean) || null;

/**
 * Building points -> OSM-style way elements, each a box sized by its type
 * (or `width` x `height` when given). Only buildings in use are kept (status
 * TB). `addresses` maps adresseId -> { street, number, postcode, city }.
 */
export const buildingElements = (buildings, addresses = new Map(), { width = null, height = null, idBase = NORWAY_ID_BASE } = {}) => {
  const out = [];
  let id = idBase;
  for (const b of buildings) {
    if (!inUse(b)) continue;
    const type = buildingTypeFor(b.type);
    out.push({
      type: 'way',
      id: id--,
      tags: buildingTagsFor(b, addressOf(b, addresses)),
      geometry: boxFootprint(b.easting, b.northing, width ?? type.width, height ?? type.depth),
    });
  }
  return out;
};

const pointInRing = (lat, lon, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.lat > lat) !== (b.lat > lat) && lon < ((b.lon - a.lon) * (lat - a.lat)) / (b.lat - a.lat) + a.lon) inside = !inside;
  }
  return inside;
};

// OSM building outlines by ~200 m cell: finds the outline a Matrikkel point lies in.
const CELL = 0.002;
const outlineIndex = (elements) => {
  const cells = new Map();
  const add = (ring, index) => {
    let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity;
    for (const p of ring) { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lon); e = Math.max(e, p.lon); }
    for (let x = Math.floor(w / CELL); x <= Math.floor(e / CELL); x++) for (let y = Math.floor(s / CELL); y <= Math.floor(n / CELL); y++) {
      const k = `${x},${y}`;
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push({ ring, index });
    }
  };
  elements.forEach((el, index) => {
    if (!el.tags?.building) return;
    if (el.type === 'way' && el.geometry?.length > 2) add(el.geometry, index);
    else if (el.type === 'relation') for (const m of el.members || []) if (m.role !== 'inner' && m.geometry?.length > 2) add(m.geometry, index);
  });
  return (lat, lon) => {
    for (const entry of cells.get(`${Math.floor(lon / CELL)},${Math.floor(lat / CELL)}`) || []) if (pointInRing(lat, lon, entry.ring)) return entry.index;
    return -1;
  };
};

/** The Matrikkel details an OSM building lacks: its type (when OSM says only "yes"), storeys and address. */
const detailsFor = (el, building, address) => {
  const type = buildingTypeFor(building.type);
  const tags = el.tags || {};
  const extra = {};
  if (!tags['kartverket:bygningstype'] && building.type) extra['kartverket:bygningstype'] = String(building.type);
  if (tags.building === 'yes' && type.building !== 'yes') {
    extra.building = type.building;
    for (const [k, v] of Object.entries(type.extra || {})) if (!tags[k]) extra[k] = v;
  }
  if (type.levels && !tags['building:levels'] && !tags.height && (extra.building || tags.building === type.building)) extra['building:levels'] = String(type.levels);
  if (!tags['addr:housenumber']) Object.assign(extra, addressTagsFor(address));
  return extra;
};

/**
 * Adds Matrikkel buildings to live OSM `data` ({ elements }).
 * - A Matrikkel point inside an OSM building outline gives that building the
 *   details it lacks (type, storeys, address): `enriched`.
 * - A point with no outline becomes a box sized by its type, unless a
 *   building already stands there: `added`, else `skipped`.
 * Returns { data, added, enriched, skipped }; the input is not mutated.
 */
export const mergeNorwayBuildings = (data, buildings, addresses, bounds, options = {}) => {
  const elements = [...(data?.elements || [])];
  const outlineAt = outlineIndex(elements);
  const { rings } = osmBuildingRings(elements);
  const overlaps = overlapIndex(rings);
  const inside = (ring) => !bounds || ring.some((p) => p.lat >= bounds.south && p.lat <= bounds.north
    && p.lon >= bounds.west && p.lon <= bounds.east);
  const { width = null, height = null, idBase = NORWAY_ID_BASE } = options;
  const touched = new Set();
  let added = 0, enriched = 0, skipped = 0, id = idBase;
  for (const b of buildings) {
    if (!inUse(b)) continue;
    const address = addressOf(b, addresses || new Map());
    const point = utm32ToLatLon(b.easting, b.northing);
    const index = outlineAt(point.lat, point.lon);
    if (index >= 0) {
      // (the first Matrikkel building in an outline sets its type; later ones may still bring an address)
      const el = elements[index];
      const extra = detailsFor(el, b, address);
      if (Object.keys(extra).length) {
        elements[index] = { ...el, tags: { ...el.tags, ...extra, 'mapng:details_source': 'norway-matrikkel' } };
        if (!touched.has(index)) { touched.add(index); enriched++; }
      } else skipped++;
      continue;
    }
    const type = buildingTypeFor(b.type);
    const geometry = boxFootprint(b.easting, b.northing, width ?? type.width, height ?? type.depth);
    if (!inside(geometry) || overlaps(geometry)) { skipped++; continue; }
    elements.push({ type: 'way', id: id--, tags: buildingTagsFor(b, address), geometry });
    added++;
  }
  return { data: { ...data, elements }, added, enriched, skipped };
};
