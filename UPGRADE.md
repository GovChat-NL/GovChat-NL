# Upgrade-instructies

Dit document is bedoeld voor beheerders die GovChat-NL installeren en bijwerken. Het beschrijft per wijziging de gevolgen voor de installatie en de handelingen die nodig zijn. Wijzigingen waarvoor geen handeling nodig is, worden hier niet opgenomen.

## Werkwijze

- De meest recente wijziging staat bovenaan.
- Wordt een installatie over meerdere wijzigingen heen bijgewerkt, voer dan de handelingen van alle tussenliggende wijzigingen uit, van oud naar nieuw (van onder naar boven).
- Nieuwe functies en wijzigingen voor eindgebruikers staan hier niet; die worden beschreven in de betreffende pull requests.
- Elke wijziging is op dezelfde manier opgebouwd:
  - **Samenvatting**: wat er voor de installatie verandert.
  - **Vereiste handelingen**: de stappen die de beheerder moet uitvoeren, in volgorde.
  - **Ongewijzigd**: wat zonder handeling blijft werken.
- In de tabel bij elke wijziging staat vanaf welke versie de handelingen gelden en welke versie het resultaat is. Zolang GovChat-NL geen versienummers gebruikt, is een versie een commit in GovChat-NL-LibreChat.

---

## Startscherm na het inloggen

| | |
|---|---|
| **Status** | Nog niet uitgerold |
| **Bijwerken vanaf** | Beleidskompas als eigen pagina (hieronder) |
| **Nieuwe versie** | Wordt ingevuld bij uitrol |

### Samenvatting

Na het inloggen komt de gebruiker op een startscherm, een eigen pagina op `/start/`, met een tegel per app (standaard Chat en Beleidskompas) en een link naar de handleiding. Welke apps er staan, en de titel en ondertitel, staan in `apps.json` onder `landing`; met `"enabled": false` komt de gebruiker zoals voorheen direct in de chat. De App Launcher heeft een tegel "Start" om terug te gaan.

### Vereiste handelingen

1. Herstart nginx, omdat de configuratie een nieuw adres heeft: `docker compose restart librechat-proxy`.
2. Herstart de beheeromgeving, zodat ze de nieuwe `apps.json` uit de repository overneemt: `docker compose restart govchat-overlay-admin`.

### Ongewijzigd

- Wie geen startscherm wil, zet in `apps.json` `landing.enabled` op `false`; verder verandert er dan niets.
- Gesprekken, gebruikersaccounts en de instellingen van de beheeromgeving.

---

## Beleidskompas als eigen pagina

| | |
|---|---|
| **Status** | Nog niet uitgerold |
| **Bijwerken vanaf** | Overlay uit de repository, in modules (hieronder) |
| **Nieuwe versie** | Wordt ingevuld bij uitrol |

### Samenvatting

Beleidskompas is een eigen pagina op `/beleidskompas/`, naast LibreChat, in plaats van een venster over de chat. De tegel in de App Launcher is een link naar die pagina (in `apps.json`: `url` `/beleidskompas/`, `target` `navigate`); het doeltype "Beleidskompas" bestaat niet meer in de apps-editor van de beheeromgeving. De handleiding heeft een hoofdstuk "Beleidskompas gebruiken".

### Vereiste handelingen

1. Herstart nginx, omdat de configuratie nieuwe adressen heeft: `docker compose restart librechat-proxy`.
2. Bouw de beheeromgeving opnieuw: `make rebuild-admin`. Bij het starten neemt de beheeromgeving de `apps.json` uit de repository over, zoals ze bij elke start doet; de tegel wijst daarna naar de pagina.
3. Optioneel: het hoofdstuk "Beleidskompas gebruiken" in de handleiding. Een bestaande installatie houdt haar eigen help-tekst; neem het hoofdstuk over uit `overlay/defaults/help-content.json` of voeg het toe in de help-editor.

### Ongewijzigd

- De Beleidskompas-stappen en -instellingen in de beheeromgeving.
- Gesprekken: een Beleidskompas-casus is een gewoon LibreChat-gesprek en is op de pagina terug te vinden.

---

## Overlay uit de repository, in modules

| | |
|---|---|
| **Status** | Nog niet uitgerold |
| **Bijwerken vanaf** | Beleidskompas als eigen endpoint (hieronder) |
| **Nieuwe versie** | Wordt ingevuld bij uitrol |

### Samenvatting

De overlay (`overlay.js`, voorheen `loader.js`, en `custom.css`) staat in `overlay/src/` en wordt door nginx rechtstreeks uit die map op de server geladen, niet meer uit de publicatiemap van de beheeromgeving. De overlay is nu een module die uit meerdere bestanden bestaat. De publicatiemap bevat voortaan alleen nog configuratie (`apps.json`, `help-content.json` en dergelijke).

### Vereiste handelingen

1. Start de stack opnieuw met `docker compose up -d`; nginx wordt daarbij opnieuw aangemaakt met de map `overlay/src` erin gemount.
2. Bouw de beheeromgeving opnieuw: `make rebuild-admin`.
3. Optioneel: verwijder de achtergebleven `loader.js` en `custom.css` uit `/opt/librechat/overlay/publish` en `/opt/librechat/overlay/data`. Deze bestanden worden niet meer gebruikt.

### Ongewijzigd

- De configuratie van de overlay in de beheeromgeving (apps, help-tekst) en de gepubliceerde bestanden daarvan.
- Gesprekken en gebruikersaccounts.

---

## Beleidskompas als eigen endpoint in LibreChat

| | |
|---|---|
| **Status** | Nog niet uitgerold |
| **Bijwerken vanaf** | Beleidskompas stap 1 (hieronder) |
| **Nieuwe versie** | Wordt ingevuld bij uitrol |

### Samenvatting

Beleidskompas is in `librechat.yaml` een eigen endpoint (`govchat-beleidskompas`), dat via de n8n-openai-bridge naar de hoofdagent-workflow gaat; de route daarvoor staat in `bridge/models.json`. Nginx geeft het feedback-verkeer van Beleidskompas (`/govchat-api/beleidskompas-feedback`) door aan de beheeromgeving.

### Vereiste handelingen

1. Herstart LibreChat, de bridge en nginx, omdat ze hun configuratie alleen bij het opstarten lezen: `docker compose restart librechat n8n-openai-bridge librechat-proxy`.

### Ongewijzigd

- Het bestaande chat-endpoint `govchat-orchestrator` en de instellingen ervan.
- Gesprekken, gebruikersaccounts en de instellingen van de beheeromgeving.

---

## Beleidskompas stap 1: redenering, bronvermelding en feedback

| | |
|---|---|
| **Status** | Nog niet uitgerold |
| **Bijwerken vanaf** | Mongo-data in een named volume (hieronder) |
| **Nieuwe versie** | Wordt ingevuld bij uitrol |

### Samenvatting

De workflow voor stap 1 van Beleidskompas redeneert nu echt via het taalmodel, met bronvermelding op passage-niveau, en wordt gegenereerd uit broncode in `agents/beleidskompas/`. De hoofdagent accepteert ook het token dat de n8n-openai-bridge meestuurt en geeft het volledige antwoord van een stap door. De beheeromgeving heeft een endpoint voor anonieme gebruikersfeedback uit Beleidskompas en toont die feedback in de Beleidskompas-editor.

### Vereiste handelingen

1. Laad de workflows opnieuw in n8n: `make reload-workflows`.
2. Bouw de beheeromgeving opnieuw: `make rebuild-admin`.

### Ongewijzigd

- De instellingen `BELEIDSKOMPAS_N8N_BASE_URL` en `BELEIDSKOMPAS_N8N_WEBHOOK_TOKEN` staan nu in `.env.example`; de beheeromgeving las ze al en valt zonder deze regels terug op `http://n8n:5678` en `N8N_WEBHOOK_TOKEN`.
- Gesprekken, gebruikersaccounts en de instellingen van de beheeromgeving.

---

## Mongo-data in een named volume

| | |
|---|---|
| **Status** | Nog niet uitgerold |
| **Bijwerken vanaf** | Instelbaar chatmodel (hieronder) |
| **Nieuwe versie** | Wordt ingevuld bij uitrol |

### Samenvatting

De database van LibreChat (Mongo) bewaart zijn bestanden voortaan in het Docker-volume `mongodb-data`, net als n8n en de n8n-database, en niet meer in de map `/opt/librechat/data/mongodb`. Op Docker Desktop (macOS, Windows) kon Mongo die map niet in eigendom nemen en bleef hij herstarten; op servers maakte het niet uit. Een nieuwe installatie hoeft niets te doen. Een bestaande installatie moet de database eenmalig naar het volume overzetten, anders start Mongo met een lege database.

Docker zet de naam van het Compose-project voor de naam van het volume, bijvoorbeeld `govchat-nl-librechat_mongodb-data`; `docker volume ls` toont de volledige naam. Die projectnaam is standaard de naam van de map waarin de repository staat. Wordt die map hernoemd, dan start Mongo met een nieuw, leeg volume. Voor de volumes van n8n gold dat al.

### Vereiste handelingen

1. Stop de stack: `docker compose down` (zonder `-v`; dat zou de volumes van n8n wissen).
2. Werk GovChat-NL-LibreChat bij naar de nieuwe versie.
3. Laat Docker de Mongo-container en het nieuwe volume aanmaken zonder Mongo te starten: `docker compose create mongodb`.
4. Kopieer de database naar het volume, met behoud van de eigenaar van de bestanden:

   ```sh
   docker run --rm --volumes-from librechat-mongodb -v /opt/librechat/data/mongodb:/from:ro alpine sh -c 'cp -a /from/. /data/db/'
   ```

5. Start de stack: `docker compose up -d`. Log in en controleer dat eerdere gesprekken er zijn.
6. Pas daarna: neem het volume op in de back-up (`docker volume inspect <volledige naam>` toont waar het op de server staat) en verwijder de map `/opt/librechat/data/mongodb`.

### Ongewijzigd

- De inhoud van de database: gebruikers, gesprekken en instellingen gaan ongewijzigd mee.
- De overige mappen onder `/opt/librechat`.

---

## Instelbaar chatmodel

| | |
|---|---|
| **Status** | Nog niet uitgerold |
| **Bijwerken vanaf** | De samenvoeging van de repositories (hieronder) |
| **Nieuwe versie** | Wordt ingevuld bij uitrol |

### Samenvatting

Het chatmodel stond vast in de LiteLLM-configuratie (`azure/gpt-5.4`), waardoor elke installatie een Azure-deployment met precies die naam nodig had. Het model wordt nu ingesteld in `.env` met `AZURE_OPENAI_CHAT_MODEL`. De LiteLLM-aliassen `govchat-default` en `govchat-versimpelaar` wijzen naar die instelling; de alias `gpt-5.4` bestaat niet meer. De orchestrator- en Versimpelaar-workflows gebruiken de aliassen in plaats van `gpt-5.4`.

### Vereiste handelingen

1. Zet in `.env` de regel `AZURE_OPENAI_CHAT_MODEL='azure/<naam van de chat-deployment>'`, met `azure/` ervoor. Er is geen standaardwaarde; zonder deze regel heeft LiteLLM geen model voor de chat. Kies een model dat ook afbeeldingen kan lezen, zoals gpt-4o of gpt-5. De chat gebruikt hetzelfde model om afbeeldingen in een bericht te beschrijven; met een model dat alleen tekst aankan, werkt dat niet.
2. Herstart LiteLLM, zodat het de nieuwe configuratie en instelling inleest: `docker compose up -d --force-recreate litellm`.
3. Laad de workflows opnieuw in n8n, omdat de orchestrator en de Versimpelaar gewijzigd zijn: `make reload-workflows`. Zonder `make` zijn dit de commando's:

   ```sh
   AGENTS_BOOTSTRAP_FORCE=true docker compose up -d --force-recreate n8n-bootstrap
   docker compose wait n8n-bootstrap
   docker compose restart n8n
   ```

### Ongewijzigd

- De modellen voor spraak-naar-tekst en embeddings.
- Gesprekken, gebruikersaccounts en de instellingen van de beheeromgeving.

---

## Samenvoeging van de repositories

| | |
|---|---|
| **Status** | Nog niet uitgerold |
| **Bijwerken vanaf** | GovChat-NL-LibreChat `a4b9e67` (14 juli 2026) |
| **Nieuwe versie** | Wordt ingevuld bij uitrol |

### Samenvatting

GovChat-NL bestond uit drie afzonderlijke repositories die alleen in combinatie werkten: GovChat-NL-LibreChat, GovChat-NL-Agents en GovChat-AdminOverlay. Deze zijn samengevoegd in GovChat-NL-LibreChat:

- de n8n-workflows (voorheen GovChat-NL-Agents) staan in de map `agents/n8n/workflows/`;
- de beheeromgeving (voorheen GovChat-AdminOverlay) staat in de map `services/admin-overlay/`;
- de configuratie van de bridge, voorheen `n8n-openai-bridge/models.json`, staat in `bridge/models.json`.

### Vereiste handelingen

1. Werk GovChat-NL-LibreChat bij naar de nieuwe versie. De checkouts van GovChat-NL-Agents en GovChat-AdminOverlay naast de repository zijn daarna niet meer nodig.
2. Alleen van toepassing als `n8n-openai-bridge/models.json` lokaal was aangepast: neem die aanpassingen over in `bridge/models.json`.
3. Start GovChat-NL opnieuw met `docker compose up -d`. De beheeromgeving hoeft niet opnieuw gebouwd te worden; de code ervan is niet veranderd, alleen de plek in de repository.
4. Alleen van toepassing als de beheeromgeving als kant-en-klare image van GitHub (`ghcr.io`) wordt opgehaald in plaats van lokaal gebouwd: wijzig de naam van de image van `govchat-adminoverlay-admin` naar `govchat-nl-librechat-admin`. Onder de oude naam verschijnen geen nieuwe versies meer.

### Ongewijzigd

- Gesprekken, gebruikersaccounts, de workflows in n8n en de instellingen van de beheeromgeving blijven behouden.
- De workflows worden bij het bijwerken niet opnieuw in n8n geïmporteerd; dat is ook niet nodig, want ze zijn inhoudelijk gelijk aan die van de vorige versie. `AGENTS_BOOTSTRAP_FORCE` werkt zoals voorheen.
- De workflows worden voortaan altijd uit de map `agents/n8n/workflows/` geladen en niet meer van GitHub. De volgende instellingen in `.env` hebben daardoor geen effect meer: `AGENTS_WORKFLOW_SOURCE`, `AGENTS_RAW_BASE_URL`, `AGENTS_WORKFLOW_FILES` en `AGENTS_LOCAL_WORKFLOWS_DIR`. Ze kunnen blijven staan zonder gevolgen en kunnen bij gelegenheid worden verwijderd.
- `N8N_BASIC_AUTH_USER`, `N8N_BASIC_AUTH_PASSWORD`, `PGADMIN_DEFAULT_EMAIL` en `PGADMIN_DEFAULT_PASSWORD` staan nu in `.env.example`; `docker-compose.yml` gebruikte ze al, aan hun werking verandert niets.
