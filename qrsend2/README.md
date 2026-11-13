# QR-overføring 2 (toveis)

Som `../qrsend`, men begge enhetene bruker **frontkameraet** og holdes skjerm mot skjerm:

- **Avsender** viser pakker med 10 data-QR-koder og leser samtidig mottakerens skjerm med frontkameraet.
- **Mottaker** leser data-QR-kodene og viser **kvitterings-QR-koder**: et bitkart over hvilke biter
  (QR-koder) som er mottatt (80 byte = 640 biter per kvitterings-QR; flere kvitteringer vises etter tur).
- Avsenderen hopper over alt som er kvittert. Hver ny runde inneholder bare bitene som ennå ikke er
  kvittert, blandet i ny rekkefølge. Når mottakeren melder «ferdig», stopper avsenderen.
- Leser avsenderen ingen kvitteringer, sender den bare alt i løkke som versjon 1.

Kvitteringsformat: se `protocol.js` (`makeAcks` / `parseAck`).
