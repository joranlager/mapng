# QR-overføring 3 (halvdeler)

Bygger på versjon 1 (`../qrsend`): enveis, ingen kvitteringer, mottakeren bruker bakkameraet.

Forskjellen er rekkefølgen avsenderen sender i:
1. Bitene deles i to halvdeler (første halvdel får den ekstra biten ved oddetall).
2. Første halvdel sendes i «Runder per halvdel» runder (standard 3), 10 QR-koder per pakke.
   Første runde i rekkefølge, senere runder blandet. Første halvdel er helt ferdig før andre halvdel starter.
3. Andre halvdel sendes på samme måte.
4. Deretter starter det på nytt fra første halvdel («gjennomgang 2» …) til du trykker Stopp.

Mottakeren er den samme som i versjon 1. Formatet er det samme som i versjon 1 (se `protocol.js`).
