# QR-overføring 4 (fontene-koder, fargerutenett)

Bygget på versjon 1 (`../qrsend`). Avsenderen sender symboler kontinuerlig, og mottakeren
trenger bare nok symboler. Tapte bilder gjør ikke noe: de bare forlenger overføringen.

## Symboler (`protocol.js`)
Strømmen `[u16 metaLen][meta JSON][bildefil]` deles i K blokker på B byte. Hvert symbol er en XOR av
noen blokker (LT-koder med robust soliton-fordeling). De K første symbolene er systematiske
(én blokk hver), deretter tilfeldige. Mottakeren bruker peeling-dekoding og er ferdig når alle K blokker er kjent.

Symbolet er 22 byte overhead + B: magic, flagg, overførings-id, K, B, streamLen, seed, nyttelast og CRC-32.

## To modi (avsender)
- **QR-koder**: 10 QR-koder per pakke (standard), byte per symbol 380, bytt pakke hvert 300 ms.
- **Fargerutenett**: G×G celler (standard 40), 4 eller 8 farger (2 eller 3 bit per celle), 10 bilder/s.
  Rammen og paletteremsen gjør det mulig å kalibrere farger og finne hjørnene. Homografi gir tåleevne mot rotasjon og perspektiv.

## Mottaker
Leser QR-koder og fargerutenett samtidig, i egne arbeidstråder (`decoder-worker.js` og `grid-worker.js`).
Fargerutenettet må ha samme G og antall farger som avsenderen (innstilles i mottakerens skjema).
Prosent overført er blokker mottatt / K. MB/s er nyttig data per sekund.

## Test
- Fontene-koden: ingen tap gir K symboler, 10 % tap gir ca. 1,2×K, 40 % tap gir ca. 2,2×K.
- Fargerutenett i Chromium: eksakt avlesing med skalering 0,45–1, rotasjon ±0,05 rad, uskarphet og støy.
- Ende-til-ende med simulert kamera (skjermbilder, 20 % droppede bilder): QR og fargerutenett kommer fram med kontrollsum OK.
- Ikke testet på ekte telefon eller webkamera.
