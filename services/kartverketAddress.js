// Norwegian address search via Kartverket's open address API (Matrikkelen - Adresse).
// Licence: NLOD 2.0. Attribution: Kartverket.
// Coordinates come as EPSG:4258 (ETRS89), which is treated as WGS84 here (differences are sub-metre).

// In the browser, requests go through the same-origin proxy (dev: vite.config.js, hosted: a worker route).
export const KARTVERKET_ADDRESS_PATH = '/api/kartverket-adresse/sok';

const titleCase = (value) =>
    String(value || '')
        .toLowerCase()
        .replace(/(^|[\s-])(\p{L})/gu, (_, sep, ch) => sep + ch.toLocaleUpperCase('nb-NO'));

export const buildAddressSearchParams = (query, limit = 5) =>
    new URLSearchParams({
        sok: String(query || '').trim(),
        treffPerSide: String(limit),
        side: '0'
    });

// Turns one API response into the same shape searchLocation() returns for Nominatim.
export const parseAddressResponse = (json) => {
    const list = Array.isArray(json?.adresser) ? json.adresser : [];
    const seen = new Set();
    const results = [];

    for (const address of list) {
        const lat = Number(address?.representasjonspunkt?.lat);
        const lng = Number(address?.representasjonspunkt?.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

        const street = address.adressetekst || address.adressetekstutenadressetilleggsnavn || '';
        const place = [address.postnummer, address.poststed].filter(Boolean).join(' ');
        const municipality = titleCase(address.kommunenavn);
        // Same municipality name as the post town is not repeated.
        const parts = [street, place];
        if (municipality && municipality.toLowerCase() !== String(address.poststed || '').toLowerCase()) {
            parts.push(municipality);
        }
        const displayName = parts.filter(Boolean).join(', ');

        // Duplicate addresses (same coordinates and name) are dropped.
        const key = `${displayName}|${lat.toFixed(6)}|${lng.toFixed(6)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
            lat,
            lng,
            displayName,
            type: 'address',
            boundingBox: undefined,
            source: 'kartverket',
            addressId: address.adresseid != null ? String(address.adresseid) : undefined
        });
    }

    return results;
};

// Returns [] on any failure so the caller can fall back to other geocoders.
export const searchNorwayAddresses = async (query, { limit = 5, signal } = {}) => {
    const text = String(query || '').trim();
    if (text.length < 2) return [];

    try {
        const response = await fetch(`${KARTVERKET_ADDRESS_PATH}?${buildAddressSearchParams(text, limit)}`, {
            headers: { Accept: 'application/json' },
            signal
        });
        if (!response.ok) {
            console.warn(`[KartverketAddress] HTTP ${response.status}`);
            return [];
        }
        return parseAddressResponse(await response.json());
    } catch (error) {
        if (error?.name !== 'AbortError') {
            console.warn('[KartverketAddress] search failed:', error);
        }
        return [];
    }
};
