# LibreChat-branding configureren

De LibreChat-container ondersteunt drie waarden voor `BRANDING_MODE`. Stel de
variabele in het lokale `.env`-bestand in; de standaardwaarde is `govchat`.

| `BRANDING_MODE` | Gedrag |
| --- | --- |
| `govchat` | Past de GovChat-NL-logo's en favicons uit `./branding` toe. Dit is de standaard. |
| `custom` | Past eerst GovChat-NL toe en overschrijft daarna alleen de aangeleverde bestanden uit `./custom-branding`. |
| `librechat` | Wijzigt de assets niet; de oorspronkelijke bestanden uit de LibreChat-image blijven actief. |

`APP_TITLE` stelt alleen de zichtbare applicatietitel in en staat los van de
logo's en favicons. De modus bepaalt de afbeeldingen; de titel moet je
afzonderlijk instellen als je bijvoorbeeld de oorspronkelijke LibreChat-logo's
met een andere applicatietitel wilt gebruiken.

## Eigen logo's gebruiken

De standaard GovChat-NL-logo's en favicons staan samen in `./branding`. Plaats
eigen assets in `./custom-branding` met exact deze namen en afmetingen:

| Bestand | Formaat / afmetingen |
| --- | --- |
| `logo.svg` | SVG, schaalbaar vectorbestand. |
| `favicon-32x32.png` | PNG, 32 × 32 pixels. |
| `favicon-16x16.png` | PNG, 16 × 16 pixels. |
| `apple-touch-icon-180x180.png` | PNG, 180 × 180 pixels. |

Alle bestanden zijn optioneel. In `custom`-modus wordt eerst de GovChat-NL-
branding als basis gekopieerd; elk geldig bestand in de eigen map vervangt
alleen het bestand met dezelfde naam. Je kunt dus alleen `logo.svg` toevoegen
en houdt voor de andere drie bestanden de GovChat-NL-defaults. Ontbrekende of
lege bestanden en directories worden overgeslagen; kopieerfouten en een
onbekende modus stoppen de container met een duidelijke foutmelding.

## De modus wijzigen

1. Wijzig `BRANDING_MODE` in `.env` in `govchat`, `custom` of `librechat`.
2. Voer vanuit deze map uit:

   ```sh
   docker compose up -d
   ```

   Compose maakt de container opnieuw aan als de configuratie is gewijzigd.
   Omdat Compose veranderingen in de inhoud van een bind-mounted map niet
   detecteert, forceer je bij het wisselen van logo's of na het bijwerken van
   eigen bestanden een nieuwe container met
   `docker compose up -d --force-recreate librechat`.

De branding wordt bij iedere containerstart vóór `npm run backend` toegepast.
De brandingassets zelf worden niet persistent in `client/dist/assets` gemount:
zo blijven de originele imagebestanden intact en herstelt modus `librechat` de
originele branding bij een nieuwe container. Start voor een wissel dus de
container opnieuw aan via Compose; een browser-refresh alleen wijzigt de
containerassets niet.

Als je Compose met expliciete `-f`-bestanden start, moet je ook de override
opnemen omdat Compose die niet automatisch toevoegt:

```sh
docker compose -f docker-compose.yml -f docker-compose.override.yml up -d
```

Na het wijzigen van de branding moet de browsercache worden omzeild met een
harde refresh: **Ctrl+F5** op Windows/Linux of **Cmd+Shift+R** op macOS. Browsers
cachen SVG-logo's en favicons vaak agressief.

De instelbare modi en containerstart zijn getest met de geïsoleerde
shelltests in `tests/branding/run-tests.sh`; voer ze uit met:

```sh
sh tests/branding/run-tests.sh
```
