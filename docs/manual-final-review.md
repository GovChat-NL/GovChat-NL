# Gecombineerde eindreview configureerbare handleiding

Datum: 27 november 2026 (UTC). Alleen de worktree GovChat-NL-handleiding; branch feat/configurable-user-manual, basis/HEAD **b87a6c7345a6484a2400b39661498b1a4171416c**. Alle drie niet-gecommitte siblingreviews en hun bronwijzigingen zijn behouden: [agent](manual-agent-review.md), [content/beveiliging](manual-content-security-review.md) en [frontend/native](manual-frontend-review.md). Het gevraagde plan was niet aanwezig binnen deze worktree en is nergens buiten de worktree gelezen. Geen commit, push, deployment, andere worktree of private runtime/credentials gebruikt.

## Besluit: veilige gedeeltelijke acceptatie, geen volledige goedkeuring

**De concrete cross-reviewfixes en de finale geïsoleerde regressies zijn groen. Dat accepteert de huidige veilige fallback gedeeltelijk, niet het volledige vereiste van vertrouwde agentspecifieke gebruikerscontext en niet productieactivatie.** Handleiding standaard uit, automatisch openen standaard nooit; geen feature geactiveerd. Groene unit-/browsertests maken ontbrekende vertrouwensadapters niet alsnog beschikbaar.

Expliciete blockers:

1. **Volledige vertrouwde agentgebruikerscontext ontbreekt.** Een geauthenticeerde, niet door AI/client te wijzigen LibreChat → bridge → n8n → backendketen voor actuele identiteit, rol, persoonlijke promptrechten en effectieve functies is niet geïmplementeerd/aangetoond. Gedeelde bearer, Entra-/metadataheaders, launcherconfig of toolargumenten bewijzen dit niet. De agent krijgt alleen algemene context, geen persoonlijke upload-/bestands-/promptrechten. Eventuele afzonderlijke publieke voorwaardelijke promptbibliotheekuitleg is geen beschermde passage, citaat of rechtentoekenning. Het browsergebruikerspad verifieert identiteit/rechten opnieuw maar is geen atomair autorisatiesnapshot of zelfstandig bewijs van SSO-revocatie.
2. **Drie optionele beschikbaarheidsadapters zijn niet geverifieerd:** OpenBesluitvorming, TOPdesk en transcriptie. Hun passages blijven verborgen; een launcherentry of losse featureboolean mag die toegang niet openen. Alleen het weglaten van deze claims is veilig, geen volledige functionele acceptatie.
3. **Productie-installatie/auth-/deploymentacceptatie blijft apart geautoriseerd werk.** Geen live LLM, Entra, n8n-/bridgeketen of productiecredentials zijn nodig of gebruikt voor deze review; hun ontbreken is geen reden om onveilige rechtenfallbacks te maken. Eerst de twee inhoudelijke blockers oplossen/expliciet herbesluiten, vervolgens de normale installatie-/authsmoke vóór activatie.

## Gesloten concrete bevindingen

- [Gedeelde serverzoekrangschikking](../services/admin-overlay/admin/lib/manual-routes.js:22): Unicode NFKC, Nederlandse lowercase, trim en samengevouwen witruimte. Genormaliseerde **exacte volledige code/foutmelding wint**; gedeeltelijke codes/aliases winnen niet als exacte foutidentiteit. Dynamische templates worden niet geëxpandeerd of als exacte identiteit gerankt. Daarna komen passende hoofdstukken/topics vóór niet-exacte foutartikelen, met titelrelevantie en stabiele documentvolgorde bij gelijke score. Alleen het vooraf door de compiler gefilterde document wordt gerankt; gebruikers-/agentlimieten blijven afzonderlijk. [Vier nieuwe rankingregressies](../tests/manual/search-ranking.test.js:8) testen exact/ties, templates, filtering vóór ranking en gewone chat/document/promptvragen; bestaande matrix-/HTTP-tests blijven intact.
- [Geteste adminsessiehelper](../services/admin-overlay/admin/lib/admin-session.js:4): vaste server-side **24 uur**, exact dezelfde constante voor de cookie in de gedeelde adminserver. Controle verlengt niets; expiry op de grens weigert/verwijdert de record. Onbekende/malforme/future timestamps worden geweigerd. [Drie tests](../tests/manual/admin-session.test.js:5) bewijzen grens, malformed/future en server/cookiewiring. Geen wijziging aan LibreChat-/Entra-/bridge-auth, geen nieuwe idle-timeout of centrale revocatieclaim.
- [Browsercataloguscontrole](../tests/manual/browser-acceptance.cjs:101): **692 totaal, 466 gewoon, 226 standaard verborgen bijlage**. Onder vertrouwde synthetische fixturecontext blijven 450 gewone artikelen zichtbaar; zestien gewone artikelen vallen weg door effectieve rechten/functies. Ieder bijlage-ID ontbreekt in het defaultdocument. De private editor beheert de volledige catalogus. Screenshots en beide machinebrowserrapporten zijn opnieuw gemaakt tegen de actuele bronnen/catalogus.
- [Inventory](manual-error-inventory.json): **851 bronvermeldingen, 263 artifacts: 58 repo, 204 gepinde upstream, één fallbackcontract**. De nieuwe sessiehelper is echt gefingerprint; overige gewijzigde bronfingerprints zijn expliciet hergegenereerd. Alle **684 oorspronkelijke IDs behouden, acht toegevoegd**. De basis bevatte feitelijk 839 vermeldingen, niet het oude overdrachtsgetal 837. Geen blanket hash-/brononderdrukking. De Python-fingerprinttests veranderen tijdelijke bronkopieën en bewijzen nog steeds dat drift faalt en alleen expliciet hergenereren de check herstelt.
- [Publieke regressiesnapshot](../scripts/run_regressions.py:23): expliciete allowlist voor de nieuwe helper/reviewtests en het reeds tracked optionele native buildconfigbestand. Een [snapshotregressie](../tests/test_regression_runner.py:41) controleert dat laatste bestand als tracked bron; private/runtime/symlink-/ongecontroleerde-untracked-exclusies blijven behouden. Geen andere bronboom gebruikt.

## Actuele safe-state/publicatiegrenzen

De [store](../services/admin-overlay/admin/lib/manual-store.js:89) weigert reads en effectieve metadata bij blokkermarker, write-lock of onveilige markerpaden. Publicatie houdt de lock over de private staat- en metadatastappen; pas na succesvolle publicatie wordt de blokkering opgeheven. Bij markerwrite-falen blijft de lock staan en wordt oude openbare activatiemetadata alsnog verwijderd waar mogelijk. Andere store-instanties/herstarts mogen niet ongezien de oude live versie lezen; dangling symlinks gelden niet als “afwezig”. Storagefalen is geen succesvolle save, defaultreset of automatische unlock.

Herstel blijft operatorwerk: schrijvers stoppen, geverifieerde private back-up veiligstellen, lock-eigenaarschap beoordelen en daarna expliciet herstellen/publiceren. Geen actieve lock/blokkermarker blind verwijderen. Een blijvend onschrijfbare filesystem kan geen duurzame nieuwe state garanderen. Openbare activatiemetadata is geen autorisatie of beschermde inhoud. Frontend hercontroleert actuele revisie/disable/rechten; reeds ontvangen chatcitaten, exports, browsergeheugen en eerder gecachete legacy-assets zijn niet achteraf intrekbaar.

## Finale resultaten — gescheiden, niet optellen

| Finale complete run | Geslaagd | Fouten/cancellations | Expliciete skips / grens |
| --- | ---: | ---: | --- |
| Complete manual Node-suite | **92** | **0 / 0** | **0**; alle drie siblings plus cross-review |
| Start/Beleidskompas Node | **18** | **0 / 0** | **0** |
| Brede native/minimal/branding/auth/runtime/retentie/tool/document/image/prompt-/naambronregressies | **166** | **0 / 0** | **1**, live Tika/externe PDF-extractie; 167 tests |
| Python discovery | **59** | **0** | **13** proxy-integraties; 72 tests |
| Offline publieke regressiesnapshot | **59 Python** | **0** | Dezelfde 13 skips; tevens releasepinfixture 2/2 en vertaalfixtures groen |
| Fixture Chromium | **29 scenario's** | **0** | Synthetische identiteit/config; echte model/store/routes/editor/ES modules |
| Volledige native Chromium | **5 scenario's** | **0** | Echte bestaande native Vite-build en productieoverlay; synthetische API/auth/opgeslagen foutturn |
| Contentgenerator read-only / inventory met gepinde upstream / whitespace | **Groen** | **0** | 12 hoofdstukken, 53 topics, 692 artikelen; 851 vermeldingen/263 artifacts |

Alle finale exitcodes zijn **0**; de drie Node-exitstatussen zijn afzonderlijk **0/0/0**. Raw [finale Node-TAP](../.manual-tools/final-review/regressions-final.tap), [Python](../.manual-tools/final-review/python-final.log), [offline snapshot](../.manual-tools/final-review/offline-final.log), [fixturebrowser](../.manual-tools/final-review/browser-final.log) en [native browser](../.manual-tools/final-review/native-browser.log) blijven genegeerd binnen de worktree. Publiek bewijs: [gecombineerde machinesamenvatting](../tests/manual/evidence/final-acceptance.json), [fixturemachine-resultaat](../tests/manual/evidence/browser-results.json), [nativemachine-resultaat](../tests/manual/evidence/native-browser-results.json) en [screenshots/bewijsgrenzen](../tests/manual/evidence/README.md).

**Geen som van siblingaantallen, gerichte runs, Python discovery/snapshot of herhaalde browserruns.** Het offline pad en de discovery bevatten dezelfde Python-tests; de discovery voert via runnerregressies bovendien reeds overlappende offline checks uit. Browseraantallen zijn scenario's, geen extra unit-tests. De eerdere native productiecompile (**9.733 modules, 20,77 seconden**) is siblingbewijs, geen nieuwe compile in deze cross-review.

## Reproduceerbare finale harness

Vanuit deze worktree, met bestaande worktree-local Node/Playwright/renderdependencies en de bestaande gepinde publieke LibreChat-image. Alleen de al verklaarde tijdelijke Temporal-adminafhankelijkheid is aanvullend lokaal geïnstalleerd; geen projectmanifest gewijzigd. De container heeft vanaf start geen netwerk, geen gepubliceerde poort, geen secrets/private runtime/Docker-socketmount. Alleen een gesanitiseerde public-source snapshot en read-only testdependencies worden gemount. Native bron/dependencies komen uit de publieke image. Express **4.21.2** uit de admin/browserfixturedependencies moet vóór image-Express 5 resolven.

```sh
export PATH="$PWD/.manual-tools/node-v22.21.1-linux-x64/bin:$PATH"
mkdir -p .manual-tools/final-review/public-source .manual-tools/final-review/tmp
npm install --prefix .manual-tools/final-review/admin-deps --no-audit --no-fund @js-temporal/polyfill@0.5.1
python3 - <<'PY'
from pathlib import Path
from scripts.run_regressions import snapshot
snapshot(Path('.manual-tools/final-review/public-source').resolve())
PY
docker run --rm --network none --user 0:0 --memory 3g \
  --mount "type=bind,source=$PWD/.manual-tools/final-review/public-source,target=/public-source,readonly" \
  --mount "type=bind,source=$PWD/.manual-tools/node_modules,target=/browser-deps/node_modules,readonly" \
  --mount "type=bind,source=$PWD/.manual-tools/deps/node_modules,target=/render-deps/node_modules,readonly" \
  --mount "type=bind,source=$PWD/.manual-tools/final-review/admin-deps/node_modules,target=/admin-deps/node_modules,readonly" \
  --entrypoint sh registry.librechat.ai/librechat-ai/librechat:v0.8.8 -c '
set -eu
cp -a /public-source /repo
ln -s /repo /workspace
cd /repo
export NODE_PATH=/browser-deps/node_modules:/render-deps/node_modules:/admin-deps/node_modules:/app/node_modules:/app/api/node_modules
export GOVCHAT_TEST_LIBRECHAT_ROOT=/app GOVCHAT_DOCKER_TESTS=0
node --test --test-reporter=tap --test-force-exit --test-concurrency=1 --test-timeout=60000 tests/manual/*.test.js
node --test --test-reporter=tap tests/overlay/start-page.test.js overlay/src/apps/beleidskompas/tests/*.test.js
node --test --test-reporter=tap --test-force-exit --test-concurrency=1 --test-timeout=60000 \
  tests/native-chat-footer.test.js tests/minimal-ui.test.js tests/branding/*.test.js \
  tests/librechat-entra.test.cjs tests/librechat-release-pin.test.js tests/librechat-runtime-compatibility.test.js \
  tests/govchat-retention-policy.test.js tests/govchat-retention-worker.test.js tests/librechat-tool-event-overlay.test.js \
  tests/n8n-processEventStream.patched.test.js tests/document-context.test.js \
  tests/image-request-compatibility.test.js tests/image-tool-identity.test.js tests/image-edit-workflow.test.js \
  tests/orchestrator/name*.test.js tests/orchestrator/prompt*.test.js
'
export TMPDIR="$PWD/.manual-tools/final-review/tmp" GOVCHAT_DOCKER_TESTS=0
python3 -m unittest discover -s tests -p 'test_*.py' -v
python3 scripts/run_regressions.py --offline
python3 scripts/build-manual-content.py --check
python3 scripts/manual-error-inventory.py --upstream .manual-tools/LibreChat-0.8.8
export NODE_PATH="$PWD/.manual-tools/node_modules:$PWD/.manual-tools/deps/node_modules:$PWD/.manual-tools/final-review/admin-deps/node_modules"
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.manual-tools/browsers" PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64
node tests/manual/browser-acceptance.cjs
GOVCHAT_NATIVE_DIST="$PWD/.manual-tools/frontend-review/native-dist-final" node tests/manual/native-browser-acceptance.cjs
sha256sum -c .manual-tools/frontend-review/inputs.sha256
git diff --check
```

De finale image draaide Node **24.16.0**, lokale browserruns Node **22.21.1**, Chromium **145.0.7632.6**, Playwright **1.58.2**. Gebruikte lokale image-ID: **5b706bcee1ca154a1e2987303aaeca0eb27f97919cccee4bb604226c2f8abf61**. Native patch SHA-256 blijft **2c22f2e18ef59eed2de88df17dcdb0725d871b1d17e4e8e77a596f1fe87fa3f9**; native runner **3802096c63d8f987bfc406806da622dd75026fa4c002cefbecf314477230b916**; bestaande build-shell **6253c58a7b5de440f88202ae863e8c6ae5e2fa1eef9fc7d3d5065a955dfc348c**. De volledige sibling inputchecksumcheck is groen. Native patch, recipe, upstream lock, helper en bestaande build-shell zijn niet gewijzigd; de native runner is eveneens ongewijzigd sinds de siblingreview.

## Eerlijke diagnostiek en niet geteste grenzen

- Eerste gerichte nieuwe testpoging: 5 passes/2 failures doordat gewijzigde fixtures een oude topiclink behielden. Fixtures gecorrigeerd; daarop 7/7 gericht groen en vervolgens opgenomen in de volledige 92-test-run. Geen productiebug of weggefilterde assertie.
- Een inventorycheckpoging gebruikte ten onrechte een aparte checkflag; die generator checkt standaard zonder updateflag. De finale standaardcheck met upstreambron en contentgeneratorcheck zijn groen.
- Snapshotvoorbereiding miste eerst de vooraf vereiste destinationmap; geen suite gestart. Daarna eerste container-run: **87/92 manual geslaagd, vijf failures** door verkeerde Expressresolutie en ontbrekende native Compose-snapshotbron. Gerichte HTTP-diagnostiek: twee failures die Express 5-routeparsefout bevestigden; geen productieaanpassing gedaan om die testharness te maskeren.
- Na dependencycorrectie: **91/92 manual geslaagd, één failure** door het ontbrekende tracked native buildconfigbestand. Expliciete snapshotallowlist plus regressionassertie toegevoegd. Alleen de daaropvolgende finale complete **92/92** telt als groen. Apps/brede suites uit diagnostische runs worden niet opnieuw opgeteld.
- Geforceerde Node-suite-exit en 60-secondenlimiet zijn harnessvoorzieningen voor bestaande open native/runtimehandles, geen bewijs dat upstream die vanzelf sluit. Finale runs hebben nul failures/cancellations; skips zijn niet als passes geteld.
- Geen nieuwe native compile/image-export, deployment-/reverse-proxy-/TLS-/Entra-/Mongoacceptatie, upstream volledige testsuite/hele-repo TypeScriptcheck, live LLM/SSE-generatie, n8n-/bridgeexecutie, extractieservice, Firefox/WebKit, schermlezerhardware, OS-printer/PDF-uitvoer of formele WCAG-certificering. Browserroutes zijn loopback-only, outbound origins geblokkeerd en native serviceworkers geblokkeerd. Print bewijst veilige actuele document-DOM/printmedia, niet OS-uitvoer. Voorkeuren blijven origin/account en tab/session storage, niet centraal/cross-device beleid.

## Parent-overdracht en definitieve guard

[Contract](configurable-manual.md), [backendoverdracht](manual-backend-handoff.md), [frontendbeheer](manual-frontend.md) en [bewijssamenvatting](../tests/manual/evidence/README.md) noemen nu de actuele catalogus, veilige state/publicatiemarkergrenzen en expliciete partial-readiness. Siblingreviewdetails blijven als zelfstandig historisch bewijs bewaard, met verwijzing naar dit finale gecombineerde oordeel.

Parent voert vlak vóór een eigen expliciet geautoriseerde commit de **definitieve worktreeguard** uit: juiste worktree en branch, HEAD nog b87a6c7, complete diff inclusief untracked siblingtests/reviews/evidence, geen private runtime-/credentialbestanden, content/inventory/whitespacecheck groen, native checksum nog gelijk. Controleer dat alle siblingedits behouden zijn; geen blind reset/clean/stage van lokale tooling. Deze taak laat alles bewust **ongecommitteerd en ongepusht** achter. Een parentcommit of releasebesluit verandert de open trusted-context-/adapterblockers niet automatisch in acceptatie.
