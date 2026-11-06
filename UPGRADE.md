# Upgrade-instructies

Dit document is bedoeld voor beheerders die GovChat-NL installeren en bijwerken. Het beschrijft per versie de gevolgen voor de installatie en de handelingen die nodig zijn. Wijzigingen waarvoor geen handeling nodig is, worden hier niet opgenomen.

## Werkwijze

- Er is één blok per versie van GovChat-NL-LibreChat. De nieuwste versie staat bovenaan.
- Bovenaan staat steeds het blok "Laatste versie": wat er in deze versie van de repository is veranderd ten opzichte van de vorige. Dat blok wordt bij elke wijziging bijgewerkt. Komt er een nieuwere versie bij, dan krijgt dit blok de commit van zijn versie als naam, en komt daarboven een nieuw blok "Laatste versie".
- Wordt een installatie over meerdere versies heen bijgewerkt, voer dan de handelingen van alle tussenliggende versies uit, van oud naar nieuw (van onder naar boven).
- Nieuwe functies en wijzigingen voor eindgebruikers staan hier niet. Die worden beschreven in de betreffende pull requests.
- Elk blok is op dezelfde manier opgebouwd:
  - **Samenvatting**: wat er voor de installatie verandert.
  - **Vereiste handelingen**: de stappen die de beheerder moet uitvoeren, in volgorde.
  - **Ongewijzigd**: wat zonder handeling blijft werken.
- In de tabel bij elk blok staat van welke versie naar welke versie je bijwerkt. Zolang GovChat-NL geen versienummers gebruikt, is een versie een commit in GovChat-NL-LibreChat.

---

## Laatste versie

| | |
|---|---|
| **Bijwerken vanaf** | GovChat-NL-LibreChat `dev`, `5df84fe` (2 november 2026) |
| **Bijwerken naar** | Deze versie. De commit wordt ingevuld zodra er een nieuwere versie bij komt. |

### Samenvatting

- Het chatmodel wordt ingesteld in `.env` met `AZURE_OPENAI_CHAT_MODEL`, in plaats van vast `azure/gpt-5.4`.
- Mongo bewaart zijn gegevens in het Docker-volume `mongodb-data` in plaats van in de map `/opt/librechat/data/mongodb`.
- De workflows staan per functie in een submap van `agents/n8n/workflows/`.
- nginx laadt de overlay rechtstreeks uit `overlay/src/`. De publicatiemap van de beheeromgeving bevat alleen nog instellingen.
- Beleidskompas is een eigen pagina op `/beleidskompas/`, met een eigen endpoint in LibreChat. Na het inloggen komt de gebruiker op een startscherm op `/start/`. Met `landing.enabled` op `false` in `apps.json` komt hij zoals voorheen direct in de chat. Het startscherm en de feedback van Beleidskompas werken alleen als de beheeromgeving draait (profiel `admin-overlay`).

### Vereiste handelingen

1. Stop de stack: `docker compose down`. Gebruik geen `-v`, want dat wist de volumes van n8n.
2. Haal de nieuwe code op: `git pull` in de map waar GovChat-NL staat. De containers lezen hun configuratie en code uit die map. Sinds deze versie geldt dat ook voor de overlay, die eerst door de beheeromgeving werd gepubliceerd.
3. Zet in `.env` het chatmodel: `AZURE_OPENAI_CHAT_MODEL='azure/<naam van de chat-deployment>'`. Er is geen standaardwaarde. Kies een model dat ook afbeeldingen kan lezen, zoals gpt-4o of gpt-5.
4. Alleen als je de bestaande gegevens wilt behouden (gebruikersaccounts en gesprekken): zet de Mongo-database over naar het volume. Sla je deze stap over, dan start Mongo met een lege database.

   ```sh
   docker compose create mongodb
   docker run --rm --volumes-from librechat-mongodb -v /opt/librechat/data/mongodb:/from:ro alpine sh -c 'cp -a /from/. /data/db/'
   ```

   Gebruik in dit commando de werkelijke oude datamap: als `GOVCHAT_DATA_ROOT`
   eerder was aangepast, vervang `/opt/librechat/data/mongodb` door die locatie.
   Dat geldt ook voor de overlaypaden verderop in deze handleiding. De nieuwe
   Mongo-opslag is een named volume en volgt `GOVCHAT_DATA_ROOT` niet.

   Hernoem daarna de map van de repository niet. Docker zet die naam voor de naam van het volume, en met een andere naam start Mongo met een leeg volume.
5. Start de stack: `docker compose up -d --build`.
6. Laad de workflows opnieuw in n8n met `make reload-workflows`. Heb je geen `make`, gebruik dan in plaats daarvan deze drie commando's:

   ```sh
   AGENTS_BOOTSTRAP_FORCE=true docker compose up -d --force-recreate n8n-bootstrap
   docker compose wait n8n-bootstrap
   docker compose restart n8n
   ```

7. Controleer dat je na het inloggen op het startscherm komt, dat de chat en Beleidskompas antwoord geven, en, als je stap 4 hebt gedaan, dat eerdere gesprekken er nog zijn.
8. Werk zo nodig de back-up bij. De database met gebruikersaccounts en gesprekken staat nu in het nieuwe Docker-volume `mongodb-data` in plaats van onder `/opt/librechat`. Een back-up van de hele server of van alle Docker-volumes neemt het vanzelf mee. Een back-up van alleen `/opt/librechat` niet: neem het volume dan apart op. `docker volume inspect <naam>` toont de locatie op de server.
9. Ruim op als alles werkt: de map `/opt/librechat/data/mongodb` (de oude kopie van de database), en `loader.js` en `custom.css` in `/opt/librechat/overlay/publish` en `/opt/librechat/overlay/data`. Die worden niet meer gebruikt.

Optioneel:

- Het nieuwe hoofdstuk "Beleidskompas gebruiken" komt niet vanzelf in de handleiding van een bestaande installatie. Is de handleiding nooit aangepast, verwijder dan `/opt/librechat/overlay/data/help-content.json` en herstart de beheeromgeving (`docker compose restart govchat-overlay-admin`). Is hij wel aangepast, voeg het hoofdstuk dan handmatig toe via de beheeromgeving. De tekst staat in `overlay/defaults/help-content.json`.

### Ongewijzigd

- De instellingen van de beheeromgeving.
- De chat en de andere apps werken zoals voorheen.
