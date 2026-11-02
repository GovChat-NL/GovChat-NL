# Bijdragen aan GovChat-NL agent-workflows

De workflowbron staat in `agents/` van de canonical GovChat-NL-repository. Dien workflow- en runtimewijzigingen daar in en valideer exports met `node tests/agents/validate-workflows.js`.

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

- Plaats deploybare workflow-exports als top-level `.json`-bestanden in `n8n/workflows/`. Bootstrap scant deze map automatisch; ieder gevonden JSON-bestand wordt geïmporteerd en gepubliceerd.
- Gebruik beschrijvende bestandsnamen, bijvoorbeeld `orchestrator-litellm.json`.

## Versiebeheer-richtlijn

- Gebruik PR's voor elke workflow-wijziging.
- Benoem migratie-impact als workflow-`id`, webhook-pad of output-schema wijzigt.

## Opmerking voor lokaal testen

De monorepo bootstrap mount deze workflowmap lokaal. Na een workflowwijziging zet je `AGENTS_BOOTSTRAP_FORCE=true` en voer je `n8n-bootstrap` opnieuw uit om de bestaande seed-marker te forceren; zet de variabele daarna terug op `false`.

