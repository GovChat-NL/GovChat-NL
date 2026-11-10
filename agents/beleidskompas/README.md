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

De orchestrator is ook de enige die in de opslag van Beleidskompas schrijft: de database van de beheeromgeving met de stand van elke casus (`services/admin-overlay/admin/lib/beleidskompas/`). Hij gebruikt daarvoor `store-client.js` en de instellingen `BELEIDSKOMPAS_STORE_URL` en `BELEIDSKOMPAS_STORE_TOKEN`; de casus is het gesprek-id (`sessionId`) en de gebruiker (`userId`) die de bridge doorgeeft. Per verzoek schrijft hij: de casustekst (maakt de casus aan als die nieuw is), bij een getypt bericht de beurt van de gebruiker vooraf en die van de stap achteraf, bij een uitwerking de tekst ervan en de citaten, en bij het titelverzoek de titel.

Hij leest er ook uit. Na het schrijven van de casustekst haalt hij de stand van de casus op (`getState`) en geeft die aan de stap: de nieuwste casustekst, de nieuwste uitwerking per deelstap als bevindingen (bij een vraag alle deelstappen, bij een uitwerking alleen die tot en met de deelstap zelf), en de laatste twintig beurten van het gesprek. Kent de opslag de casus nog niet, zoals bij een eerste vraag in de gewone chat van LibreChat, dan is de stand leeg. Zo heeft een vraag uit de gewone chat van LibreChat dezelfde casus en hetzelfde gesprek als op de pagina. Het veld `store.read` in het antwoord zegt of de stand gelezen is. De stappen weten niets van de opslag.

De opslag is verplicht. Zonder opslag zou een stap antwoorden alsof de casus nieuw is, en zou het antwoord verloren gaan, terwijl de gebruiker een gewoon antwoord ziet. Daarom beantwoordt de orchestrator een bericht niet als de opslag niet te gebruiken is, en zegt hij dat in de chat. Drie gevallen, elk met een eigen tekst in `orchestrator.js`: de instellingen ontbreken of de bridge geeft geen gesprek en gebruiker door (`STORE_MISSING_TEXT`); de opslag geeft een fout voordat de stap is gevraagd, bij het schrijven van de casustekst, het lezen van de stand of het schrijven van de beurt van de gebruiker (`STORE_FAILED_TEXT`, de gebruiker kan het opnieuw proberen); de opslag geeft een fout nadat de stap heeft geantwoord, bij het schrijven van de uitwerking of de beurt van de stap (dan gaat het antwoord terug met `STORE_WARNING_TEXT` erboven). De fouten staan ook in het veld `store` van het antwoord van de orchestrator, zichtbaar in de uitvoering in n8n. Alleen het titelverzoek werkt zonder opslag.

## Een stap

Een stap bestaat uit deelstappen. Elke deelstap is één tekstbestand in `prompts/<stap>/`, met twee delen: de instructie voor het taalmodel, en onderaan, na "Antwoord in deze vorm:", het antwoordformaat. Het antwoordformaat is markdown en gaat zoals het er staat naar het model:

- elk kopje (`### Probleemdefinitie`) wordt op de pagina een eigen vak, in de volgorde van het bestand;
- onder een kopje staan de onderdelen met een vetgedrukte naam (`**Primaire oorzaken:**`), en een lijst als opsomming (`- …`);
- een kopje waarvan de eerste regel `**Oordeel:** ja | nee | …` is, is een oordeel: de pagina toont de waarde als badge naast het kopje. Groen is "ja", rood is "nee", al het andere is "onduidelijk".

Rond het antwoordformaat van de deelstappen staan in `prompts/report-prompt.md` drie vaste kopjes: `### Samenvatting casus` ervoor, en `### Redenering` en `### Aannames en ontbrekende informatie` erna. De pagina herkent die drie aan hun naam: de samenvatting toont zij in de chat, Redenering en Aannames staan standaard dicht, en het aantal punten onder Aannames telt mee voor de melding "Niet eenduidig beoordeeld". Wie die kopjes hernoemt, moet de pagina dus ook aanpassen (`overlay/src/apps/beleidskompas/format.js`, `panels/chat.js` en `panels/step-card.js`).

De pagina vraagt per deelstap een uitwerking (`substep_id`); het model werkt dan die ene deelstap uit, met de antwoorden van de eerdere deelstappen als bevindingen. Zonder `substep_id` werkt het model alle deelstappen van de stap in één aanroep af, en krijgt het antwoord een kopje per deelstap. Zit er een `message` bij (de gebruiker typte iets), dan werkt de stap niets uit maar reageert het model daarop in gewone tekst, met de systeemprompt uit `prompts/conversation-prompt.md`; dat antwoord komt alleen in de chat. Bij het opnieuw uitwerken stuurt de pagina het gesprek over de deelstap mee (`conversation`), zodat het model verwerkt wat de gebruiker heeft aangedragen. Een deelstap aanpassen, ook de onderdelen van het antwoord, is dus een tekstbestand aanpassen en de workflows opnieuw genereren; aan de code hoef je niet te komen.

Wat `runStep` in `shared.js` met zo'n definitie doet:

1. **Bronnen zoeken.** Het bericht, de casus en de bevindingen worden met een eenvoudige trefwoordscore vergeleken met de bronfragmenten in [`fixtures/source-passages.json`](fixtures/source-passages.json); de beste treffers gaan als citaties mee. Het is dezelfde scoring als in de Beleidskompas-editor van de beheeromgeving. Die fragmenten zijn demo-materiaal (twee komen uit beleidskaders van Provincie Limburg, de rest is illustratief) en zijn de plek waar later de documenten uit de beheeromgeving komen.
2. **Het taalmodel aanroepen.** De systeemprompt wordt opgebouwd uit `prompts/report-prompt.md`, waarin de rol van het model, de deelstappen in volgorde, de algemene regels uit `prompts/rules.md` en het antwoordformaat van de deelstappen worden ingevuld. De gebruikersprompt bevat de casus, de bevindingen tot nu toe (de antwoorden van de eerdere deelstappen), het gesprek over de deelstap en het bericht van de gebruiker als die er zijn, en de gevonden bronfragmenten. Het model wordt aangeroepen via LiteLLM (`LITELLM_URL` met `LITELLM_API_KEY` of `OPENAI_API_KEY`; het model via `BELEIDSKOMPAS_MODEL`).
3. **Het antwoord opbouwen.** Het model antwoordt in markdown, met de kopjes uit het antwoordformaat. `composeReport` zet daar de kop van de stap boven en de bronnen en de disclaimer onder; verder blijft het antwoord zoals het model het schreef. Laat het model een onderdeel weg, dan ontbreekt het ook op de pagina. De citaties reizen mee in een onzichtbaar blok achter de tekst, omdat de chatpijplijn alleen tekst doorgeeft.

Is er geen taalmodel geconfigureerd, of mislukt de aanroep, dan geeft de stap `ok: false` terug met een melding die in de chat verschijnt. Er is geen plaatsvervangend antwoord: een storing ziet eruit als een storing, niet als een beoordeling.

## Wijzigingen doorvoeren

Voer na een wijziging in deze map de tests uit, genereer de workflows opnieuw en laad ze opnieuw in n8n. Vanuit de root van de repository:

```sh
make test-beleidskompas
make generate-workflows
make reload-workflows
```

Zonder `make`: `node --test` en `node generate-workflow.js` in deze map, en daarna de stappen uit de [richtlijnen voor workflows](../CONTRIBUTING.md#wijzigingen-lokaal-testen).
