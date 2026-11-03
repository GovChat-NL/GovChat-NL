# Agent-workflows

> [!WARNING]
> **Status: niet productierijp / niet gegarandeerd werkend.** Dit zijn referentieworkflows die aanvullende validatie, security review en beheerafspraken vereisen.

Deze directory is de monorepo-bron van waarheid voor GovChat-NL n8n-workflows. De historie van de voormalige `GovChat-NL-Agents` repository is opgenomen via Git subtree; wijzigingen worden voortaan hier beheerd en mee gereviewd met de deployment/runtime waarvoor ze bedoeld zijn.

## Integratie

- Workflows: [`n8n/workflows/`](n8n/workflows/), per functie in een submap (`algemeen/`, `beleidskompas/`, `openbesluitvorming/`).
- Broncode van de Beleidskompas-workflow voor stap 1, waaruit `n8n/workflows/beleidskompas/beleidskompas-step-stap1.json` wordt gegenereerd: [`beleidskompas/`](beleidskompas/README.md).
- Compose mount de directory read-only op `/workspace/agents`; `n8n-bootstrap` importeert uit `/workspace/agents/n8n/workflows`.
- Bootstrap scant alle `.json`-bestanden in deze map en de submappen ervan, valideert JSON en stabiele IDs, en importeert/publiceert ze; er is geen handmatige lijst of sibling-checkout nodig.
- De bootstrap maakt de `LiteLLM API` credential aan. Workflows gebruiken `${LITELLM_URL}/v1` en `${LITELLM_API_KEY}`.

De OpenBesluitvorming-exports staan direct in `n8n/workflows/` zodat ze door dezelfde bootstrap worden ontdekt. De ingest- en synchronisatieworkflows gebruiken de interne Compose-service `qdrant`; configureer de workflow-nodes voor de gewenste bron, collectie en credentials voordat een workflow wordt geactiveerd.

## Verzoekroute en modelroute

1. LibreChat stuurt een OpenAI-compatible verzoek naar de afzonderlijke bridge.
2. De bridge routeert `govchat-orchestrator` naar de n8n `orchestrator` webhook.
3. De orchestrator gebruikt de volledige berichtenhistorie en roept specialisten zoals de B1-versimpelaar als interne tools aan.
4. n8n roept LiteLLM rechtstreeks aan; dit modelverkeer loopt niet door de bridge.
5. De streamed webhookrespons gaat via de GovChat-NL-bridge terug. De standaard Compose bouwt branch `main` en laadt de runtimepatches voor native live tool-cards; zie [`../docs/live-tool-calling.md`](../docs/live-tool-calling.md).

## Wijzigingen en workflow-ID's

- Houd workflow-`id` stabiel om bestaande workflow-imports bij te werken; verander IDs alleen bewust.
- Wijzigingen aan workflow-JSON worden in deze checkout gedaan en vervolgens via de normale monorepo review uitgerold.
- Controleer structuur/JSON met `node tests/agents/validate-workflows.js`.
- Zie [`CONTRIBUTING.md`](CONTRIBUTING.md) voor bijdragen.

