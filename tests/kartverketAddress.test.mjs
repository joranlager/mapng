import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    buildAddressSearchParams,
    parseAddressResponse,
    searchNorwayAddresses,
    KARTVERKET_ADDRESS_PATH
} from '../services/kartverketAddress.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
    readFileSync(join(here, 'fixtures', 'kartverket-karl-johans-gate-1.json'), 'utf8')
);

test('builds the Kartverket query string', () => {
    const params = buildAddressSearchParams('  Karl Johans gate 1 ', 3);
    assert.equal(params.get('sok'), 'Karl Johans gate 1');
    assert.equal(params.get('treffPerSide'), '3');
    assert.equal(params.get('side'), '0');
});

test('parses coordinates and names each address with its municipality', () => {
    const results = parseAddressResponse(fixture);
    assert.equal(results.length, 3);

    const oslo = results.find((r) => r.displayName.includes('Oslo') || r.displayName.includes('OSLO'));
    assert.ok(oslo, 'Oslo result present');
    assert.equal(oslo.displayName, 'Karl Johans gate 1, 0154 OSLO');
    assert.equal(oslo.lat, 59.91137751973457);
    assert.equal(oslo.lng, 10.749403963247154);
    assert.equal(oslo.type, 'address');
    assert.equal(oslo.source, 'kartverket');
    assert.equal(oslo.addressId, '285717643');
});

test('keeps municipality when it differs from the post town', () => {
    const results = parseAddressResponse({
        adresser: [{
            adressetekst: 'Storgata 1',
            postnummer: '7011',
            poststed: 'TRONDHEIM',
            kommunenavn: 'TRONDHEIM',
            representasjonspunkt: { lat: 63.43, lon: 10.39 }
        }, {
            adressetekst: 'Dalvegen 2',
            postnummer: '6800',
            poststed: 'FØRDE',
            kommunenavn: 'KINN',
            representasjonspunkt: { lat: 61.45, lon: 5.85 }
        }]
    });
    assert.equal(results[0].displayName, 'Storgata 1, 7011 TRONDHEIM');
    assert.equal(results[1].displayName, 'Dalvegen 2, 6800 FØRDE, Kinn');
});

test('skips addresses without coordinates and drops exact duplicates', () => {
    const results = parseAddressResponse({
        adresser: [
            { adressetekst: 'Ingen 1', postnummer: '0001', poststed: 'X', kommunenavn: 'X', representasjonspunkt: {} },
            { adressetekst: 'Dup 1', postnummer: '0002', poststed: 'Y', kommunenavn: 'Y', representasjonspunkt: { lat: 60, lon: 10 } },
            { adressetekst: 'Dup 1', postnummer: '0002', poststed: 'Y', kommunenavn: 'Y', representasjonspunkt: { lat: 60, lon: 10 } }
        ]
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].displayName, 'Dup 1, 0002 Y');
});

test('handles empty or malformed responses', () => {
    assert.deepEqual(parseAddressResponse(null), []);
    assert.deepEqual(parseAddressResponse({}), []);
    assert.deepEqual(parseAddressResponse({ adresser: 'nope' }), []);
});

test('searchNorwayAddresses calls the proxy path and parses the body', async () => {
    const originalFetch = globalThis.fetch;
    let calledUrl = '';
    globalThis.fetch = async (url) => {
        calledUrl = String(url);
        return { ok: true, json: async () => fixture };
    };
    try {
        const results = await searchNorwayAddresses('Karl Johans gate 1', { limit: 3 });
        assert.ok(calledUrl.startsWith(`${KARTVERKET_ADDRESS_PATH}?`));
        assert.ok(calledUrl.includes('sok=Karl+Johans+gate+1'));
        assert.equal(results.length, 3);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('searchNorwayAddresses returns [] on HTTP errors and network failures', async () => {
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
        globalThis.fetch = async () => ({ ok: false, status: 503 });
        assert.deepEqual(await searchNorwayAddresses('Storgata 1'), []);

        globalThis.fetch = async () => { throw new TypeError('network down'); };
        assert.deepEqual(await searchNorwayAddresses('Storgata 1'), []);
    } finally {
        globalThis.fetch = originalFetch;
        console.warn = originalWarn;
    }
});

test('searchNorwayAddresses ignores queries shorter than two characters', async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
    try {
        assert.deepEqual(await searchNorwayAddresses(' a '), []);
        assert.equal(called, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
