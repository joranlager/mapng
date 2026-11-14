# QR-overføring 4 (fontene-kode, fargerutenett, feilretting)

Bygget på versjon 1 (`../qrsend`). Enveis: avsenderen sender symboler helt til den stoppes, og
mottakeren trenger bare nok symboler. Tapte bilder forlenger bare overføringen.

## Fontene-kode (`protocol.js`)
Strømmen `[u16 metaLen][meta JSON][fil]` deles i K blokker på B byte. De K første symbolene er
systematiske (én blokk hver). Deretter er hvert symbol en XOR av et tilfeldig utvalg blokker
(tilfeldig lineær kode over GF(2): hver blokk med sannsynlighet 1/2 opp til 1024 blokker, ellers 512
tilfeldige blokker). Mottakeren løser ligningene fortløpende med Gauss-eliminasjon.
Målt: 0–4 symboler mer enn K, uansett tap (0–50 %).

Symbol = 22 byte overhead + B: magic, flagg, overførings-id, K, B, streamLen, seed, nyttelast, CRC-32.

## Fargerutenett (`grid.js`, `rs.js`)
G×G celler med 4 eller 8 farger (hjørnene i RGB-kuben), svart ramme og en paletteremse som
kalibrerer fargene i hvert bilde. Mottakeren finner rammens fire hjørner og bruker en homografi,
så rotasjon og perspektiv tåles. Hvert bilde er beskyttet med Reed-Solomon (32 paritetsbyte per
255, flettet), som retter inntil 16 feilleste byte per kodeord.

Forhåndsvalg: Trygg 40×40/4 farger/10 bilder/s · Rask 96×96/8/12 (2986 byte per bilde, 35 kB/s brutto)
· Maks 120×120/8/15 (4674 byte per bilde, 68 kB/s brutto). Mottakeren finner selv hvilket som brukes.

## QR-modus
Samme fontene-kode i QR-koder (10 per pakke). Tregere, men leses av enklere kameraer.

## Målt i simulering (Chromium, ikke ekte kamera)
1 MB, 1080p-kamera, 20 % tapte bilder, litt uskarpt og vridd: Rask 44 s, Maks 29 s.
Ikke testet på ekte mobiler.
