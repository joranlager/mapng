# QR-overføring 7 (LT-koder)

Versjon 6 (`../qrsend6`: QR-koder, nedtelling, statuslinje og fargekart) med ekte Luby Transform-koder.

- **Avsender:** filen deles i K blokker. Skjermen viser en endeløs strøm av koder. Hver kode er XOR av
  d tilfeldige blokker, der d trekkes fra robust soliton-fordelingen (c = 0,05, δ = 0,5). Koden bærer
  bare en seed; mottakeren kjører samme tilfeldige generator og vet hvilke blokker som er slått sammen.
  Det finnes ingen egne datakoder, og ingen kode vises to ganger.
- **Mottaker:** dekoderen kjører i en Web Worker (`lt-worker.js`). Kjedereaksjon (peeling): en kode med
  én ukjent blokk gir den blokken, som trekkes ut av alle koder som venter på den. Når minst K koder er
  samlet og kjedereaksjonen står stille, løses resten som et ligningssett (Gauss).
- **Kart:** grønn = blokk lest direkte (kode med grad 1), gul = regnet ut med XOR, grå = ikke løst.
- Prosenten viser andel av kodene som trengs (ca. 1,05×K) som er samlet. Blokkene løses mest mot slutten.

Målt (snitt av 15 forsøk, 20 % tap): bare kjedereaksjon trenger 1,38×K (K=53), 1,22×K (K=201),
1,14×K (K=1053). Med ligningssett til slutt: 1,09×K, 1,04×K, 1,03×K. Versjon 6 trenger K + 0–4 koder.
