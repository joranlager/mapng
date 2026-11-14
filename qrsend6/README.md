# QR-overføring 6 (data først, deretter paritet, med nedtelling)

Som versjon 5 (`../qrsend5`), med nedtelling før start.

- Nedtelling på avsenderskjermen før sending (standard 5 s, kan endres, 0 = av).
- Avsenderen sender først alle K datakodene én gang. Når de er ferdige, sendes bare paritetskoder
  (alltid nye) helt til den stoppes.
- En paritetskode kan erstatte en hvilken som helst tapt kode. Mottakeren trenger K + ca. 0–4 koder.
