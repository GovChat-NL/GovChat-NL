# Deploymentconfiguratie zonder lokale broncodepatches

Instellingen horen in een private `.env` of `docker-compose.local.yml`, niet in
de gedeelde broncode. `.env`, `*.local.yml` en `nginx/*.local.conf`/`*.local.geo`
worden genegeerd door Git. Reeds getrackte bestanden worden door een ignore-regel
niet beschermd: controleer altijd de volledige staged diff vóór een commit.
Publiceer geen secrets, tenant/client-ID's, interne hostnamen, ingress-adressen,
browserstates, databasebestanden of deploymentlogs.

## Basis en compatibiliteit

Gebruik Docker Compose v2 en Nginx 1.28 of nieuwer (de standaardimage). Dynamische
upstream-DNS gebruikt `resolve` en een gedeelde upstream-zone. Nginx schrijft de
gegenereerde configuratie en optionele auth-blokkering uitsluitend naar tmpfs;
de containerfilesystem en bronbestanden blijven read-only. Alleen de expliciete
templatevariabelen worden vervangen; Nginx-variabelen blijven intact.

| Instelling | Default / betekenis |
| --- | --- |
| `GOVCHAT_DATA_ROOT` | `/opt/librechat`; hostdirectory voor bestaande bind mounts |
| `GOVCHAT_NETWORK_NAME` | `librechat-net` |
| `GOVCHAT_NETWORK_EXTERNAL` | `false`; `true` gebruikt een reeds bestaand netwerk |
| `MONGO_IMAGE` | `mongo:8.0.20`; compatibiliteitskeuze zonder verplichte upgrade |
| `N8N_OPENAI_BRIDGE_BUILD_CONTEXT` | `../n8n-openai-bridge-main`; lokale buildcheckout |
| `LC_BIND_IP`, `LC_PORT` | Alle interfaces, poort 3080; kies loopback/ingress-interface achter een hostproxy |
| `PUBLIC_BASE_URL` | Bestaande publieke URL voor LibreChat en standaard ingress-hostnaam |
| `GOVCHAT_SERVER_NAMES` | Leeg: host uit publieke URL plus `localhost` en `librechat-proxy`; anders expliciete spatiegescheiden hostnamen |
| `NGINX_TRUSTED_PROXIES_CONF_PATH` | `./nginx/trusted-proxies.conf` (standaard geen vertrouwen) |
| `NGINX_TRUSTED_PROXIES_GEO_PATH` | `./nginx/trusted-proxies.geo` (standaard geen vertrouwen) |

Onbekende Host-headers blijven geweigerd. Configureer exacte hostnamen, geen
wildcard/catch-all. Deze optie is bedoeld voor DNS-hostnamen, niet IPv6-literals.
Een upstreamrecreatie krijgt na de DNS-cachetijd een nieuwe resolutie zonder
proxyherstart. De optionele overlay-admin wordt pas bij een API-aanroep opgelost.

Maak beide trustlijsten privé en configureer **dezelfde exacte ingress-CIDR's**:
`set_real_ip_from <INGRESS_CIDR>;` in de conf en `<INGRESS_CIDR> 1;` in de geo.
Vervang deze placeholders lokaal; vertrouw nooit alle netwerken. Configureer de
private paden via de twee bovenstaande opties. De proxy gebruikt forwarding-
metadata alleen van expliciet vertrouwde peers. Laat de lijsten leeg totdat de
werkelijke ingressbron is vastgesteld. Het netwerk als geheel vertrouwen is
geen veilige vervanging voor het vaststellen van die bron.

Verander `GOVCHAT_DATA_ROOT` alleen als de data op de nieuwe locatie staat en
rechten/back-ups zijn geregeld; een nieuwe lege directory is geen datamigratie.
Wijzig een database-image pas na een back-up en controle op ondersteunde
upgrade/downgradepaden. Een nieuw instelbaar image impliceert niet dat iedere
databaseversie is getest.

## SSO-only als samenhangend opt-in beleid

```sh
docker compose --env-file .env \
  -f docker-compose.yml -f docker-compose.override.yml \
  -f docker-compose.sso-only.yml config --quiet
```

Gebruik dezelfde bestandsselectie voor `up -d`. Het brandingbestand is optioneel.
Zodra `-f` wordt gebruikt, wordt de normale override niet automatisch toegevoegd.

Deze policy schakelt lokale registratie, e-maillogin, password reset en de
dev-seeder uit; social login/registratie blijven aan. De proxy blokkeert lokale
auth-API's én de lokale adminlogin met 403, ook bij hoofdlettervarianten of een
trailing slash. OpenID/callback/refreshroutes blijven bereikbaar. `ADMIN_SSO_ONLY`
staat aan en server-side adminverkeer gaat door de proxy, niet rechtstreeks naar
LibreChat. Publiceer de applicatiecontainer nooit buiten de ingress.

De normale basis behoudt het bestaande loginbeleid: lokale login/registratie
volgen `DEV_SEED_ADMIN_ENABLED` (default false), password reset staat aan, social
login/registratie staan aan. Deze flags zijn afzonderlijk configureerbaar via
`ALLOW_*`. `GOVCHAT_BLOCK_PASSWORD_AUTH=false` behoudt het normale ingressgedrag;
alleen dit op `true` zetten regelt niet de volledige SSO-only policy.

| OpenID-optie | Basis | SSO-only |
| --- | --- | --- |
| `OPENID_SCOPE` | `openid profile email offline_access` | `openid profile email` |
| `OPENID_REUSE_TOKENS` | `true` | `false` |
| `USE_ENTRA_ID_FOR_PEOPLE_SEARCH` | `true` | `false` |
| `OPENID_GRAPH_SCOPES` | Bestaande Graph/people-scopes | Leeg |
| `OPENID_ON_BEHALF_FLOW_FOR_USERINFO_REQUIRED` | `true` | `false` |

Deze OpenID-opties kunnen expliciet worden ingesteld als Graph-toegang wél
ingericht is. Een expliciet lege `OPENID_GRAPH_SCOPES` blijft leeg, niet de default.
Stel deze variabelen niet gedachteloos op de basisdefaults in als je de SSO-only
defaults wilt gebruiken. Providerpermissions en tokenaudiences moeten kloppen.

`OPENID_ADMIN_ROLE` is standaard leeg: geen nieuwe claimmapping afdwingen.
Voor adminclaimmapping stel je de gewenste rol in, met
`OPENID_ADMIN_ROLE_TOKEN_KIND=id` en `OPENID_ADMIN_ROLE_PARAMETER_PATH=roles`
(of een bewust gekozen alternatieve claimbron). Configureer ook de bestaande
vereiste toegangsrol. De upstreamapp kan ADMIN bij een latere SSO-login intrekken
als de adminclaim ontbreekt: controleer bestaande beheerders vóór migratie.
Configureer beide OpenID-callbacks in de providerregistratie:
`/oauth/openid/callback` en `/api/admin/oauth/openid/callback` op de eigen publieke
app-URL. Roltoewijzing, consent, MFA en interactieve login moeten lokaal worden
getest; proxytests bewijzen die providerstappen niet.

## Beheerinterfaces achter een geauthenticeerde hostproxy

`docker-compose.management.yml` is optioneel. Het voegt HTTP-adapters voor n8n,
Qdrant, MeiliSearch en de bridge toe, plus een 404-sink met `/healthz`. Alle
hostbindings zijn **uitsluitend loopback**. De adapters authenticeren zelf niet;
gebruik een bestaande geauthenticeerde hostproxy via HTTPS. Loopback beschermt
niet tegen andere processen/gebruikers op dezelfde host. Behoud de eigen
backendauthenticatie en beperk toegang tot de host. Verbind deze listeners niet
met een ongeauthenticeerde publieke ingress. De bridge bewaart diens API-auth.

De hostpoorten zijn configureerbaar via `N8N_MANAGEMENT_PORT`,
`QDRANT_MANAGEMENT_PORT`, `MEILI_MANAGEMENT_PORT`, `BRIDGE_MANAGEMENT_PORT` en
`MANAGEMENT_SINK_PORT`. Interne upstreamnamen en poorten veranderen niet.
`MANAGEMENT_FORWARDED_PROTO` is `https` (of bewust `http` voor lokale tests).
Vertrouw dit alleen omdat de buitenste proxy de beveiligingsgrens vormt.

Bij een prefix-strippende proxy (zoals code-server `/proxy/<port>/`) stel je:

- `N8N_PATH` en `N8N_MANAGEMENT_PATH` op het externe editorpad met trailing slash;
- `N8N_EDITOR_BASE_URL` op de volledige externe editor-URL;
- `N8N_PROXY_HOPS` op het werkelijke aantal vertrouwde proxyhops;
- `QDRANT_MANAGEMENT_PATH` op de externe prefix met trailing slash.

De n8n-adapter herschrijft het cookiepad en ondersteunt WebSocket-upgrades.
Qdrant krijgt aangepaste statische dashboardpaden en een correcte redirect;
dit is dashboard-versiegevoelig, voer na upgrades de browsertest uit.
Bij toegang zonder subpad laat je beide managementpaden `/`.
`N8N_WEBHOOK_URL` is **apart** van de editorconfiguratie; n8n's editorpad verplaatst
niet automatisch backend-webhookroutes. De publieke GovChat-proxy blijft alleen
de bestaande toegestane webhook doorgeven, niet de editor of overige n8n-paden.

### Adminpanel onder een subpad

De basis gebruikt `ADMIN_PANEL_IMAGE` en `ADMIN_PANEL_API_SERVER_URL` (standaard
via `librechat-proxy`). Stel `ADMIN_PANEL_PUBLIC_URL` op de bereikbare externe
panel-URL in. De panelhostpoort blijft loopback op `ADMIN_PANEL_PORT`.

Vite vereist het base path tijdens de **build**. Alleen een runtimevariabele is
niet genoeg. Voeg `docker-compose.admin-panel-build.yml` toe en configureer
`ADMIN_PANEL_BASE_PATH` inclusief begin- en eindslash. Dit bestand gebruikt
dezelfde pathwaarde voor buildarg en runtime. De default buildcontext verwijst
naar een publieke, gepinde upstreamrevision; kies desgewenst een andere reviewed
revision via `ADMIN_PANEL_BUILD_CONTEXT`. Gebruik `ADMIN_PANEL_BUILD_IMAGE` als
lokale imagenaam. Bouw opnieuw na een pathwijziging. De externe proxy moet het
padgedrag van het gebouwde panel behouden (code-server: `/absproxy/<port>/`).

## Migratie van een lokale installatie

1. Bewaar de bestaande `.env`, lokale overrides, trustlijsten en alle data privé.
2. Zet elke hardcode om naar bovenstaande variabelen; geen provider-/hostwaarden
   in gedeelde Compose- of Nginx-bestanden opnemen.
3. Selecteer SSO-only, beheeradapters en/of panelbuild expliciet als nodig.
4. Platformspecifieke legacy-TLS-doorverwijzingen kunnen een private
   `docker-compose.local.yml` nodig hebben. Voeg geen providerpoort of IP toe aan
   publieke defaults. Plaats dat bestand als laatste en controleer dat het geen
   securitybeleid opheft. Om een bestaande poortlijst te **vervangen** in plaats
   van uit te breiden is Compose `!override` nodig (Compose 2.24.4+).
5. Controleer eerst `config --quiet`, maak back-ups en plan de daadwerkelijke
   omschakeling afzonderlijk. Controleer HTTPS, toegangsblokkering, SSO,
   dashboardassets/cookies en inference. Dit bestand migreert geen live data.

## Tests

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
GOVCHAT_DOCKER_TESTS=1 python3 -m unittest discover -s tests -p 'test_deployment_configuration.py'
```

De Docker-tests gebruiken tijdelijke containers, een apart netwerk en fictieve
upstreams; geen hostpoorten of productievolumes. Ze controleren rendering,
SSO-only blokkering, hostcontrole, forwardingmetadata, DNS-recreatie en opstart
zonder optionele overlay/adminservices. Vereist de Nginx-testimage lokaal.

`scripts/test-management-access.py` is een optionele interactieve-ingress smoke
test in een Playwright-omgeving. Zet `MANAGEMENT_CODE_URL` expliciet op de eigen
HTTPS-code-server-URL en geef het wachtwoord als JSON via stdin (`password`).
Zet `N8N_MANAGEMENT_PATH`, `QDRANT_MANAGEMENT_PATH`, `ADMIN_PANEL_BASE_PATH` en
de managementpoorten passend bij die ingress. `MANAGEMENT_LEGACY_ADMIN_URL`
is optioneel: alleen als een oude publieke panel-URL 404 moet geven. Het script
slaat geen cookies, screenshots of browserstate op en print geen credentials of
browserexceptiondetails. Testaccounts/credentials horen nooit in Git. De test
bewijst geen Entra-login of workflowuitvoering.
