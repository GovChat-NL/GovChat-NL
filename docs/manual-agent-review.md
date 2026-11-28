# Onafhankelijke security- en agentintegratiereview

> Dit onafhankelijke siblingbewijs blijft behouden. Actuele gecombineerde resultaten en concrete cross-reviewfixes staan in [manual-final-review.md](manual-final-review.md); de hier vastgestelde vertrouwde-agentcontext-/optionele-adapterblockers blijven open.

Datum: 27 november 2026. Worktree: GovChat-NL-handleiding; branch feat/configurable-user-manual; begin- en eindbasis b87a6c7. Geen commit, push, deployment of private runtime gewijzigd. Frontend, native bron/buildbestanden en handleidinginhoud/catalogus zijn niet aangepast. Testartefacten staan uitsluitend in de genegeerde werkmap; de definitieve Node-run gebruikt ook die map voor tijdelijke fixtures.

## Conclusie / activeringsbesluit

**Geen goedkeuring voor volledige agentspecifieke gebruikerscontext.** De geauthenticeerde, niet door AI te wijzigen keten LibreChat → bridge → n8n → handleidingbackend is niet geïmplementeerd of end-to-end aangetoond. Dit is een expliciete activeringsblokker voor het kritieke gebruikerscontextvereiste, geen impliciete acceptatie op basis van groene unit-tests.

De geleverde veilige fallback heeft uitsluitend algemene agentcontext. Voorwaardelijke introductie/gebruiksuitleg van de promptbibliotheek komt uit de publieke productconfiguratie, zonder toekenning van persoonlijke rechten, zonder passage-ID/citaat en zonder beschermde handleidingtekst. Gebruik, maken, bewerken en delen van geconfigureerde beschermde passages blijven rights-filtered; product-API's blijven bovendien eigenaar-/resourcerechten afdwingen. De bestaande handleidingactivatie blijft standaard uit; niets is geactiveerd.

## Onderzochte bronnen en exacte ketenblocker

- De huidige [backendcontext](../services/admin-overlay/admin/lib/manual-context.js:5), [routes](../services/admin-overlay/admin/lib/manual-routes.js:29), [compiler](../services/admin-overlay/admin/lib/manual-model.js), [store](../services/admin-overlay/admin/lib/manual-store.js), [serverregistratie](../services/admin-overlay/admin/server.js:2472), [policy](../scripts/n8n-orchestrator-tool-policy.js:14) en [workflowgenerator](../scripts/orchestrator-manual-workflow.js:6) zijn daadwerkelijk gelezen en onafhankelijk getest. De oorspronkelijke contracten staan in [configurable-manual.md](configurable-manual.md) en [manual-backend-handoff.md](manual-backend-handoff.md).
- [LibreChat-endpointconfiguratie](../librechat.yaml:14) stuurt een gedeelde bridgecredential en headers voor Entra en gebruikersmetadata. Een metadataheader, chatbericht, request-body of gedeelde transportcredential bewijst geen actuele LibreChat-accountstatus of promptrechten. Entra-identiteit is niet automatisch hetzelfde als de actuele LibreChat-rol/autorisatie.
- De [bridge-buildconfiguratie](../docker-compose.yml:757) verwijst naar een externe buildcheckout. Binnen de toegestane worktree staan alleen [modelroutes](../bridge/models.json), een [tool-eventoverlay](../scripts/n8n-bridge-tool-events.js) en [bridge-runtime-tests](../tests/topdesk-bridge-runtime.test.cjs), niet de bridge-HTTP-/contextimplementatie. De andere checkout, draaiende services en private runtime zijn conform scope niet gelezen of gewijzigd. De eventoverlay is geen authenticatieadapter.
- De aanwezige offline LibreChatbron is geïnspecteerd voor user-route, JWT-strategie, role-route en fileconfig-route. Dat ondersteunt het gedelegeerde browserauthcontract, maar is geen nieuw uitgevoerd gepind native JWT-/SSO-acceptatiebewijs. De huidige review draait geen native LibreChat of echte identity provider. De oude overdracht telt niet als een nieuwe end-to-end test.
- De [TOPdesk-workflowbeveiliging](../scripts/topdesk-workflow-security.js:11) gebruikt een opaque bridgehandle en een verse private controle. De handle hoort niet bij de manualtool, bewijst geen LibreChat-promptrechten en is geen veilige vervanging voor een volledige contextadapter. Een handmatige of AI-aangeleverde gebruiker/rol/handle is daarom uitdrukkelijk niet toegevoegd aan de handleidingtool.

Voor een vervolgimplementatie zijn minimaal nodig: een server-afgeleid per-requestbewijs uit de geauthenticeerde LibreChatrequest; audience-/expiry-/replay- en requestbinding in de bridge; geen acceptatie van dezelfde context uit AI-/browserbody; gecontroleerde doorgifte naar **beide** agentroutes en hun subworkflow; verse identiteit/rechtencontrole bij de backend; tests met echte gepinde native componenten voor gewijzigde rol/tenant, uitgeschakeld/verwijderd account, verlopen/gewijzigd bewijs, replay, concurrente gebruikers en beide routes. Eventuele tokens mogen niet in modelinputs, antwoorden of execution-opslag belanden. Dit vereist gecoördineerde eigenaarschapstoegang tot de bridge en native transportintegratie, buiten deze taakgrens.

## Bevindingen en reparaties

| Bevinding | Risico vóór reparatie | Reparatie / bewijs |
|---|---|---|
| Geen vertrouwde persoonlijke agentcontext | Kritiek integratiegat: service-authenticatie kon als gebruikerscontext worden gelezen | Algemene scope wordt expliciet door backend afgedwongen; modelinvoer heeft geen rechtencontext. Beide prompts benoemen de grens. Volledige keten blijft blocker. |
| Gedeeltelijke context bleef staan na late configuratiefout | Rechten konden na bijvoorbeeld een fout in appconfig alsnog worden geretourneerd | Aanvullende context wordt afzonderlijk opgebouwd en pas na succes toegewezen. Late exceptions en misvormde context geven alleen algemene subset. |
| Minimale UI werd als uploadautorisatie gebruikt | Expliciet uitgeschakelde uploads konden door de algemene subset zichtbaar blijven | Geen upload/bestanden in algemene context. Geauthenticeerde effectieve fileconfig bepaalt gebruikerspassages; endpointprioriteit respecteert expliciete disable. |
| Identiteit niet opnieuw gecontroleerd na aanvullende reads | Identiteit/rol/tenant kon tijdens verzameling veranderen | Tweede user-read en vergelijking; fouten, veranderingen en expliciete disabled/banned/inactive worden geweigerd. Geen claim van een atomair snapshot. |
| Onvoldoende input-/authvormcontrole in losse router | Ongeprefixte servicecredential werd geaccepteerd; routertests hadden geen eigen bytegrens | Expliciete bearer, JSON en 2 KB bytegrens; onbekende contextvelden geweigerd vóór aanvullende contextreads. De serverparser had al een 2 KB grens. |
| Losse transcriptfeatureboolean kon als beschikbaarheid tellen | Launcher + boolean kon optionele passage toelaten zonder backendbewijs | Transcriptie blijft verborgen; OpenBesluitvorming en TOPdesk worden evenmin uit launchers/featurebooleans afgeleid. |
| Lokale manualpolicy accepteerde symlink en ongeldige revisievorm | Niet-canonieke metadata kon toolselectie onterecht toestaan | Alleen regulier bestand zonder symlink en correcte revisievorm. Backend blijft autoriteit bij stale lokale metadata. |
| Generatorfixture miste manualafhankelijkheid | Bestaande brede agentregressie faalde bij geïsoleerde generatie | [Fixture](../tests/agents/pr13-bootstrap-integration.test.js:68) aangevuld; ook tweemaal identieke manualexport gecontroleerd. |

## Optionele beschikbaarheidsadapters

Geen launcher-only adapter of nieuwe vrij te zetten manualcapability toegevoegd. Onderstaande beperkingen zijn niet met een false-positive beschikbaarheidsclaim omzeild.

| Functie | Werkelijk onderzocht bewijs | Exact ontbrekend bewijs / veilige uitkomst |
|---|---|---|
| OpenBesluitvorming | [Statistiekservice](../services/openbesluitvorming-statistics/server.py:114) heeft een geauthenticeerde read-only cataloguscontrole; [orchestrator](../agents/n8n/workflows/algemeen/orchestrator-litellm.json) heeft zoek- en statistiektools | Een gezond catalogusantwoord bewijst niet dat de actuele n8n-zoekworkflow, embeddings en zoekcollectie bruikbaar zijn. Het gedeelde manualcapability dekt meer dan catalogusmetadata. Geen bestaande volledige read-only beschikbaarheidscontract/credentials bij de manualbackend; passages blijven verborgen. |
| TOPdesk | [Availability- en retrievalchecks](../scripts/topdesk-workflow-security.js:34) controleren via de bridge een requestgebonden handle; [bootstrap](../n8n/bootstrap.js:30) verwerkt de opt-in vlag | De manualbackend ontvangt geen geverifieerde bridgehandle of persoonlijke autorisatie. Algemene service-auth of een launcher volstaat niet. Geen eigen handle-toolinput toegevoegd; passages blijven verborgen. |
| Transcriptie | [Workflow](../agents/n8n/workflows/algemeen/transcriptie-litellm.json) en de realtimeconfiguratie in [Compose](../docker-compose.yml:1099) | Launcher/config/modelnaam bewijzen geen werkende chunk- én realtime-STT-providerrechten. Er is geen gezamenlijke read-only beschikbaarheidscontrole voor deze gebruikersfunctie; een echte audio/providerprobe zou verkeer/kosten veroorzaken en valt buiten de onaangeroerde runtimegrens. Passages blijven verborgen. |

Deze beperking betekent niet dat de functies in een deployment daadwerkelijk uit staan; alleen dat de handleiding hun beschikbaarheid niet veilig kan aantonen.

## Exacte wijzigingen

- [manual-context.js](../services/admin-overlay/admin/lib/manual-context.js): atomair opgebouwde effectieve subset, typed identiteit en rolcontrole, tweede identiteitread, uploaddisable en endpointprioriteit, geen common-uploadinference, geen transcriptbooleanadapter; afzonderlijke voorwaardelijke promptbibliotheekuitleg zonder rechten.
- [manual-routes.js](../services/admin-overlay/admin/lib/manual-routes.js): strikte serviceauth-/JSON-/byte-/schemagrens; interne reads krijgen altijd lege rights en algemene scope, onafhankelijk van aangeleverde headers/body.
- [orchestrator-manual-workflow.js](../scripts/orchestrator-manual-workflow.js), [manualexport](../agents/n8n/workflows/govchat-manual-read.json), [orchestratorexport](../agents/n8n/workflows/algemeen/orchestrator-litellm.json): expliciete scope-/beschikbaarheidsinstructie in beide routes, upgrade bestaande regel in plaats van duplicatie, succesvolle workflowantwoorden vereisen algemene scope. Masterprompt, naam, overige tools en laatste streammarker blijven behouden. De orchestratorexport wijzigt uitsluitend de twee systeempromptexpressies.
- [n8n-orchestrator-tool-policy.js](../scripts/n8n-orchestrator-tool-policy.js): symlink- en revisievormcontrole voor manualmetadata.
- [agent-review.test.js](../tests/manual/agent-review.test.js), [routes.test.js](../tests/manual/routes.test.js), [generatorfixture](../tests/agents/pr13-bootstrap-integration.test.js): regressies en correctie van de oude fixtureafhankelijkheid.
- Dit rapport en de bijgewerkte [contractdocumentatie](configurable-manual.md). Geen inhouds-, frontend-, native-, Compose-, dependency- of manifestwijzigingen.

## Onafhankelijke tests en evidence

Uitgevoerd met de reeds aanwezige tijdelijke Node 22.16.0 en gelockte testdependencies. Geen systeem-Node, containerstart, imagebuild/pull, providerverkeer of deployment nodig.

| Run | Resultaat |
|---|---|
| Backend model/store/routes/workflow vóór uitbreiding | 21/21 geslaagd; inclusief 256 visibility/contextcombinaties, sanitization, storageprivacy, revisies, rollback en disable. |
| Nieuwe onafhankelijke security-/workflowtests plus bestaande workflowtests | 8/8 geslaagd. |
| Definitieve gecombineerde Node-regressie | 88 tests: 87 geslaagd, 0 fouten, 1 bestaande skip voor de native MCP-class die de gepinde n8n-image vereist. |
| Python deploymentconfiguratie | 26 tests: 13 geslaagd, 13 expliciet overgeslagen live proxytests; geen fouten. |
| Workflowexportvalidator | 25 exports, 25 unieke workflow-ID's; alle geslaagd, inclusief TOPdeskstructuur en secret hygiene. |
| Diff-whitespacecontrole | Geslaagd. |
| Foutcatalogus/fingerprintcontrole | **Niet groen:** gewijzigd bronbewijs voor precies [policy](../scripts/n8n-orchestrator-tool-policy.js), [context](../services/admin-overlay/admin/lib/manual-context.js) en [routes](../services/admin-overlay/admin/lib/manual-routes.js). Dit is de bedoelde expliciete reviewgate; catalogus is niet stilzwijgend bijgewerkt. |

De definitieve Node-run omvat de vijf backend/reviewtests in [tests/manual](../tests/manual), utilitytools/-server, prompt-/naammanagement en routes in [tests/orchestrator](../tests/orchestrator), plus [TOPdesk-integratie](../tests/agents/topdesk-orchestrator.test.js), [bootstrap/generatie](../tests/agents/pr13-bootstrap-integration.test.js) en [MCP-integratie](../tests/agents/mcp-hub-minimal.test.js). De eerste brede run had één ontbrekende manualgeneratorafhankelijkheid in de fixture; na de bovengenoemde fixturecorrectie is dezelfde hele selectie opnieuw groen uitgevoerd. Er is geen producttest verwijderd of tijdelijk uitgezet.

Raw, synthetische testoutput staat lokaal in [definitieve Node-evidence](../.manual-tools/manual-agent-review-node-final.tap), [Python-evidence](../.manual-tools/manual-agent-review-python.txt) en [fingerprint-evidence](../.manual-tools/manual-agent-review-inventory.txt). Deze bestanden zijn genegeerd, bevatten geen echte tokens/gebruikersdata en worden niet gecommit. De testbronnen zijn de blijvende reproduceerbare evidence.

De oorspronkelijke contextmodule is daarnaast rechtstreeks uit begincommit b87a6c7 in een geïsoleerde module geladen en met dezelfde synthetische autoriteitsantwoorden vergeleken met de reparatie. Drie oorspronkelijke gedragingen zijn bevestigd: late appconfigfout behield verzamelde promptdeelrechten; minimale UI behield uploads ondanks expliciet uitgeschakelde custom-upload; algemene agentcontext leidde uploads uitsluitend uit UI af. De reparatie weigert alle drie. Zie [baseline-reproductie](../.manual-tools/manual-agent-review-baseline.txt). Deze vergelijking schrijft geen checkoutbestanden en gebruikt geen echte gebruikersgegevens.

De HTTP-test draait echte lokale backend- en autoriteitsservers met synthetische tokens. Zij bewijst dat weigering door de autoriteit niet wordt omzeild, dat iedere read opnieuw controleert, dat gewijzigde rechten geen cached passage opleveren en dat beide workflowexpressies de algemene grens behouden. Zij bewijst **niet** cryptografische JWT-validatie door native LibreChat, echte Entra-/Graphrevocatie, een werkende bridgeketen of modelgedrag. De n8n-code en expressions zijn rechtstreeks uitgevoerd; geen nieuwe native n8n-engineacceptatie geclaimd. Bestaande uitvoeringspolicytest controleert disable tussen selectie en invocation; de HTTP-test controleert backenddisable afzonderlijk.

## Overdracht aan parent

1. Behoud de veilige algemene fallback zolang de volledige vertrouwde contextketen ontbreekt. Geen activering als het kritieke per-gebruikervereiste een releasevoorwaarde is.
2. Review de drie gewijzigde bronfingerprints en werk daarna pas de [foutinventaris](manual-error-inventory.json) expliciet bij met de bestaande [inventoryprocedure](../scripts/manual-error-inventory.py). De parent/contenteigenaar moet dit in de gecombineerde wijzigingen doen; hier is geen content of baselinebewijs herschreven.
3. Neem voor vervolgwerk bridge-/native-eigenaarschap op en test de hele keten onder de gepinde componenten. Voeg optionele capabilities pas toe na een volledige, verse, trusted beschikbaarheidsadapter; TOPdesk vereist ook persoonlijke autorisatie.
4. De parent maakt de gecombineerde commit. Deze worktree blijft ongecommit; geen push, andere worktree of private runtime aangeraakt.
