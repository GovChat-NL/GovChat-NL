# PR #13: conflictkeuzes en integratiecontrole

De bronbranch feature/beleidskompas-sprint-1 is samengevoegd met dev als normale
merge, zonder rebase of force-push. Dit document beschrijft de inhoudelijke
conflictoplossing; het is geen deployment- of merge-opdracht voor GitHub.

## Zes conflicten

| Bestand | Keuze |
| --- | --- |
| [README](../README.md) | Beide: eigen Beleidskompas-pagina, startscherm, Makefile en upgradehandleiding uit de PR; TOPdesk, huisstijl, vertalingen en configureerbare deployment uit dev. |
| [Compose](../docker-compose.yml) | PR: alleen-lezen mount van modulaire frontend, named Mongo-volume en instelbaar Azure-chatmodel. Dev: template-rendering, configureerbare ingress/trust/dataroot/netwerk, SSO, minimale UI en TOPdesk/utility-omgeving. De verwijderde configureerbare workflowdirectory keert niet terug. |
| [Bootstrap](../n8n/bootstrap.js) | PR: vaste monorepo-workflowdirectory en recursieve ontdekking. Dev: TOPdesk-credentials, templates, opt-in activatie en gerichte herimport bij vlagwijziging. Nieuwe marker v8 importeert de gecombineerde exports na beide ouderversies; rendering maakt private submappen aan. |
| [Proxytemplate](../nginx/librechat-overlay.conf) | Beide: PR-routes voor startscherm, Beleidskompas en modules; dev-beveiliging, brandingcachebeleid, runtime-DNS, beheerroutes en minimale stylesheet. De renderer injecteert modules in normale modus, uitsluitend minimale stijlen in minimale modus. |
| [Overlay](../overlay/src/overlay.js) | PR: modulaire imports en zelfstandig app/startschermgedrag. Dev: deploymenthuisstijl voor applicatienaam en footer. De vervallen inline Beleidskompas-configuratie wordt niet teruggezet. |
| [Adminserver](../services/admin-overlay/admin/server.js) | PR: frontendcode wordt niet meer gepubliceerd; Beleidskompas-configuratie en feedback blijven behouden. Dev: genormaliseerde utility-policy en atomaire publicatie, inclusief invalidatie bij fouten. De oude raw-codepublicatiefunctie vervalt. |

## Aanvullende integratiecorrecties

- [Proxy-renderer](../scripts/render-proxy-config.sh) verwijst naar de modulaire
  frontend, niet naar de oude gepubliceerde loader.
- De nieuwe dev-tests en [OpenBesluitvorming-handleiding](openbesluitvorming-public-links.md)
  gebruiken de verplaatste orchestrator-/OpenBesluitvorming-paden.
- Utility- en TOPdesk-exports blijven op hun bestaande vlakke dev-locaties;
  recursieve ontdekking ondersteunt dit naast de gegroepeerde PR-workflows.
  [De orchestrator-generator](../scripts/update-orchestrator-workflow.js) schrijft
  utility-exports op diezelfde locaties, zodat geen dubbele IDs ontstaan.
- [Upgrade-instructies](../UPGRADE.md) en [deploymentconfiguratie](deployment-configuration.md)
  verduidelijken named Mongo-opslag versus dataroot, en Beleidskompas versus
  optionele minimale modus.
- De automatisch samengevoegde orchestrator behoudt TOPdesk, utility-tools en
  chronologische instructies; de verplaatste OpenBesluitvorming-exports behouden
  de officiële Limburg-links. Retentie, huisstijl, vertalingen en beheeropties
  uit dev blijven behouden.

## Regressiedekking en grenzen

- [Bootstrap-integratie](../tests/agents/pr13-bootstrap-integration.test.js):
  gemengde directorystructuur, unieke IDs, upgrade van beide markers,
  idempotentie, private submap-rendering en veilige generatoruitvoer.
- [Deployment-/proxytests](../tests/test_deployment_configuration.py): opslag,
  mounts, normale en minimale modus, losse pagina's/modules, headers, SSO,
  admin-API-pad/query-rewrite, trustgrenzen en runtime-DNS.
- [Brandingtests](../tests/branding/metadata.test.js): de modulaire overlay
  behoudt deploymentbranding en de renderer gebruikt geen oude loader.
- [Admin-integratie](../tests/orchestrator/utility-server.test.js): genormaliseerd
  beleid, private feedback zonder opgeslagen gebruiker-/gesprek-ID en beschermd
  uitlezen; publieke configuratie bevat geen frontendcode of feedback.
- De bestaande LibreChat-test controleert vereiste handlerparameters binnen de
  juiste aanroep in plaats van één specifieke upstream-parameter-volgorde.

Tests gebruiken wegwerpcontainers, afzonderlijke tijdelijke data en een intern
testnetwerk, zonder productievolumes, hostpoorten of service-restarts. De adminimage
wordt alleen lokaal onder een afzonderlijke testtag gebouwd.

Geen live SSO-providerlogin, echte LLM/Azure-aanroep, Mongo-datamigratie, n8n-import
in productie of deployment is uitgevoerd. Beleidskompas-stappen 2–4 blijven
onuitgewerkt zoals in de PR. Feedback-POST blijft bewust zonder authenticatie;
vrije tekst kan persoonsgegevens bevatten en er is geen tijdgebaseerde retentie
(wel de bestaande limiet van 500 items). Dat bestaande risico is niet uitgebreid
of als opgelost voorgesteld.

## Uitgevoerde checks

- 85 Node-regressie-/integratietests: geslaagd, geen skips; gepinde n8n 2.25.7
  met de calculator-/policymounts uit Compose, lokale lockfile-afhankelijkheden
  en LibreChat-bronfixtures uit de v0.8.7-image.
- 34 Beleidskompas-logictests en 12 frontendtests: geslaagd op Node 20.
- 28 Python-tests inclusief opt-in geïsoleerde proxyintegratie: geslaagd, geen skips.
- 21 workflowexports/21 unieke IDs, TOPdesk-structuur en secret-hygiene: geslaagd.
- Branding-shellsuite, 49 vertaaloverridecontroles en echte LibreChat
  locale/i18next-loadercheck: geslaagd.
- Compose-configuratie met voorbeeldomgeving, JavaScript-/modulesyntax en
  admin-imagebuild: geslaagd.

De definitieve runs vervangen de eerste fixture-/mountgerelateerde mislukkingen.
De bestaande LibreChat-parameterassertie is inhoudelijk aangescherpt, niet
uitgeschakeld. De eindregel van [de TOPdesk-handleiding](topdesk-knowledge-items.md)
is genormaliseerd voor de staged whitespacecheck.
