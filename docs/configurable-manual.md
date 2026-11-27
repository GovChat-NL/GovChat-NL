# Configureerbare handleiding — backend- en frontendcontract

## Status en grens

Backend/content/agent én de gedeelde frontend en beheereditor zijn geïmplementeerd vanaf dev-commit 5b1e251. Chat, startpagina en Beleidskompas gebruiken dezelfde geauthenticeerde modal met zoeken, passagenavigatie, print, automatische voorkeuren en gevalideerde citaatbestemmingen. De editor gebruikt uitsluitend de private beheer-API, zonder inline contentbootstrap. Native footer/menu/mobiele toegang vereist de kleine opt-in buildoverride; zie [frontendbeheer en migratie](manual-frontend.md). De feature blijft standaard uit. Activeer pas na onafhankelijke security-/agentintegratiereview; er is niets uitgerold.

Standaard is de handleiding uit; automatisch openen staat afzonderlijk op nooit. Er worden geen LibreChat-productfuncties aan-/uitgezet. Limburg/LAICA is een afzonderlijk optioneel profiel. De opgegeven contacten en cursuslink zijn profieldata om vóór publicatie te controleren; geen beleidsgaranties. Er zijn geen vaste model-, kennisgrens-, privacy-, logging-, training-, retentie-, beschikbaarheids-, kosten- of CO₂-garanties opgenomen.

## Eén model en compiler

De compiler staat in [manual-model.js](../services/admin-overlay/admin/lib/manual-model.js). De generieke content staat in [manual.json](../overlay/defaults/manual.json); het profiel in [manual-limburg.json](../overlay/defaults/manual-limburg.json). Dezelfde twee bestanden bestaan in de admin-image-buildcontext: Compose vervangt die defaultsmap met de overlaydefaults. [build-manual-content.py](../scripts/build-manual-content.py) houdt beide kopieën gelijk. Geen runtimecontent wordt tijdens een restart door die defaults overschreven.

Modelvelden, met strikt toegestane namen en types:

| Veld | Contract |
|---|---|
| schemaVersion | 1; onafhankelijk van inhoudsrevisie |
| enabled | boolean, standaard false |
| agentEnabled | boolean, standaard true; alleen handleidingtool, effectief uit zolang handleiding uit is |
| autoOpen | never / first-use / new-revision / every-session; standaard never |
| profile | generic / limburg |
| title / subtitle / reviewedAt | tekst; controledatum wordt niet verzonnen, standaard leeg |
| organization | appName, name, helpdeskEmail, aiEmail, trainingEmail, privacyEmail, courseUrl, policyUrl, incidentUrl; tekst, mail/URL validatie; expliciet leeg blijft leeg |
| sections | geordende hoofdstukken, elk maximaal één niveau items/subsecties |
| errorCategories | geordende categorieën met id, title, optioneel parentId naar hoofdstuk/topic, articles |
| visibility | chapters/topics/categories/articles: kaarten van bestaand ID naar boolean; errors: boolean |

Een hoofdstuk, item of foutartikel heeft id, title, content, items, aliases, requires, rights, related, codes en messages. Ontbrekende lijsten worden leeg. Alleen hoofdstukken mogen items bevatten. IDs/aliases: 1–80 letters/cijfers/underscore/koppelteken, eerste teken alfanumeriek, globaal uniek. Aliases mogen geen ID overschrijven. related verwijst alleen naar bestaande IDs/aliases. Een verwijzing naar een later verborgen passage wordt bij gebruikers-/agentcompilatie verwijderd; de linktekst kan blijven, zonder bestemming.

Voorwaarden zijn expliciete allowlists, geen vrije evaluatie:

- capabilities: chat, history, upload, files, prompts, temporaryChat, sharedLinks, webSearch, fileSearch, models, beleidskompas, image, transcript, simplifier, nos_news, l1_news, holidays, time, calculator, openbesluitvorming, topdesk.
- rights: prompts.use, prompts.create, prompts.edit, prompts.share, prompts.sharePublic.
- Niet aangetoonde capabilities/rechten blijven afwezig. Voor OpenBesluitvorming/Topdesk/transcriptie is nog geen aanvullende vertrouwde beschikbaarheidsadapter toegevoegd; hun passages blijven daarom verborgen. Een launcherentry alleen bewijst geen werkende optionele backend; afbeeldingenuitleg vereist ook het bestaande IMAGE_JOBS_ENABLED.
- visibility false op een ouder kan nooit door true op een kind worden overruled. Het standaardfoutennaslagwerk erft ook van het hoofdstuk problemen. Een categorie kan expliciet aan een ander bestaand hoofdstuk/topic hangen.

HTML-allowlist: p, br, strong, em, b, i, ul, ol, li, h3, h4, blockquote, code, pre, a, hr. Geen afbeeldingen, scripts, SVG/MathML, formulieren, iframes, styles, eventhandlers of vrij te kiezen attributen. Links: http/https zonder credentials, beperkte mailto, relatieve same-origin paden (geen protocol-relative of backslashes), interne manual:ID-verwijzingen. Voor interne bronverwijzingen genereert uitsluitend de compiler de canonieke passage-/revisiebestemming. De tekstvariant wordt uit dezelfde gesanitiseerde HTML gemaakt; geen tweede losse agenttekst.

Hoofdletterplaceholders: APP_NAME, ORG_NAME, SUPPORT_EMAIL, AI_EMAIL, TRAINING_EMAIL, PRIVACY_EMAIL, COURSE_URL, POLICY_URL, INCIDENT_URL, tussen dubbele accolades. Ze worden als tekst geëscapet; onbekende hoofdletterplaceholders zijn ongeldig. Kleine-letterpromptvariabelen blijven letterlijk staan. Lege optionele contactvelden genereren geen ongeldige mailto-link. Configuratiegegevens worden nooit als JavaScript geëvalueerd.

Grenzen: maximaal 80 hoofdstukken, 100 items per hoofdstuk, 50 foutcategorieën, 700 artikelen per categorie, 1200 totale passages; inhoud maximaal 24.000 tekens per passage en 2 miljoen tekens totaal; titels 400, subtitel 1000. Validatie controleert de **hele** catalogus, niet alleen de zichtbare subset.

## Voorrang, bron en reset

Voorrang: generieke basis → gekozen profiel → eenmalig geïmporteerde deploymentdefaults → expliciet opgeslagen concept/publicatieoverrides. Deploymentdefaults worden privé vastgelegd, niet bij iedere restart opnieuw gelezen. Publicatie stelt een volledige effectieve versie samen; browser en agent krijgen geen overrides/concepten.

Beheer geeft zowel model (effectief concept) als overrides (expliciet ingevoerde velden) en sources (per top-levelveld, organisatieveld en zichtbaarheidsoverride) terug. De frontend moet **overrides** bewerken als profiel-/defaultovererving gewenst is. Een volledig model importeren is bewust een volledige override; een expliciet lege string of false valt niet terug op defaults. reset verwijdert alleen het genoemde overrideveld. Arrays zijn bewust een volledige geordende vervanging, geen onzichtbare ID-merge. Legacymigratie vormt een uitzondering: behoud bestaande hoofdstukken/items/IDs/aliases en voeg ontbrekende basisonderwerpen toe zodat verwijzingen blijven werken. Legacy-inhoud wordt uitsluitend als privaat concept geïmporteerd; beoordeel oude beleidsclaims vóór publicatie.

## Ingress en authenticatie

Browserbasis: /govchat-api/manual. De bestaande applicatieproxy herschrijft /govchat-api/ naar /api/. Geen directe adminpoort vanuit de browser gebruiken. Managementbasis: /api/admin/manual op de bestaande beveiligde managementingress (eventuele prefix door die ingress bepaald). Agentbasis: /api/internal/manual, uitsluitend interne serviceverbinding met server-bearer. De publieke proxy weigert de nieuwe admin-/interneroutes.

Gebruikersreads vereisen een **actueel LibreChat-access-token** in Authorization Bearer. De adapter controleert /api/user via de vaste interne LibreChat-origin, daarna /api/config, /api/roles/VERIFIED_ROLE en /api/files/config. Geen door de client aangeleverde rollen/capabilities, geen refresh-cookie-only authenticatie, geen auth-refresh omzeiling. De frontend gebruikt de bestaande LibreChat-authbootstrap/refreshflow en verstuurt het geldige access-token; een 401 vraagt heraanmelding, geen eigen fallbacklogin.

De gepinde files/config kan een lege 200-body teruggeven bij ontbrekende YAML-overrides: dat is de bekende uploaddefault. Expliciete disabled wordt gerespecteerd. Minimale UI onderdrukt onder meer tijdelijk chatten, delen, modelkeuze, native webzoeken en native bestandszoeken, maar houdt uploads/bestandsbeheer en prompts behouden. De backend ontvangt hetzelfde bestaande minimale-UI-instellingsveld. Promptrechten komen uit de geverifieerde rol; bewerkingsuitleg is geen toekenning van eigenaarschap aan een concrete prompt. De product-API blijft eigenaar-/resourcerechten controleren.

Bij ontbrekende effectieve context blijft alleen de veilige algemene subset: chat/geschiedenis en vertrouwd ingeschakelde utilitytools. In minimale mode is upload/bestandsbeheer algemeen aangetoond door de bestaande minimale-UI-transformatie. Agentreads gebruiken diezelfde algemene subset, **niet** toolargumenten met gebruiker/rollen. Promptonderwerpen met gebruiks-/deelrechten komen dus niet automatisch bij de agent terecht. Volledige agentspecifieke gebruikersrechten vereisen later een vertrouwde contextadapter; niet de toolinputs uitbreiden met vrij aangeleverde rechten.

Beheer gebruikt de bestaande adminsessie, JSON-contenttype en origin/Sec-Fetch-Site-bescherming. TLS-origins worden tegen PUBLIC_BASE_URL gecontroleerd; bij ontbreken daarvan tegen request-origin/Host. Afwezige Origin is toegestaan voor niet-browserbeheer op de vertrouwde managementingress. Alle reads en beheerantwoorden zijn private, no-store, Vary Authorization/Cookie. Foutantwoorden zijn generiek genoeg om geen interne bestanden of exceptiondetails uit te lekken.

## Browser-API

| Methode / pad na basis | Antwoord |
|---|---|
| GET /config | ok, schemaVersion, enabled, revision, autoOpen, agentEnabled; **alleen dit is openbaar**; geen titel, profiel, contacts, passages of private status |
| GET /toc | ok, revision, title, subtitle, autoOpen, reviewedAt, sections, errorCategories; gefilterde geordende titels/IDs, category parentId |
| GET /search?query=…&limit=…&revision=… | ok, revision, results: id/title/snippet/href, total; query 1–200 tekens, limit 1–50 (default 20) |
| GET /get?id=…&revision=… | ok, revision, passage; alias wordt naar canonical ID opgelost |
| GET /document | ok, schemaVersion, revision, enabled, autoOpen, title, subtitle, reviewedAt, sections, errorCategories, passages; volledige toegestane versie voor lezen/print |

Passage: id, title, html, text, kind (chapters/topics/articles), parentId, aliases, codes, messages, requires, rights, related (id/href), href. Geen verborgen passage, alias, code of inhoud in resultaten. De interne metadata voor vereisten is geen autorisatie-invoer; frontend kan daarmee geen verborgen passage vrijgeven.

Canonieke href: /c/new?manual=ID&manualRevision=REV. Alleen concrete **passages** hebben zo’n bestemming. Categorieën navigeren via de toc; ze zijn geen los passageantwoord. De fallback is /c/new?manual=toc.

Frontendvalidatie voor chatcitaten/deep-links:

1. Parse uitsluitend same-origin relatieve /c/new-bestemmingen met exact manual en manualRevision; geen willekeurige URL of ID accepteren.
2. Gebruik /get met ID en revisie onder het **huidige** ingelogde gebruikerscontext. Render/activeer pas een handleidingcitaat wanneer die read geldig is; geen link afleiden uit vrije modeltekst.
3. Bij 409 REVISION_CHANGED: actuele toc/document laden en duidelijke melding; oud citaat niet stilzwijgend aan gewijzigde tekst koppelen. Bij 404 PASSAGE_NOT_FOUND of MANUAL_DISABLED: duidelijke fallback; nooit verborgen inhoud openen. Bij 503: bestaande chat blijft bruikbaar.
4. Een gevalideerde passageklik opent/navigereert een reeds geopende gedeelde modal zonder het gesprek te vervangen. Niet standaard naar /c/new navigeren wanneer de modal de passage in de huidige chat kan openen.
5. Ordinary externe bronlinks blijven gewone links. Chattekst niet als HTML uitvoeren. Titel, snippet en foutmelding als tekst renderen; alleen html uit het geauthenticeerde compilerantwoord kan als gesanitiseerde inhoud worden ingevoegd.
6. Nieuwe auth-/configbootstrap uitvoeren na publicatie/routegebruik/nieuwe sessie; geen langdurig publiek cachebestand als activatieautoriteit gebruiken. Feature uit/onbereikbaar betekent geen automatische opening en geen stale handleidinglink.

De automatische voorkeuren zelf zijn frontendwerk. Gebruik inhoudsrevision, niet applicatieversie. first-use/new-revision/every-session apart behandelen; manual passageclick heeft voorrang. Opslagweigering moet veilig geen herhaalde popup veroorzaken. Geen beleidsacceptatie suggereren. /document is de toegestane volledige printbron.

## Beheer-API

GET basis: ok, model, overrides, sources, profileReview (Limburg-reviewonderwerpen en waarschuwing; geen bewijs dat review is uitgevoerd), baseRevision, draftRevision, source, hardDisabled, blocked, effective metadata, history (laatste maximaal tien eerdere publicaties met revision/publishedAt/source; geen inhoud publiek).

Alle mutaties behalve preview bevatten baseRevision én draftRevision uit het meest recent gelezen beheerantwoord. De nieuwe response bevat nieuwe revisies. Bij 409 moet de editor herladen/vergelijken, niet blind herhalen. Conceptrevisie en gepubliceerde inhoudsrevisie zijn afzonderlijk. Publicatie/rollback krijgen altijd een nieuwe inhoudsrevisie, ook bij identieke tekst; oude citaten worden niet hergebruikt.

| Methode / subpad | Body / werking |
|---|---|
| PUT /draft | model (expliciete overrides), baseRevision, draftRevision; valideert en bewaart concept, publiceert niet |
| POST /import | model (nieuw model of legacy), beide revisies; dezelfde conceptvalidatie |
| GET /export | ok, model: effectief concept; private export, geen automatisch live publiceren |
| POST /preview | model; samengestelde veilige preview, preview:true; passages bevatten hiddenReasons; uitsluitend beheer; expliciet verborgen preview geen live bewijs |
| POST /reset | path en beide revisies; top-levelveld, organization.FIELD of visibility.GROUP.ID / visibility.errors; verwijdert alleen de betreffende override |
| POST /publish | beide revisies; expliciet publiceren |
| POST /rollback | revision van historie plus beide actuele revisies; atomair nieuwe publicatie van historisch effectief model |
| POST /disable | beide revisies; één vergrendelde publicatie van live versie met enabled:false; niet een ander concept publiceren |

De frontendeditor toont profiel-/broninformatie, locks, lege overrides en conflicten. Preview toont verborgen redenen zoals manual-disabled, deployment-disabled, chapters-hidden, topics-hidden, errors-hidden, category-hidden, capability:… en right:…. Preview is nooit een gebruikers-/agentbron. De tijdelijke inline legacybootstrap is vervangen door geauthenticeerde fetch en expliciet toegestane editorassets; backendmodel/store/API-contracten zijn niet gewijzigd.

Statuscodes: 400 INVALID_MANUAL/INVALID_INPUT/INVALID_JSON, 401 UNAUTHORIZED, 403 CROSS_ORIGIN/TOOL_DISABLED, 404 MANUAL_DISABLED/PASSAGE_NOT_FOUND, 409 REVISION_CONFLICT/REVISION_CHANGED, 413 INPUT_TOO_LARGE, 415 JSON_REQUIRED, 503 MANUAL_UNAVAILABLE/PUBLISH_FAILED/AUTH_NOT_CONFIGURED. Foutvorm: ok:false, error:{code,message}, fallback. Parserfouten kunnen geen fallback hebben. Geen BadRequest automatisch als contentfilter vertalen.

## Opslag, failure en recovery

Privaat: DATA_DIR/manual/state.json, mode 0600 in map 0700. Eén atomair fsync/rename-document bevat live effectieve versie plus dezelfde veilige HTML/tekst/applicabilitycompilatie, concept, overrides/deploymentdefaults en begrensde historie. Lezen compileert de actuele live versie onder de vertrouwde context; niet een apart oud agentbestand. Schrijvers delen een filesystem-lock, dus CLI en server kunnen niet ongezien door elkaar schrijven. Symlinkpaden voor opslag/import worden geweigerd; publicatie-/privémappen moeten gescheiden zijn. Private staat niet via nginx/static aanbieden.

Alleen PUBLISH_DIR/manual-config.json (strikt beperkte metadata, mode 0644) is openbaar. Oude help-content-assets worden verwijderd; nginx geeft voor oude inhoudsbestemmingen 410, ook als een ouder volume nog HTML bevat. De oude /api/config/help-content GET/POST zijn 410. Public assets die eerder gecachet zijn kunnen niet achteraf uit een browser worden gewist: de frontend moet de nieuwe read/configcontracten gebruiken. Geen organisatie-informatie in een publiek contentbestand publiceren.

Voor publicatie/disable wordt een privaat blocked.json vastgelegd vóór de risicovolle write. I/O-falen geeft 503, blokkeert de backend/agent en invalideert metadata; geen misleidende succes-save. Een schemafout verandert live niet. Een geslaagde nieuwe publicatie wist het fail-closed block. Bij crash kan het blok of de write-lock blijven staan: onderhoudsprocedure is schrijvers stoppen, privéback-up veiligstellen, lock-eigenaarschap controleren, **niet zomaar een actieve lock verwijderen**, en pas expliciet opnieuw publiceren. Corrupt privébestand vereist herstel van een geverifieerde privéback-up, niet een onzichtbare defaultreset. Als de filesystem zelf geen block/removal kan opslaan, blijft de draaiende backend lokaal geblokkeerd; blijvende filesystemfouten vereisen operatorherstel. Geen systeem kan een onschrijfbare storage duurzaam bijwerken.

## Bestands-/scriptbeheer en deployment

Geen admin-UI nodig om content te beheren: [govchat-manual.js](../scripts/govchat-manual.js) gebruikt dezelfde store/compiler. Node 20+ en de bestaande gelockte admindependencies (htmlparser2) nodig. Eén expliciet import-/exportbestand; geen directoryscans of willekeurige agentpaden. DATA_DIR/PUBLISH_DIR of expliciete argumenten wijzen op **dezelfde** deploymentopslag. Exports mode 0600; scriptstate/output kan interne content bevatten, niet in CI/public logs opslaan.

Acties: validate, migrate, import, export, state, publish, rollback, disable. Argumenten: --file, --data-dir, --publish-dir, --revision, --dry-run. validate vereist --file en wijzigt niets; migrate geeft het veilige gemigreerde model op stdout; import bewaart concept; publish publiceert expliciet. Export overschrijft geen bestaand pad. Dry-run schrijft niets; publish/rollback/disable dry-run vereisen bestaande staat en beoordelen dezelfde doelversie als de publicatie (concept/historie/live-disable). CLI leest actuele revisies en gebruikt dezelfde conflictdetectie onder lock. Import gevolgd door publicatie is bewust twee aparte beslissingen.

Compose geeft GOVCHAT_MANUAL_HARD_DISABLED (false standaard), GOVCHAT_MANUAL_CONFIG_FILE (leeg standaard), bestaande GOVCHAT_MINIMAL_UI en vaste LIBRECHAT_INTERNAL_URL door. GOVCHAT_MANUAL_CONFIG_FILE is één expliciet **containerpad** voor een eerste privéconcept/deploymentdefaultimport; mount precies dat configuratiebestand via een eigen beveiligde deploymentoverride. Restarts lezen een bestaand model niet opnieuw uit het bestand. Gebruik daarna CLI of API. Hard disable is een bovengrens, zichtbaar in beheer en kan daar niet overruled worden; de CLI moet dezelfde deploymentomgeving gebruiken.

De backendservice blijft het bestaande opt-in admin-overlay-profiel. File-only betekent beheer via bestand/script zonder admin-editor; **niet** interne content als publieke statische handleiding. Authenticated browsercontent en de agenttool vereisen een beschikbare backend. Alleen metadata kan zonder backend worden uitgegeven; een ontbrekende backend geeft veilige onbeschikbaarheid, geen openbare/private fallback. Er is bewust geen nieuw publiek-inhoudsdeploymentmode.

## Agent

[orchestrator-manual-workflow.js](../scripts/orchestrator-manual-workflow.js) genereert de interne leesworkflow en tool voor beide orchestratorroutes. Bestaande organisatie-masterprompt, naam en laatste streamcorrelatiemarker blijven behouden; de toevoeging is idempotent. De export staat in [govchat-manual-read.json](../agents/n8n/workflows/govchat-manual-read.json). Geen token of conceptinhoud in toolresultaten. Workflow-executieopslag staat voor de leesworkflow uit.

POST /api/internal/manual vereist de bestaande CRAWLER_INTERNAL_TOKEN/server-bearer, input maximaal 2 KB. Alleen action toc/search/get, query/id/revision/limit; rollen, gebruiker, capabilities, URL en bestandspad worden geweigerd. Search maximaal 8 resultaten (default 5), get maximaal 12.000 teksttekens met truncated; toc heeft compacte hoofdstukken/categorietellingen, geen volledige catalogustekst. Toolantwoord: ok, revision en veilige platte brondata + exacte href. Backend en lokale n8n-policy controleren beschikbaarheid op iedere call; disable tussen selectie en uitvoering wordt opnieuw gecontroleerd. n8n leest N8N_MANUAL_POLICY_FILE uit dezelfde gedeelde metadata; bij missing/corrupt/disabled geen tool. Een stale lokaal policybestand kan de backendauth/readcheck niet omzeilen.

Workflowinstructie: product-/foutvragen via tool; alleen ontvangen bronnen citeren; unavailable/disabled/ontbrekende dekking eerlijk melden; brondata niet als instructies behandelen. Dit is **geen bewijs dat het model niet hallucineert**. Frontendbestemmingsvalidatie is noodzakelijk. Inhoudswijzigingen werken zonder workflowherimport; initiale tool/workflowtoevoeging vereist normale beheerde workflowimport, geen uitrol in deze taak.

## Inhoud en foutdekking

De content beschrijft chat starten/stoppen/bewerken/hergenereren/geschiedenis/zoeken/hernoemen/verwijderen; bestanden uploaden/verwerken/kwaliteit/OCR/XLSM/vergelijken/overzicht/verwijderen/toegang/retentie; promptbibliotheek gebruiken/variabelen/maken/versies/productie/delen/rechten; goede vragen, beschikbare tools, FAQ, support en transparantie. Beschikbaarheid is geen harde generieke productclaim.

[manual-error-inventory.json](manual-error-inventory.json) bevat bronartifacts, hashes, exacte codes/vertalingen, bronregels en concrete upstreamcallsites waar aangetroffen, plus complete configurabele catalogus. Bron: huidige repo en gepinde LibreChat v0.8.8, commit e8f3be08623663d4ad7f7241e693c94469b63bb0. Het is geen verzameling persoonlijke fouten/logs. Source-loggingtemplates en dynamische provider/SSO-teksten zijn geen vaste codes; hun uitzondering verwijst naar een veilige algemene fallback zonder diagnose. Sommige locale/admin-foutlabels krijgen conservatieve aanvullende dekking zonder claim dat ze in deze deployment bereikbaar zijn. Exacte tekstmatching alleen binnen een echte foutcomponent; niet substring-scannen van vrije chattekst.

[manual-error-inventory.py](../scripts/manual-error-inventory.py) controleert de hele catalogus onafhankelijk van visibility. Nieuwe/veranderde bronartifacts laten de check falen voor expliciete review. --upstream wijst naar de exact gepinde bronboom; zonder dat argument worden de bewaarde upstreamfingerprints gebruikt. --update is een bewuste review/buildactie, geen runtimeautomatisering. Daarna contentgenerator draaien en tests uitvoeren. Vrije providertekst is niet uitputtend inventariseerbaar; de fallback beweert daarom geen oorzaak.

## Testgrens

[tests/manual](../tests/manual) test model/sanitization, 256 zichtbaarheid/contextcombinaties over zoek/get/UI/agent, ouders, defaults/profiel/lege waarden, migratie, source/reset, revisionconflicten, storageprivacy, symlinks, publicatiefalen, restart, rollback, CLI, echte lokale HTTP-auth/API en toolselectie/invocationdisable. Gepinde upstream UI-/errorbronnen zijn onderzocht. Bestaande minimale-UI-, footer-, toolstream-, prompt-/naam-, documentcontext-, utilityserver- en configuratietests worden apart gerapporteerd in de overdracht.

De historische backendtaak bevatte nog geen browseracceptatie. De frontendvervolgtaak bevat echte geïsoleerde Playwright-tests voor modal/editor, zichtbaarheid, voorkeuren, print-DOM, focus/inert, citaatklik en appintegratie, plus een geslaagde volledige native-clientcompilatie. Zie [browserbewijs](../tests/manual/evidence/README.md) en [native/regressieresultaten](manual-native-build-validation.md). Live Entra/SSO, echte LLM-product-/foutvragen, schermlezerhardware, OS-printer/PDF-uitvoer en browseracceptatie van de volledige ingelogde native client blijven niet uitgevoerd. Geen deployments veranderd, geen push/PR gemaakt.
