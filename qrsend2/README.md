# QR-overføring 2 (toveis)

Som `../qrsend`, men begge enhetene bruker **frontkameraet** og holdes skjerm mot skjerm.
Begge skjermene viser bare QR-koder i fullskjerm.

## Format (`protocol.js`)
- **Data-QR** (avsender → mottaker): `[u16 nr][data]`. `nr` er hvilken bit av bildet koden bærer.
  Bit 0 starter med `[u16 antall biter][u16 metaLen][meta JSON]`, der meta = navn, type, størrelse og CRC-32.
- **Kvitterings-QR** (mottaker → avsender): `[u16 nr][u16 nr]…` – numrene på mottatte biter (opptil 11 per kode,
  QR versjon 2).

## Flyt
- Avsenderen viser 10 data-QR per pakke og leser kvitteringer med frontkameraet (kamerabildet vises ikke).
  Kvitterte numre tas bort fra skjermen med en gang og sendes aldri igjen; hver ny runde har bare ukvitterte numre.
  Den venter 1 s på siste kvitteringer før en ny runde, og godtar bare kvitteringer for numre den har vist (≥ 0,2 s).
- Mottakeren viser kvitteringer over hele skjermen: så få og store kvitterings-QR som mulig (som regel én),
  flere (opptil «Maks kvitterings-QR per bilde») når mange nye numre venter. Nye numre først (hvert to ganger),
  ledig plass fylles med alle mottatte numre etter tur. Etter at alt er mottatt vises kvitteringer i 8 s til.
- Uten overførings-id: mottakeren skjønner at en ny overføring har startet når samme nummer kommer med annet innhold.
  «Start mottak» etter et ferdig mottak starter alltid på nytt.
