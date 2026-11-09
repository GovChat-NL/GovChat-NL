# PR #13: startpagina en Beleidskompas aansluiten op dev

De actuele dev-commit **847d2f6fee871237ffac2aa67a419a3ef048d5e8**, inclusief
de gemergede image-to-image PR #33, is geïntegreerd
in de bestaande featurebranch. Dev is inhoudelijk leidend; de PR voegt de eigen
pagina's voor start en Beleidskompas toe zonder oudere infrastructuur terug te zetten.
De PR is niet automatisch gemerged of naar een draaiende installatie uitgerold.

## Conflictresolutie

- De verplaatste orkestrator behoudt exact de workflowinhoud uit dev, inclusief
  documentcontext, dynamische masterprompt en vertrouwde afbeeldingsidentiteit.
- De [generator](../scripts/update-orchestrator-workflow.js) gebruikt het nieuwe
  workflowpad en behoudt alle dev-builders. Regenereren herstelt ook promptbeheer
  en maakt geen dubbele utility-exports in de nieuwe submap.
- Image-to-image gebruikt exact de actuele dev-workflowtemplates, met behoud van
  bronvalidatie, vertrouwde ownercontext, uploadlimieten, generatie- én editroutes.
  De [image-to-image-tooling](../scripts/enable-image-to-image.js) en bijbehorende
  [n8n-smoketest](../tests/orchestrator/run-image-edit-smoke.js) volgen de verplaatste
  workflowpaden. De regressierunner neemt zowel deze tests als de paginatests mee.
- De [proxyrenderer](../scripts/render-proxy-config.sh) laadt de modulaire overlay.
  De native LibreChat-footer blijft verantwoordelijk voor de chatwaarschuwing;
  verouderde footerinjectie is niet teruggebracht.
- Beide groepen [deploymenttests](../tests/test_deployment_configuration.py)
  blijven behouden: nieuwe pagina's/modules én de huidige dev-footer-/securitypolicy.

## Dev blijft leidend buiten de feature

- Mongo behoudt zijn bestaande bindmount via de dataroot. Geen onbedoelde lege
  database door overstappen op een named volume.
- De bestaande LiteLLM-modelroutes en de voorbeeldomgeving zijn ongewijzigd ten
  opzichte van dev. Er wordt geen nieuw verplicht Azure-modelveld geïntroduceerd.
- De configureerbare workflowdirectory blijft bestaan. De bootstrap ontdekt nu
  ook submappen, bewaart unieke workflow-IDs en importeert na de oude marker opnieuw.
- Utility- en TOPdesk-workflows blijven op hun huidige dev-paden; verwijzingen
  naar verplaatste workflows zijn ook in nieuwe dev-tests en tooling bijgewerkt.
- SSO-only, vertrouwde proxies, minimale UI, prompt-/naambeheer, documentlimieten,
  toolbeleid, afbeeldingsautorisatie en de officiële LibreChat-releasepin blijven intact.

## Gerichte regressies

- [Startpagina](../tests/overlay/start-page.test.js): loginvereiste, veilige chatlink,
  bestaande gesprekcontext, uitgeschakelde/ontbrekende configuratie, ongeldige app-ID's,
  tegelvolgorde en ge-escapete configuratie.
- [Bootstrap en generator](../tests/agents/pr13-bootstrap-integration.test.js):
  recursieve import, unieke IDs, markerupgrade, TOPdesk-integratie, private output
  en behoud van document-, prompt- en afbeeldingslogica bij regeneratie.
- [Native footer](../tests/native-chat-footer.test.js) en
  [branding](../tests/branding/metadata.test.js): modulaire overlay met behoud van dev-footer.
- [Regressierunner](../scripts/run_regressions.py): neemt ook de featuretests mee
  in de bestaande publieke, secretvrije CI-suite; testconcurrency is begrensd.

De tests gebruiken uitsluitend broncode, tijdelijke fixtures en geïsoleerde
containers/netwerken. Geen deploymentconfiguratie, providerkeys of productievolumes
zijn in de tests of de PR opgenomen. Zie [UPGRADE.md](../UPGRADE.md) voor uitrol
en de bekende beperkingen van Beleidskompas als eerste versie.
