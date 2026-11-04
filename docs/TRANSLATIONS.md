# Nederlandse LibreChat-vertalingen

GovChat-NL kan eigen Nederlandse vertalingen toepassen boven op de vertalingen
uit de vastgezette officiële LibreChat-image. De runtime-override houdt de
officiële image als upgradegrens aan; hiervoor is geen LibreChat-fork of eigen
image-build nodig. De wijziging aan de gebundelde locale is wel gekoppeld aan de
gecontroleerde asset- en serviceworker-signatures van de gekozen LibreChat-image.

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

De override wijzigt naast de Nederlandse bundel de cacheversie in LibreChats
serviceworker. Die versie wordt automatisch afgeleid van de locale-override, de
locale-bundel en de originele serviceworker. De serviceworker-activatie verwijdert
oude `locale-chunks`-caches; de nieuwe versie gebruikt een eigen cache. De
reverse proxy zet daarnaast `no-store`-headers op de gewijzigde locale-URL, zodat
de normale browser-HTTP-cache de upstream hashnaam niet als ongewijzigde inhoud
behandelt, en `no-cache` op `/sw.js` zodat de serviceworker-updatecontrole steeds
de gewijzigde worker kan waarnemen.

Pas na het wijzigen van `.env` of `translation.json` de container opnieuw toe:

```sh
docker compose up -d --force-recreate librechat
```

De vertalingen en serviceworker worden vóór `npm run backend` aangepast. De
aangepaste JS-, gzip- en brotli-localevarianten plus `sw.js` worden alleen in de
schrijfbare containerlaag bijgewerkt. Originele bestanden worden tijdelijk onder
`/tmp` bewaard zodat herhaalde starts veilig zijn en uitschakelen zowel de locale
als de serviceworker uit de image herstelt. Bij het opnieuw aanmaken van de
container begint LibreChat weer met de imagebestanden. Navigaties laten de
gewijzigde serviceworker automatisch controleren en activeren; normaal gesproken
is handmatig wissen van Cache Storage niet nodig.

Een open tabblad kan de huidige pagina nog met de eerder geladen vertalingen
weergeven. Vernieuw die pagina na de containerstart; handmatig Cache Storage
wissen of serviceworkers unregisteren hoort niet bij de normale procedure.

## LibreChat-image bijwerken

De imageversie staat vast in [`docker-compose.yml`](../docker-compose.yml:13).
Een build-time LibreChat-fork of custom image zou de schoonste oplossing zijn
voor compile-time content hashes, maar wijkt af van de operationele keuze om de
officiële image rechtstreeks te gebruiken. Daarom blijft dit een versiegebonden
runtimepatch. De patch vereist exact één `locale-nl.*.js`, de verwachte
ES-module-export en precies één Workbox `StaleWhileRevalidate`-cache met de naam
`locale-chunks`. Bij een onbekende bundel- of serviceworkerstructuur stopt de
containerstart fail-closed. De upstream assetnaam blijft ongewijzigd; de
serviceworker-cache krijgt daarentegen een inhoudsafhankelijke versie en de
proxy schakelt browser-HTTP-caching voor die localebestanden uit.

Een LibreChat-upgrade is een expliciete acceptatiestap, geen automatische
tag-upgrade:

1. Wijzig de gepinde image in [`docker-compose.yml`](../docker-compose.yml:13)
   naar een expliciet gekozen release en haal die image op.
2. Voer de unit-tests uit met `node tests/translations/run-tests.js`.
3. Test de kandidaat-image tegen zijn **eigen echte** gebundelde locale en
   `i18next`-dependency (PowerShell vanuit `GovChat-NL-LibreChat`):

   ```powershell
   docker run --rm -v "${PWD}:/govchat:ro" --entrypoint node `
     registry.librechat.ai/danny-avila/librechat:v0.8.7 `
     /govchat/tests/translations/run-image-loader-test.js
   ```

   Vervang `v0.8.7` bij een upgrade door de kandidaat-tag. De controle importeert
   de gepatchte echte locale-module, geeft
   `module.t.default` door aan `i18next` en controleert de v0.8.7-legacy-key
   `com_ui_good_evening` op de UI-uitkomst `Goedenavond, Jeannot`.
4. Start de kandidaatimage opnieuw, controleer de logs op de toegepaste
   cacheversie en test in een browser dat de serviceworker vernieuwt en de
   Nederlandse begroeting klopt, zonder handmatige Cache Storage-verwijdering.
5. Promoveer de tag pas na deze controles; rollback door de vorige gepinde
   image-tag terug te zetten en de container opnieuw aan te maken.

De tests valideren de aanwezige runtimecontracten, niet elke toekomstige
LibreChat-build. Een nieuwe Workbox- of bundelstructuur moet eerst expliciet in
de patch en tests worden ondersteund.

De geïsoleerde logica-tests staan in
[`tests/translations/run-tests.js`](../tests/translations/run-tests.js). Start ze
met `node tests/translations/run-tests.js`. De echte image-/loader-controle staat
in [`tests/translations/run-image-loader-test.js`](../tests/translations/run-image-loader-test.js)
en draait in de LibreChat-container zelf. De branding-startprocedure heeft
afzonderlijke tests in [`tests/branding/run-tests.sh`](../tests/branding/run-tests.sh).
