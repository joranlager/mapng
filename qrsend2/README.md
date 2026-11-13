# QR-overføring 2 (toveis)

Som `../qrsend`, men begge enhetene bruker **frontkameraet** og holdes skjerm mot skjerm:

- **Avsender** viser bare QR-koder (10 per pakke) og leser samtidig mottakerens skjerm med frontkameraet (kamerabildet vises ikke). Trykk på skjermen eller Esc stopper; mellomrom = pause, +/− = fart. Resultatet vises når avspillingen lukkes.
- Hver data-QR har bilde-id og en **id** (bitnummeret) i headeren inni koden.
- **Mottaker** leser data-QR-kodene og viser små **kvitterings-QR-koder** (QR versjon 2, 25×25 ruter):
  - nye id-er kvitteres straks som en liste («kvitterer id 30, 31, …», inntil 11 per kode, hver vist 2 ganger),
  - mange nye på én gang kvitteres med bitkart-segmentet de ligger i (160 id-er per kode),
  - mangler det 11 eller færre: én kode med «alt unntatt id …»; tom liste = ferdig.
- **Avsender** sender aldri en id som er kvittert: kvitterte id-er fjernes fra skjermen med en gang,
  og hver ny runde inneholder bare ukvitterte id-er. Før en ny runde venter den 1 s på siste kvitteringer.
- Leser avsenderen ingen kvitteringer, sender den bare alt i løkke som versjon 1.

Kvitteringsformat: se `protocol.js` (`makeAcks` / `parseAck`).
