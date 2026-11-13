# GovChat-NL Overlay voor Open WebUI

> [!IMPORTANT]
> **Monorepo-integratie:** de GovChat-NL LibreChat deployment bouwt uitsluitend [`admin/`](admin/) uit deze component (`services/admin-overlay/admin`). De servicecode, beheerschermen en API-functies worden gebruikt door de LibreChat-stack. De Open WebUI-gerichte root-level loader/assets/configuratie en [`admin/defaults/`](admin/defaults/) zijn historische/standalone Open WebUI-defaults en worden niet gemount door de LibreChat Compose-service. LibreChat-defaults zijn eigendom van [`../../overlay/defaults/`](../../overlay/defaults/). Gebruik de Open WebUI Compose quickstart hieronder niet om de LibreChat-stack te starten.

> [!WARNING]
> **Status: niet productierijp / niet gegarandeerd werkend.**
> Deze repository wordt gedeeld als **inspiratie en referentie-implementatie** voor leveranciers en mede-overheden.
> Gebruik dit niet als kant-en-klare productieoplossing zonder eigen validatie, security review, hardening en acceptatietesten.

## Doel van publicatie

- Inspiratie bieden voor leveranciersselectie en doorontwikkeling binnen overheidscontext.
- Transparant delen van architectuurkeuzes en implementatie-ideeën.
- Niet bedoeld als “direct deploybaar” standaardproduct.

Een configureerbare overlay die **help-button**, **app launcher** en **admin panel** toevoegt aan een standaard [Open WebUI](https://github.com/open-webui/open-webui) deployment — zonder fork, zonder codewijzigingen.

Ontwikkeld als onderdeel van [GovChat-NL](https://github.com/GovChat-NL/GovChat-NL), het open-source AI-platform met LibreChat als standaard front-end. Zie de [GovChat-NL-documentatie](https://govchat-nl.github.io/) voor actuele informatie.

## Wat zit erin?

| Component | Omschrijving |
|---|---|
| **Help-button** | Floating "?" button rechtsonder met een complete handleiding-modal |
| **App Launcher** | Grid met apps rechtsboven in de navbar (Versimpelaar, externe tools, etc.) |
| **Admin Panel** | Webinterface om handleiding en apps te beheren — zonder herbouw van het Docker image |
| **Versimpelaar** | Ingebouwde tekstvereenvoudiger (B1/B2 taalniveau) via n8n webhook |

## Architectuur

Elke gemeente draait twee containers:

1. **`ghcr.io/open-webui/open-webui:<versie>`** — het officiële Open WebUI image, versie naar keuze
2. **`ghcr.io/.../govchat-overlay-admin:latest`** — publiceert alle overlay-bestanden

Communicatie verloopt via een **shared Docker volume**:

```
┌─────────────────────┐                        ┌──────────────────┐
│   Open WebUI         │  ← shared volume ──   │  govchat-admin   │
│   (officieel image)  │   /app/backend/static  │  (Node.js/Express)│
│                      │                        │                  │
│   Serveert:          │                        │  Publiceert:     │
│   loader.js          │                        │  loader.js       │
│   custom.css         │                        │  custom.css      │
│   help-content.json  │                        │  help-content.json│
│   apps.json          │                        │  apps.json       │
└─────────────────────┘                        └──────────────────┘
                                                       │
                                                ┌──────┴──────┐
                                                │  Beheerder   │
                                                │  :3002       │
                                                │  Admin UI    │
                                                └─────────────┘
```

**Startup-volgorde:**
1. Open WebUI start → kopieert eigen defaults naar STATIC_DIR
2. Admin container start → publiceert overlay-bestanden naar hetzelfde volume (overschrijft defaults)
3. Browsers laden de overlay via `/static/loader.js`

**Er is geen custom Docker image meer nodig.** Gemeentes kiezen zelf hun Open WebUI versie.

## Snel starten

```bash
# Clone de repository
git clone https://github.com/MarjoleinVerP/open-webui-govchat-overlay.git
cd open-webui-govchat-overlay

# Start met docker compose (productie-voorbeeld met alle services)
GOVCHAT_ADMIN_PASSWORD=mijnwachtwoord docker compose -f docker-compose.govchat.yaml up -d
```

Open daarna:
- **Open WebUI**: http://localhost:3000
- **Admin Panel**: http://localhost:3002

## Bestanden

```
open-webui-help-overlay/
├── loader.js                     # Injecteert help-button, app launcher, versimpelaar
├── custom.css                    # Alle styling (dark mode, responsive)
├── help-content.json             # Standaard handleiding (fallback)
├── apps.json                     # Standaard apps config (fallback)
├── docker-compose.yaml           # Basis compose (ontwikkeling)
├── docker-compose.govchat.yaml   # Productie config (volledig voorbeeld)
└── admin/
    ├── Dockerfile                # Admin panel image (node:20-alpine)
    ├── package.json
    ├── server.js                 # Express server met API + admin UI
    ├── views/
    │   ├── login.html            # Login pagina
    │   ├── dashboard.html        # Overzicht met snelkoppelingen
    │   ├── help-editor.html      # WYSIWYG handleiding-editor
    │   └── apps-editor.html      # Apps configuratie
    └── defaults/
        ├── help-content.json     # Standaard handleiding
        ├── apps.json             # Standaard apps config
        ├── loader.js             # Standaard overlay loader
        └── custom.css            # Standaard overlay styling
```

## Admin Panel

Het admin panel draait als aparte container en biedt:

- **Handleiding bewerken** — WYSIWYG editor met rich text toolbar, emoji picker, secties en subsecties toevoegen/verwijderen
- **Apps configureren** — Apps toevoegen, verwijderen, herschikken met emoji picker en target type (navigate/iframe/blank/versimpelaar)
- **App Launcher aan/uit** — Toggle om de app launcher knop te verbergen
- **Direct publishing** — Wijzigingen worden direct naar Open WebUI gepubliceerd via een shared Docker volume

Beveiligd met een wachtwoord via de `GOVCHAT_ADMIN_PASSWORD` environment variable.

## Features

- Floating "?" help-button rechtsonder
- Modal met sidebar-navigatie en collapsible secties
- App launcher knop rechtsboven in de navbar
- Versimpelaar voor tekstvereenvoudiging (B1/B2)
- Dark mode support (volgt Open WebUI theme)
- Print-functie en fullscreen toggle
- "Niet meer automatisch tonen" checkbox
- `{{APP_NAME}}` placeholder-support
- Configureerbaar via admin panel (geen herbouw nodig)

## Configuratie via environment variables

| Variable | Omschrijving | Voorbeeld |
|---|---|---|
| `GOVCHAT_ADMIN_PASSWORD` | Wachtwoord voor het admin panel | `geheim123` |
| `STATIC_DIR` | Open WebUI static directory (belangrijk!) | `/app/backend/static` |
| `CORS_ALLOW_ORIGIN` | Toegestane origin voor API calls | `https://chat.organisatie.nl` |
| `WEBUI_NAME` | Naam van de applicatie | `GovChat` |

**Let op**: `STATIC_DIR=/app/backend/static` is vereist in de Open WebUI container zodat de overlay-bestanden correct worden geserveerd.

## Beleidskompas: database

Templates, versies en referentiedocumenten van het Beleidskompas staan, net als de casussen, in de aparte database `beleidskompas-postgres` (niet in pgvector, dat is van LibreChat). De verbinding stel je in met `BELEIDSKOMPAS_POSTGRES_PASSWORD`; de host is vast. De tabellen staan in `admin/db/migrations` en worden bij het opstarten van de admin aangemaakt of bijgewerkt (`0002-templates.sql` voor de templates).

Bestaat er nog een `beleidskompas-state.json` in de data-map en is de database leeg, dan wordt die bij de eerste start eenmalig geïmporteerd als template "SiS 4.0" en hernoemd naar `beleidskompas-state.json.migrated`. Na een controle kun je dat bestand verwijderen.

Export en import nemen de huidige set documenten van een template mee, niet de volledige documentgeschiedenis; het is dus geen back-up van de documentsets van eerdere versies.

De databasetests van de store draaien met `make test-beleidskompas-db`, in een tijdelijke admin-container tegen `beleidskompas-postgres` (de stack moet draaien). Elke test werkt in een eigen schema dat daarna wordt verwijderd; de data van de service blijft ongemoeid. Zonder `BELEIDSKOMPAS_DB_TEST=true` worden de databasetests overgeslagen, dus `node --test` in `admin/` werkt ook zonder database.

## Updaten naar nieuwe Open WebUI versie

Pas de image tag aan in je `docker-compose.govchat.yaml`:

```yaml
open-webui:
  image: ghcr.io/open-webui/open-webui:v0.9.0   # nieuwe versie
```

Herstart:

```bash
docker compose -f docker-compose.govchat.yaml up -d
```

De overlay-bestanden worden automatisch opnieuw gepubliceerd door de admin container. Er hoeft geen image herbouwd te worden.

---

## GovChat-NL

Dit project is onderdeel van **[GovChat-NL](https://github.com/GovChat-NL/GovChat-NL)** — een initiatief dat AI-chattools toegankelijk en veilig maakt voor de Nederlandse overheid.

### Wat is GovChat-NL?

GovChat-NL is een open-source AI-chatplatform specifiek ontwikkeld voor Nederlandse overheidsorganisaties. Het biedt een veilige, privacy-vriendelijke omgeving waarin ambtenaren kunnen werken met grote taalmodellen (LLMs), zonder dat gevoelige gegevens naar externe partijen gaan.

### Wie werken eraan?

GovChat-NL is een samenwerkingsverband van Nederlandse overheidsorganisaties — gemeenten, provincies en andere publieke instellingen — die samen werken aan veilige en toegankelijke AI-tools.

### Meedoen of interesse?

GovChat-NL is open source en staat open voor deelname van alle Nederlandse overheidsorganisaties.

- **Documentatie**: [govchat-nl.github.io](https://govchat-nl.github.io/)
- **Contact**: Neem contact op via de website voor meer informatie over deelname
- **GitHub**: Bekijk de broncode, dien issues in of draag bij via pull requests
- **Licentie**: Open source — vrij te gebruiken en aan te passen

Of je nu een gemeente, provincie, waterschap of andere overheidsorganisatie bent: je bent welkom om GovChat-NL te gebruiken, te testen en mee te ontwikkelen.
