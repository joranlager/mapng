# QR-overføring 5 (QR-koder med paritet)

Versjon 1 (`../qrsend`) med paritet, slik PAR-filer og gjenopprettingsvolum virker: en paritetskode kan
erstatte en hvilken som helst tapt kode. Bare QR-koder, enveis, samme utseende og innstillinger som versjon 1.

- Avsenderen viser først alle K datakodene én gang, og deretter bare paritetskoder, uten ende.
- En paritetskode er XOR av et tilfeldig utvalg datablokker (tilfeldig lineær kode over GF(2), se `protocol.js`).
  Mottakeren løser ligningene fortløpende og trenger K + ca. 0–4 koder totalt, uansett hvilke som gikk tapt.
- Mottakeren viser prosent, overføringstid og MB/s, og hvor mange koder som kom fra paritet.

Versjon 1 må vise en tapt kode på nytt og mottakeren må vente på akkurat den. Beregnet for 200 koder:
5 % tap: 2,2×K mot 1,06×K · 20 % tap: 3,8×K mot 1,26×K · 40 % tap: 6,5×K mot 1,68×K.
