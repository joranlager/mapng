# QR-overføring 6 (paritet, data, paritet)

Versjon 5 (`../qrsend5`) med en annen rekkefølge hos avsenderen. Overføringen går i tre like deler,
hver på K koder (K = antall datakoder):

1. bare paritetskoder
2. alle datakodene
3. bare paritetskoder

Deretter starter den forfra, med nye paritetskoder hver gang (ingen paritetskode vises to ganger).
Mottakeren, formatet og innstillingene er som i versjon 5.

Beregnet (K = 201, snitt av 30 forsøk): mottakeren er ferdig etter like mange viste koder som i versjon 5,
uansett når den begynner å se: 1,00–1,01×K uten tap, ca. 1,26×K ved 20 % tap, ca. 1,68×K ved 40 % tap.
