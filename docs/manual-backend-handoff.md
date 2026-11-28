# Overdracht backend/content/agent — configureerbare handleiding

> Historische overdracht van backendcommit 6e1417996d69071aeab20dbfb0cfe804e04abb3f, aangevuld met de actuele veilige staat na de drie siblingreviews en cross-review op basis b87a6c7. Frontend/editor en volledige native browseracceptatie met synthetische auth zijn inmiddels geleverd. De historische testresultaten hieronder worden niet bij het huidige gecombineerde bewijs opgeteld; dat staat in [manual-final-review.md](manual-final-review.md). Volledige vertrouwde agentgebruikerscontext blijft expliciet niet geaccepteerd.

Branch: feat/configurable-user-manual. Basis: origin/dev 5b1e2517e1bfad83fb8caf3f9b03911717c68f47. Geen push, PR, deploymentwijzigingen, andere worktrees of private runtimebestanden. Tijdelijke Node/upstream/testafhankelijkheden staan uitsluitend in de genegeerde werkmap van deze worktree. Geen manifest-/dependenciewijzigingen nodig.

Het exacte model, alle endpoints, body-/responsevormen, foutcodes, filtering, frontendrevisie-/citaatvalidatie, authbootstrap, adminoverrides/reset en script-/deployprocedure staan in [configurable-manual.md](configurable-manual.md).

## Geïmplementeerd

- Default off, apart automatisch-openenbeleid, generic/Limburg-profiel; expliciete lege/false overrides en private eenmalige deploymentdefaultimport met veldbronnen/reset.
- Eén allowlisted compiler voor veilige HTML en tekst; stabiele IDs/aliases; hoofdstuk/topic/foutencategorie/artikelovererving, inclusief foutenouder, capabilities en vertrouwde promptrechten.
- Authenticated gebruikersreads via LibreChat-user/config/role/fileconfig; geen refresh-cookie-only auth of toolrollen. Alleen beperkte activatiemetadata openbaar; oude raw-helpcontent geblokkeerd.
- Private atomische state/publicatie, draft/live-revisieconflicten, maximaal tien eerdere publicaties (ook begrensd op opslagbudget), rollback, lock en symlinkbescherming, fail-closed publish/disable.
- Beheer-API en CLI via dezelfde store; imports via één expliciet pad; restarts overschrijven geen publicatie/concept.
- 12 hoofdstukken, 53 topics; generiek Nederlands plus configureerbare Limburg-contacten/cursus. Geen onbevestigde beleids-/privacy-/modelgaranties.
- Actuele beheerde catalogus: 692 configureerbare artikelen, 466 gewone en 226 standaard verborgen bijlageartikelen; 851 bronvermeldingen in 263 artifacts. Alle 684 oorspronkelijke IDs behouden. De historische basis bevatte feitelijk 839 bronvermeldingen in 257 artifacts, niet de eerder genoemde 837. Exacte upstreamcommit en concrete callsites waar aangetroffen; dynamische/overconservatieve dekking en uitzonderingen expliciet. Visibility beïnvloedt coverage niet.
- Interne bounded manualtool/workflow voor beide agentroutes, actuele published revisie, veilige tekst/href, policycontrole bij selectie én uitvoering; behoud masterprompt/naam/streammarker.

## Historisch uitgevoerde backendtests (geen actuele gecombineerde telling)

- Gerichte brede Node-suite: 113 tests, 112 geslaagd, 0 fouten, 1 bestaande skip. Inclusief handleiding, prompt-/naambeheer en routes/editorcontracts, utilityserver/tools, minimale UI, native footer, branding, documentcontext en toolstreamcorrelatie. Lokale tijdelijke Node 22; gepinde upstreambron v0.8.8.
- Nieuwe handleidingtests: sanitization/XSS/URLs/placeholders, strict types/IDs/aliases, 256 flags/contextcombinaties op UI/search/get/agent, foutouder, migratie, configprecedence/reset, privacy, lock/symlink, I/O-falen, restart, rollback, CLI en echte lokale HTTP-auth/revisies/disable.
- Geïsoleerde gepinde n8n 2.25.7: 7/7 tests, inclusief echte calculator supply/execute-policy en manualtool select/invocation/streamregels. Geen netwerk, readonly bronmounts, alleen huidige overlaymounts.
- Geïsoleerde officiële LibreChat v0.8.8: 17/17 native SSO-header-/auth-, uploadfallbackguard-, runtimeconfig/retentie- en footercontracttests. Geen netwerk; geforceerde suite-exit wegens open native handles; tijdelijke containerwerkmap voor testlogging.
- Python/Compose/static-security/runner: 63 tests, 0 fouten, 13 expliciet overgeslagen proxytests in de statische run. De bestaande proxyintegraties zijn afzonderlijk uitgevoerd: alle proxytests groen; de twee nieuwe private-manual-/optionele-Compose-contracttests opnieuw expliciet groen na correctie van testprofielselectie. Alleen tijdelijke interne testnetwerken/services, bestaande deployments niet aangepast.
- Error coverage met echte gepinde upstreamboom: groen. Diff-whitespacecheck: groen. Geen browser-/live-agentacceptatie geclaimd.

## Actuele veilige staat en resterende blockers

- Helpmodal, helpknoppen, mobiele/footer-/startpagina-integratie, automatische voorkeuren, print, contextuele foutlinks, frontendcitaatvalidatie en private admineditor zijn geïmplementeerd en geïsoleerd getest; ook de volledige native client is in Chromium getest. Formele WCAG-/schermlezerhardwarecertificering is niet geleverd. Oude editor-save blijft 410.
- Frontend bewerkt expliciete overrides, bewaart beide revisies, behoudt lokale edits bij conflicten, valideert actuele passagebestemmingen en gebruikt LibreChat-access-tokenbootstrap. Safe-state/publicatie-locks en blokkermarkers gelden ook voor andere processen en herstarts; bij markerwrite-falen blijft de lock behouden en wordt oude activatiemetadata verwijderd waar mogelijk. Geen auto-unlock/defaultreset; operatorherstel blijft nodig. Eerder ontvangen inhoud kan niet worden teruggeroepen.
- De gedeelde adminsessie heeft nu een geteste vaste server-side levensduur van 24 uur, gelijk aan de cookie; geen wijziging aan LibreChat-/Entra-/bridge-auth. Exacte volledige foutcodes/meldingen winnen bij zoeken; templates niet, betekenisvolle topics daarna, filtering altijd vooraf.
- **Volledige agentspecifieke gebruikerscontext blijft geblokkeerd:** de vertrouwde LibreChat → bridge → n8n → backendketen is niet aangetoond. Alleen veilige algemene agentcontext; geen upload-/bestands- of persoonlijke promptrechten uit minimale UI/toolinputs. Eventuele publieke voorwaardelijke promptbibliotheekuitleg is geen beschermde passage, citaat of rechtentoekenning. De drie aanvullende adapters voor OpenBesluitvorming, TOPdesk en transcriptie zijn niet geverifieerd; hun passages blijven verborgen. Launcherentries/losse featurebooleans zijn geen beschikbaarheidsbewijs.
- File-only is scriptbeheer zonder admineditor, niet openbare statische organisatie-inhoud. Authenticated lezen en agenttoegang vereisen de opt-in backend. Eerste workflow/toolinstallatie vereist normale beheerde import; inhoudsrevisies daarna geen workflowherimport.
- Geen live SSO/LLM-/agentvraag of productiedeployment getest. Browserklik, focus/inert en reflow zijn wel met synthetische fixtures en echte native build getest. Hallucinatiepreventie door prompt alleen wordt niet beweerd; frontendvalidatie blijft vereist.
- Catalogus combineert concrete fouttypen met conservatieve locale/adminlabels. Niet ieder geïnventariseerd type wordt in elke deployment bereikbaar; dynamische provider-/SSO-tekst is niet uitputtend te inventariseren. Exclusions en fallback zijn expliciet, zonder verzonnen diagnose.
- De gecombineerde eindreview geeft uitsluitend gedeeltelijke acceptatie van de veilige fallback, geen activatiegoedkeuring voor het volledige gebruikerscontextvereiste. Parent moet de definitieve worktree-/branch-/basisguard en eigen diffcontrole uitvoeren en pas daarna een expliciet geautoriseerde commit/releasebeslissing nemen. Deze cross-review doet geen commit/push/deployment.

## Gewijzigde bestanden

Configuratie/integratie:
- [.env.example](../.env.example)
- [.gitignore](../.gitignore)
- [docker-compose.yml](../docker-compose.yml)
- [nginx/librechat-overlay.conf](../nginx/librechat-overlay.conf)
- [server.js](../services/admin-overlay/admin/server.js)

Gedeelde backend:
- [manual-model.js](../services/admin-overlay/admin/lib/manual-model.js)
- [manual-store.js](../services/admin-overlay/admin/lib/manual-store.js)
- [manual-context.js](../services/admin-overlay/admin/lib/manual-context.js)
- [manual-routes.js](../services/admin-overlay/admin/lib/manual-routes.js)

Content/defaults:
- [overlay manual.json](../overlay/defaults/manual.json)
- [overlay manual-limburg.json](../overlay/defaults/manual-limburg.json)
- [overlay help-content.json](../overlay/defaults/help-content.json) (lege compatibiliteitsinhoud, geen openbare organisatieclaims)
- [admin manual.json](../services/admin-overlay/admin/defaults/manual.json)
- [admin manual-limburg.json](../services/admin-overlay/admin/defaults/manual-limburg.json)
- [admin help-content.json](../services/admin-overlay/admin/defaults/help-content.json) (zelfde veilige legacygrens)

Beheer/build/agent:
- [govchat-manual.js](../scripts/govchat-manual.js)
- [build-manual-content.py](../scripts/build-manual-content.py)
- [manual-error-inventory.py](../scripts/manual-error-inventory.py)
- [orchestrator-manual-workflow.js](../scripts/orchestrator-manual-workflow.js)
- [n8n-orchestrator-tool-policy.js](../scripts/n8n-orchestrator-tool-policy.js)
- [update-orchestrator-workflow.js](../scripts/update-orchestrator-workflow.js)
- [run_regressions.py](../scripts/run_regressions.py)
- [govchat-manual-read.json](../agents/n8n/workflows/govchat-manual-read.json)
- [orchestrator-litellm.json](../agents/n8n/workflows/algemeen/orchestrator-litellm.json) (scoped toevoeging, geen workflowreset)

Tests/docs:
- [fixture.js](../tests/manual/fixture.js)
- [model.test.js](../tests/manual/model.test.js)
- [store.test.js](../tests/manual/store.test.js)
- [routes.test.js](../tests/manual/routes.test.js)
- [workflow.test.js](../tests/manual/workflow.test.js)
- [utility-server.test.js](../tests/orchestrator/utility-server.test.js)
- [test_deployment_configuration.py](../tests/test_deployment_configuration.py)
- [configurable-manual.md](configurable-manual.md)
- [manual-error-inventory.json](manual-error-inventory.json)
- [manual-backend-handoff.md](manual-backend-handoff.md)

Niet gewijzigd **in de oorspronkelijke backendcommit**: gedeelde helpfrontend, overlayintegratie, start/appfrontend, modal-CSS en admineditorimplementatie. De frontendvervolgcommit wijzigt deze wel; zie de actuele frontenddocumentatie.
