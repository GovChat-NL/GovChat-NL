# Beleidskompas stap 1

Deze map bevat de broncode van de Beleidskompas-workflow voor stap 1.

## Gegenereerde workflow

Het script `generate-workflow.js` stelt uit `logic.js` en de bestanden in `fixtures/` de workflow samen die n8n inlaadt. Deze workflow staat niet in deze map, maar bij de overige workflows: [`n8n/workflows/beleidskompas/beleidskompas-step-stap1.json`](../n8n/workflows/beleidskompas/beleidskompas-step-stap1.json).

Wijzig dat bestand niet handmatig. Het script maakt het bij elke uitvoering volledig opnieuw aan, waardoor handmatige wijzigingen verloren gaan. Wijzigingen worden altijd in `logic.js` of `fixtures/` aangebracht.

## Wat de workflow doet

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
  `retrieval_trace`. `beleidskompas-hoofdagent.json` geeft dit object ongewijzigd door aan de
  aanroeper.

## Wijzigingen doorvoeren

Voer na een wijziging in deze map de tests uit, genereer de workflow opnieuw en laad hem opnieuw in n8n. Vanuit de root van de repository:

```sh
make test-beleidskompas
make generate-stap1
make reload-workflows
```

Zonder `make`: `node --test` en `node generate-workflow.js` in deze map, en daarna de stappen uit de [richtlijnen voor workflows](../CONTRIBUTING.md#wijzigingen-lokaal-testen).
