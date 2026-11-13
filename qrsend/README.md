# QR-overføring

Webapp som sender et bilde fra én enhet til en annen kun via skjerm og kamera.

- **Send**: velg et bilde. Det komprimeres (valgfritt), deles i biter, og hver bit blir en QR-kode.
  Skjermen spiller av *pakker* med 10 QR-koder om gangen, i løkke. Hver runde blandes rekkefølgen,
  så en kode som var vanskelig å lese et sted på skjermen havner et annet sted neste runde.
- **Motta**: kameraet leser alle QR-kodene i hvert bilde (zxing-cpp/WebAssembly i Web Workers),
  samler bitene, sjekker CRC-32 og viser bildet med Del/Lagre og Last ned.

Ingen server, ingen nettverk under overføringen; alt kjører i nettleseren. Bibliotekene ligger i `vendor/`.

## Kjøre
Kameraet krever HTTPS (eller `localhost`). Enklest: GitHub Pages via `.github/workflows/qrsend-pages.yml`
(Settings → Pages → Source: GitHub Actions). Lokalt: `cd qrsend && python3 -m http.server 8000`.

`?mode=recv` åpner direkte i mottaksmodus.

## Tips
- Full lysstyrke på avsenderskjermen, hold mottakeren stødig så alle 10 kodene er i bildet.
- Leser mottakeren for få koder: øk «Tid per pakke», senk «Byte per QR-kode», eller velg 1440p/4K.

## Format
Se `protocol.js`: 10 byte header (magic, versjon, overførings-id, indeks, antall) + data per QR-kode
(binær byte-modus). Bit 0 starter med metadata (navn, type, størrelse, CRC-32).

Lisenser: qrcode-generator (MIT, Kazuhiko Arase), zxing-wasm (MIT, se `vendor/LICENSE-zxing-wasm.txt`).
