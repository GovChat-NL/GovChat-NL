# Nederlandse LibreChat-vertalingen

GovChat-NL kan eigen Nederlandse vertalingen toepassen boven op de vertalingen
uit de vastgezette LibreChat-image. Dit is een runtime-override; er is geen
LibreChat-fork of eigen image-build nodig.

## Instelling

Stel [`LIBRECHAT_NL_TRANSLATIONS_ENABLED`](../.env.example:11) in het lokale
[`.env`](../.env.example)-bestand in:

| Waarde | Gedrag |
| --- | --- |
| `true` | Past de ingevulde vertalingen uit [`overlay/locales/nl/translation.json`](../overlay/locales/nl/translation.json) toe. Dit is de standaard. |
| `false` | Herstelt de originele Nederlandse bundel uit de image en schakelt de eigen vertalingen uit. |

De instelling staat los van [`BRANDING_MODE`](BRANDING.md:3). Ook met de
LibreChat-huisstijl kan de Nederlandse vertaaloverride actief blijven.

## Vertalingen aanpassen en fallback

Bewaar het bestand op
[`overlay/locales/nl/translation.json`](../overlay/locales/nl/translation.json).
Gebruik een JSON-object waarin de LibreChat-vertaalsleutel aan een tekstwaarde
is gekoppeld. De sleutel en alle interpolaties, bijvoorbeeld `{{name}}` of
`{{0}}`, moeten behouden blijven. Waarden die ontbreken, leeg zijn of alleen
witruimte bevatten, worden genegeerd.

Per vertaalsleutel gebruikt LibreChat deze volgorde:

1. De eigen Nederlandse tekst uit [`translation.json`](../overlay/locales/nl/translation.json), als die niet leeg is.
2. De Nederlandse vertaling uit de LibreChat-image.
3. De Engelse LibreChat-vertaling via de normale taal-fallback.

De eigen vertalingen worden over de bestaande Nederlandse bundel gelegd; ze
vervangen die bundel niet. Niet-Nederlandse talen worden niet aangepast.
Het meegeleverde woordenboek bevat zowel de nieuwe `com_ui_greeting_*`-sleutels
als de oudere `com_ui_good_*`-sleutels die LibreChat v0.8.7 nog voor de
welkomstgroet gebruikt.

## Toepassen en uitschakelen

Vanwege de browsercache van LibreChat is alleen `.env` aanpassen of een browser
herladen niet voldoende. Maak de LibreChat-container opnieuw aan:

```sh
docker compose up -d --force-recreate librechat
```

De vertalingen worden vóór `npm run backend` toegepast. De aangepaste JS-, gzip-
en brotli-bundels worden alleen in de schrijfbare containerlaag bijgewerkt; de
oorspronkelijke bundels worden tijdelijk onder `/tmp` bewaard zodat herhaalde
starts veilig zijn en uitschakelen de LibreChat-imageversie herstelt. Bij het
opnieuw aanmaken van de container begint LibreChat weer met de bundels uit de
image.

Na het wisselen kun je zo nodig een harde browser-refresh uitvoeren: **Ctrl+F5**
op Windows/Linux of **Cmd+Shift+R** op macOS.

## LibreChat-image bijwerken

De imageversie staat vast in [`docker-compose.yml`](../docker-compose.yml:13).
De startup-override controleert of precies één `locale-nl.*.js`-bundel aanwezig
is en of de verwachte ES-module-export bestaat. Als LibreChat de naamgeving of
bundelstructuur verandert, stopt het starten met een gerichte foutmelding in
plaats van stilzwijgend de verkeerde asset te wijzigen. Test daarom na een
LibreChat-upgrade de startup en de Nederlandse taalkeuze voordat de image in
productie wordt gebruikt.

De geïsoleerde logica-tests staan in
[`tests/translations/run-tests.js`](../tests/translations/run-tests.js). Start ze
met `node tests/translations/run-tests.js`; de branding-startprocedure heeft
afzonderlijke tests in [`tests/branding/run-tests.sh`](../tests/branding/run-tests.sh).
