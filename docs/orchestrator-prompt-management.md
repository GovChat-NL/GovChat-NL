# Inhoudelijke orkestrator-masterprompt beheren

Gebruik **GovChat Admin → Orchestrator → Inhoudelijke masterprompt**, niet de n8n-editor.
De bestaande GovChat-inhoudelijke prompt (inclusief chronologische rapportage) blijft actief zolang geen organisatieprompt is ingesteld.

## Voorrang en levenscyclus

1. Private opgeslagen beheerdersoverride.
2. `N8N_ORCHESTRATOR_MASTER_PROMPT` in de omgeving van **govchat-overlay-admin**.
3. De bestaande GovChat-standaard, gebundeld als `services/admin-overlay/admin/lib/orchestrator-prompt-default.json`.

Opslaan is actief vanaf het volgende verzoek, zonder workflowimport of containerherstart. Reset verwijdert de override; de omgevingswaarde wordt **niet** gekopieerd naar opslag. Een lopend verzoek behoudt de al opgehaalde prompt. De editor toont de actieve bron en een tekstpreview van het concept; preview slaat niets op en voert niets uit.

Tekst moet een niet-lege string van maximaal 32.000 UTF-16-code-eenheden zijn. Whitespace en regeleinden blijven intact. Een lege omgevingswaarde betekent niet ingesteld; een whitespace-only omgevingswaarde is ongeldig. Multilinevoorbeeld voor een private `.env`:

```dotenv
N8N_ORCHESTRATOR_MASTER_PROMPT='Eerste regel organisatie-instructies.
Tweede regel organisatie-instructies.'
```

Na wijzigen van de omgeving moet **govchat-overlay-admin opnieuw worden aangemaakt**, niet slechts herstart. Laat n8n en andere services ongemoeid. Controleer eerst de daadwerkelijk gebruikte Compose-bestanden, buildcontexten en bind mounts; lokale overrides kunnen een andere admin-image of serverversie selecteren.

## Beveiliging en technische instructies

De override staat uitsluitend in `DATA_DIR/private/orchestrator-prompt.json`: directory 0700, atomisch vervangen bestand 0600. Geen prompt in `/publish`, openbare `/api/config/orchestrator`, publieke proxyconfiguratie of applicatielogs. Backups bevatten mogelijk vertrouwelijke tekst: private directory 0700, bestanden 0600 en geen commits/publicatie.

- `GET/POST/DELETE /api/orchestrator/prompt`: geauthenticeerde beheerderssessie; mutaties weigeren cross-site verzoeken.
- `GET /api/internal/orchestrator/prompt`: uitsluitend intern Bearer-token `CRAWLER_INTERNAL_TOKEN` (bestaande fallback `N8N_WEBHOOK_TOKEN`). Niet aan browserclients geven.
- Beide API's gebruiken `Cache-Control: no-store`, ook bij authenticatie- en configuratiefouten. De editor haalt de prompt apart op en gebruikt uitsluitend tekst/textarea, geen HTML-rendering of evaluatie van promptinhoud.
- FINAL_ANSWER, gebruikerscontext/privacy, gevalideerde streaming UUID en utility-toolregels worden onafhankelijk toegevoegd. De bestaande TOPdesk-bootstrap voegt bij enabled de TOPdesk-instructies en toolverbinding toe; promptwijzigingen wijzigen dit niet.
- De runtime haalt private configuratie bij **ieder** verzoek op. Onbereikbaar endpoint, ontbrekend token, ongeldige respons of corrupte private opslag breekt het verzoek expliciet af. Geen stille terugval naar env/default bij een aanwezige ongeldige override.
- n8n bewaart voor deze workflow geen succesvolle, mislukte, handmatige of tussentijdse node-resultaten. Zet dit niet opnieuw aan: node-resultaten bevatten de per-request prompt. n8n kan tot de reguliere pruning wel een soft-deleted startrecord met oorspronkelijke webhookinvoer en workflowtemplate bewaren; daarin staat geen opgehaalde runtimeprompt. AI-providerverwerking blijft onderdeel van de normale vertrouwelijke modelverwerking; configureer ook daar geen body/promptlogging.

## Eerste uitrol en rollback

Eenmalig moet de runtime-loader in de actieve orkestrator komen. **Importeer niet alle workflows en gebruik geen algemene force-bootstrap.**

1. Inspecteer actieve containers, Compose-overrides, private mounts en bestaande lokale aanpassingen zonder secrets weer te geven.
2. Maak private backups van de actieve Compose/omgeving, admin-image en gemounte server/view/lib-bestanden, private promptopslag (of leg afwezigheid vast), plus de live orkestratorworkflow en diens actieve versie.
3. Maak een kandidaat-adminoverlay die bestaande deploymentpatches behoudt. Controleer routes, editor, afhankelijkheden en defaultbestand. Voer de tests uit vóór activering.
4. Exporteer uitsluitend workflow-ID `govchat-orchestrator-litellm`. Pas `configurePromptManagement` uit `scripts/orchestrator-prompt-workflow.js` toe op die **live export**. Dit behoudt andere nodes, credentials, TOPdesk, tools en verbindingen; het wijzigt alleen promptopbouw, de bestaande detectienode en privacyinstellingen.
5. Importeer uitsluitend deze kandidaatworkflow en publiceer/activeer diens juiste versie volgens de geïnstalleerde n8n-versie. n8n 2.25.7 genereert tijdens import zelf een nieuwe versie-ID: lees die na import terug of publiceer de huidige versie met `publish:workflow --id=govchat-orchestrator-litellm`, en verifieer dat `versionId` en `activeVersionId` gelijk zijn. Gebruik niet zonder controle de versie-ID uit het kandidaatbestand. CLI-publicatie vereist een n8n-herstart om de gewijzigde versie te laden. Geen credentialimports of wijzigingen aan andere workflows. Controleer een eventuele bootstrapmarker zodat latere starts niet ongemerkt een oude template terugplaatsen.
6. Verifieer defaultbron, weigering zonder token, no-store, ontbreken in publieke configuratie, streamingcorrelatie, utility-tools en enabled TOPdesk. Test admin-save/reset desgewenst eerst geïsoleerd zodat gebruikers niet tijdelijk een testprompt krijgen.

Rollback: herstel de geback-upte admin-image/mounts en private Compose/configuratie, hercreëer uitsluitend de betrokken admin-container, en herstel/importeer/publiceer uitsluitend de geback-upte orkestratorversie. Herstel de override uit de private backup of verwijder deze wanneer hij vóór uitrol afwezig was. Bewaar overige workflows, integraties en credentials ongewijzigd.

## Tests

De nieuwe tests staan in `tests/orchestrator/prompt-management.test.js`, `tests/orchestrator/prompt-routes.test.js` en `tests/orchestrator/prompt-editor.test.js`. Draai deze samen met de chronology-, TOPdesk- en utility-regressietests. De route-tests gebruiken de bestaande admin-afhankelijkheden en een geïsoleerde tijdelijke opslag; ze benaderen geen live beheerconfiguratie.
