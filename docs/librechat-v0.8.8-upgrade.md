# LibreChat v0.8.8 upgradekandidaat

## Status en scope

Gecontroleerd op 6 november 2026 in een afzonderlijke werkboom en op branch
**upgrade/librechat-v0.8.8**, gebaseerd op dev-commit
**e6ab1e86a1812a32cbcf61a15cce65f8ec690024**.

De kernintegratie is getest en de branch is voorbereid voor review. Dit is
**geen vrijgave van de volledige dev-deployment**: de acceptatievoorwaarden
onderaan moeten eerst worden afgehandeld. Geen PR, push, merge of live-upgrade
is onderdeel van deze uitvoering.

De [upstreamrelease](https://github.com/LibreChat-AI/LibreChat/releases/tag/v0.8.8)
verplaatst de officiële images naar de organisatie LibreChat-AI. GitHub markeert
deze release als prerelease; de gekozen tag is exact v0.8.8, geen release
candidate, dev-image of zwevende latest-tag.

- Applicatie en retentiewerker in [de deployment](../docker-compose.yml:12)
  gebruiken beide **registry.librechat.ai/librechat-ai/librechat:v0.8.8**.
- Gecontroleerde manifestdigest:
  **sha256:5b706bcee1ca154a1e2987303aaeca0eb27f97919cccee4bb604226c2f8abf61**.
- De oude registrynaam van danny-avila bevat geen v0.8.8-tag en geeft daarvoor
  een onbekend manifest. Alleen het versienummer vervangen is dus onvoldoende.
- Overige diensten zijn niet geüpgraded. Het optionele RAG-image en de
  bijbehorende diensten vallen buiten de uitgevoerde runtimeacceptatie.

## Compatibiliteit

De bestaande branding-, vertaal-, minimale-UI-, request-time naam- en
tool-eventoverlays werken met het officiële image; er is geen LibreChat-fork
of custom applicatiebuild nodig. Beide tool-eventmodules zijn daadwerkelijk
geladen bij startup en met een echte calculatorvraag getest.

De v0.8.8-footer is een anders gepositioneerde band en gebruikt niet meer de
oude contentinfo-rol. De [footertests](../tests/native-chat-footer.test.js)
controleren daarom de werkelijke tekst, enkelvoudige rendering, zichtbaarheid
en de nieuwe contracten voor gesprekweergave en aangeleverde startupconfiguratie.
De operatorwaarschuwing blijft ook in een gesprek zichtbaar. Expliciet lege
footerwaarden en juridische links blijven ondersteund.

De [tool-eventtests](../tests/librechat-tool-event-overlay.test.js) kunnen nu
de werkelijke bron in het officiële image gebruiken, naast een expliciete
upstreamwerkboom. De [runtime-interfacetests](../tests/librechat-runtime-compatibility.test.js)
laden de echte config- en retentie-exportfuncties, zonder databaseverbinding.
De [Compose-regressie](../tests/test_deployment_configuration.py) bewaakt dat
applicatie en retentiewerker dezelfde officiële release gebruiken.

### Private Entra-integratie

Een bestaande private sharing-patch mag **niet** als volledige v0.8.7-controller
over v0.8.8 heen worden gemount. In v0.8.8 is principal-search verplaatst naar
een gedeelde functie met expliciete people-picker-typebeperkingen.

Voor de lokale test is een private patch opnieuw opgebouwd op de v0.8.8-controller:
permission-updates gebruiken bij voorkeur het sessie-API-token; principal-search
gebruikt een gerichte wrapper met dezelfde tokenkeuze. De originele requestheaders
blijven ongewijzigd en de nieuwe gebruikers-, groeps- en roltypebeperkingen blijven
behouden. Deze organisatiegebonden patch staat **niet in deze branch** en moet
bij de latere private deploymentmigratie gericht worden meegenomen.

## Testbewijs

| Controle | Resultaat |
| --- | --- |
| Chat, retentie, branding, minimale UI, footer, tool-events, agentworkflows en echte runtime-exportfuncties | 61/61 |
| Admin-, naam-, prompt- en utilityregressies in het eigen admin-image | 40/40 |
| Gepinde n8n-runtime, inclusief echte calculatorpatch | 5/5 |
| Python-/Compose-/beveiligings-/proxytests met Docker-integratie ingeschakeld | 27/27, geen skips |
| Private Graph-tokenkeuze en behoud van people-picker-types, met gestubde Graph-aanroepen | 7/7 |
| Nederlandse vertaaloverridecontroles | 49 checks geslaagd |
| Echte v0.8.8-locale-module, serviceworker en i18next-loader | Geslaagd |

Totaal **140 regressietests**, daarnaast de 49 vertaalchecks en de
image-loader-/browser-/HTTP-controles. De suites draaien in hun eigen runtimes;
admin-afhankelijkheden worden niet ten onrechte uit het LibreChat-image verwacht.
Hostuitvoering van de native bron-/interfacetests zonder een upstreamwerkboom is
geen vervanging voor uitvoering tegen het officiële image.

### Echte browser- en API-controles

- Native lokale sessieverversing geeft 200; browser-authbootstrap is niet gemockt.
  Dit is een synthetische lokale testsessie, **geen volledige Entra-doorloop**.
- Branding, publieke orchestratornaam en de private masterprompt zijn behouden.
  Prompttoegang is geauthenticeerd en gebruikt no-store; cross-site schrijfverzoeken
  worden geweigerd met 403. Alleen promptvergelijkingsresultaten zijn gerapporteerd.
- Precies één zichtbare native waarschuwing op de landingspagina en behoud ervan
  in een bestaand gesprek; geen legacy-disclaimercomponenten of -assets.
- Twee korte echte modelvragen via de geïsoleerde bridge en gateway: een kort
  antwoord en een calculatorvraag. De calculator geeft 42 en verschijnt als native
  toolkaart. Geen zichtbare sidebandmarkeringen en geen JavaScriptfouten.
- De testworkflow is een afzonderlijke minimale streaming-orchestrator met alleen
  de calculator. Geen productie-workflow- of credentialimport en geen externe
  schrijfacties. Deze smoke-test bewijst niet alle productie-agentworkflows.
- Zowel minimale als volledige UI gecontroleerd. In de volledige UI: testagent
  aanmaken 201, lezen als eigenaar 200, lezen als andere gebruiker 403.
- Een synthetische PNG-upload geeft 200 en verschijnt in de eigen bestandslijst.
  De afbeelding is niet naar een model gestuurd. Dit bewijst geen OCR of RAG.
- Zoekdienst actief; gerichte geschiedeniszoekopdracht vindt precies het
  synthetische migratiegesprek.
- Zonder sessie: gebruikers- en Agents-routes 401; wachtwoordlogin 403.
  Entra-start geeft een HTTPS-redirect 302 naar Microsoft, zonder callbackdoorloop.

Eerdere testprobes met onvoldoende mountrechten, onjuiste routes, ontbrekende
runtime-testconfiguratie en een onjuiste verwachte promptinstelling zijn gecorrigeerd
en opnieuw uitgevoerd. Alleen de succesvolle hercontroles gelden als bewijs.

## Testisolatie en rollback

De private omgeving is lokaal gekopieerd met rechten 0600 en blijft buiten Git.
Alle testcontainers, het netwerk, de poorten en de schrijfbare opslag zijn
afzonderlijk. De teststack heeft geen mounts naar schrijfbare live data en is niet
aan het live netwerk verbonden. Managementpoorten zijn uitsluitend loopback.

De kunstmatige testlimiet van 192 MiB voor de retentiewerker veroorzaakte na een
herstart een geheugenoverschrijding. Alleen in de private testdeployment is die
limiet verhoogd naar 512 MiB; startup en draaiende status zijn daarna opnieuw
geverifieerd zonder OOM. De publieke/live deployment heeft hiermee geen nieuwe
geheugenlimiet gekregen. Controleer voldoende resourceheadroom bij de rollout.

**Start niet blind de standaard Compose-deployment vanuit een tweede werkboom met
een gekopieerde omgeving.** De originele absolute datapaden, netwerknamen en
containernamen kunnen dan nog naar live verwijzen. Gebruik alleen een vooraf
gecontroleerde private geïsoleerde deployment. Publiceer nooit een gerenderde
private Composeconfiguratie, omgeving, sessie, databasearchive of prompt.

De migratieoefening gebruikte een synthetische gebruiker, gesprek en berichten
die met de eigen v0.8.7-modellen zijn aangemaakt en via HTTP zijn gecontroleerd.
Na de upgrade naar v0.8.8 blijven gesprekidentiteit en berichtinhoud behouden.

Rollback is daadwerkelijk geoefend: testapp en retentiewerker stoppen, de vooraf
gemaakte v0.8.7-testsnapshot herstellen, v0.8.7 starten en de originele berichten
via HTTP vergelijken. Daarna is de afzonderlijk bewaarde v0.8.8-testdatabase
hersteld en de testapp opnieuw op v0.8.8 gecontroleerd. Geen live database of
volume is hersteld of verwijderd. Deze kleine fixture is geen bewijs voor een
volledige historische productiedataset of een databehoudende in-place downgrade.

De eindmeting bevestigt een ongewijzigde dev-commit, schone dev-werkboom,
byte-identieke live omgeving en ongewijzigde identiteit, image en starttijd van
alle oorspronkelijke containers.

## Vrijgavevoorwaarden voor de latere dev-PR

1. Echte Entra-login met een goedgekeurde testcallback, logout, sessieherstel,
   vereiste rol, adminrol, Graph-groeps-/personenzoeken en werkelijk delen testen.
   De zeven private tokenregressies vervangen dit niet.
2. De private sharing-patch gericht op v0.8.8 migreren en opnieuw beoordelen;
   nooit de oude volledige controller terugplaatsen.
3. Alle voor de dev-installatie noodzakelijke productie-agentworkflows,
   document/RAG-verwerking, transcriptie/realtime en beeldgeneratie apart testen.
   Deze functies zijn in deze uitvoering niet end-to-end bewezen.
4. Een consistente, private backup en representatieve datamigratie voor de echte
   dev-dataset voorbereiden, inclusief herstelplan en toegestane onderhoudsperiode.
   Rollback naar een snapshot verliest writes die na die snapshot zijn gedaan.
5. Nieuwe upstreamfuncties zoals scheduled chats, code workspaces en plugins niet
   impliciet activeren; tenant- en permissiebeleid afzonderlijk beoordelen.
6. De branch opnieuw vergelijken met de dan actuele dev-tak en alleen de publieke
   code-, test- en documentatiewijzigingen in de PR opnemen.
