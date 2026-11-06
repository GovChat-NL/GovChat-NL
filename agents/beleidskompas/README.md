# Beleidskompas

Deze map bevat de broncode van de n8n-workflows van Beleidskompas: de orchestrator, die elk bericht ontvangt en doorstuurt, en de stappen, die de inhoud leveren.

| Bestand | Wat erin staat |
|---|---|
| `orchestrator.js` | De orchestrator: controleert het token, beantwoordt het titelverzoek van LibreChat, haalt het bericht van de pagina uit elkaar en stuurt het naar de juiste stap. |
| `shared.js` | Wat de orchestrator en de stappen delen: het token lezen, HTTP-verzoeken, de aanroep van het taalmodel, bronnen scoren, het bronnenblok in een chatbericht, het titelverzoek, en `runStep`, dat een stap uitvoert. |
| `steps/step1.js` … `steps/step4.js` | De structuur van een stap: welke deelstappen er zijn en welk promptbestand bij elke deelstap hoort. |
| `prompts/` | De teksten voor het taalmodel, als gewone tekstbestanden: het sjabloon van de systeemprompt voor het uitwerken (`system-prompt.md`) en voor een gesprek over een deelstap (`conversation-prompt.md`), de regels die voor elke stap gelden (`rules.md`), en per stap een map met de rol van het model (`role.md`) en één bestand per deelstap. |
| `fixtures/` | Een voorbeeldcasus en de bronfragmenten die een stap doorzoekt. |
| `tests/` | De tests. |

## Gegenereerde workflows

n8n leest alleen workflow-bestanden (JSON), met de code als tekst in een Code node. Het script `generate-workflow.js` maakt die bestanden uit de broncode in deze map en zet ze bij de overige workflows in [`n8n/workflows/beleidskompas/`](../n8n/workflows/beleidskompas/):

| Workflow | Gemaakt uit |
|---|---|
| `beleidskompas-orchestrator.json` | `orchestrator.js`, plus wat het gebruikt uit `shared.js` |
| `beleidskompas-step-stap1.json`, `-stap2.json`, … | Eén workflow per bestand in `steps/`: de stapdefinitie met de teksten uit `prompts/`, plus wat die gebruikt uit `shared.js` en de bestanden in `fixtures/` |
| `overlay/src/apps/beleidskompas/steps.json` | De lijst van stappen en deelstappen (id, nummer, titel) voor de Beleidskompas-pagina, uit dezelfde stapdefinities |

Wijzig die workflow-bestanden niet met de hand en niet in n8n: het script maakt ze bij elke uitvoering volledig opnieuw aan, waardoor zulke wijzigingen verloren gaan. Een wijziging hoort in de broncode in deze map.

## De orchestrator

De orchestrator is de webhook achter het Beleidskompas-endpoint van LibreChat. Elk bericht van de Beleidskompas-pagina komt daar binnen. In volgorde:

1. **Token.** Het token van de aanroeper wordt vergeleken met `BELEIDSKOMPAS_N8N_WEBHOOK_TOKEN` (of `N8N_WEBHOOK_TOKEN`). Klopt het niet, dan komt er `ok: false` terug en gebeurt er verder niets.
2. **Titelverzoek.** LibreChat vraagt via hetzelfde endpoint om een korte gesprekstitel; dat verzoek is te herkennen aan de markering in `titlePrompt` in `librechat.yaml`. De orchestrator maakt die titel zelf, zonder een stap aan te roepen.
3. **Bericht uit elkaar halen.** De pagina kan alleen tekst sturen en zet daarom alles in één bericht, met een label aan het begin van elk deel: `Deelstap:` (of `Stap:` voor een hele stap), `Casus:` (de casus zoals de gebruiker die beschreef), `Eerdere bevindingen:` (de uitwerkingen tot nu toe), `Gesprek:` (het gesprek over deze deelstap) en `Bericht:` (wat de gebruiker zojuist typte). De orchestrator knipt het bericht op die labels in losse delen. Een deelstap noemt ook haar stap: `1.3` hoort bij `stap1`.
4. **Doorsturen.** De delen gaan als velden (`step_id`, `substep_id`, `case_text`, `findings`, `conversation`, `message`) naar de webhook van de stap (`beleidskompas-step-<stap>`), met het token van de aanroeper. Het antwoord van de stap gaat ongewijzigd terug. De stappen hoeven zo niets te weten van hoe de pagina haar bericht opmaakt.

Wordt er geen stap herkend (alleen `stap1` tot en met `stap4` gelden), dan wordt het bericht niet beantwoord: de orchestrator geeft `ok: false` terug met een leesbare melding in het tekstveld, zodat die in de chat verschijnt. Er is bewust geen standaardstap. Een antwoord van de verkeerde stap zou op de pagina ongemerkt onder de actieve stap terechtkomen.

## Een stap

Een stap bestaat uit deelstappen. Elke deelstap is één tekstbestand in `prompts/<stap>/`, met twee delen: de instructie voor het taalmodel, en onderaan, na "Antwoord in deze vorm:", een `json`-blok met het voorbeeld van het antwoord. Dat voorbeeld is de afspraak over het antwoord, voor het model én voor de code:

- de sleutels zijn de onderdelen van het antwoord, en worden op de pagina de labels (schrijf ze dus in het Nederlands, zoals je ze wilt zien);
- de vorm van elke waarde zegt wat het is: een tekst (`"…"`), een lijst (`["…"]`) of een oordeel (`{ "oordeel": "ja | nee | …", "toelichting": "…" }`, op de pagina een eigen kopje met een badge);
- de volgorde van de sleutels is de volgorde op de pagina;
- het blok moet geldige JSON zijn, anders stopt het genereren met de naam van het bestand.

De pagina vraagt per deelstap een uitwerking (`substep_id`); het model werkt dan die ene deelstap uit, met de antwoorden van de eerdere deelstappen als bevindingen. Zonder `substep_id` werkt het model alle deelstappen van de stap in één aanroep af, en krijgt het antwoord een kopje per deelstap. Zit er een `message` bij (de gebruiker typte iets), dan werkt de stap niets uit maar reageert het model daarop in gewone tekst, met de systeemprompt uit `prompts/conversation-prompt.md`; dat antwoord komt alleen in de chat. Bij het opnieuw uitwerken stuurt de pagina het gesprek over de deelstap mee (`conversation`), zodat het model verwerkt wat de gebruiker heeft aangedragen. Een deelstap aanpassen, ook de onderdelen van het antwoord, is dus een tekstbestand aanpassen en de workflows opnieuw genereren; aan de code hoef je niet te komen.

Wat `runStep` in `shared.js` met zo'n definitie doet:

1. **Bronnen zoeken.** Het bericht, de casus en de bevindingen worden met een eenvoudige trefwoordscore vergeleken met de bronfragmenten in [`fixtures/source-passages.json`](fixtures/source-passages.json); de beste treffers gaan als citaties mee. Het is dezelfde scoring als in de Beleidskompas-editor van de beheeromgeving. Die fragmenten zijn demo-materiaal (twee komen uit beleidskaders van Provincie Limburg, de rest is illustratief) en zijn de plek waar later de documenten uit de beheeromgeving komen.
2. **Het taalmodel aanroepen.** De systeemprompt wordt opgebouwd uit `prompts/system-prompt.md`, waarin de rol van het model, de deelstappen in volgorde, de algemene regels uit `prompts/rules.md` en de vorm waarin het model moet antwoorden worden ingevuld. De gebruikersprompt bevat de casus, de bevindingen tot nu toe (de antwoorden van de eerdere deelstappen), het gesprek over de deelstap en het bericht van de gebruiker als die er zijn, en de gevonden bronfragmenten. Het model wordt aangeroepen via LiteLLM (`LITELLM_URL` met `LITELLM_API_KEY` of `OPENAI_API_KEY`; het model via `BELEIDSKOMPAS_MODEL`).
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
