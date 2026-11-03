# Beleidskompas

Deze map bevat de broncode van de Beleidskompas-workflows: de hoofdagent en stap 1.

- `shared.js`: wat alle workflows delen (token, HTTP en het taalmodel, bronnen scoren, het bronnenblok, het titelverzoek) en `runStep`, de loop die elke stap doorloopt.
- `main-agent.js`: de hoofdagent.
- `steps/step1.js`: alleen wat van stap 1 zelf is (de systeemprompt, de vorm van het antwoord, de teksten), samengevat in een definitie `STEP` die `runStep` gebruikt. Elke volgende stap krijgt zo'n bestand.
- `fixtures/`: de voorbeeldcasus en de bronfragmenten.

## Gegenereerde workflows

n8n leest alleen workflow-bestanden (JSON), met de code als tekst in een Code node. Het script `generate-workflow.js` maakt die bestanden uit de broncode in deze map en zet ze bij de overige workflows in [`n8n/workflows/beleidskompas/`](../n8n/workflows/beleidskompas/):

| Workflow | Broncode |
|---|---|
| `beleidskompas-hoofdagent.json` | `main-agent.js`, met wat het gebruikt uit `shared.js` |
| `beleidskompas-step-stap1.json` | `steps/step1.js`, met wat het gebruikt uit `shared.js`, en de bestanden in `fixtures/` |

Wijzig die bestanden niet handmatig. Het script maakt ze bij elke uitvoering volledig opnieuw aan, waardoor handmatige wijzigingen verloren gaan. Wijzigingen worden altijd in de broncode aangebracht.

## Wat de hoofdagent doet

De hoofdagent is de webhook achter het Beleidskompas-endpoint van LibreChat. Elk bericht komt daar binnen.

- **Token**: het token van de aanroeper wordt vergeleken met `BELEIDSKOMPAS_N8N_WEBHOOK_TOKEN` (of `N8N_WEBHOOK_TOKEN`). Klopt het niet, dan komt er `ok: false` terug.
- **Titelverzoek**: LibreChat vraagt via hetzelfde endpoint om een korte gesprekstitel (herkenbaar aan de markering in `titlePrompt` in `librechat.yaml`). De hoofdagent beantwoordt dat zelf met een titel, zonder een stap aan te roepen.
- **Bericht uit elkaar halen**: de Beleidskompas-pagina kan alleen tekst sturen en zet daarom alles in één bericht met een label per deel (`Stap:`, `Casus/eerdere bevindingen:`, `Bekende bronnen:`, `Vraag:`). De hoofdagent knipt het bericht op die labels in losse delen. Alleen `stap1` tot en met `stap4` worden als stap herkend.
- **Doorsturen**: de delen gaan als velden (`step_id`, `question`, `case_text`, `sources`) naar de webhook van die stap (`beleidskompas-step-<stap>`), met het token van de aanroeper, en het antwoord van de stap gaat ongewijzigd terug. De stappen weten zo niets van het berichtformaat van de pagina.
- **Geen stap herkend**: dan wordt het bericht niet beantwoord. De hoofdagent geeft `ok: false` terug met een leesbare melding in het tekstveld, zodat die in de chat zichtbaar is. Er is bewust geen standaardstap: een antwoord van de verkeerde stap zou op de pagina onopgemerkt onder de actieve stap terechtkomen.

## Wat de workflow van stap 1 doet

- **Retrieval**: dezelfde keyword/tag-scoring als de Beleidskompas-admineditor, tegen een klein,
  vast setje brondocumenten in [`fixtures/source-passages.json`](fixtures/source-passages.json)
  (twee excerpten zijn afkomstig uit echte Provincie Limburg-beleidskaders die al in de oudere
  Python/OpenWebUI/Qdrant PoC als testfixture stonden; de rest is illustratief demo-materiaal).
- **Redenering**: als `LITELLM_URL` + `LITELLM_API_KEY`/`OPENAI_API_KEY` zijn geconfigureerd, roept de
  workflow LiteLLM aan met een system-prompt die de publiek-belang-criteria (marktfalen, publieke
  goederen, sociale rechtvaardigheid, externe effecten, consumentenbescherming) en de
  publiek/provinciaal-belangafweging combineert, condensed vanuit de 6-staps promptketen
  (`001`-`006`) van de eerdere Python/OpenWebUI/Qdrant Beleidskompas-PoC.
- **Demo-fallback**: ontbreekt een taalmodel-configuratie, of faalt de aanroep, dan retourneert de
  workflow een deterministische, expliciet als `"mode": "demo_fallback"` gelabelde plaatsvervangende
  uitvoer met dezelfde structuur (nooit stilzwijgend een gok voorwenden als AI-oordeel).
- **Output**: stabiel JSON-schema met `case_summary`, `public_interest`, `provincial_interest`,
  `reasoning`, `assumptions_missing_info`, `disclaimer`, `citations` (bron op passage-niveau) en
  `retrieval_trace`. De hoofdagent geeft dit object ongewijzigd door aan de aanroeper.

## Wijzigingen doorvoeren

Voer na een wijziging in deze map de tests uit, genereer de workflows opnieuw en laad ze opnieuw in n8n. Vanuit de root van de repository:

```sh
make test-beleidskompas
make generate-workflows
make reload-workflows
```

Zonder `make`: `node --test` en `node generate-workflow.js` in deze map, en daarna de stappen uit de [richtlijnen voor workflows](../CONTRIBUTING.md#wijzigingen-lokaal-testen).
