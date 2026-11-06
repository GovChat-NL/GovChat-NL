# v0.8.8 tijdelijke rollout en mergevoorwaarden

## Uitgevoerde omschakeling

Na de [geïsoleerde upgradeacceptatie](librechat-v0.8.8-upgrade.md) is op expliciet
verzoek een tijdelijke v0.8.8-kandidaat op de bestaande deploymentadressen gestart.
Daarvoor zijn oude chatapp en retentiewerker gestopt en een Mongo-snapshot gemaakt.
De oude containers/images blijven beschikbaar. Databases, ingress, configuratie
en credentials zijn niet vervangen; een nieuwe Entra-callback is niet toegevoegd.

Dit is een tijdelijke runtimeomschakeling, **geen Git-merge**. De dev-bron en
private omgeving zijn niet naar de upgradebranch omgezet. De extra localhost-
teststack is gestopt. De beheerder gebruikt nu het bestaande deploymentadres.
De reguliere rootdeployment mag niet blind naast de kandidaat worden gestart.

## Aanvullende acceptatie

- Bestaande ingress en HTTPS-configroute geven 200.
- Browser op die HTTPS-ingress: echte synthetische sessieverversing 200, juiste
  branding, één zichtbare native footer, chatinvoer zichtbaar, geen legacy-
  disclaimer of JavaScriptfouten. Geen TLS-bypass of gemockte authbootstrap.
- Authgrenzen: Microsoft-startredirect 302, onbevoegde gebruikers-/Agents-routes
  401, wachtwoordlogin 403. Dit vervangt geen echte Microsoft-login of Graph-sharing.
- De werkelijk bestaande orchestrator/bridge/gateway geeft met de calculator 42.
- Tika haalt de synthetische documenttekst correct uit de input, met status 200.
- Beeldgeneratie is werkelijk getest. Daarbij bleek een bestaande requestfout:
  GPT Image weigert de DALL-E-parameter response_format. De
  [requestgenerator](../scripts/harden-image-workflow.js) en
  [workflowbron](../agents/n8n/workflows/image-generator-litellm.json) zijn gericht
  gecorrigeerd. [Acht model-/providerregressies](../tests/image-request-compatibility.test.js)
  bewaken zowel GPT Image als DALL-E voor OpenAI- en Azure-requestvormen.
- Alleen de overeenkomstige gepubliceerde beeldworkflow is na een n8n-backup
  aangepast en herpubliceerd. De hercontrole geeft 200 met een geldige afbeelding,
  ownerdirectory 0700 en bestand 0600. Geen credentialimport of andere workflowwijziging.

Tijdelijke synthetische accounts/sessies en gegenereerde testbestanden worden
gericht opgeruimd; er wordt geen bestaande gebruikersdata verwijderd.

### Laatste regressiestand

Na de beeldfix is de volledige geïsoleerde runner opnieuw uitgevoerd:
**71 chat-/runtime-/requesttests, 40 adminregressies, 5 n8n-integratieregressies
en 53 Python-/configuratie-/proxytests**, alle geslaagd zonder skips.
De 7 private Entra-tokenregressies zijn afzonderlijk herhaald en geslaagd.
Totaal **176 regressietests**, daarnaast 49 vertaalchecks en de echte locale-loader.
Deze groene regressies vervangen de hieronder genoemde externe acceptatie niet.

## Open voorwaarden — niet als geslaagd presenteren

1. **Spraakprovider:** de bestaande transcriptiegateway geeft 500 omdat zijn
   Azure-endpoint ontbreekt. De rechtstreekse gatewayaanroep bevestigt dezelfde
   fout. Geef een juiste providerconfiguratie en test transcriptie/realtime opnieuw,
   of accepteer expliciet dat deze functie buiten de huidige vrijgave valt.
   De upgrade heeft de gatewayconfiguratie niet gewijzigd.
2. **Documentretrieval:** native LibreChat-RAG is niet geconfigureerd. Tika is
   getest, maar volledige retrieval via de interne documentzoekworkflow is niet
   bewezen. Configureer geen nieuwe RAG-stack impliciet tijdens een image-upgrade.
3. **Entra-acceptatie:** de bestaande callback blijft bruikbaar op hetzelfde
   deploymentadres. Echte login/logout, rolmapping, sessieherstel en Graph-sharing
   moeten met een bevoegde Microsoft-testsessie worden bevestigd, of expliciet als
   resterend acceptatierisico worden vastgelegd. Geen nieuwe callback vereist.
4. **Private overlay:** neem bij definitieve deploymentmigratie de gerichte
   v0.8.8-sharing-patch mee. De oude volledige v0.8.7-controller terugplaatsen
   verwijdert nieuwe upstream people-picker-typebeperkingen en is niet toegestaan.
5. **Definitieve deployment:** actualiseer de dev-diff, controleer CI en migreer
   het lokale root-entrypoint/private overrides gericht. Pas na expliciete
   rolloutacceptatie de tijdelijke runtimekandidaat opruimen; behoud backups.

De code kan worden gereviewd terwijl deze punten worden afgehandeld. Dit rapport
claimt geen volledig groene integratievrijgave en voert geen PR, push of merge uit.

## Rollback

De private rollbackprocedure controleert de oude containeridentiteiten, stopt
eerst de kandidaat en start daarna v0.8.7. Databaseherstel wordt nooit automatisch
aan een latere gewone rollback gekoppeld: een snapshotherstel verliest writes na
die snapshot. Bij expliciet goedgekeurd herstel eerst de actuele database bewaren.
Gegevens en configuratie die inmiddels door gebruikers/beheerders zijn gewijzigd
niet blind uit oude archives terugzetten.

## Snel bijtrekken bij volgende releases

Gebruik de [herhaalbare upgradeprocedure](librechat-upgrades.md): dagelijkse
read-only controle van officiële releases en manifests, expliciete voorbereiding
van beide gesynchroniseerde imagepins en een volledige geïsoleerde regressierun.
CI merge/deployt niet automatisch. Nieuwe upstreamcontracten moeten zichtbaar
falen in tests, niet stilzwijgend worden overgeslagen.
