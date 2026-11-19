# Beleidskompas

Hier staat de broncode van de n8n-workflows van Beleidskompas. Er is een orchestrator die elk bericht ontvangt, en per stap een agent die het werk doet. Allemaal zijn het AI Agent nodes met een taalmodel en tools.

| Bestand | Wat erin staat |
|---|---|
| `orchestrator.js` | De code rond de orchestrator |
| `step-agent.js` | De code rond de agent van een stap |
| `shared.js` | Wat de workflows delen |
| `steps/` en `prompts/` | De stappen en teksten waarmee de beheeromgeving begint |
| `template.js` | Maakt van die stappen en teksten het template voor de beheeromgeving |
| `generate-workflow.js` | Maakt de workflows uit de bestanden hierboven |
| `tests/` | De tests |

## De workflows worden gegenereerd

n8n leest alleen workflow-bestanden in JSON. `generate-workflow.js` maakt die uit deze map en zet ze in [`n8n/workflows/beleidskompas/`](../n8n/workflows/beleidskompas/). Het script maakt ook `steps.json`, de lijst van stappen voor de Beleidskompas-pagina, en `default-template.json`, het template waarmee de beheeromgeving begint.

Pas de workflows niet met de hand aan, ook niet in n8n. Het script overschrijft ze. Een wijziging hoort in deze map.

## De teksten komen uit de beheeromgeving

In de workflows staan geen prompts. Bij elk bericht haalt de orchestrator het template op dat in de beheeromgeving is gepubliceerd (`GET /api/beleidskompas/live`). Daarin staan de stappen met hun deelstappen, de prompts, de regels, de disclaimer en het model. Een beheerder die iets aanpast en publiceert, ziet dat bij het volgende bericht terug.

De orchestrator geeft elke agent van een stap zijn deel van het template mee. Zo werken ze binnen één bericht met dezelfde versie.

De bestanden in `steps/` en `prompts/` zijn alleen het begin: het template dat de beheeromgeving heeft zolang er niets is aangepast.

Een stap uit het template werkt alleen als hij een eigen workflow heeft. Dit script maakt er een voor elke stap in `steps/`.

## Hoe een bericht loopt

Elk bericht voor Beleidskompas komt binnen bij de orchestrator. Dat geldt voor de Beleidskompas-pagina en voor de gewone chat van LibreChat.

1. De workflow controleert het token en haalt het bericht uit elkaar. De pagina zet achter de zichtbare tekst een onzichtbaar blok met de deelstap en wat de gebruiker typte. Zonder getypte tekst is het een verzoek om een uitwerking.
2. De workflow haalt het template op bij de beheeromgeving en de stand van de casus uit de opslag. De orchestrator krijgt de rapporten tot nu toe en de laatste honderd beurten van het gesprek. Wat de gebruiker over de casus heeft verteld, staat in dat gesprek.
3. De orchestrator kiest de stap en roept de agent van die stap aan. Gaat een vraag over meer stappen, dan roept hij er meer aan. Zijn instructie komt uit het template.
4. De agent van de stap doet het werk. Hij krijgt het gesprek en de eerdere rapporten volledig mee. Bij een uitwerking zijn dat de rapporten tot en met de gevraagde deelstap, bij een vraag alle rapporten.
5. Bij een uitwerking slaat de agent van de stap het rapport zelf op. Wat de pagina toont, is dus wat de agent van de stap schreef. De orchestrator krijgt het rapport te lezen.
6. De orchestrator schrijft het bericht voor de chat. Na een uitwerking zegt hij wat er nog ontbreekt.

Een titelverzoek van LibreChat gaat niet naar de orchestrator. Een Basic LLM Chain node maakt de titel met één aanroep van het model.

Welke casus en welke gebruiker het is, geeft de workflow door aan een tool. Het model vult alleen de deelstap en de opdracht in.

## De opslag

De stand van elke casus staat in de database van de beheeromgeving. De workflows lezen en schrijven die met HTTP Request nodes. Daarvoor zijn `BELEIDSKOMPAS_STORE_URL` en `BELEIDSKOMPAS_STORE_TOKEN` nodig. Het template komt van dezelfde dienst.

Zonder opslag of zonder template wordt een bericht niet beantwoord. De gebruiker krijgt dan een melding in de chat. Anders zou een agent antwoorden alsof de casus nieuw is, of met andere teksten dan de beheerder heeft gepubliceerd. Alleen het titelverzoek werkt zonder opslag.

## Het antwoordformaat van een deelstap

Een deelstap heeft een instructie voor het model en een antwoordformaat in markdown. In de beheeromgeving zijn dat twee velden. In `prompts/<stap>/` is het één bestand, met het antwoordformaat na "Antwoord in deze vorm:".

De pagina leest dat formaat:

- Elk kopje (`### Probleemdefinitie`) wordt op de pagina een eigen vak.
- Een kopje met als eerste regel `**Oordeel:** ja | nee | …` krijgt een badge. Groen is "ja", rood is "nee", al het andere is "onduidelijk".

In de prompt voor een uitwerking staan drie vaste kopjes om het formaat van de deelstap heen. De pagina herkent er twee op naam, dus hernoem ze niet zomaar. `### Redenering` en `### Aannames en ontbrekende informatie` staan op de stapkaart standaard dicht, en de pagina telt de punten onder Aannames.

## Wijzigingen doorvoeren

Na een wijziging in deze map, vanuit de root van de repository:

```sh
make generate-workflows
make test-beleidskompas
make reload-workflows
```

Voor een andere prompt of regel is dit niet nodig. Die pas je aan in de beheeromgeving.
