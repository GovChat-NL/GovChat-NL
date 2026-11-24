# Linkpreviews configureren

De titel, beschrijving en optionele previewafbeelding van GovChat-NL worden
tijdens de containerstart uit de publieke deploymentconfiguratie opgebouwd.
Ze staan direct in de geserveerde HTML: WhatsApp, Teams, LinkedIn en andere
crawlers hoeven geen JavaScript uit te voeren. Een nieuwe LibreChat-build is
niet nodig. De configuratie geldt voor alle pagina's, inclusief gedeelde links.

## Variabelen en defaults

Stel de waarden in je lokale, niet-gecommitteerde omgeving in. Het
[env-voorbeeld](../.env.example:36) bevat de variabelen; [Compose](../docker-compose.yml:48)
geeft ze door aan de LibreChat-container.

| Variabele | Gedrag |
| --- | --- |
| [`APP_TITLE`](../.env.example:36) | Bestaande applicatienaam; standaard `GovChat-NL`. Gebruikt voor de HTML-titel, Open Graph-sitenaam en -titel, Twitter-titel en alternatieve afbeeldingtekst. Ook de overlaynaam en webappnaam blijven hiervan afgeleid. |
| [`APP_DESCRIPTION`](../.env.example:39) | Eigen publieke omschrijving. Niet ingesteld, leeg of alleen witruimte: de applicatienaam gevolgd door ` — AI-chatassistent`. Witruimte aan begin/einde wordt verwijderd. Gebruikt voor de gewone HTML-beschrijving, Open Graph en Twitter. |
| [`APP_IMAGE_URL`](../.env.example:42) | Optionele absolute HTTP(S)-URL voor de previewafbeelding. Leeg of alleen witruimte: geen afbeeldingtags en een Twitter-summarykaart. Met afbeelding: een grote Twitter-summarykaart. Er wordt geen LibreChat-afbeelding of favicon als fallback ingevoegd. |
| [`PUBLIC_BASE_URL`](../.env.example:44) | Bestaande publieke applicatie-URL; levert ook de Open Graph-URL. Gebruik de voor gebruikers zichtbare URL, niet een interne containernaam. De wrapper gebruikt de bestaande clientdomeinvariabele als fallback; ontbreken beide, dan wordt de Open Graph-URL weggelaten. |

De metadata wordt in **alle drie brandingmodi** toegepast. De
[brandingmodus](BRANDING.md:3) bepaalt de logo's en favicons, niet de linkpreviewtekst.
Lege waarden schakelen de omschrijving niet uit: de generieke default voorkomt
dat crawlers alsnog de oorspronkelijke LibreChat-beschrijving kiezen.

## Configuratievoorbeeld

```dotenv
APP_TITLE='Mijn GovChat'
APP_DESCRIPTION='AI-assistent voor medewerkers van onze organisatie.'
PUBLIC_BASE_URL='https://chat.example.org'
APP_IMAGE_URL='https://cdn.example.org/govchat-preview-v1.png'
```

Laat de afbeeldingsvariabele leeg als je geen eigen previewafbeelding wilt.
De URL wordt niet door de container opgehaald of naar een lokaal bestand gekopieerd:
host de afbeelding zelf op een publiek bereikbare HTTPS-locatie. Een bestand in
de lokale brandingmap is niet automatisch een publieke previewafbeelding.
Gebruik bij voorkeur een PNG of JPEG van ongeveer **1200 × 630 pixels** met een
passende inhoud en beperkte bestandsgrootte; de uiteindelijke weergave blijft
afhankelijk van het platform.

## Validatie en privacy

- URL's moeten absoluut en HTTP(S) zijn. Relatieve paden, andere protocollen,
  credentials, fragments, interne witruimte/controltekens en backslashes worden
  geweigerd. De publieke applicatie-URL mag ook geen queryparameters bevatten.
  De afbeeldings-URL mag wel queryparameters hebben, bijvoorbeeld voor een
  publieke afbeeldingsversie; gebruik geen geheime of tijdelijke toegangstokens.
- Ongeldige URL's stoppen de metadata-wrapper met een foutmelding vóór het
  schrijven van metadata. De applicatie start niet met een half bijgewerkte preview.
- Titel en omschrijving worden HTML-geëscaped. Zet alleen publieke informatie
  in deze variabelen: iedereen die de pagina kan opvragen kan de metadata lezen.
- Geen gesprekstitels, berichten, gebruikersgegevens of parameters uit de
  gedeelde URL worden in de preview opgenomen. De Open Graph-URL verwijst naar
  de ingestelde applicatiebasis, niet naar een specifieke chat.
- Bestaande Open Graph- en Twitter-tags worden vervangen, ook afbeeldings-
  subproperties. Er is één gezaghebbende set deploymentmetadata; oude of dubbele
  LibreChat-waarden blijven niet beschikbaar voor crawlers.
- De wrapper omzeilt geen authenticatie, SSO, firewall of crawlerblokkade. Als
  een platform de applicatie of afbeelding niet kan bereiken, kan het ook geen
  correcte preview ophalen. Maak daarvoor geen privégesprekken of uploads openbaar.

## Activeren en verifiëren

Maak na wijzigingen de LibreChat-container opnieuw aan vanuit de repository:

```sh
docker compose up -d --force-recreate librechat
```

Gebruik je expliciete Compose-bestanden, neem dan ook de
[brandingoverride](../docker-compose.override.yml) en eventuele deploymentoverrides op:

```sh
docker compose -f docker-compose.yml -f docker-compose.override.yml up -d --force-recreate librechat
```

Alleen herstarten na een env-wijziging is niet genoeg: de bestaande container
houdt zijn oude environment. De override is noodzakelijk voor de branding-wrapper.
Controleer daarna de logs en de ruwe HTML, niet alleen de DOM na browser-JavaScript:

```sh
docker compose logs --tail=50 librechat
curl --compressed -A 'WhatsApp/2.0' https://chat.example.org/
curl --compressed -A 'WhatsApp/2.0' https://chat.example.org/share/REPLACE_WITH_PUBLIC_SHARE_ID
```

Controleer titel, beschrijving en de Open Graph-/Twitter-tags. Beide responses
moeten dezelfde publieke branding bevatten, zonder de oorspronkelijke
LibreChat-omschrijving. Een eventuele SSO-redirect moet eerst op infrastructuurniveau
worden beoordeeld. Gecomprimeerde HTML en webmanifestbestanden worden samen met
de gewone bestanden bijgewerkt; Workbox-revisies van gewijzigde bestanden wijzigen mee.

## Oude previews verversen

Chat- en socialmediaplatforms bewaren previews buiten GovChat. Een browserrefresh
of containerherstart wist die externe cache niet. Test eerst een nog niet gedeelde
publieke URL, gebruik waar beschikbaar een platformtool voor opnieuw scrapen
(bijvoorbeeld LinkedIn Post Inspector of Facebook Sharing Debugger), of wacht op
cache-expiratie. WhatsApp en Teams bieden niet altijd een handmatige cache-reset.
Bij een gewijzigde afbeelding helpt een nieuwe publieke bestandsnaam of versie-URL.
De exacte kaartopmaak en verversingstermijn worden door het platform bepaald.

## Tests

De [unit- en regressietests](../tests/branding/link-preview.test.js) controleren
defaults, escaping, afwijkende HTML-opmaak, dubbele/ontbrekende tags, URL-validatie,
manifestcompatibiliteit, herhaalde uitvoering en gecomprimeerde bestanden.

```sh
node --test tests/branding/metadata.test.js tests/branding/link-preview.test.js
sh tests/branding/run-tests.sh
```

De [image-smoketest](../tests/branding/link-preview-image.test.js) gebruikt de echte
HTML en response-handler uit de vastgepinde LibreChat-image, de containerstart-wrapper
en loopback-HTTP voor de hoofdpagina en gedeelde links, met en zonder gzip en voor
alle brandingmodi. Niet-gerelateerde CSP/devtools-functies worden geïsoleerd;
dit is geen volledige deployment- of externe-platformtest. Deze tests worden
automatisch meegenomen door de bestaande publieke regressieworkflow. Buiten de
LibreChat-image wordt alleen de image-smoketest overgeslagen.
