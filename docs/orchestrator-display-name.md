# Configureerbare chatweergavenaam

De chatnaam is uitsluitend publieke presentatie, geen model-/versieclaim en geen identiteitsprompt.
Endpoint, model-ID, workflow en organisatie-instructies veranderen niet.
De generieke standaard blijft **GovChat Orchestrator**; organisatiekeuzes horen alleen in private omgeving of adminoverride.

## Beheer

Voorrang: opgeslagen beheerdersoverride → **N8N_ORCHESTRATOR_DISPLAY_NAME** → generieke standaard.
Een lege envwaarde betekent standaard. Een ongeldige niet-lege waarde wordt niet stilzwijgend vervangen.
In **GovChat Admin → Orchestrator → Chatweergavenaam** staan het naamveld, de actieve bron, opslaan en reset.
Reset verwijdert uitsluitend de naamoverride, niet de envwaarde en nooit de masterpromptoverride.
Namen: maximaal 100 UTF-16-tekeneenheden, niet leeg, platte tekst, geen control-/format-/surrogaattekens,
regel-/paragraafscheiding of HTML-hoekhaakjes. Buitenste spaties worden verwijderd. De editor gebruikt veilige tekstvelden.

## Runtime en uitrol

[Naamstore](../services/admin-overlay/admin/lib/orchestrator-name.js) bewaart de override privaat en publiceert
uitsluitend een gevalideerde whitelist van naam, bron, versie en limiet naar een apart naambestand.
[Adminroutes](../services/admin-overlay/admin/lib/orchestrator-name-routes.js) vereisen een bestaande beheerderssessie,
controleren Origin/Fetch-Metadata bij writes en eisen JSON voor opslaan. Responses zijn no-store.
De publieke GET-route `/api/config/orchestrator/name` bevat alleen naammetadata; de bestaande publieke policy krijgt geen promptvelden.
De chatproxy serveert het publieke bestand onder `/govchat-overlay/orchestrator-name.json`.
Oudere private proxy-overlays kunnen de equivalente `/govchat-api/config/orchestrator/name`-route niet correct doorsturen;
de request-time backendintegratie gebruikt het bestand en is niet van die legacy-doorsturing afhankelijk.
De masterprompt blijft in aparte private opslag en achter de bestaande interne/adminauthenticatie.

[LibreChat-runtime-integratie](../scripts/librechat-orchestrator-name.js) leest het publieke naambestand bij configuratieverzoeken
en past kopieën van endpointlabels en gekoppelde modelSpecs-labels aan, zonder gedeelde caches te muteren.
Daardoor werken admin-save/reset zonder LibreChat-hercreatie: herlaad de chatpagina voor frontend-caches.
Nieuwe requests krijgen de nieuwe configuratie. Bestaande opgeslagen bericht-senders of gesprekstitels worden niet gemigreerd;
handmatig opgeslagen model-/agentlabels kunnen eigen labels houden. Reeds gestarte requests houden hun oorspronkelijke configuratie.
Er is geen DOM-vervanging en geen Docker-socket of containerbeheer vanuit het adminpaneel.

[Compose](../docker-compose.yml) mount uitsluitend de publieke publicatiemap read-only in LibreChat en behoudt de tool-event-preload.
De integratie is gericht op de gepinde LibreChat-configuratie-API; voer bij een LibreChat-upgrade opnieuw endpoint-/modelSpec-/berichttests uit.
Als het optionele admin-overlayprofiel ontbreekt en geen naambestand bestaat, gebruikt LibreChat env/standaard.
Een eerder gepubliceerd naambestand blijft geldig; verwijder bij bewust uitschakelen van adminbeheer uitsluitend dat naambestand
om terug te vallen op env. Corrupt/onleesbaar naambestand veroorzaakt een configuratiefout, geen onbeveiligde fallback.

Bij envwijziging: hercreëer alleen **govchat-overlay-admin** en **librechat** via de echte Compose-entrypoint met
admin-overlayprofiel, zonder build of afhankelijke services. Herstart n8n niet en importeer geen workflows.
Bewaar private backups van actuele omgeving, Compose en lokale patchkandidaten; deze kunnen secrets bevatten.
Bij multi-worktrees: merge de kleine server/editor-aanpassingen in een nieuwe live kandidaat en behoud bestaande auth/disclaimerpatches.
Verwijder eventuele oude startup-labelrendering: die mag niet concurreren met de request-time naam.

## Tests en rollback

[Naamtests](../tests/orchestrator/name-management.test.js), [routetests](../tests/orchestrator/name-routes.test.js) en
[editortests](../tests/orchestrator/name-editor.test.js) controleren voorrang/reset, strikte validatie,
publicatiewhitelist, auth/CSRF, veilige tekst, request-time labels en behoud van IDs.
[Runtime-loadertest](../tests/orchestrator/name-overlay-loader.test.js) controleert met een geïsoleerde store dat
save/reset bij de volgende aanvraag effectief worden, zonder procesrestart of mutatie van gedeelde caches.
Test admin-save/reset uitsluitend met een geïsoleerde store, niet met tijdelijke namen in productie.
Rollback: herstel alleen de naamgerelateerde mounts/loader/configuratie na vergelijking met latere wijzigingen;
raak private prompt, credentials en workflows niet aan. Hercreëer alleen betrokken containers.
