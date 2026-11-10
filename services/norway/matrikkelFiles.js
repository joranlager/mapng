// Loads Kartverket Matrikkel buildings and addresses for the municipalities
// under a map area, and turns them into records matrikkelBuildings.js merges.
//
// Flow: a small WFS box query names the municipalities (kommunenummer); each
// municipality's building and address GML zips come from the Matrikkel Atom
// feeds (EPSG:25832), are cached, and are parsed here.
//
// Source: Kartverket, Matrikkelen (CC BY 4.0).
import JSZip from 'jszip';
import { utm32ToLatLon } from './matrikkelBuildings.js';

export const MATRIKKEL_WFS_BASE = 'https://wfs.geonorge.no/skwms1';
export const MATRIKKEL_ATOM = {
  buildings: 'http://nedlasting.geonorge.no/geonorge/ATOM-feeds/MatrikkelenBygning_AtomFeedGML.xml',
  addresses: 'http://nedlasting.geonorge.no/geonorge/ATOM-feeds/MatrikkelenAdresse_AtomFeedGML.xml',
};
const WFS_CRS = 'urn:ogc:def:crs:EPSG::4258';   // stored system of the WFS (latitude, longitude)
const FILE_PROJECTION = '25832';                 // the zip files we read (easting, northing)

// Feature members of a GML file, any namespace prefix.
const FEATURE_MEMBER = /<(?:[\w.-]+:)?featureMember[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?featureMember>/g;

const tagValue = (xml, name) => {
  const m = xml.match(new RegExp(`<(?:[\\w.-]+:)?${name}>([^<]*)<`));
  return m ? m[1].trim() : null;
};

const memoryCache = () => {
  const store = new Map();
  return { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); } };
};

/** Municipality numbers (kommunenummer) of building points near the box, from a small WFS query. */
export async function kommunerInBox(bounds, { fetchImpl = globalThis.fetch, signal, sample = 200 } = {}) {
  const bbox = `${bounds.south},${bounds.west},${bounds.north},${bounds.east},${WFS_CRS}`;
  const params = new URLSearchParams({
    service: 'WFS', version: '2.0.0', request: 'GetFeature', typenames: 'app:Bygning',
    srsName: WFS_CRS, bbox, count: String(sample),
  });
  const res = await fetchImpl(`${MATRIKKEL_WFS_BASE}/wfs.matrikkelen-bygningspunkt?${params}`, { signal });
  if (!res.ok) throw new Error(`Matrikkel WFS answered ${res.status}`);
  const text = await res.text();
  return [...new Set([...text.matchAll(/kommunenummer>(\d{4})</g)].map((m) => m[1]))];
}

// Oslo's file is named by its county code (03), not its municipality number (0301).
const FILE_CODE = { '0301': '03' };

/** The zip link in an Atom feed for one municipality and projection, or null. */
export function findKommuneLink(atomXml, kommune, { projection = FILE_PROJECTION } = {}) {
  const code = FILE_CODE[kommune] || kommune;
  for (const entry of atomXml.split(/<entry[\s>]/).slice(1)) {
    const link = [...entry.matchAll(/href="([^"]+\.zip)"/g)].map((m) => m[1])
      .find((h) => h.includes(`_${code}_`) && h.includes(`_${projection}_`));
    if (link) return link;
  }
  return null;
}

/** Building records (easting, northing in EPSG:25832) from a building GML text. */
export function parseBuildingsGml(text) {
  const out = [];
  for (const m of text.matchAll(FEATURE_MEMBER)) {
    const f = m[1];
    const pos = f.match(/<(?:[\w.-]+:)?pos>\s*([\d.-]+)\s+([\d.-]+)\s*</);
    if (!pos) continue;
    out.push({
      id: tagValue(f, 'uuidBygning') || tagValue(f, 'bygningId') || '',
      easting: Number(pos[1]),
      northing: Number(pos[2]),
      type: tagValue(f, 'bygningstype'),
      status: tagValue(f, 'bygningsstatus'),
      addressIds: [...f.matchAll(/adresseId>(\d+)</g)].map((x) => Number(x[1])),
      kommune: tagValue(f, 'kommunenummer'),
    });
  }
  return out;
}

/** Address map (adresseId -> { street, number, postcode, city }) from an address GML text. */
export function parseAddressesGml(text) {
  const map = new Map();
  for (const m of text.matchAll(FEATURE_MEMBER)) {
    const f = m[1];
    const id = f.match(/adresseId>(\d+)</);
    if (!id) continue;
    const number = (tagValue(f, 'nummer') || '') + (tagValue(f, 'bokstav') || '');
    map.set(Number(id[1]), {
      street: tagValue(f, 'adressenavn'),
      number: number || null,
      postcode: tagValue(f, 'postnummer'),
      city: tagValue(f, 'poststed'),
    });
  }
  return map;
}

/** The GML text inside a zip (the first .gml or .xml file). */
export async function gmlFromZip(zipBytes) {
  const zip = await JSZip.loadAsync(zipBytes);
  const name = Object.keys(zip.files).find((n) => /\.(gml|xml)$/i.test(n));
  if (!name) throw new Error('No GML file in the Matrikkel zip');
  return zip.file(name).async('string');
}

/**
 * Buildings and addresses for one municipality. Downloads go through `cache`
 * ({ get(key), put(key, bytes) }) so a municipality is fetched once.
 */
export async function loadKommune(kommune, { fetchImpl = globalThis.fetch, signal, cache = memoryCache() } = {}) {
  const atomFor = async (kind) => {
    const key = `atom:${kind}`;
    let xml = await cache.get(key);
    if (!xml) {
      const res = await fetchImpl(MATRIKKEL_ATOM[kind], { signal });
      if (!res.ok) throw new Error(`Matrikkel ${kind} feed answered ${res.status}`);
      xml = await res.text();
      await cache.put(key, xml);
    }
    return xml;
  };
  const zipFor = async (kind) => {
    const link = findKommuneLink(await atomFor(kind), kommune);
    if (!link) throw new Error(`No ${kind} file for kommune ${kommune} in the Matrikkel feed`);
    const key = `zip:${link}`;
    let bytes = await cache.get(key);
    if (!bytes) {
      const res = await fetchImpl(link, { signal });
      if (!res.ok) throw new Error(`Matrikkel ${kind} file answered ${res.status}`);
      bytes = new Uint8Array(await res.arrayBuffer());
      await cache.put(key, bytes);
    }
    return bytes;
  };

  const buildings = parseBuildingsGml(await gmlFromZip(await zipFor('buildings')));
  const addresses = parseAddressesGml(await gmlFromZip(await zipFor('addresses')));
  return { kommune, buildings, addresses };
}

const insideBounds = (b, bounds) => {
  const p = utm32ToLatLon(b.easting, b.northing);
  return p.lat >= bounds.south && p.lat <= bounds.north && p.lon >= bounds.west && p.lon <= bounds.east;
};

/**
 * Buildings inside `bounds` and the addresses of the municipalities they lie in,
 * ready for mergeNorwayBuildings(data, buildings, addresses, bounds).
 */
export async function norwayBuildingsForArea(bounds, opts = {}) {
  const kommuner = await kommunerInBox(bounds, opts);
  const buildings = [];
  const addresses = new Map();
  for (const kommune of kommuner) {
    const loaded = await loadKommune(kommune, opts);
    for (const b of loaded.buildings) if (insideBounds(b, bounds)) buildings.push(b);
    for (const [id, a] of loaded.addresses) addresses.set(id, a);
  }
  return { buildings, addresses, kommuner };
}
