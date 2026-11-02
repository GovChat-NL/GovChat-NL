# GovChat-NL-LibreChat

> [!WARNING]
> **Status: niet productierijp / niet gegarandeerd werkend.**
> Deze repository wordt gedeeld als **inspiratie en referentie-implementatie** voor leveranciers en mede-overheden.
> Gebruik dit niet als kant-en-klare productieoplossing zonder eigen validatie, hardening, security review en acceptatietesten.

## Belangrijke publicatienotitie

- Doel van deze codebase: architectuurideeën, proof-of-concept flows en samenwerkingsbasis.
- Bekende beperkingen: onderdelen kunnen incompleet, experimenteel of omgeving-afhankelijk zijn.
- Verwachte inzet: inspiratie voor aanbesteding, leveranciersdialoog en doorontwikkeling binnen overheidscontext.

## Monorepo-scope en componentgrenzen

Deze repository is de bron van waarheid voor de deployment en bijbehorende configuratie, n8n-workflows en overlay-integratie. De oorspronkelijke LibreChat-stack blijft op repository-root zodat Compose-entrypoints hun bestaande relatieve paden behouden. De componentgrenzen zijn:

- **LibreChat deployment en LibreChat-overlay**: [`docker-compose.yml`](docker-compose.yml), [`librechat.yaml`](librechat.yaml), [`nginx/librechat-overlay.conf`](nginx/librechat-overlay.conf), [`overlay/defaults/`](overlay/defaults/) en [`n8n/`](n8n/).
- **Proxy- en tenant-hardening**: [`docs/nginx-security.md`](docs/nginx-security.md).
- **Agent-workflows**: [`agents/n8n/workflows/`](agents/n8n/workflows/); n8n-bootstrap importeert deze bestanden lokaal uit de monorepo.
- **GovChat Admin-overlay service (WIP, optioneel)**: server en beheerinterface in [`services/admin-overlay/admin/`](services/admin-overlay/admin/). Standaard uit; start met Compose-profiel `admin-overlay`. Compose mount LibreChat-specifieke defaults uit [`overlay/defaults/`](overlay/defaults/) en neemt dus niet stilzwijgend de Open WebUI-defaults over.
- **Bridge**: blijft een afzonderlijke repository/service. De standaard Compose bouwt de GovChat-NL-bridge vanuit de sibling-checkout van branch `main`; stackconfiguratie staat in [`bridge/models.json`](bridge/models.json). Bron: [GovChat-NL/n8n-openai-bridge](https://github.com/GovChat-NL/n8n-openai-bridge).

De request-flow blijft LibreChat → OpenAI-compatibele GovChat-NL-bridge → n8n webhook → workflow/LiteLLM (rechtstreeks vanuit n8n). Tool-calling en native live tool-cards zijn standaard actief: Compose bouwt de bridge vanaf `main` en laadt de bijbehorende LibreChat- en n8n-runtime-overlays. Zie [`docs/live-tool-calling.md`](docs/live-tool-calling.md) en [`docs/monorepo-migration.md`](docs/monorepo-migration.md).

## OpenBesluitvorming

De OpenBesluitvorming-workflows maken publieke besluitvormingsdocumenten doorzoekbaar met bronverwijzingen. De workflow-JSON staat als monorepo-assets in [`agents/n8n/workflows/`](agents/n8n/workflows/): documentworker, checkpointed snapshot-ingest, high-recall search, incremental sync en de orchestrator-integratie. De lokale n8n-bootstrap importeert deze bestanden samen met de overige agent-workflows.

De snapshot-ingest en delta-sync zijn standaard inactief. Configureer de zichtbare workflow-nodes voor bron en collectie, voltooi eerst de initiële snapshot en activeer daarna pas de delta-sync. Qdrant is een interne Compose-service zonder gepubliceerde hostpoort. Zie [`docs/openbesluitvorming-release-artifacts.md`](docs/openbesluitvorming-release-artifacts.md) voor snapshotdistributie, governance, herstel en wekelijkse release-operaties.

De zoekworkflow gebruikt begrensde queryvarianten, brede Qdrant-kandidaten, document-level reciprocal-rank fusion en optionele LiteLLM-reranking. Resultaten bevatten bronmetadata, beschikbare documentlinks en een expliciete dekkingsmelding; vectorzoekresultaten zijn geen volledigheidsgarantie. Bij politiek gevoelige vragen gebruikt de orchestrator deze zoektool en citeert hij primaire bronlinks. De delta-sync verwerkt maximaal één pagina van 500 wijzigingen per uitvoering en hoort pas te worden geactiveerd nadat de initiële snapshot-checkpoint is voltooid; de aanbevolen frequentie is eens per zes uur.

Voor lokaal testen kun je de gepubliceerde Provincie Limburg-snapshot expliciet inladen via het Compose-profiel `openbesluitvorming-test`; zie [`docs/openbesluitvorming-release-artifacts.md`](docs/openbesluitvorming-release-artifacts.md). Dit restore-profiel wordt niet gestart door de normale `docker compose up`.

### Snelle start en controles

1. Kopieer `.env.example` naar een lokaal, genegeerd `.env` en vul de omgevingsspecifieke URLs, provider/API-sleutels en sterke willekeurige secrets in. Commit nooit `.env`.
2. Clone de bridge naast deze repository op branch `main`:

   ```sh
   git clone --depth 1 --branch main https://github.com/GovChat-NL/n8n-openai-bridge.git ../n8n-openai-bridge-main
   ```

3. Controleer Compose en de geïmporteerde workflowbestanden:

   ```sh
   docker compose --env-file .env.example config --quiet
   docker compose --env-file .env.example --profile admin-overlay config --quiet
   node tests/agents/validate-workflows.js
   node --check n8n/bootstrap.js
   node --check services/admin-overlay/admin/server.js
   ```

4. Start met `docker compose --env-file .env up -d`. Compose bouwt de GovChat-NL-bridge vanuit de sibling-checkout op `main` als de lokale image nog ontbreekt. De WIP Admin Overlay blijft standaard uit. Gebruik `docker compose --env-file .env build n8n-openai-bridge` alleen nadat je de bridgebron hebt gewijzigd; daarna start je de stack weer met `up -d`.
5. De live orchestrator-/transcriptietests vereisen draaiende services en providerconfiguratie: `node tests/orchestrator/run-validation.js` en `node tests/transcript/run-validation.js`.

De volledige omgevingsvariabelen staan in [`.env.example`](.env.example); de technische migratie- en testmatrix staat in [`docs/monorepo-migration.md`](docs/monorepo-migration.md). Dit blijft een referentie-implementatie, niet een productieklare deployment.

Het configureerbare gegevensbewaarbeleid en de daadwerkelijke opschoonmechanismen staan in [`docs/retention-policy.md`](docs/retention-policy.md).

De stack is breder dan alleen “orchestrator + versimpelaar” en bevat onder meer:
- **Werkende test-apps in de overlay**:
  - Versimpelaar
  - Live transcriptie
  - Afbeelding-generator (async image jobs)
  - Beleidskompas (conceptueel / in ontwikkeling)
  - Crawler-koppeling (conceptueel / in ontwikkeling)
- **RAG-gerelateerde componenten optioneel** via profielen in [`docker-compose.yml`](docker-compose.yml):
  - `pgvector`
  - `rag-api`
  - `pgadmin`

> Let op: `pgvector` + `rag-api` horen bij de optionele LibreChat-RAG-profielen. OpenBesluitvorming gebruikt de afzonderlijke, interne `qdrant`-service uit deze Compose-configuratie.

## Services in de standaard (simpele) start

Standaard actief met `docker compose up -d`:

- `librechat`
- `librechat-proxy` (injecteert overlay in HTML)
- `admin-panel` (LibreChat admin panel op `${ADMIN_PANEL_PORT:-3100}`)
- `n8n-openai-bridge` (OpenAI-compatibele bridge tussen LibreChat en n8n)
- `mongodb`
- `redis`
- `meilisearch`
- `n8n-postgres`
- `n8n`
- `n8n-bootstrap` (eenmalige workflow-import)
- `qdrant` (interne vector-store voor OpenBesluitvorming; geen hostpoort)

> n8n versie is gepind via `N8N_VERSION` (default: `2.25.7`).

Niet standaard actief:

- `govchat-overlay-admin` (WIP; profiel: `admin-overlay`)
- `pgvector` (profiel: `rag` of `admin`)
- `rag-api` (profiel: `rag`)
- `pgadmin` (profiel: `admin`)

De WIP Admin Overlay blijft bewust standaard uit. Schakel hem alleen in voor
testen met `docker compose --profile admin-overlay up -d`. Herbouw hem expliciet
met `docker compose --profile admin-overlay build govchat-overlay-admin` nadat de
broncode is gewijzigd.

## Waarom `pgvector`, `rag-api`, `pgadmin`?

- `pgvector`: PostgreSQL + vector-extensie voor RAG-indexen, gedefinieerd in [`docker-compose.yml`](docker-compose.yml).
- `rag-api`: ingest/retrieval service voor document-RAG, gedefinieerd in [`docker-compose.yml`](docker-compose.yml).
- `pgadmin`: beheertool voor pgvector DB, gedefinieerd in [`docker-compose.yml`](docker-compose.yml).

Als je nu **geen RAG** nodig hebt, hoef je deze services niet te starten.

## Voor GitHub-publicatie (transparant over status)

Gebruik bij publicatie expliciet deze positionering:

- niet productierijp
- inspiratie voor leveranciers en mede-overheden
- aanvullende validatie en hardening vereist

Aanbevolen commit message:

```text
docs: expliciete publicatiewaarschuwing toegevoegd (niet productierijp, inspiratie voor leveranciers en mede-overheden)
```

Aanbevolen push-checklist:

1. Controleer dat geen secrets in `.env` of logs staan.
2. Controleer of alle status-waarschuwingen in README zichtbaar zijn.
3. Noteer bekende beperkingen en openstaande risico's.
4. Push pas na interne akkoordronde op deze positionering.

## Lokaal draaien (simpel)

1. Kopieer [`.env.example`](.env.example) naar [`.env`](.env).
2. Vul minimaal in [`.env`](.env):
   - `LC_PORT`
   - `APP_TITLE`
   - `PUBLIC_BASE_URL`
   - `ADMIN_PANEL_PUBLIC_URL`
   - `LITELLM_URL`
   - `LITELLM_API_KEY`
   - `OPENAI_API_KEY`
   - `LITELLM_CONFIG_PATH` (default: `./litellm/config.yaml`)
   - `N8N_OPENAI_BRIDGE_BEARER_TOKEN`
    - `GOVCHAT_ADMIN_PASSWORD`
    - `N8N_POSTGRES_PASSWORD`
    - `N8N_ENCRYPTION_KEY`
    - `N8N_BASIC_AUTH_USER` and `N8N_BASIC_AUTH_PASSWORD`
    - `N8N_WEBHOOK_TOKEN`
   - `N8N_ENABLE_IMAGE_TOOL` (`true`/`false`, default `false`)
   - `N8N_LITELLM_IMAGE_BASE_URL` (default `${LITELLM_URL}`)
   - `N8N_LITELLM_IMAGE_API_KEY` (default `${LITELLM_API_KEY}`)
   - `N8N_LITELLM_IMAGE_MODEL` (default `gpt-image-1`)
   - DB/secrets (`MONGO_ROOT_PASS`, `MEILI_MASTER_KEY`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `SESSION_SECRET`, `CREDS_KEY`, `CREDS_IV`)
3. Zorg dat hostmappen uit [`docker-compose.yml`](docker-compose.yml) bestaan.
4. Standaard wordt [`librechat.yaml`](librechat.yaml) uit de repo gemount. Overschrijven kan met `LIBRECHAT_CONFIG_PATH` in [`.env`](.env).
5. LiteLLM config-file route staat standaard aan via [`litellm/config.yaml`](litellm/config.yaml) en de mount in [`docker-compose.yml`](docker-compose.yml).
6. Start:

```bash
docker compose -f docker-compose.yml --env-file .env up -d
```

## Optioneel: RAG later inschakelen

Met RAG services:

```bash
docker compose -f docker-compose.yml --env-file .env --profile rag up -d
```

Met pgAdmin:

```bash
docker compose -f docker-compose.yml --env-file .env --profile admin up -d
```

LibreChat admin-panel start automatisch mee in de standaard `docker compose up -d`.

## Troubleshooting: `admin-panel` pull faalt met GHCR 403

Zie je een fout zoals `failed to fetch oauth token ... 403 Forbidden` voor `ghcr.io/clickhouse/librechat-admin-panel`?

Dit gebeurt vaak als Docker nog oude/onjuiste GHCR-credentials heeft opgeslagen. Docker probeert dan **geauthenticeerd** te pullen met een token zonder package-leesrechten, en GHCR weigert de aanvraag.

Snelle fix:

```bash
docker logout ghcr.io
docker compose -f docker-compose.yml --env-file .env pull admin-panel
docker compose -f docker-compose.yml --env-file .env up -d
```

Verwachte uitkomst:

- `docker logout ghcr.io` meldt `Removing login credentials for ghcr.io`
- `pull admin-panel` downloadt de image zonder 403
- `docker compose ... up -d` start `admin-panel` normaal mee

Alleen als jouw organisatie bewust private GHCR-packages gebruikt: log opnieuw in met een token dat package-read rechten heeft.

## LibreChat standaard koppeling via n8n-openai-bridge

De versimpelaar-URL staat standaard op [`/n8n/webhook/versimpelaar`](overlay/defaults/apps.json) en wordt geproxied naar interne n8n.

De **standaard chat** is gekoppeld via [`librechat.yaml`](librechat.yaml) aan [`bridge/models.json`](bridge/models.json):

- custom endpoint `govchat-orchestrator`
- LibreChat -> `http://n8n-openai-bridge:3333/v1`
- bridge model `govchat-orchestrator` -> `http://n8n:5678/webhook/orchestrator`
- bridge-authenticatie via `${N8N_OPENAI_BRIDGE_BEARER_TOKEN}`

De standaard [`docker-compose.yml`](docker-compose.yml) bouwt de bridge vanuit `../n8n-openai-bridge-main`, een lokale clone van branch `main` van [GovChat-NL/n8n-openai-bridge](https://github.com/GovChat-NL/n8n-openai-bridge). Er is geen upstream-image of tweede Compose-override nodig.

### Native live tool-call kaarten

De runtime-overlays voor native kaarten worden standaard door [`docker-compose.yml`](docker-compose.yml) in LibreChat en n8n geladen. De standaard bridge-build komt van GovChat-NL `main`, waar de sideband voor tool-lifecycle-events onderdeel van is. Er is geen feature-branch-override nodig; zie [`docs/live-tool-calling.md`](docs/live-tool-calling.md) voor de event-flow en teststappen.

### Context/token usage indicator (default uit)

In deze stack staat de LibreChat context/token-indicator standaard uit in [`librechat.yaml`](librechat.yaml):

```yaml
interface:
  contextUsage: false
  contextCost: false
```

Reden: de chatflow loopt via n8n-orchestratie en toolcalls. Daardoor kan de UI-indicator afwijken van de werkelijke end-to-end tokenconsumptie.

## Taalmodellen beheren: twee routes

### Route A (aanbevolen): via LiteLLM config file (Git-managed)

Deze route is nu geïmplementeerd en actief in compose:

- Config file: [`litellm/config.yaml`](litellm/config.yaml)
- Mount + startup flag: de `litellm` service in [`docker-compose.yml`](docker-compose.yml)
- Env variabele: `LITELLM_CONFIG_PATH` in [`.env.example`](.env.example)

Werkwijze:
1. Voeg/werk modellen bij in [`litellm/config.yaml`](litellm/config.yaml) onder `model_list`.
2. Zorg dat provider-sleutels in [`.env`](.env) staan (bijv. `OPENAI_API_KEY`).
3. Herstart LiteLLM:

```bash
docker compose -f docker-compose.yml --env-file .env up -d litellm
```

4. Controleer modellen:

```bash
curl ${LITELLM_URL}/v1/models
```

5. Selecteer het model in n8n in de `OpenAI Chat Model` node(s) en publish de workflow opnieuw.

### Route B: via LiteLLM UI + n8n workflow update

Werkwijze:
1. Voeg model toe in LiteLLM UI (admin).
2. Open n8n workflow(s):
   - [`orchestrator-litellm.json`](agents/n8n/workflows/orchestrator-litellm.json)
   - [`versimpelaar-litellm.json`](agents/n8n/workflows/versimpelaar-litellm.json)
3. Kies het gewenste model in `OpenAI Chat Model` node.
4. Publish workflow opnieuw in n8n.
5. Verifieer dat het model zichtbaar is op `${LITELLM_URL}/v1/models`.

## Afbeeldingen via orchestrator (optioneel, centraal configureerbaar)

De orchestrator kan optioneel een image-tool gebruiken die via LiteLLM naar `/v1/images/generations` gaat.

### Configuratie in [`.env`](.env)

- `N8N_ENABLE_IMAGE_TOOL=false`
  - `false`: feature staat uit; workflow geeft een nette niet-fatale melding terug.
  - `true`: feature staat aan en gebruikt de hieronder genoemde image settings.
- `N8N_LITELLM_IMAGE_BASE_URL`
  - apart image-endpoint (fallback: `LITELLM_URL`)
- `N8N_LITELLM_IMAGE_API_KEY`
  - aparte image-sleutel (fallback: `LITELLM_API_KEY`)
- `N8N_LITELLM_IMAGE_MODEL`
  - image-model (default: `gpt-image-1`)

Deze waarden worden via Compose doorgegeven aan zowel `n8n` als `n8n-runners` in [`docker-compose.yml`](docker-compose.yml).

### Runtime vereisten voor image generation

1. **JS runner modules toegestaan**
   - [`n8n/task-runners.json`](n8n/task-runners.json) zet `NODE_FUNCTION_ALLOW_BUILTIN` op `fs,path,crypto`.
   - Deze file is gemount in `n8n-runners` in [`docker-compose.yml`](docker-compose.yml).

2. **Gedeelde image map beschikbaar**
   - `/opt/librechat/images:/shared-images` wordt gebruikt om gegenereerde PNG/JPEG-bestanden per LibreChat-user op te slaan (`/shared-images/<user-id>/`).
   - Bij Linux host-permissieproblemen (`EACCES`) moet de map schrijfbaar zijn voor runner user (uid/gid `1000`).
   - Nginx serveert uitsluitend `/images/<user-id>/<filename>` na verificatie van de LibreChat refresh-cookie en overeenkomst van de user-id; oude globale `/images/<filename>`-URLs worden bewust geweigerd.

3. **Publieke URL opbouw**
   - workflow retourneert een relatief pad `/images/<user-id>/<bestand>`; Nginx controleert de eigenaar bij elke request.

### Gedrag bij output

- Bij normale URL-output van model: workflow retourneert direct markdown `![gegenereerde afbeelding](...)`.
- Bij base64-output: workflow controleert formaat/magic bytes, schrijft de afbeelding exclusief in de directory van de geauthenticeerde eigenaar en retourneert markdown met het ownerscoped pad.
- Hierdoor kan LibreChat de afbeelding inline renderen in plaats van alleen tekst te tonen.

### Asynchrone image-jobs met tussentijdse status (aanbevolen)

Voor nette voortgangsfeedback zonder lange spinner ondersteunt deze stack nu een asynchrone route via `govchat-overlay-admin`:

- `POST /govchat-api/image-jobs` → start job (antwoord: `202` + `job_id`)
- `GET /govchat-api/image-jobs/:job_id` → poll status (`queued`/`running`/`succeeded`/`failed`)

De worker in `govchat-overlay-admin` roept intern de bestaande n8n image-webhook aan (`/webhook/image-generator`) en bewaart jobstatus in `/opt/librechat/overlay/data/image-jobs`.

#### Benodigde `.env` variabelen

- `IMAGE_JOBS_ENABLED=true`
- `IMAGE_JOBS_WEBHOOK_URL=http://n8n:5678/webhook/image-generator`
- `IMAGE_JOBS_WEBHOOK_TOKEN=<n8n webhook token>` (fallback op `N8N_WEBHOOK_TOKEN`)
- `IMAGE_JOBS_CONCURRENCY=1`
- `IMAGE_JOBS_TTL_HOURS=24`

#### Overlay app-configuratie

In [`overlay/defaults/apps.json`](overlay/defaults/apps.json) staat standaard een app `Afbeelding generator` met:

- `target: "imagegen"`
- `url: "/govchat-api/image-jobs"`
- `config.image_jobs_api`; authenticatie verloopt via de ingelogde LibreChat-refresh-cookie (geen browser-brede bearer token)

Image-jobs zijn per user afgeschermd: de API accepteert alleen een geldig gesigneerd refresh-token, slaat de eigenaar aan de job op, en weigert polling door andere gebruikers. Maximaal twee actieve jobs en zes generaties per uur per gebruiker, strikte invoerlimieten en Nginx rate limiting beperken kostenmisbruik.

Zie [`docs/nginx-security.md`](docs/nginx-security.md) voor Nginx/Compose-hardening, trusted ingress-CIDR-configuratie, validatie en rollback.

De loader toont tijdens polling statusberichten in het Nederlands, zoals:

- “Je afbeelding staat in de wachtrij.”
- “Je afbeelding wordt nu gegenereerd.”
- “Je afbeelding is klaar.”

## Overheidscrawler (allowlist + robots.txt) via GovChat Admin + n8n

> ⚠️ **Let op (experimenteel):** de webcrawler is op dit moment een **experimentele feature** en nog **ver van af / niet af** voor volledige productie-inzet. De eerste stappen zijn gezet (beheer, runs, historisch overzicht, basis-optimalisaties), maar verdere doorontwikkeling en hardening zijn nog nodig.

Deze stack ondersteunt nu een beheersbare overheidscrawler met:

- bron-allowlist per domein/pad,
- robots.txt-respect,
- handmatige runs vanuit GovChat Admin,
- automatische schedule-runs in n8n,
- run-auditlog in GovChat Admin.

### UI in GovChat Admin

In `govchat-overlay-admin` is een nieuwe pagina beschikbaar:

- `/crawler-editor`

Daar beheer je:

- globale crawlerinstellingen (interval, max pagina's, timeout, user-agent),
- `respect_robots_txt`,
- embedding-instellingen (aan/uit, model alias, max chars),
- allowlist-bronnen (`start_url`, `allowed_domains`, `allowed_path_prefixes`, sitemaps),
- handmatige start van een crawl-run,
- laatste run-overzicht (visited/blocked/errors).

Daarnaast zie je nu:

- geïndexeerde pagina's met timestamp, subwebsite en pad (laatste run),
- tokengebruik per domein,
- tokengebruik per subwebsite.

> Tokengebruik is best-effort: als LiteLLM embedding usage teruggeeft wordt die gebruikt; anders gebruikt de crawler een schatting (`chars/4`).

### Nieuwe workflow

Bootstrap importeert/publisht nu ook:

- [`govcrawler-run.json`](agents/n8n/workflows/govcrawler-run.json)

Deze workflow heeft:

- `Webhook /webhook/govcrawler-run` (voor handmatige run vanuit admin),
- `Schedule Trigger` (15-min basis; intern skip als crawler disabled of geen actieve bronnen),
- allowlist-validatie,
- robots.txt-check per bron,
- crawl-run metrics,
- run-persist naar GovChat Admin interne API.

### Benodigde `.env` variabelen

Toegevoegd in [`.env.example`](.env.example):

- `AZURE_OPENAI_API_BASE`
- `AZURE_OPENAI_API_VERSION` (default `2023-05-15`)
- `AZURE_OPENAI_API_KEY`
- `CRAWLER_ADMIN_BASE_URL` (default `http://govchat-overlay-admin:3002`)
- `CRAWLER_INTERNAL_TOKEN` (interne auth tussen n8n en overlay-admin)
- `CRAWLER_N8N_WEBHOOK_URL` (default `http://n8n:5678/webhook/govcrawler-run`)
- `CRAWLER_N8N_WEBHOOK_TOKEN` (token voor webhook-calls naar n8n)
- `CRAWLER_RUNS_LIMIT` (max aantal bewaarde runs)
- `CRAWLER_EMBEDDING_MODEL` (default `govchat-embedding`)

LiteLLM bevat embedding alias in [`litellm/config.yaml`](litellm/config.yaml):

- `govchat-embedding` -> `azure/text-embedding-3-large`

Voor jullie Azure endpoint in `.env`:

- `AZURE_OPENAI_API_BASE=https://librechat-construction-foundry.cognitiveservices.azure.com`
- `AZURE_OPENAI_API_VERSION=2023-05-15`
- `AZURE_OPENAI_API_KEY=<jullie key>`

De crawler gebruikt vervolgens altijd LiteLLM (`${LITELLM_URL}/v1/embeddings`).

Aanbeveling:

- zet `CRAWLER_INTERNAL_TOKEN` en `CRAWLER_N8N_WEBHOOK_TOKEN` expliciet op sterke random values,
- gebruik niet overal dezelfde token in productie.

### Bootstrap gedrag

`n8n-bootstrap` gebruikt marker `.govchat-seeded-v5` en voert [`n8n/bootstrap.js`](n8n/bootstrap.js) uit. Het script scant alle top-level `.json`-exports in [`agents/n8n/workflows/`](agents/n8n/workflows/), valideert de bestanden en stabiele IDs, en importeert, verifieert en publiceert de workflows.

Een nieuwe workflow vereist geen wijziging aan Compose of een aparte bestandslijst. Alleen deploybare workflows horen in deze map: iedere gevonden JSON-export wordt gepubliceerd. Bewaar concepten/drafts elders.

## n8n beveiliging (from-scratch baseline)

- n8n is **niet publiek geëxposed** (alleen intern netwerk).
- Alleen [`/n8n/webhook/*`](nginx/librechat-overlay.conf) wordt via proxy doorgelaten.
- Overige [`/n8n/*`](nginx/librechat-overlay.conf) routes geven 404 (editor/API niet publiek).
- Webhook vereist `x-govchat-token` header, gecontroleerd in workflow.
- n8n draait met external task runners (sidecar) volgens n8n production guidance.
- Voor Code-nodes met `$env.*` is `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` gezet (vereist voor deze workflow in runner-mode).
- n8n secrets staan in [`.env.example`](.env.example):
  - `N8N_ENCRYPTION_KEY`
  - `N8N_WEBHOOK_TOKEN`
  - `N8N_RUNNERS_AUTH_TOKEN`

## Standaard n8n workflows

Bij opstart voert de [`n8n-bootstrap`-service in Compose](docker-compose.yml) [`n8n/bootstrap.js`](n8n/bootstrap.js) uit om alle JSON-workflows uit [`agents/n8n/workflows/`](agents/n8n/workflows/) te ontdekken en te importeren.

Bootstrapinstellingen in [`.env.example`](.env.example):

- `AGENTS_LOCAL_WORKFLOWS_DIR` (default: `/workspace/agents/n8n/workflows`)
- `AGENTS_BOOTSTRAP_FORCE` (`false` standaard; zet op `true` om import/publish geforceerd opnieuw uit te voeren)
- `N8N_OWNER_EMAIL` (optioneel; als gezet wordt owner automatisch geprovisioned)
- `N8N_OWNER_PASSWORD` (optioneel; samen met `N8N_OWNER_EMAIL`)
- `N8N_OWNER_FIRST_NAME` (default: `GovChat`)
- `N8N_OWNER_LAST_NAME` (default: `Admin`)

### n8n admin-user deterministisch provisionen (aanbevolen)

De service `n8n-bootstrap` kan de n8n owner automatisch aanmaken op basis van [`.env`](.env):

- `N8N_OWNER_EMAIL`
- `N8N_OWNER_PASSWORD`
- optioneel `N8N_OWNER_FIRST_NAME` en `N8N_OWNER_LAST_NAME`

Gedrag:

- Als er nog geen owner is, maakt bootstrap de owner aan via de n8n setup-API.
- Als er al een owner bestaat, wordt de setup overgeslagen (idempotent).

Forceer een nieuwe bootstrap-run met:

```bash
docker compose -f docker-compose.yml --env-file .env up -d --force-recreate n8n-bootstrap
```

Bootstrap leest workflows direct uit de read-only mount van `./agents`; er is geen remote download of aparte checkout.

Stabiliteit in productie/lokaal:

- Standaard (`AGENTS_BOOTSTRAP_FORCE=false`) slaat bootstrap import/publish over na de eerste succesvolle seed.
- Hiermee voorkom je dat workflows bij elke herstart onnodig gedeactiveerd/geherpubliceerd worden terwijl verkeer al loopt.
- Bij toevoegen/wijzigen van workflow JSON: zet tijdelijk `AGENTS_BOOTSTRAP_FORCE=true`, forceer een nieuwe `n8n-bootstrap`-run en zet het daarna terug op `false`.

Voorbeelden uit de automatisch ontdekte catalogus zijn [`orchestrator-litellm.json`](agents/n8n/workflows/orchestrator-litellm.json), [`versimpelaar-litellm.json`](agents/n8n/workflows/versimpelaar-litellm.json) en [`image-generator-litellm.json`](agents/n8n/workflows/image-generator-litellm.json).

Bootstrap-flow:

1. Scant en valideert alle top-level `.json`-workflowexports in `AGENTS_LOCAL_WORKFLOWS_DIR`.
2. Importeert elk exportbestand met `n8n import:workflow`.
3. Haalt stabiele IDs uit de JSON, verifieert ze met `n8n export:workflow` en publiceert ze met `n8n publish:workflow`.

Architectuurafspraak:

- Alle eindgebruikersverkeer loopt via de orchestrator-agent.
- Sub-agents (zoals Versimpelaar B1) worden door de orchestrator als tool aangeroepen.

Daarnaast maakt [`n8n/bootstrap.js`](n8n/bootstrap.js) automatisch een n8n credential aan:

- `openAiApi` met naam `LiteLLM API`
- `apiKey` = `${LITELLM_API_KEY}`
- `url` = `${LITELLM_URL}/v1`

Let op: de eerste LiteLLM start kan langer duren door database-migraties. Daarom is de healthcheck-venster in compose verruimd.

Hierdoor zijn de OpenAI Chat Model nodes in beide workflows direct gekoppeld aan deze credential.

### 1) Versimpelaar B1 sub-agent

Webhook: `POST /n8n/webhook/versimpelaar`

Flow:
1. Valideert `x-govchat-token` en payload (`text`, `preserved_words`)
2. Gebruikt een n8n [`AI Agent`](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/)
3. Agent is gekoppeld aan [`OpenAI Chat Model`](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatopenai/) met Base URL `${LITELLM_URL}/v1`
4. B1-gedrag wordt afgedwongen via system prompt van de agent
4. Retourneert vereenvoudigde tekst als JSON `{ "text": "..." }`

### 2) Orchestrator-agent

Webhook: `POST /n8n/webhook/orchestrator`

Flow:
1. Valideert `x-govchat-token` en payload (`text/prompt/input` of OpenAI `messages`)
2. Gebruikt een n8n [`AI Agent`](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/)
3. Agent is gekoppeld aan [`OpenAI Chat Model`](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatopenai/) met Base URL `${LITELLM_URL}/v1`
4. Agent heeft een sub-tool (`Call n8n Workflow Tool`) voor B1-versimpeling via `/webhook/versimpelaar`
5. Agent beslist autonoom wanneer deze B1-tool wordt gebruikt
6. `Prepare Input` gebruikt de volledige chatgeschiedenis uit `messages` (rollen + content) als context, in plaats van alleen de laatste user-vraag
7. Streaming loopt direct via de webhook (`responseMode: streaming` + agent `enableStreaming: true`); een expliciete terugkoppeling van `AI Agent` naar `Webhook` is niet nodig

Authenticatie is standaard al voorgeselecteerd via de gebootstrapte `LiteLLM API` credential.

Controleer beschikbare modellen via `${LITELLM_URL}/v1/models`.

## Publish-readiness checklist

Minimale checks vóór publicatie:

1. Compose valideert zonder fouten:

```bash
docker compose -f docker-compose.yml --env-file .env config
```

2. Core services zijn healthy/up (`librechat`, `litellm`, `n8n`, `n8n-openai-bridge`).
3. Bridge endpoint reageert:

```bash
docker compose -f docker-compose.yml --env-file .env exec n8n-openai-bridge wget -qO- http://localhost:3333/health
```

4. Bridge modellen endpoint bevat `govchat-orchestrator`:

```bash
docker compose -f docker-compose.yml --env-file .env exec n8n-openai-bridge wget -qO- http://localhost:3333/v1/models
```

5. LiteLLM modellen endpoint toont verwachte modellen:

```bash
curl ${LITELLM_URL}/v1/models
```
