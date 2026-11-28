# Configureerbare handleiding — frontend, beheer en migratie

## Oplevering en grenzen

De configureerbare handleiding heeft een bruikbare Nederlandse gebruikersinterface én beheereditor. De feature blijft standaard **uit** en automatisch openen standaard **nooit**. Inhoud en agenttool gebruiken het backendcontract in [configurable-manual.md](configurable-manual.md). De [frontend/native-review](manual-frontend-review.md) en [gecombineerde cross-review](manual-final-review.md) leveren geïsoleerd bewijs voor de actuele veilige staat. **Geen volledige acceptatie of activatiegoedkeuring:** de vertrouwde agentgebruikerscontextketen is niet aangetoond en de drie optionele beschikbaarheidsadapters zijn niet geverifieerd. Er zijn geen deploymentwijzigingen, commit, push of PR uitgevoerd. Parent bewaakt de uiteindelijke worktreeguard/commit; productie-installatie/authenticatie blijft afzonderlijke acceptatie.

De [gedeelde modal](../overlay/src/shared/help.js) gebruikt afzonderlijke [API-/citaatvalidatie](../overlay/src/shared/manual-client.js), [voorkeuren](../overlay/src/shared/manual-preferences.js), [veilige DOM-rendering](../overlay/src/shared/manual-render.js), [stijl](../overlay/src/shared/manual.css) en [native/contextadapter](../overlay/src/shared/manual-entrypoints.js). Chat, startpagina en Beleidskompas openen dezelfde implementatie, niet afzonderlijke kopieën.

Gebruikers zien een ruime modal met compacte inhoudsopgave, foutcategorieën, serverzoekresultaten met snippets, artikelpaneel, vorige/volgende passage, mobiel inhoudsmenu, desktop schermvullende weergave, Print/PDF en automatische voorkeur. Op kleine of door zoom verkleinde schermen blijven controls en tekst bereikbaar door reflow/scroll. Focus blijft in de dialoog; sluiten, Escape en backdropklik herstellen focus, de eerdere scroll-lock en bestaande inertwaarden. Een uitsluitend tijdens de geopende modal actieve child-list-observer maakt nieuw gemonteerde achtergrondroots inert; die observeert geen chattekst en doet geen netwerkreads/polling.

Alleen metadata is openbaar. Inhoud komt uit actuele geauthenticeerde reads via de bestaande gedeelde LibreChat-refresh/bearerflow. Een nieuwe login/appbootstrap vernieuwt de token en verifieert gebruiker plus applicatieconfiguratie. Geen private defaults, oude helpassets, adminpreview of modeltekstfallback wordt gerenderd. API-reads en bootstrap hebben een deadline; fouten verstoren de chat niet.

## Native footer, menu en mobiel: expliciete buildstap

De gepinde LibreChat-footer heeft geen voldoende stabiel publiek help-slot. Daarom voegt [patch-manual-native.js](../scripts/patch-manual-native.js) alleen een kleine activatiehook, footer-/mobiele slots, menu-event en markers op echte native foutcomponenten toe. Exacte bronfingerprints worden vóór schrijven gecontroleerd; herhaalde toepassing verandert geen bytes. Disclaimer-Markdown, expliciet lege disclaimer en juridische links blijven upstream. Geen disclaimerteksten worden door de overlay gekopieerd, vertaald of substring-gematcht. De oude zwevende helpknop wordt niet meer aangemaakt.

Gebruik bij een toekomstige beheerde deployment de bestaande no-fork buildwijze met [docker-compose.manual-native-build.yml](../docker-compose.manual-native-build.yml) en [manual-native.Dockerfile](../scripts/manual-native.Dockerfile):

```sh
docker compose -f docker-compose.yml -f docker-compose.manual-native-build.yml build librechat
```

Selecteer daarna dezelfde override binnen de normale, afzonderlijk beoordeelde deploymentprocedure. Deze taak start of herconfigureert die deployment niet. De Dockerfile-specifieke ignore-file beperkt de buildcontext tot de patch/buildrecipe. Op een host zonder buildx kan de beperkte tarcontext uit [native-entrypointhandoff](manual-entrypoints-handoff.md) worden gebruikt. Pinned bronwijzigingen laten de build bewust falen voor review.

De volledige gepatchte productieclient **is gecompileerd** met de officiële gelockte dependencies. De [onafhankelijke eindreview](manual-frontend-review.md) valideert ook de daadwerkelijke volledige client in Chromium met synthetische API/auth en de echte overlay-route-loop, niet alleen markers. De native patch reserveert bij activatie een mobiel helpvak zodat de composer de control niet bedekt. Een volledige nieuwe image-export of deployment is niet uitgevoerd. Zonder deze override zijn de nieuwe native desktop-/mobiele slots en native foutmarkers niet aanwezig. Start/Beleidskompas en de overlayfallback voor het bestaande Help & FAQ-menu blijven bruikbaar; dit is niet de aanbevolen complete native integratie.

De bestaande route-loop synchroniseert slots herhaalveilig, zonder tweede brede observer/polling. Uitschakelen/logout verwijdert uitsluitend eigen helpcontrols. Help & FAQ opent de modal wanneer actief en behoudt de externe FAQ-fallback wanneer uitgeschakeld. Native mobile krijgt een gelabelde helpcontrol omdat de upstream desktopfooter klein verborgen is.

## Bestemmingen, fouten en actuele toegang

Alleen de exacte relatieve compilervorm `/c/new?manual=ID&manualRevision=REV` wordt onderschept. Extra/omgekeerde parameters, fragments, alternate/encoded paden en externe bronnen blijven gewone links. De expliciete fallback `/c/new?manual=toc` opent alleen de inhoudsopgave. Iedere passageklik haalt `/get` op onder de huidige bearercontext én aangehaalde revisie voordat HTML getoond wordt. Geen vrije modelstrings worden naar een bestemming omgezet.

Een reeds geopende modal navigeert binnen hetzelfde venster; het huidige gesprek, de composer en de chathistory worden niet vervangen. Vorige/volgende handleidingpassage is interne, begrensde navigatie, los van de browser-/chathistory. Een verouderde, verborgen of onbekende passage toont uitleg en een expliciete actuele-inhoudsopgaveactie. Die actie opent nooit stilzwijgend de gewijzigde passage. Alleen de toegestane compiler-HTML wordt door een tweede inert DOM-allowlist gekopieerd; titels, snippets en status zijn tekstnodes.

Op openen, echte routewisseling en windowfocus worden activatie/revisie opnieuw gecontroleerd; requests worden samengevoegd en routechecks begrensd. Revisie/disable wist oude tekst, navigatie en eventuele print-DOM. Op route/focus wordt een geopende passage opnieuw onder actuele toegang gevalideerd. Contextindexes worden per readlifecycle opnieuw opgebouwd. Geen permanente contentcache in browseropslag of publieke assets.

Contextuele hulp matcht alleen exacte toegestane codes/messages/aliases in gemarkeerde daadwerkelijke foutcomponenten. De native failed-turn/provider, agent, prompt en auth-errorcomponenten zijn brongetest; authroutes blijven zonder geauthenticeerde inhoud. Beleidskompas markeert uitsluitend door een catch-pad aangemaakte chat-/feedbackfouten. Normale gegenereerde antwoorden worden niet gescand. Onbekende of ambigue fouten krijgen alleen de algemene probleempassage als deze toegestaan is. De bestemming wordt vervolgens weer via `/get` gevalideerd. Niet ieder toast-/extern appfoutvlak heeft een marker; de algemene manualingang blijft daarvoor beschikbaar.

Print leest `/document` opnieuw en bouwt alle actuele toegestane hoofdstukken, topics, categorieën en artikelen met veilige DOM-invoeging. Geen ontsnapte titel/stringinjectie, verborgen defaults of alleen-het-actieve-artikelprint. Browserprint ondersteunt PDF via de gewone browserfunctie. OS-printer/PDF-uitvoer is niet getest; print-DOM en printmedia wel.

## Automatische voorkeuren

Vier beleidsopties: nooit, eerste gebruik, nieuwe inhoudsrevisie en iedere browsersessie. Bij **nooit** is de voorkeurenfooter volledig verborgen; bij actieve automatische opening blijft deze compact (57 px op de geteste mobiele viewport). Opt-out vervangt de checkbox door een korte status en **Opnieuw toestaan**. Een automatische opening vereist succesvolle token-/gebruiker-/configbootstrap, actieve metadata en een geauthenticeerde toegestane TOC-preflight. Ze wordt niet boven een andere dialoog/alertdialoog of op een authroute getoond en wacht/pollt daar niet op. Handmatig openen/citaatklik wint. Een browsersessie opent hoogstens één keer, ook over volledige chat → start → appnavigaties; revisie is niet de applicatieversie.

Voorkeuren bewaren alleen `seen`, inhoudsrevision en opt-out, onder een SHA-256-digest van origin plus vertrouwd geverifieerd gebruikers-ID. Geen token, e-mail, titel, contact, gesprek of passage wordt opgeslagen. Zowel lokale als sessieopslag wordt getest. Denied/ontbrekende/corrupte opslag betekent veilig **geen automatische opening**, ook bij nieuwe paginalading; handmatige toegang blijft mogelijk. Alle sluitacties hebben dezelfde voorkeursemantiek. Herstellen heft opt-out op, maar opent niet meteen opnieuw en suggereert geen beleidsacceptatie.

De huidige beperkte backendreads geven geen betrouwbaar profiel-/installation-ID aan de browser. Daarom is voorkeurenscheiding origin/account, niet een extra profielscope. Een profielwisseling deelt eerste-gebruik/opt-out met dezelfde account; nieuwe-revisie volgt wel de nieuwe publicatie. “Sessie” is browser-tab/sessieopslag, niet een centraal Entra-loginmoment. Cross-device synchronisatie en centraal preferencebeheer zijn niet toegevoegd.

## Beheer: gewone controls, private concepten

De [editor](../services/admin-overlay/admin/views/help-editor.html) wordt door de bestaande adminauth beschermd en leest `/api/admin/manual` met fetch. Alleen expliciet toegestane eigen JS/CSS-assets worden geauthenticeerd geserveerd. Geen directe scriptinterpolatie, publieke concepten of wijziging van model/store/API-contracten. De pagina heeft een restrictieve CSP en private/no-store caching.

1. **Instellingen en organisatie:** aan/uit, agenttool, automatisch beleid, profiel, titel/subtitel/controledatum en alle naam/contact/URL-velden. Bronnen en override/reset zijn zichtbaar. Hard disable wordt als niet te overruleden grens getoond. Limburg-claims/contacten moeten vóór publicatie door de organisatie worden gecontroleerd.
2. **Hoofdstukken en onderwerpen:** selecteer, zoek/filter, wijzig titel/tekst, voeg toe/verwijder/verplaats en orden met gewone knoppen (geen drag-only bediening). Veilige rich-textcontrols hebben een optionele HTML-bronweergave. IDs/aliases/related/voorwaarden/rechten zijn expliciet bewerkbaar.
3. **Foutennaslagwerk:** globale zichtbaarheid, categorieën met ouder, artikelkeuze/filtering, codes/aliases/messages en artikelinhoud/voorwaarden. Eigen én overgeërfde zichtbaarheid en verborgen redenen worden zichtbaar. Productfuncties/rechten worden hiermee niet toegekend.
4. **Concept bewaren:** bewerkt alleen expliciete overrides. Een wijziging aan een array vervangt bewust de volledige geordende array, met waarschuwing. Profielovererving wordt na save opnieuw van de server gelezen. Een expliciet lege string/false blijft expliciet; reset verwijdert alleen de genoemde override en vereist eerst een bewaard concept.
5. **Preview controleren:** uitsluitend veilige private compilerpreview met gelabelde hiddenReasons; geen live bewijs en geen agentbron. Previewlinks zijn niet voor navigatie.
6. **Publiceren:** afzonderlijke expliciete actie na concept/save; **Live uitschakelen** gebruikt het aparte disable-endpoint en publiceert geen ander concept. Imports bewaren alleen concept; export bevat het effectieve private concept en moet veilig worden bewaard. Lokale overrides kunnen vóór conflict/herladen worden gedownload.
7. **Historie/rollback:** terugzetten publiceert een nieuwe revision. Beide actuele tokens zijn vereist bij mutaties. Een 409 behoudt lokale edits, blokkeert mutaties en biedt vergelijken, lokaal exporteren en expliciet actueel concept overnemen. Geen blind retry. Onzekere netwerk-/publicatiefouten vereisen eveneens expliciete recovery; succes wordt niet verzonnen.

Verwijderen van een passage die nog door related/ouders/visibility wordt genoemd vereist opschonen van die verwijzingen; de serverweigering wijzigt live niets. Het is bewust geen verborgen cascadeverwijdering.

## Migratie en bediening

1. Houd feature uit tot de onafhankelijke review is afgerond. Bewaar private state/export/back-up buiten publieke mounts.
2. Bouw native markerimage met de bestaande gelockte pinned release en installeer overlay/backend/assets gezamenlijk via normale releaseprocedure. Nieuwe frontend leest de oude openbare helpassets niet meer. Oude API/assets blijven 410; er is geen fallback naar oude gecachte organisatiecontent.
3. Open de beveiligde editor of gebruik de bestaande file/CLI-route. Legacy HTML-import komt uitsluitend als concept binnen; controleer organisatie-/privacyclaims en profielcontacten. Een volledig model importeren is bewust een volledige override; gewone editorwijzigingen pinnen niet de hele geërfde basis.
4. Controleer effectieve capabilities/rechten, ouderzichtbaarheid en private preview. Publiceer expliciet en test met een gewone ingelogde gebruiker. Optionele toolinstallatie volgt de bestaande beheerde workflowimport; inhoudswijzigingen daarna vereisen geen workflowherimport.
5. Bij nood: gebruik **Live handleiding uitschakelen** of CLI-disable. Bij een storageblock/publicatiefout volg uitsluitend de recoveryprocedure uit [backendcontract](configurable-manual.md); verwijder geen actieve lock. Rollback blijft expliciete nieuwe publicatie.

Backendgrenzen blijven: agent heeft alleen de veilige algemene trusted subset, geen volledige per-gebruikerpromptrechtenadapter; OpenBesluitvorming/Topdesk/transcriptie hebben geen aanvullende trusted beschikbaarheidsadapter en blijven verborgen. Geen nieuwe autorisatieclaims of modeltoolinputs met vrije rollen toegevoegd.

De actuele catalogus heeft **692** configureerbare artikelen: **466 gewone en 226 standaard verborgen bijlageartikelen**. De gewone artikelen zijn ook rights-/capability-filtered; de browserfixture ziet 450, niet iedere installatie. De private editor kan alle 692 beheren; het gewone gebruikers-/agentdocument, inhoudsopgave, zoeken en print bevatten standaard geen bijlage. Zoekresultaten geven genormaliseerde exacte volledige foutcodes/meldingen voorrang, zonder template-expansie; relevante topics volgen vóór niet-exacte foutartikelen, met stabiele gelijke scores.

Storagefalen blokkeert actuele browser-/agentreads en metadata. Publicatie moet zowel private staat als openbare activatiemetadata afronden voordat het blok verdwijnt. Een niet duurzaam schrijfbare blokkermarker laat de write-lock staan; oude metadata wordt alsnog verwijderd waar mogelijk. Symlinks/stale locks worden niet blind als afwezig behandeld. Herstel is expliciet operatorwerk, niet automatisch defaults publiceren. De frontend hercontroleert revision/disable/rechten vóór opnieuw tonen, maar reeds ontvangen chatcitaten/exports/browsergeheugen zijn niet achteraf intrekbaar. De gedeelde beheersessie verloopt nu server-side na dezelfde vaste 24 uur als de cookie; andere productie-auth is niet gewijzigd.

## Testbewijs en resterende acceptatie

| Laatste afgeronde controle | Resultaat / reproduceren |
| --- | --- |
| Echte geïsoleerde Chromium/Playwright-acceptatie | **29 geslaagd, 0 fouten**; [resultaatbestand](../tests/manual/evidence/browser-results.json), [eindreview/reproductie](manual-frontend-review.md) |
| Volledige gecompileerde native client in Chromium | **5 geslaagd, 0 fouten**; echte client/overlay, synthetische API/auth; [resultaatbestand](../tests/manual/evidence/native-browser-results.json) |
| Complete manual Node-suite in officiële geïsoleerde image | **92 geslaagd, 0 fouten/skips**; actuele drie-sibling/cross-reviewharness in [eindreview](manual-final-review.md) |
| Start/Beleidskompas-unitregressies | **18 geslaagd, 0 fouten/skips**; `node --test tests/overlay/start-page.test.js overlay/src/apps/beleidskompas/tests/*.test.js` |
| Brede native/minimal/branding/auth/runtime/tool/document/promptregressies | **166 geslaagd, 1 expliciete live-extractieskip, 0 fouten**; exacte selectie/harness in [native validatie](manual-native-build-validation.md) |
| Python static/config/security/runner | **72 tests: 59 geslaagd, 13 expliciete proxy-integratieskips, 0 fouten**; directe discovery en offline snapshot overlappen, niet optellen |
| Errorcoverage met gepinde bron | **692 artikelen, 851 bronvermeldingen, 263 artifacts**; 466 gewone/226 standaard verborgen; [actuele reproductie](manual-final-review.md) |
| Native productiecompile | **Geslaagd, 9.733 modules, 20,77 seconden**; gelockte dependencies en offline compile/prune, [exact eindbewijs](manual-frontend-review.md) |
| Syntax en whitespace | Geslaagd; Node syntaxchecks en `git diff --check` |

Tijdelijke Node/dependencies zijn uitsluitend in de genegeerde worktree-map geïnstalleerd; de browserrunner bootstrapt deze lokaal. De Nodecommando's hierboven veronderstellen de runtime/dependency-harness, niet een globale Node-installatie. Geen productie-/Entra-test wordt door deze aantallen geïmpliceerd; skips worden niet als geslaagd geteld.

- [Playwright-reproductie en scenario's](../tests/manual/browser-README.md), [screenshots en machine-resultaten](../tests/manual/evidence/README.md): echte Chromium, echte ES modules, echte model/store/routes/editor, loopback-only synthetische auth/config. Inclusief gehele 692-artikelbeheerbibliotheek, 466 gewone/226 standaard verborgen, 450 onder actuele fixturetoegang toegestane artikelen en expliciete bijlage-uitsluiting; visibility/print, auto/storage, context, citaatvalidatie, focus/inert, reflow en start/app.
- [Native compile en brede regressies](manual-native-build-validation.md): volledige gepatchte clientcompile, native footer/minimal/branding/auth/runtime/retentie/tools/documentcontext/image/prompt-/naamregressies; één expliciete live-extractieskip.
- [Frontendunit-tests](../tests/manual/frontend.test.js): exacte citaatparser, geauthenticeerde reads, previewweigering, token-/configbootstrap, opaque accountscope, vier beleidsopties, sessienavigatie en storageweigering.
- [Editor/route-tests](../tests/manual/editor.test.js) en [native-entrypointtests](../tests/manual/entrypoints-native.test.js) vullen het echte browserbewijs aan.
- Errorcoverage is met de exacte gepinde upstreamboom opnieuw gecontroleerd. Alle 684 oorspronkelijke artikel-IDs blijven behouden; acht artikelen zijn toegevoegd en de inhoud is praktisch herzien, zonder 692 bewezen bereikbare foutoorzaken te claimen. Actueel 851 bronvermeldingen/263 artifacts, inclusief de nieuwe sessiehelper; geen blanket hashonderdrukking. De historische basis had 839, niet 837 bronvermeldingen.

Niet geclaimd: live Entra/SSO, complete productieproxy, echte LLM-/agentvraag, productie-authenticatie, schermlezerhardware, alle browsers, OS-printer of formele WCAG-certificering. De gewone browseracceptatie gebruikt native-slotfixtures; de native runner valideert daarnaast de **daadwerkelijke volledige native client** met synthetische auth/API tegen de bestaande siblingbuild. Zie [gecombineerde eindreview](manual-final-review.md) voor actuele fixes, exacte gescheiden tellingen en de resterende vertrouwde-agentcontext-/adapterblockers en afzonderlijk geautoriseerde installatie-/auth-/deploymentacceptatie vóór activatie.
