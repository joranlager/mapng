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

/** Whether the user has the feature on (on unless turned off, as Overture is). */
export const norwayBuildingsEnabled = () => {
  try {
    return globalThis.localStorage?.getItem(NORWAY_BUILDINGS_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
};

// Building type codes (Matrikkel bygningstype). Only the common ones are named; the rest keep building=yes.
const BUILDING_TYPE = { 111: 'house', 121: 'house', 161: 'cabin', 181: 'garage', 231: 'commercial', 311: 'industrial' };

/** OSM tags for one building point (and its linked address, if any). */
export const buildingTagsFor = (building, address) => {
  const tags = {
    building: BUILDING_TYPE[building.type] || 'yes',
    'mapng:source': 'norway-matrikkel',
    'kartverket:bygningstype': String(building.type ?? ''),
  };
  if (address) {
    if (address.street && address.number) {
      tags['addr:street'] = address.street;
      tags['addr:housenumber'] = address.number;
    }
    if (address.postcode) tags['addr:postcode'] = address.postcode;
    if (address.city) tags['addr:city'] = titleCase(address.city);
  }
  return tags;
};

const titleCase = (s) => String(s).toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, sep, ch) => sep + ch.toLocaleUpperCase('nb-NO'));

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

/**
 * Building points (see readBuildings in the desktop runner) -> OSM-style way
 * elements. Only buildings in use are kept (status TB), as the Matrikkel
 * export does. `addresses` maps adresseId -> { street, number, postcode, city }.
 */
export const buildingElements = (buildings, addresses = new Map(), { width = 10, height = 10, idBase = NORWAY_ID_BASE } = {}) => {
  const out = [];
  let id = idBase;
  for (const b of buildings) {
    if (b.status && b.status !== 'TB') continue;
    const address = (b.addressIds || []).map((i) => addresses.get(i)).find(Boolean) || null;
    out.push({
      type: 'way',
      id: id--,
      tags: buildingTagsFor(b, address),
      geometry: boxFootprint(b.easting, b.northing, width, height),
    });
  }
  return out;
};

/**
 * Adds Matrikkel buildings to live OSM `data` ({ elements }): a building is
 * added only where no OSM building already covers its footprint, so the
 * houses already mapped are not doubled. Returns { data, added, skipped }; the
 * input is not mutated.
 */
export const mergeNorwayBuildings = (data, buildings, addresses, bounds, options = {}) => {
  const elements = [...(data?.elements || [])];
  const { rings } = osmBuildingRings(elements);
  const overlaps = overlapIndex(rings);
  const candidates = buildingElements(buildings, addresses, options);
  const inside = (ring) => !bounds || ring.some((p) => p.lat >= bounds.south && p.lat <= bounds.north
    && p.lon >= bounds.west && p.lon <= bounds.east);
  let added = 0;
  let skipped = 0;
  for (const el of candidates) {
    if (!inside(el.geometry) || overlaps(el.geometry)) { skipped++; continue; }
    elements.push(el);
    added++;
  }
  return { data: { ...data, elements }, added, skipped };
};
