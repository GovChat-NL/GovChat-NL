# Beleidskompas

Deze map bevat de broncode van de n8n-workflows van Beleidskompas: de orchestrator, die elk bericht ontvangt en doorstuurt, en de stappen, die de inhoud leveren.

| Bestand | Wat erin staat |
|---|---|
| `orchestrator.js` | De orchestrator: controleert het token, beantwoordt het titelverzoek van LibreChat, haalt het bericht van de pagina uit elkaar en stuurt het naar de juiste stap. |
| `store-client.js` | De aanroepen van de opslag van de beheeromgeving (casustekst, uitwerking, gespreksbeurt, titel, de stand), die de orchestrator gebruikt. |
| `shared.js` | Wat de orchestrator en de stappen delen: het token lezen, HTTP-verzoeken, de aanroep van het taalmodel, bronnen scoren, het bronnenblok in een chatbericht, het titelverzoek, en `runStep`, dat een stap uitvoert. |
| `steps/step1.js` … `steps/step4.js` | De structuur van een stap: welke deelstappen er zijn en welk promptbestand bij elke deelstap hoort. |
| `prompts/` | De teksten voor het taalmodel, als gewone tekstbestanden: de sjablonen van de systeemprompt voor het uitwerken (`report-prompt.md`), voor een gesprek over een stap (`conversation-prompt.md`) en voor de keuze van de orchestrator welke stap een bericht beantwoordt (`orchestrator-prompt.md`), de regels die voor elke stap gelden (`rules.md`), en per stap een map met de rol van het model (`role.md`) en één bestand per deelstap. |
| `fixtures/` | Een voorbeeldcasus en de bronfragmenten die een stap doorzoekt. |
| `tests/` | De tests. |

## Gegenereerde workflows

n8n leest alleen workflow-bestanden (JSON), met de code als tekst in een Code node. Het script `generate-workflow.js` maakt die bestanden uit de broncode in deze map en zet ze bij de overige workflows in [`n8n/workflows/beleidskompas/`](../n8n/workflows/beleidskompas/):

| Workflow | Gemaakt uit |
|---|---|
| `beleidskompas-orchestrator.json` | `orchestrator.js` en `store-client.js`, plus wat die gebruiken uit `shared.js` |
| `beleidskompas-step-stap1.json`, `-stap2.json`, … | Eén workflow per bestand in `steps/`: de stapdefinitie met de teksten uit `prompts/`, plus wat die gebruikt uit `shared.js` en de bestanden in `fixtures/` |
| `overlay/src/apps/beleidskompas/steps.json` | De lijst van stappen en deelstappen (id, nummer, titel) voor de Beleidskompas-pagina, uit dezelfde stapdefinities |

Wijzig die workflow-bestanden niet met de hand en niet in n8n: het script maakt ze bij elke uitvoering volledig opnieuw aan, waardoor zulke wijzigingen verloren gaan. Een wijziging hoort in de broncode in deze map.

## De orchestrator

De orchestrator is de webhook achter het Beleidskompas-endpoint van LibreChat. Elk bericht van de Beleidskompas-pagina komt daar binnen, en ook elk bericht dat iemand in de gewone chat van LibreChat aan Beleidskompas stuurt. In volgorde:

1. **Token.** Het token van de aanroeper wordt vergeleken met `BELEIDSKOMPAS_N8N_WEBHOOK_TOKEN` (of `N8N_WEBHOOK_TOKEN`). Klopt het niet, dan komt er `ok: false` terug en gebeurt er verder niets.
2. **Titelverzoek.** LibreChat vraagt via hetzelfde endpoint om een korte gesprekstitel; dat verzoek is te herkennen aan de markering in `titlePrompt` in `librechat.yaml`. De orchestrator maakt die titel zelf, zonder een stap aan te roepen.
3. **Bericht uit elkaar halen.** De pagina kan alleen tekst sturen. Daarom zet zij achter de zichtbare tekst van het bericht een verborgen blok: een markdown-linkdefinitie `[beleidskompas-request]: data:application/json;base64,…` met daarin als JSON `substep_id` (de deelstap), `case_text` (de casus zoals de gebruiker die beschreef) en `message` (wat de gebruiker zojuist typte). Markdown toont zo'n regel niet, en wat de gebruiker typte zit ín het JSON, dus kan het nooit voor een van die velden worden aangezien. Dezelfde truc gebruiken de stappen voor de bronnen achter een antwoord. De uitwerkingen en het gesprek stuurt de pagina niet mee; die haalt de orchestrator uit de opslag. Een deelstap noemt ook haar stap: `1.3` hoort bij `stap1`.
4. **De stap kiezen.** Een verzoek om een uitwerking (geen `Bericht:`) gaat naar de stap van de deelstap. Een getypt bericht gaat naar de stap waar het over gaat: de orchestrator legt het model de stappen voor (nummer, titel, rol en deelstappen, met het sjabloon `prompts/orchestrator-prompt.md`) en vraagt alleen een nummer. Noemt het model geen geldige stap, of is er geen model, dan blijft het de stap van de deelstap. Een bericht zonder dat blok komt uit de gewone chat van LibreChat; dat is altijd een vraag, en de stap om op terug te vallen is dan stap 1.
5. **Doorsturen.** De delen gaan als velden (`step_id`, `substep_id`, `asked_from`, `case_text`, `findings`, `conversation`, `message`) naar de webhook van de stap (`beleidskompas-step-<stap>`), met het token van de aanroeper. Gaat het bericht naar een andere stap dan die van de deelstap, dan gaat de deelstap niet mee: die stap beantwoordt de vraag over zijn hele stap. `asked_from` zegt altijd vanuit welke deelstap is gevraagd. Het antwoord van de stap gaat ongewijzigd terug; de stap zet in het meta-blok achter de tekst zijn eigen id (`agent`) en `asked_from`, zodat de pagina kan tonen welke stap antwoordde.

Een bericht van de pagina dat geen bekende stap noemt (alleen `stap1` tot en met `stap4` gelden), wordt niet beantwoord: de orchestrator geeft `ok: false` terug met een leesbare melding in het tekstveld, zodat die in de chat verschijnt.

### De opslag

De orchestrator is ook de enige die in de opslag van Beleidskompas schrijft: de database van de beheeromgeving met de stand van elke casus (`services/admin-overlay/admin/lib/beleidskompas/`). Hij gebruikt daarvoor `store-client.js` en de instellingen `BELEIDSKOMPAS_STORE_URL` en `BELEIDSKOMPAS_STORE_TOKEN`; de casus is het gesprek-id (`sessionId`) en de gebruiker (`userId`) die de bridge doorgeeft. Per verzoek schrijft hij: de casustekst (maakt de casus aan als die nieuw is), bij een getypt bericht de beurt van de gebruiker vooraf en die van de stap achteraf, bij een uitwerking de JSON van het model met de gerenderde tekst en de citaten, en bij het titelverzoek de titel.

Hij leest er ook uit. Na het schrijven van de casustekst haalt hij de stand van de casus op (`getState`) en geeft die aan de stap in plaats van wat de pagina meestuurde: de nieuwste casustekst, de nieuwste uitwerking per deelstap als bevindingen (bij een vraag alle deelstappen, bij een uitwerking alleen die tot en met de deelstap zelf), en de laatste twintig beurten van het gesprek. Wat de pagina meestuurde is de terugval als de opslag uit staat, niet antwoordt of de casus nog niet kent. Zo heeft een vraag uit de gewone chat van LibreChat dezelfde casus en hetzelfde gesprek als op de pagina. Het veld `store.read` in het antwoord zegt of de stand uit de opslag kwam. Een schrijfactie die mislukt breekt het gesprek niet: het antwoord van de stap gaat gewoon terug, en de fout staat in het veld `store` van het antwoord van de orchestrator, zichtbaar in de uitvoering in n8n. Zonder de instellingen schrijft hij niets. De stappen weten niets van de opslag.

## Een stap

Een stap bestaat uit deelstappen. Elke deelstap is één tekstbestand in `prompts/<stap>/`, met twee delen: de instructie voor het taalmodel, en onderaan, na "Antwoord in deze vorm:", een `json`-blok met het voorbeeld van het antwoord. Dat voorbeeld is de afspraak over het antwoord, voor het model én voor de code:

- de sleutels zijn de onderdelen van het antwoord, en worden op de pagina de labels (schrijf ze dus in het Nederlands, zoals je ze wilt zien);
- de vorm van elke waarde zegt wat het is: een tekst (`"…"`), een lijst (`["…"]`) of een oordeel (`{ "oordeel": "ja | nee | …", "toelichting": "…" }`, op de pagina een eigen kopje met een badge);
- de volgorde van de sleutels is de volgorde op de pagina;
- het blok moet geldige JSON zijn, anders stopt het genereren met de naam van het bestand.

De pagina vraagt per deelstap een uitwerking (`substep_id`); het model werkt dan die ene deelstap uit, met de antwoorden van de eerdere deelstappen als bevindingen. Zonder `substep_id` werkt het model alle deelstappen van de stap in één aanroep af, en krijgt het antwoord een kopje per deelstap. Zit er een `message` bij (de gebruiker typte iets), dan werkt de stap niets uit maar reageert het model daarop in gewone tekst, met de systeemprompt uit `prompts/conversation-prompt.md`; dat antwoord komt alleen in de chat. Bij het opnieuw uitwerken stuurt de pagina het gesprek over de deelstap mee (`conversation`), zodat het model verwerkt wat de gebruiker heeft aangedragen. Een deelstap aanpassen, ook de onderdelen van het antwoord, is dus een tekstbestand aanpassen en de workflows opnieuw genereren; aan de code hoef je niet te komen.

Wat `runStep` in `shared.js` met zo'n definitie doet:

1. **Bronnen zoeken.** Het bericht, de casus en de bevindingen worden met een eenvoudige trefwoordscore vergeleken met de bronfragmenten in [`fixtures/source-passages.json`](fixtures/source-passages.json); de beste treffers gaan als citaties mee. Het is dezelfde scoring als in de Beleidskompas-editor van de beheeromgeving. Die fragmenten zijn demo-materiaal (twee komen uit beleidskaders van Provincie Limburg, de rest is illustratief) en zijn de plek waar later de documenten uit de beheeromgeving komen.
2. **Het taalmodel aanroepen.** De systeemprompt wordt opgebouwd uit `prompts/report-prompt.md`, waarin de rol van het model, de deelstappen in volgorde, de algemene regels uit `prompts/rules.md` en de vorm waarin het model moet antwoorden worden ingevuld. De gebruikersprompt bevat de casus, de bevindingen tot nu toe (de antwoorden van de eerdere deelstappen), het gesprek over de deelstap en het bericht van de gebruiker als die er zijn, en de gevonden bronfragmenten. Het model wordt aangeroepen via LiteLLM (`LITELLM_URL` met `LITELLM_API_KEY` of `OPENAI_API_KEY`; het model via `BELEIDSKOMPAS_MODEL`).
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
