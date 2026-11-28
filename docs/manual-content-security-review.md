# Onafhankelijke content- en backendbeveiligingsreview

> Behouden onafhankelijk siblingbewijs. De hieronder genoemde cross-reviewoverdracht voor search, browserbewijs en server-side adminsessie-expiry is inmiddels opgelost; de definitieve telling is 692 artikelen/851 bronvermeldingen/263 artifacts, inclusief de nieuwe sessiehelper. Zie [manual-final-review.md](manual-final-review.md) voor actuele gescheiden resultaten en de nog open agentcontext-/adapterblockers. De oorspronkelijke bevindingen/resultaten hieronder zijn geen nieuw totaal.

Datum: 27 november 2026. Werkbranch: feat/configurable-user-manual, basis b87a6c7. Geen commit, push of deployment. Alleen deze worktree is gewijzigd; bestaande sibling-wijzigingen zijn behouden.

## Scope en contract

Het lokale [functionele/backendcontract](configurable-manual.md) en de [historische backendoverdracht](manual-backend-handoff.md) zijn gebruikt; er is geen aanvullend plan uit een andere repository ingelezen. De werkelijke compiler, store, gebruikers-/beheer-API en editorbron zijn onderzocht. Wijzigingen beperken zich tot content/defaults, generator/inventaris, model/store, onafhankelijke tests, de publieke regressiesnapshot en dit document. Context, routes, workflow, frontend en native patch zijn niet gewijzigd door deze review.

## Exacte inhouds- en inventaristellingen

| Onderdeel | Basis b87a6c7 | Na review |
|---|---:|---:|
| Hoofdstukken / topics | 12 / 53 | 12 / 53 |
| Configureerbare catalogusartikelen | 684 | 692 |
| Bronvermeldingen | 839 | 851 |
| Gefingerprintte artifacts, inclusief fallbackcontract | 257 | 262 |

De historische overdracht noemt 837 bronvermeldingen; het daadwerkelijk onderzochte basisbestand bevat **839**. De huidige telling is **851**, niet 837. Alle **684 oorspronkelijke IDs zijn behouden**; nul verwijderd, acht toegevoegd. Het aantal artikelen is nadrukkelijk niet het aantal bewezen actieve gebruikersfouten.

| Standaardcategorie, vóór functie-/rechtenfiltering | Artikelen |
|---|---:|
| Chat, model en context | 211 |
| Aanmelden, sessie en rechten | 39 |
| Upload, extractie en bestandsbeheer | 114 |
| Promptbibliotheek | 21 |
| Netwerk, proxy en services | 13 |
| Apps en agenttools | 53 |
| Handleiding en bronverwijzingen | 15 |
| **Gewone foutcatalogus** | **466** |
| **Standaard verborgen optionele bijlage** | **226** |

De bijlage bestaat uit **61 labels/statussen/aanvullende schermteksten**, **12 interne bronfragmenten/extractieruis**, **149 specifiek uitgelegde optionele of interne functies** en **4 expliciet niet-gediagnosticeerde naslagstrings**. Die laatste vier zijn aanvullende agent-/bron-fallbacktekst, registratiegerelateerde tekst en een interne SAML-configuratiestring; zij worden niet als actieve foutdiagnose aangeboden. De bijlage blijft bewerkbaar en in privépreview inspecteerbaar, maar ontbreekt standaard in gebruikersdocument, inhoudsopgave, zoekresultaten, get en agentbron. Een beheerder kan haar expliciet activeren. Bestaande publicaties worden niet stilzwijgend met deze defaults overschreven.

## Praktische contentverbetering

De oorspronkelijke catalogus had **352 artikelen met dezelfde algemene foutverklaring**. Die tekst komt nu nergens meer voor. [Taakgerichte contentregels](../scripts/manual_catalog_content.py:7) onderscheiden onder meer:

- afzonderlijke HTTP-statussen: ontbrekende authenticatie is geen ontbrekend recht; een gateway-timeout bewijst geen gestopt werk;
- modelverbinding/credentials tegenover chatsessies, onderbroken streams, quota, context en gelijktijdige berichten;
- bestandssignatuur tegenover extensie, gevaarlijke archief-/XML-/spreadsheetverwijzingen, macro’s, lege cellen, pagina-/werkbladlimieten en parserresourcegrenzen;
- gedeeltelijke/lege extractie tegenover een geslaagde upload, en niet-bevestigde workerbeëindiging tegenover een normale timeout;
- promptversies en gebruiks-/bewerkingsrecht, gedeeltelijke verwijderacties, ingetrokken gedeelde links en niet-bevestigde toolgoedkeuring;
- optionele codeomgevingen, projecten, vaardigheden, planningen en diagnostiek, zonder algemene beschikbaarheid te beloven.

Elk artikel houdt de herkenbare code/melding, betekenis, veilige vervolgstappen, escalatie en begrensde beheeruitleg. Er worden geen persoonsgegevens, volledige chats, documenten, cookies, tokens of credentials voor een gewone helpdeskmail gevraagd. Labels worden niet meer behandeld alsof hun aanwezigheid een afzonderlijke storing bewijst. De [gewone handleidinggenerator](../scripts/build-manual-content.py:34) behoudt concrete chat-/document-/promptuitleg en legt de optionele bijlage uit.

**Geen claim van 692 afzonderlijk bewezen oorzaken:** foutfamilies delen passende herstelstappen; de exacte melding alleen bewijst vaak geen oorzaak. De vier onzekere strings blijven eerlijk begrensde naslag, niet verzonnen diagnoses. Ook de 466 gewone artikelen zijn nog onderworpen aan effectief beschikbare functies, rechten en organisatieconfiguratie.

## Concrete beveiligingsfixes

### Model en compiler

- [ID-validatie](../services/admin-overlay/admin/lib/manual-model.js:17) vereist tekst voor passage-/categorie-IDs, aliases en verwijzingen. Ontbrekende IDs, getallen en booleans konden eerder door regexcoercie worden geaccepteerd.
- Aanwezige lijstvelden met null, false, een getal of lege tekst worden geweigerd; alleen werkelijk ontbrekende optionele lijsten krijgen een lege default.
- Onbekende placeholders worden al bij validatie geweigerd, ook in hoofdtitel, ondertitel, hoofdstuk-/topic-/artikel- en categorietitels. Categorie- en artikeltitels worden consistent geïnterpoleerd.
- Organisatie-URLvelden accepteren echte web-/lokale bestemmingen, geen recursieve placeholders, manual- of mailto-bestemmingen. HTML-links blijven afzonderlijk allowlisted; credentials in HTTP-URLs, uitvoerbare schemes, backslashes en cross-origin protocolrelatieve URLs worden geweigerd.
- Verwijzingen moeten naar een leesbare passage of alias verwijzen, niet naar alleen een categorie-ID waarvoor geen passage bestaat.
- De al aanwezige HTML-allowlist blijft leidend. Organisatietekst wordt ge-escaped; scripts, SVG/MathML, iframes, formulieren, events en styling worden niet actief gepubliceerd. Links krijgen veilige rel-attributen. Er is geen URL-fetch in compiler/store en dus geen nieuwe SSRF-route.

### Private opslag, publicatie en herstel

- [Opslagreads](../services/admin-overlay/admin/lib/manual-store.js:50) openen de leaf zonder symlinks te volgen, controleren type/grootte op de geopende descriptor en sluiten die ook bij parsefouten. Een symlinkswap tussen padinspectie en openen wordt getest.
- Een achtergebleven schrijf-lock blokkeert gebruikers-/agentreads en effectieve metadata. Een dangling symlink op lock of blokkermarker kan niet meer door een simpele bestaanscontrole als “afwezig” worden beschouwd.
- Oude openbare activatiemetadata wordt ook verwijderd wanneer het schrijven van de private blokkermarker mislukt. **Als die marker niet duurzaam geschreven kan worden, blijft de reeds aangemaakte lock staan**: andere processen en herstarts mogen niet alsnog de oude live staat lezen.
- Bij gewone publicatiefouten blijft de private marker bestaan; concept bewaren of herstart heft die niet op. Een geslaagde expliciete publicatie/disable na herstel is vereist. Er wordt geen lock automatisch als “stale genoeg” verbroken.
- Reset weigert onbekende organisatievelden, prototypepaden en niet-bestaande passageflags. Geldige sparse flags zijn resetbaar zonder sibling-overrides te wissen.
- De veldbron van de default verborgen bijlage en algemene foutzichtbaarheid is correct “default”, niet onterecht “deploymentbestand”. Profiel-/deployment-/beheerprecedentie, expliciet lege/false waarden, restart en rollback blijven intact.

De private map is 0700 en state 0600; publiek blijft uitsluitend beperkte activatiemetadata. Het bestaande atomic fsync/rename-statecontract blijft behouden. De regressies bevestigen gescheiden opslaglocaties, begrensde historie, revisionconflicten en het uitblijven van private content in openbare assets. Absolute bescherming tegen een aanvaller die bevoegde private parentmappen tijdens syscalls kan vervangen wordt niet geclaimd; private opslag en expliciete importpaden moeten onder vertrouwd operatorbeheer staan.

### Beheer- en editorbron

De [beheerroute](../services/admin-overlay/admin/lib/manual-routes.js:42) gebruikt de bestaande beheerderssessie, origin-/fetch-sitecontrole en JSON-contracten. Gebruikers- en interne toolauth zijn gescheiden. Preview is privaat en geen gebruikersbron. De [editorpagina](../services/admin-overlay/admin/views/help-editor.html) bevat geen geïnjecteerde ruwe modelbootstrap; de [editorcode](../services/admin-overlay/admin/views/help-editor-assets/editor.js:345) maakt alleen allowlisted inhoud actief en gebruikt een gesandboxte preview. Onafhankelijke echte HTTP-tests weigeren onbekende modelvelden, onveilige URLs en onbekende placeholders zonder revisies te veranderen.

## Inventaris: geen onverklaarde hashonderdrukking

De [inventarisgenerator](../scripts/manual-error-inventory.py:90) heeft nu **57 repo-artifacts, 204 gepinde upstream-artifacts en één expliciet fallbackcontract**. De vijf extra bronfingerprints zijn de native patch, handleidingworkflowgenerator en drie eigen generator/contentbronnen. Generatorbronnen hebben expliciete uitsluiting als *gebruikersfoutbron*, maar hun volledige hash wordt wel gecontroleerd. Interne JS/JSX-fragmenten blijven conservatief gedekt in de verborgen bijlage; ze worden niet als echte foutmelding gepresenteerd.

De gewijzigde context-, route- en toolpolicybronnen zijn gelezen en bewust vernieuwd, niet uitgezonderd. Toegevoegde bronvermeldingen tegenover b87a6c7: context +4, routes +3, store +2, native patch +2, handleidingworkflowgenerator +1; samen **+12**, van 839 naar 851. De acht nieuwe artikel-IDs omvatten vier interne contextmeldingen en vier conservatieve bronfragmenten; alle acht zijn bijlage-inhoud, geen nieuw bewijs van actieve fouten.

Controles vergelijken de volledige bronset en hashes, bronvermeldingen, catalogusinhoud en de gematerialiseerde defaultcatalogus. Zonder upstreamboom wordt alleen de bestaande gepinde upstreamsnapshot hergebruikt, niet verouderde repo-artikeltekst. Met de lokale upstreamboom is de bron opnieuw gecontroleerd tegen de gepinde v0.8.8-inventaris met geregistreerde commit e8f3be08623663d4ad7f7241e693c94469b63bb0. Dit is geen nieuwe online verificatie van een Git-tag.

De [onafhankelijke fingerprintregressie](../tests/test_manual_content_security.py:108) verandert uitsluitend tijdelijke kopieën van context, routes, policy en native script. Iedere wijziging laat de check falen. Expliciet hergenereren verandert de hash zonder vermeldingen te verwijderen of te onderdrukken; de check is daarna weer groen. Beide defaultmappen worden door de read-only check van de [contentgenerator](../scripts/build-manual-content.py:124) gecontroleerd. De [regressierunner](../scripts/run_regressions.py:143) voert beide checks ook offline uit; uitsluitend het expliciete publieke inventorydocument en benodigde nieuwe test-/generatorbronnen zijn aan de snapshotallowlist toegevoegd, geen algemene docs-/private/runtime-uitsluiting.

## Uitgevoerd testbewijs

- Definitieve brede Node-run op de uiteindelijke content en opslagcode: **128/128 geslaagd, nul fouten, nul skips**. Selectie: alle handleidingtests plus naam-, prompt- en utilitybackend/editorregressies; lokale Node 22.21.1 met bestaande tijdelijke React/TypeScript/DOM-dependencies. Dit omvat native markertranspilatie, niet een nieuwe volledige productiebuild.
- [Onafhankelijke Node-reviewtests](../tests/manual/content-security-review.test.js): 17 nieuwe gevallen voor type-/placeholder-/URL-/HTML-invoer, bron-/resetgedrag, locks, symlinks inclusief leafswap, marker-/statewritefalen, andere store-instanties, herstart, defaultbijlage, concrete foutzoekacties en echte HTTP-beheerreads.
- [Onafhankelijke Python-reviewtests](../tests/test_manual_content_security.py): 9 inhouds-/generator-/snapshot-/fingerprintgevallen. Gerichte review plus bestaande runner-unit-tests: **24/24 groen**. Laatste volledige offline regressiesnapshot: **72 Python-tests, 59 geslaagd, 13 expliciete proxy-integratieskips, nul fouten**. Releasepinfixture: 2/2 groen; vertaalfixtures groen. De Dockeropdrachten in runner-unit-tests zijn mocks, geen deploymentacties.
- Contentgenerator --check: groen en read-only; beide defaultmappen gelijk. Inventarischeck: groen, zowel met echte lokale gepinde upstreamboom als in de geïsoleerde regressiesnapshot. Whitespacecheck: groen.
- Eerste brede Node-poging had drie ontbrekende React/TypeScript-testafhankelijkheden door een onvolledig lokaal runtimepad. Die zijn met de bestaande lokale dependencies herhaald: native-tests 7/7 groen. Geen dependencymanifest gewijzigd of test onderdrukt.

De tijdelijke logs staan uitsluitend in de genegeerde lokale toolswerkmap: [definitieve Node-log](../.manual-tools/content-security-node-final-corrected.tap), [offline regressielog](../.manual-tools/content-security-regression-offline-final.log) en [gerichte Python-log](../.manual-tools/content-security-python-final.log). Zij zijn geen nieuwe browser-/deployment-/live-agentacceptatie. Sibling-browserbewijs is niet opnieuw gegenereerd of overschreven.

## Resterende blokkades en overdracht aan siblings

1. **Exacte foutzoekprioriteit blijft een routebevinding.** De [huidige rangschikking](../services/admin-overlay/admin/lib/manual-routes.js:22) scoort woordmatches, niet exact gelijkwaardige codes/meldingen. Een gewone topic met dezelfde titel kan vóór het exacte foutartikel komen. Inhoudsfiltering vermindert ruis en representatieve echte foutzoekacties zijn groen, maar een algemene exacte-codevoorrang wordt niet geclaimd. Route-owner: normaliseer de hele zoektekst, geef exacte codes en exacte niet-dynamische meldingen de hoogste rang, en gebruik pas daarna topic-/titel-/tekstscoring met een stabiele tie-break. Behoud functie-/rechtenfiltering vóór ranking. Deze route is niet door deze review gewijzigd.
2. **Browseracceptatie/evidence moet opnieuw op de huidige inhoud.** De [browserassertie](../tests/manual/browser-acceptance.cjs:103) verwacht nog exact 684 artikelen; dat is nu bewust 692, met 226 standaard verborgen bijlageartikelen. Sibling-owner moet telling én zichtbaarheid/zoeken controleren en bewijs opnieuw maken. Bestaande screenshots en documentatie zijn geen bewijs voor deze nieuwe catalogus.
3. **Bestaande algemene adminauth heeft geen server-side sessieleeftijdcheck.** De [gedeelde sessiecontrole](../services/admin-overlay/admin/server.js:2436) toetst alleen of de sessie bekend is; een browsercookie-expiry is geen server-side revocatie van een gekopieerde cookie. Dit is bestaand algemeen adminauthgedrag, geen nieuwe handleidingroute, en is niet buiten scope aangepast. De auth-owner moet server-side expiry/inactiviteitsbeleid en revocatie afzonderlijk beoordelen.
4. **Al ontvangen inhoud is niet intrekbaar.** Backendreads, metadata en agentbron blokkeren bij disable/publicatiefalen, maar reeds ontvangen chatcitaten, exports, browsergeheugen en eerder gecachete legacy-assets kunnen niet achteraf worden gewist. Frontend moet actuele revisie/disable controleren voordat oude inhoud opnieuw zichtbaar wordt; alleen een lokale oude cache mag geen actuele bron zijn.
5. **Operatorherstel blijft nodig bij storagefalen.** Stop schrijvers, stel een geverifieerde private back-up veilig en controleer lock-eigenaarschap voordat een stale lock wordt verwijderd. Verwijder geen actieve lock of blokkermarker om de feature blind te laten lijken te werken. Herstart importeert niet opnieuw en publiceert geen defaults over bestaande private staat.

Er is geen volledige online/upstream-build-, Docker-/proxy-, browser- of live-agent-eindacceptatie door deze onafhankelijke review geclaimd. Er zijn geen deployments, private runtimebestanden of andere worktrees aangepast.
