# Orchestrator utility-tools

## Scope en koppeling

De overlay-admin levert vier interne backend-tools: NOS nieuws, L1 nieuws,
officiële feestdagen en tijd/datum. Calculator is uitsluitend een
configuratievlag voor de bestaande n8n-calculator; er is **geen** eigen
calculatorendpoint. De standaardorkestrator bevat de echte n8n-calculator en
vier workflowtools met expliciete invoerschema's. De losse utility-subworkflows
hebben uitsluitend een Execute Workflow Trigger, geen webhook of planning.

Backend: [server](../services/admin-overlay/admin/server.js), gedeelde
[configuratie](../services/admin-overlay/admin/lib/orchestrator-config.js) en
[handler](../services/admin-overlay/admin/lib/utility-tools.js).
Beheer: [orchestrator-editor](../services/admin-overlay/admin/views/orchestrator-editor.html).

## Configuratie en defaults

De admin-API leest/schrijft `/api/orchestrator/config` met bestaande adminsessie.
Een volledige genormaliseerde configuratie heeft dit formaat:

```json
{
  "image_data_url_max_chars": 450000,
  "image_max_resolution_px": 1568,
  "tools": {
    "calculator": true,
    "nos_news": true,
    "l1_news": true,
    "holidays": true,
    "time": true
  },
  "default_timezone": "Europe/Amsterdam"
}
```

Omgevingsdefaults op de **govchat-overlay-admin** service:

| Variabele | Default |
| --- | --- |
| N8N_ORCHESTRATOR_ENABLE_CALCULATOR | true |
| N8N_ORCHESTRATOR_ENABLE_NOS_NEWS | true |
| N8N_ORCHESTRATOR_ENABLE_L1_NEWS | true |
| N8N_ORCHESTRATOR_ENABLE_HOLIDAYS | true |
| N8N_ORCHESTRATOR_ENABLE_TIME | true |
| N8N_ORCHESTRATOR_DEFAULT_TIMEZONE | Europe/Amsterdam |

Omgevingsbooleans moeten letterlijk `true` of `false` zijn. Opgeslagen/API-toolwaarden
moeten JSON-booleans zijn, niet strings/nummers. Tijdzones moeten geldige IANA-zones
zijn (ook UTC); numerieke offsetzones zijn geen configuratietijdzone.
Onbekende API-configuratievelden/toolnamen worden geweigerd. Bestaande
afbeeldingslimieten behouden hun eerdere minimum/normalisatiegedrag.

Ontbrekende legacyvelden erven de omgevingsdefaults. Partial saves mergen de
huidige configuratie en afzonderlijke toolvelden: bijvoorbeeld
`{"tools":{"time":false}}` behoudt alle andere instellingen. Reeds opgeslagen
keuzes gaan vóór de omgeving. Beide bestaande JSON-defaultbestanden blijven
**alleen afbeeldingsinstellingen** bevatten, zodat zij omgevingsdefaults niet
overschrijven.

Vóór de server verzoeken accepteert, tijdens startup `publishAll`, en na iedere
geslaagde admin-save wordt de actuele genormaliseerde configuratie atomisch
geschreven naar `PUBLISH_DIR/orchestrator-config.json`. Het tijdelijke bestand
staat in dezelfde map en wordt met rename vervangen. Private opgeslagen config
wordt eveneens atomisch vervangen. Een publicatiefout resulteert bij save in
HTTP 503; de reeds opgeslagen private keuze blijft bewaard. De server probeert
een oude gepubliceerde policy te verwijderen om een verouderde enabled-policy
te voorkomen. Ongeldige opgeslagen configuratie verhindert startup.

**n8n-integratie:** de [toolpolicy](../scripts/n8n-orchestrator-tool-policy.js)
leest de gepubliceerde configuratie via een read-only directorymount op
`/govchat-config`. Ontbrekende, corrupte of onvolledige policy schakelt alle vijf
nieuwe tools uit; bestaande tools blijven beschikbaar. Er is bewust geen
environment-enabled fallback in n8n. De agentoverlay filtert het aanbod en de
calculatoroverlay controleert bij iedere uitvoering opnieuw de policy, ook als
de tool eerder in een lopend gesprek werd aangeboden. De backend controleert
bij iedere HTTP-toolaanroep opnieuw zijn actuele private configuratie.

De twee overlays en hun gedeelde policymodule worden via Compose gemount en
zijn geverifieerd met n8n 2.25.7. Houd de vijf toolnamen ongewijzigd: die vormen
de vaste koppeling met de policy. Bij een n8n-upgrade moeten overlaypaden en
integratietests opnieuw worden gecontroleerd. De standaardberekeningen blijven
volledig afkomstig uit n8n; de overlay voegt alleen de beleidscontrole toe.

## Ingebruikname (niet automatisch uitgevoerd)

Deze feature is alleen broncode op de featurebranch; de draaiende installatie
is niet aangepast. Een toekomstige uitrol vereist:

1. Bouw de gewijzigde overlay-admin en zorg dat het admin-overlayprofiel draait.
   Gebruik de nieuwe defaults op die service; bestaande opgeslagen keuzes gaan
   voor omgevingsdefaults. Publiceer de policy vóór n8n de tools gebruikt.
2. Werk de Compose-mounts van n8n en de runnerconfiguratie bij en hermaak die
   containers tijdens een gepland deploymentmoment. Gebruik aan beide kanten
   dezelfde interne token en bereikbare interne admin-URL.
3. Importeer en publiceer de vier utility-subworkflows en de bijgewerkte
   orkestrator. De bestaande bootstrap neemt ze bij een nieuwe installatie mee.
   Een reeds geseede installatie vereist een gecontroleerde herimport; de
   bootstrapoptie `AGENTS_BOOTSTRAP_FORCE=true` herimporteert **alle** meegeleverde
   workflows en kan lokale workflowaanpassingen overschrijven. Maak daarom eerst
   exports/back-ups of importeer gericht alleen deze vijf workflowbestanden.
4. Publiceer ook de utility-subworkflows: n8n 2.25.7 weigert anders de oproep.
   Publicatie stelt geen publiek endpoint open; uitvoeren blijft gated door de
   beheerconfiguratie. Controleer ook de LiteLLM-credential-URL en de gekozen
   Chat Completions/Responses API van het bestaande chatmodel.
5. Verifieer via het beheerportaal iedere schakelaar en test bijvoorbeeld
   “Wat is 17 maal 23?”, “NOS politiek”, “L1 112”, “Feestdagen Nederland 2028”,
   “Feestdagen België 2026” en “Welke datum/tijd is het over drie uur?”.

De [workflowgenerator](../scripts/orchestrator-utility-workflow.js) maakt de
vier utility-subworkflows en de orkestratorkoppelingen reproduceerbaar;
[het updatescript](../scripts/update-orchestrator-workflow.js) schrijft beide.

## Intern HTTP-contract

`POST /api/orchestrator/tools/:tool` op de overlay-admin (intern bijvoorbeeld
`http://govchat-overlay-admin:3002`). Toegestane toolnamen:
`nos_news`, `l1_news`, `holidays`, `time`. Stuur JSON, maximaal 16 KiB.

Authenticatie gebruikt de bestaande `CRAWLER_INTERNAL_TOKEN`-instelling en de
bestaande serverfallback naar `N8N_WEBHOOK_TOKEN`. Stuur
`Authorization: Bearer <token>` of `X-GovChat-Token: <token>`; token in URL/body
en admincookies zijn niet voldoende. Een ontbrekende effectieve token resulteert
in HTTP 503. Vergelijking gebruikt timing-safe vergelijking van vaste SHA-256
digests. Houd de service intern; dit is geen publieke chatbot-API.

Success is altijd `{"ok":true,...}`. Toolfouten hebben altijd:

```json
{"ok":false,"error":{"code":"TOOL_DISABLED","message":"Utility tool is disabled"}}
```

Belangrijkste codes/statussen:

| Code | HTTP | Betekenis |
| --- | --- | --- |
| AUTH_NOT_CONFIGURED | 503 | Geen effectieve interne token |
| UNAUTHORIZED | 401 | Ontbrekende/onjuiste token |
| UNKNOWN_TOOL | 404 | Ook calculator is hier niet geïmplementeerd |
| CONFIG_UNAVAILABLE | 503 | Private configuratie onleesbaar/ongeldig |
| TOOL_DISABLED | 403 | Actuele configuratie schakelt tool uit; geen source-fetch |
| INVALID_INPUT / INVALID_JSON | 400 | Ongeldige argumenten of JSON |
| INPUT_TOO_LARGE | 413 | JSON-body boven 16 KiB |
| UNSUPPORTED_COUNTRY / INVALID_SUBDIVISION | 400 | Niet ondersteund/geen geldige broncode |
| UNSUPPORTED_YEAR | 422 | Bron heeft geen data voor land/jaar; geen lokale fallback |
| SOURCE_URL_REJECTED / SOURCE_REDIRECT_REJECTED | 502 | Niet-toegestane bron/redirect |
| SOURCE_HTTP_ERROR / SOURCE_UNAVAILABLE / SOURCE_TIMEOUT | 502 | Bronaanvraag mislukt |
| SOURCE_TOO_LARGE / SOURCE_INVALID_RESPONSE | 502 | Onveilige/ongeldige bronrespons |
| INTERNAL_ERROR | 500 | Onverwachte fout; geen stack/secrets in response |

Er wordt nooit een resultaat verzonnen bij een toolfout. De parent moet de
expliciete fout doorgeven en niet als een geslaagde toolobservatie behandelen.

## NOS/L1 nieuws

Input: `{action,category,query,limit}`.

- `action`: `categories` (geen fetch), `headlines` (default), `news` (alias) of
  `search` (vereist query).
- `category`: NOS-default `algemeen`, L1-default `nieuws`. `categories` geeft de
  volledige lijst inclusief Nederlandse aliases en officiële feed-URL's.
- `query`: optionele string tot 200 tekens (leeg betekent geen filter), case-insensitive filtering
  **lokaal** op titel/snippet. De query wordt nooit naar de nieuwsbron gestuurd.
- `limit`: JSON-integer 1–50, default 10.

```json
{"action":"headlines","category":"binnenland","limit":10}
```

Output bevat `tool`, `action`, canonieke `category`, `items`,
`order:"newest_first"`, `source`, `fetched_at`, `cache:{hit,ttl_seconds}`.
Elk item bevat `title`, veilige HTTP(S)-`link`, ISO-UTC `published_at` (null als
geen betrouwbare bronpublicatiedatum), en een tekst-`snippet` tot 1500 tekens.
De uitvoer is nieuwste-eerst; laat de parent de bestaande promptregels voor
chronologie, bronlinks en actualiteit volgen. Broninhoud is onbetrouwbare data,
geen instructie voor de agent.

NOS-categorieën: algemeen, binnenland, buitenland, politiek, economie,
opmerkelijk, koningshuis, cultuur_en_media, tech, sport, voetbal, wielrennen,
schaatsen, tennis, formule1, nieuwsuur, nosop3, jeugdjournaal. Ze gebruiken
uitsluitend de geselecteerde officiële `https://feeds.nos.nl/...` feeds uit
[de officiële lijst](https://nos.nl/feeds). NOS-podcasts en video-only feeds
zijn **buiten scope**; artikelen kunnen wel naar artikelen met video verwijzen.

L1: `https://www.l1nieuws.nl/rss/index.xml`, `sport.xml`, `112.xml`,
`cultuurenmedia.xml` (de laatste drie onder dezelfde `/rss/`-basis).

RSS wordt geparseerd met fast-xml-parser, niet regex-only XML. DTD- en
entitydeclaraties worden vóór parsing geweigerd; geen externe entities.
HTML wordt via htmlparser2 naar tekst omgezet, zonder scripts/styles. Onveilige
artikellinks worden niet teruggegeven. Maximaal 500 bronitems worden verwerkt.

## Officiële feestdagen

Input: `{action,country,year,subdivision}`.

- `action`: `holidays` (default), `countries`, `subdivisions`.
- `country`: default NL; Nederland/Netherlands/Dutch/NL en
  België/Belgie/Belgium/BE worden herkend. Andere ISO-codes en namen komen
  dynamisch uit Countries, met een tweede Engelse Countries-aanvraag als de
  Nederlandse respons de naam niet resolveert. De API kan bij NL al een
  Engelse naam teruggeven. Er is geen lokale landen- of feestdagenfallback.
- `year`: JSON-integer 2000–2100; default het huidige jaar in de ingestelde
  tijdzone. Dit is een invoergrens, **geen garantie van brondekking**.
- `subdivision`: optionele broncode, shortName of naam uit Subdivisions van het
  gekozen land. Ongeldige regio wordt expliciet geweigerd. Nationwide-feestdagen
  blijven inbegrepen naast feestdagen voor de geselecteerde subdivision.

```json
{"action":"holidays","country":"NL","year":2028}
```

Vaste basis: `https://openholidaysapi.org`. Uitsluitend Countries, Subdivisions
en PublicHolidays worden bevraagd, met `languageIsoCode=NL` (EN voor de
naamfallback), `countryIsoCode` en voor feestdagen
`validFrom=YYYY-01-01&validTo=YYYY-12-31`. De vrije land-/regionaam wordt lokaal
naar een broncode vertaald; geen chattekst of gebruikersmetadata gaat naar de API.

Output holidays: `action`, `country`, `year`, `subdivision` (code/null),
chronologisch gesorteerde `holidays`, `notice`, `source`, `fetched_at`, `cache`.
De oorspronkelijke velden zoals `id`, `startDate`, `endDate`, `type`, `name`,
`regionalScope`, `temporalScope`, `nationwide`, `subdivisions` blijven behouden.
Toegevoegd: `display_name` (NL/EN/bronfallback), `date`, Nederlandse `weekday`,
`end_weekday`, `regional:!nationwide`. Countries en subdivisions retourneren
hun bronlijsten en dezelfde provenance/cachevelden.

Geen schoolvakanties. De notice benadrukt dat een feestdag **niet automatisch
recht op verlof** geeft: werkgever/cao en regionale toepasselijkheid blijven
leidend. Lege feestdagenrespons geeft UNSUPPORTED_YEAR, niet een verzonnen lege
kalender. Een geldige subdivision kan na filtering wel nul toepasselijke
regionale resultaten geven.

## Tijd en datum

Input:
`{action,datetime,end_datetime,timezone,target_timezone,amount,unit,disambiguation}`.

- `action`: `now` (default), `convert`, `add`, `difference`.
- `timezone`: geldige IANA-zone, default uit configuratie.
- `datetime`/`end_datetime`: ISO-timestamp met tijd, bijvoorbeeld
  `2026-10-25T02:30:00+02:00`, `2026-10-25T00:30:00Z` of lokaal
  `2026-10-25T02:30:00`. Geen losse datum/natuurlijke taal/bracketed zone.
- Lokale timestamps gebruiken `disambiguation:"reject"` als default. Ambigue
  en niet-bestaande tijden rond DST geven INVALID_INPUT. Alleen expliciet
  `earlier`/`later` of een timestamp met offset kan dit oplossen.
- `convert` vereist `target_timezone`.
- `add`: `amount` is een eindig JSON-getal van -1000000 tot 1000000,
  negatief toegestaan; `unit` is milliseconds/seconds/minutes/hours/days/weeks/
  months/years. Uren zijn verstreken tijd; dagen/weken/maanden/jaren zijn
  kalenderbewerkingen. Kalenderhoeveelheden moeten integers zijn; verstreken
  tijd mag fractioneel zijn (bijv. 1.5 uur), met gehele millisecondenprecisie.
  Ongeldige datumoverloop (bijv. 31 januari + een maand)
  wordt geweigerd, niet stil aangepast. DST-disambiguation geldt ook voor de
  doelkalendertijd.
- `difference` vereist `end_datetime` en geeft ondertekende verstreken
  `milliseconds`, `seconds`, `hours`, `days` (24-uursdagen, geen kalenderdagen).

```json
{"action":"add","datetime":"2026-03-28T12:00:00","amount":1,"unit":"days"}
```

Een beschreven tijdstip bevat `datetime` (ISO met offset), `timezone`, `utc`,
`epoch_milliseconds`, `date`, Nederlandse `weekday`, `offset`. Add voegt
`amount`, `unit`, `duration_kind:"calendar"|"elapsed"` toe; difference retourneert
ook `start`, `end`, `days_kind:"elapsed_24_hours"`.
De implementatie gebruikt @js-temporal/polyfill; de klok is injectable in tests.
Er is geen externe time-API en geen chatdata verlaat de service.

## Netwerkgrenzen en dependencies

De gedeelde bronclient gebruikt een totale timeout van 10 seconden (inclusief
redirects/body), maximaal 2 MiB per response, maximaal drie redirects en
handmatige controle van elke redirect. Nieuwsredirects moeten exact een van
de geselecteerde officiële feed-URL's zijn; API-redirects moeten HTTPS op de
vaste OpenHolidays-origin en een toegestaan endpoint blijven. Geen arbitrary
URL-input, credentials, bodydata of forwarded gebruikersheaders naar bronnen.

In-memory cache: maximaal 64 entries; RSS vijf minuten, API één uur. Geen
stale-on-error fallback; bronerrors worden niet als succes gecachet. Alle
opgehaalde responses hebben `source`, `fetched_at` en cache-informatie.
Externe API/feedwijzigingen kunnen expliciete fouten geven; de orkestrator moet die
zichtbaar behandelen. Live beschikbaarheid is geen eigenschap van de offline tests.

Vastgelegde nieuwe dependencies in
[package.json](../services/admin-overlay/admin/package.json) en
[package-lock.json](../services/admin-overlay/admin/package-lock.json):
@js-temporal/polyfill 0.5.1, fast-xml-parser 5.12.0, htmlparser2 10.0.0.
De [Dockerfile](../services/admin-overlay/admin/Dockerfile) gebruikt npm ci en
kopieert de gedeelde lib-map. Runtime ondersteunt Node 20+ met ingebouwde fetch.

## Tests zonder host-Node of deployment

Vanaf de repositoryroot:

```sh
docker run --rm --entrypoint node \
  --mount type=bind,source="$(pwd)",target=/work,readonly -w /work \
  docker.n8n.io/n8nio/n8n:2.25.7 tests/orchestrator/run-utility-tests.js
```

De [runner](../tests/orchestrator/run-utility-tests.js) installeert gelockte
dependencies uitsluitend in de tijdelijke container. Tests gebruiken mocks,
een injecteerbare klok en tijdelijke private/publish-mappen. De echte
adminserver start alleen binnen die container op loopback; uitgaand ophalen
is daar expliciet gestubd. Er zijn geen host-Node-installaties, productievolume-
wijzigingen of live workflow/deployment-acties.

[Module-/editortests](../tests/orchestrator/utility-tools.test.js) en
[serverintegratietests](../tests/orchestrator/utility-server.test.js) omvatten:
legacy-/partial configs, strikte booleans/zones, volledige atomische policy,
auth/gating zonder fetch, JSON-fouten/bodylimiet, XML/DTD/HTML, URL/redirect/
timeout/response-/cachegrenzen, Amsterdam-DST, nieuwjaar, negatieve durations,
ongeldige datums, NL2028/BE2026, dynamische landnamen en regionale bronvelden.

De [API-fixtures](../tests/fixtures/utility-tools/) zijn rechtstreeks van de
hierboven genoemde vaste openbare endpoints vastgelegd op 6 november 2026:
36 countries, 11 NL2028-feestdagen, 12 BE2026-feestdagen en een lege Belgische
subdivisionslijst. Bij BE zijn alle 12 feestdagen nationwide. Regionale filtering
en Engelse fallback worden daarnaast expliciet met synthetische mocks getest;
die data pretendeert geen officiële Belgische regionale kalender te zijn.
De RSS-fixture is synthetisch voor parser-/HTML-/chronologietests.

### Echte n8n-integratie zonder externe LLM

Vanaf de repositoryroot, met uitsluitend read-only bronmounts:

```sh
P='/usr/local/lib/node_modules/n8n/node_modules/.pnpm/@n8n+n8n-nodes-langchain@file+packages+@n8n+nodes-langchain_8bf81e0cdf1fe65cc684d3daaa3ca5c1/node_modules/@n8n/n8n-nodes-langchain/dist'
docker run --rm --network none --entrypoint node \
  --mount type=bind,source="$(pwd)",target=/work,readonly \
  --mount type=bind,source="$(pwd)/scripts/n8n-orchestrator-tool-policy.js",target=/opt/govchat/n8n-orchestrator-tool-policy.js,readonly \
  --mount type=bind,source="$(pwd)/scripts/n8n-toolCalculator.patched.js",target="$P/nodes/tools/ToolCalculator/ToolCalculator.node.js",readonly \
  --mount type=bind,source="$(pwd)/scripts/n8n-createAgentSequence.patched.js",target="$P/nodes/agents/Agent/agents/ToolsAgent/V3/helpers/createAgentSequence.js",readonly \
  -w /work docker.n8n.io/n8nio/n8n:2.25.7 tests/orchestrator/run-n8n-utility-smoke.js
```

De [smoketest](../tests/orchestrator/run-n8n-utility-smoke.js) importeert en
publiceert workflows alleen in zijn lege tijdelijke database, gebruikt
synthetische credentials en een lokale model-/backendfixture. Alle vijf tools
worden werkelijk door de n8n-agent/engine uitgevoerd; ieder toolresultaat wordt
gevalideerd. Daarna bewijst de test dat alle uitgeschakelde tools uit het
modelaanbod verdwijnen en geen backendoproep volgt. Alleen loopbackverkeer is
toegestaan, zonder Docker-netwerk of productievolumes.

Voor de aanvullende vijf [integratietests](../tests/orchestrator/n8n-utility-integration.test.js)
gebruik dezelfde mounts met het commando `--test tests/orchestrator/n8n-utility-integration.test.js`.

### Vastgelegde verificatie en beperkingen

- 25 backend-/beheer-/fixturetests geslaagd, ook in de gebouwde Node-20-image.
- 5 policy-/workflow-/echte-calculatorintegratietests geslaagd.
- 6 echte n8n-smokescenario's: vijf toolketens plus alles uitgeschakeld.
- 38 bestaande JavaScript-regressietests en 9 stock-overlaytests geslaagd.
- Python: 15 geslaagd; 10 optionele Docker-integratietests overgeslagen.
- Echte geïsoleerde workflowimport en Node-20-imagebuild geslaagd.
- De twee volledige LibreChat-bronoverlaytests vereisen een niet aanwezige
  LibreChat-sourcecheckout; de beschikbare stockcompatibiliteitstests zijn wel uitgevoerd.
- Externe officiële feedlijsten en OpenHolidays-landen/NL2028/BE2026 zijn
  read-only geverifieerd. Geen productiechat, deployment of echte LLM is getest.
- De XML-parser is bijgewerkt voor de auditfix. Compatibele transitive patches
  zijn gelockt. De audit meldt nog bestaande Express/qs-moderate en sharp-high
  kwetsbaarheden; de benodigde sharp-versie-upgrade valt buiten deze feature.
