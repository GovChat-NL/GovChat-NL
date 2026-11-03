# Bijdragen aan GovChat-NL agent-workflows

De workflowbron staat in `agents/` van de GovChat-NL-hoofdrepository. Dien workflow- en runtimewijzigingen daar in en valideer exports met `node tests/agents/validate-workflows.js`.

## Ontwerpprincipes

1. **Orchestrator is het entrypoint**
   - Eindgebruikersverzoeken lopen via de orchestrator-workflow.
2. **Sub-agents zijn tools**
   - Voeg specialistisch gedrag toe als aanroepbare sub-workflows/tools.

## Hoe de keten werkt (praktisch)

1. LibreChat praat met de bridge via een OpenAI-compatibele endpoint (`/v1/chat/completions`).
2. De bridge routeert `govchat-orchestrator` naar n8n `POST /webhook/orchestrator`.
3. De orchestrator verwerkt de volledige chatgeschiedenis (`messages`) als context.
4. Indien nodig roept de orchestrator een sub-agent aan (zoals de versimpelaar).
5. Antwoord gaat in streaming-modus terug via dezelfde webhookrespons.

## Koppeling met LiteLLM (vereiste)

- Gebruik in `OpenAI Chat Model` nodes altijd `${LITELLM_URL}/v1` als base URL.
- Gebruik `${LITELLM_API_KEY}` als sleutel.
- Hardcode geen provider-specifieke URL's/sleutels in workflows.

## Tools / MCP-koppelingen toevoegen aan de orchestrator

- Koppel nieuwe tools (inclusief MCP-tools) via de orchestrator, niet rechtstreeks vanuit LibreChat.
- Definieer per tool een duidelijke input en output (veldnamen, types, foutafhandeling).
- Houd tool-aanroepen idempotent waar mogelijk (zelfde input => voorspelbaar resultaat).
- Leg per tool vast:
  - wanneer de orchestrator deze tool hoort te gebruiken;
  - welke grenzen/timeouts gelden;
  - welk fallback-gedrag geldt als de tool niet beschikbaar is.
- Documenteer nieuwe tool-contracten in de PR-beschrijving en update waar nodig [`README.md`](README.md).

## Checklist voor workflow-wijzigingen

- Houd workflow-`id` stabiel (voorkomt onbedoelde duplicaten bij n8n-import).
- Houd webhook-paden expliciet en gedocumenteerd.
- Controleer token-validatie (`N8N_WEBHOOK_TOKEN`) waar van toepassing.
- Zorg dat model-nodes de LiteLLM base URL via env gebruiken.
- Voor orchestrator-flows: behoud verwerking van volledige chatgeschiedenis.

### Wat betekent workflow-`id`?

Workflow-`id` is de unieke technische sleutel van een n8n-workflow.

- Zelfde `id` houden = bestaande workflow wordt bijgewerkt bij import.
- `id` wijzigen = n8n kan dit als nieuwe workflow zien (duplicaat naast de oude).

## Bestandslocatie

- Plaats workflow-exports in een submap per functie van `n8n/workflows/`, bijvoorbeeld `algemeen/` of `beleidskompas/`. Bootstrap scant deze map en de submappen automatisch; ieder gevonden `.json`-bestand wordt geïmporteerd en gepubliceerd, dus zet er geen andere JSON-bestanden neer.
- Gebruik beschrijvende bestandsnamen in kleine letters met streepjes, zonder spaties, bijvoorbeeld `orchestrator-litellm.json`.
- `beleidskompas/beleidskompas-step-stap1.json` wordt gegenereerd vanuit [`../beleidskompas/`](../beleidskompas/README.md). Pas dat bestand niet met de hand aan.

## Versiebeheer-richtlijn

- Gebruik PR's voor elke workflow-wijziging.
- Benoem migratie-impact als workflow-`id`, webhook-pad of output-schema wijzigt.

## Wijzigingen lokaal testen

`n8n-bootstrap` zet de workflows uit deze map bij de eerste start van de stack in n8n. Daarna onthoudt het met een markerbestand in het n8n-datavolume dat dit is gebeurd, en slaat het de import bij volgende starts over. Zo worden de workflows niet bij elke herstart opnieuw geïmporteerd en gepubliceerd terwijl er al verkeer loopt.

Een gewijzigde workflow komt daardoor niet vanzelf in n8n terecht. Draai vanuit de root van de repository:

```sh
make reload-workflows
```

Dat laat `n8n-bootstrap` nog een keer draaien met `AGENTS_BOOTSTRAP_FORCE=true`, alleen voor die ene run. Daarmee negeert bootstrap de marker en importeert en publiceert het alle workflows opnieuw. Daarna herstart het n8n, want de draaiende n8n blijft anders werken met de workflows die bij het opstarten zijn ingeladen.

Gebruik je geen `make`, dan zijn dit de onderliggende commando's:

```sh
AGENTS_BOOTSTRAP_FORCE=true docker compose up -d --force-recreate n8n-bootstrap
docker compose wait n8n-bootstrap
docker compose restart n8n
```

Laat `AGENTS_BOOTSTRAP_FORCE` in `.env` op `false` staan. Zet je hem daar op `true`, dan importeert bootstrap bij elke start opnieuw.

