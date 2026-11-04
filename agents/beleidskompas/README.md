# Beleidskompas

Deze map bevat de broncode van de n8n-workflows van Beleidskompas: de hoofdagent, die elk bericht ontvangt en doorstuurt, en de stappen, die de inhoud leveren.

| Bestand | Wat erin staat |
|---|---|
| `main-agent.js` | De hoofdagent: controleert het token, beantwoordt het titelverzoek van LibreChat, haalt het bericht van de pagina uit elkaar en stuurt het naar de juiste stap. |
| `shared.js` | Wat de hoofdagent en de stappen delen: het token lezen, HTTP-verzoeken, de aanroep van het taalmodel, bronnen scoren, het bronnenblok in een chatbericht, het titelverzoek, en `runStep`, dat een stap uitvoert. |
| `steps/step1.js` … `steps/step4.js` | De structuur van een stap: welke deelstappen er zijn en welk promptbestand bij elke deelstap hoort. |
| `prompts/` | De teksten voor het taalmodel, als gewone tekstbestanden: het sjabloon van de systeemprompt (`system-prompt.md`), de regels die voor elke stap gelden (`rules.md`), en per stap een map met de rol van het model (`role.md`) en één bestand per deelstap. |
| `fixtures/` | Een voorbeeldcasus en de bronfragmenten die een stap doorzoekt. |
| `tests/` | De tests. |

## Gegenereerde workflows

n8n leest alleen workflow-bestanden (JSON), met de code als tekst in een Code node. Het script `generate-workflow.js` maakt die bestanden uit de broncode in deze map en zet ze bij de overige workflows in [`n8n/workflows/beleidskompas/`](../n8n/workflows/beleidskompas/):

| Workflow | Gemaakt uit |
|---|---|
| `beleidskompas-hoofdagent.json` | `main-agent.js`, plus wat het gebruikt uit `shared.js` |
| `beleidskompas-step-stap1.json`, `-stap2.json`, … | Eén workflow per bestand in `steps/`: de stapdefinitie met de teksten uit `prompts/`, plus wat die gebruikt uit `shared.js` en de bestanden in `fixtures/` |

Wijzig die workflow-bestanden niet met de hand en niet in n8n: het script maakt ze bij elke uitvoering volledig opnieuw aan, waardoor zulke wijzigingen verloren gaan. Een wijziging hoort in de broncode in deze map.

## De hoofdagent

De hoofdagent is de webhook achter het Beleidskompas-endpoint van LibreChat. Elk bericht van de Beleidskompas-pagina komt daar binnen. In volgorde:

1. **Token.** Het token van de aanroeper wordt vergeleken met `BELEIDSKOMPAS_N8N_WEBHOOK_TOKEN` (of `N8N_WEBHOOK_TOKEN`). Klopt het niet, dan komt er `ok: false` terug en gebeurt er verder niets.
2. **Titelverzoek.** LibreChat vraagt via hetzelfde endpoint om een korte gesprekstitel; dat verzoek is te herkennen aan de markering in `titlePrompt` in `librechat.yaml`. De hoofdagent maakt die titel zelf, zonder een stap aan te roepen.
3. **Bericht uit elkaar halen.** De pagina kan alleen tekst sturen en zet daarom alles in één bericht, met een label aan het begin van elk deel: `Stap:`, `Casus/eerdere bevindingen:` en `Vraag:`. De hoofdagent knipt het bericht op die labels in losse delen.
4. **Doorsturen.** De delen gaan als velden (`step_id`, `question`, `findings`) naar de webhook van de stap (`beleidskompas-step-<stap>`), met het token van de aanroeper. Het antwoord van de stap gaat ongewijzigd terug. De stappen hoeven zo niets te weten van hoe de pagina haar bericht opmaakt.

Wordt er geen stap herkend (alleen `stap1` tot en met `stap4` gelden), dan wordt het bericht niet beantwoord: de hoofdagent geeft `ok: false` terug met een leesbare melding in het tekstveld, zodat die in de chat verschijnt. Er is bewust geen standaardstap. Een antwoord van de verkeerde stap zou op de pagina ongemerkt onder de actieve stap terechtkomen.

## Een stap

Een stap bestaat uit deelstappen. Elke deelstap is één tekstbestand in `prompts/<stap>/`, met twee delen: de instructie voor het taalmodel, en onderaan, na "Antwoord in deze vorm:", een `json`-blok met het voorbeeld van het antwoord. Dat voorbeeld is de afspraak over het antwoord, voor het model én voor de code:

- de sleutels zijn de onderdelen van het antwoord, en worden op de pagina de labels (schrijf ze dus in het Nederlands, zoals je ze wilt zien);
- de vorm van elke waarde zegt wat het is: een tekst (`"…"`), een lijst (`["…"]`) of een oordeel (`{ "oordeel": "ja | nee | …", "toelichting": "…" }`, op de pagina een eigen kopje met een badge);
- de volgorde van de sleutels is de volgorde op de pagina;
- het blok moet geldige JSON zijn, anders stopt het genereren met de naam van het bestand.

Het model werkt alle deelstappen van een stap in één aanroep af, en het antwoord krijgt een kopje per deelstap. Een deelstap aanpassen, ook de onderdelen van het antwoord, is dus een tekstbestand aanpassen en de workflows opnieuw genereren; aan de code hoef je niet te komen.

Wat `runStep` in `shared.js` met zo'n definitie doet:

1. **Bronnen zoeken.** De vraag en de bevindingen worden met een eenvoudige trefwoordscore vergeleken met de bronfragmenten in [`fixtures/source-passages.json`](fixtures/source-passages.json); de beste treffers gaan als citaties mee. Het is dezelfde scoring als in de Beleidskompas-editor van de beheeromgeving. Die fragmenten zijn demo-materiaal (twee komen uit beleidskaders van Provincie Limburg, de rest is illustratief) en zijn de plek waar later de documenten uit de beheeromgeving komen.
2. **Het taalmodel aanroepen.** De systeemprompt wordt opgebouwd uit `prompts/system-prompt.md`, waarin de rol van het model, de deelstappen in volgorde, de algemene regels uit `prompts/rules.md` en de vorm waarin het model moet antwoorden worden ingevuld. De gebruikersprompt bevat de bevindingen tot nu toe (bij een latere stap de antwoorden van de eerdere), de vraag (bij het eerste bericht van een casus de casusbeschrijving zelf) en de gevonden bronfragmenten. Het model wordt aangeroepen via LiteLLM (`LITELLM_URL` met `LITELLM_API_KEY` of `OPENAI_API_KEY`; het model via `BELEIDSKOMPAS_MODEL`).
3. **Het antwoord opbouwen.** Het model antwoordt in JSON: `case_summary`, `substeps` (per deelstap de onderdelen uit het voorbeeld), `reasoning` en `assumptions_missing_info`. Onderdelen die het model heeft overgeslagen, worden als "onbekend" getoond en onder de aannames gemeld. Daarvan wordt de tekst gemaakt die de pagina toont: een kopje per deelstap, en voor een oordeel een eigen kopje met een regel `**Oordeel:**`, die de pagina als badge toont. De citaties reizen mee in een onzichtbaar blok achter de tekst, omdat de chatpijplijn alleen tekst doorgeeft.

Is er geen taalmodel geconfigureerd, of mislukt de aanroep, dan geeft de stap `ok: false` terug met een melding die in de chat verschijnt. Er is geen plaatsvervangend antwoord: een storing of een ontbrekende sleutel ziet eruit als een storing, niet als een beoordeling.

## Wijzigingen doorvoeren

Voer na een wijziging in deze map de tests uit, genereer de workflows opnieuw en laad ze opnieuw in n8n. Vanuit de root van de repository:

```sh
make test-beleidskompas
make generate-workflows
make reload-workflows
```

Zonder `make`: `node --test` en `node generate-workflow.js` in deze map, en daarna de stappen uit de [richtlijnen voor workflows](../CONTRIBUTING.md#wijzigingen-lokaal-testen).
