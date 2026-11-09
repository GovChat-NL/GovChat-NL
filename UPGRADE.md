# PR #13 bovenop dev installeren

Dev is de leidende basis. Deze PR voegt de startpagina en de eerste versie van
Beleidskompas toe; bestaande Mongo-opslag, modelaliases en deploymentinstellingen
blijven behouden. Maak vóór de uitrol een consistente back-up van configuratie,
databases en uploads. De PR verplaatst geen bestaande gebruikers of gesprekken.

## Wat blijft behouden

- De Mongo-bindmount via de bestaande dataroot: geen overstap naar een leeg volume.
- De bestaande Azure-modelconfiguratie en aliases, inclusief het vision-model.
- De configureerbare workflowdirectory, vertrouwde proxies en SSO-only-policy.
- De dev-versies van documentcontext, prompt-/naambeheer, afbeeldingsauthenticatie
  en de native chatfooter. De losse pagina's zijn geen nieuwe autorisatiegrens.

## Wat komt erbij

- De configureerbare startpagina en de aparte Beleidskompas-pagina.
- Een extra LibreChat-endpoint en bridge-route voor Beleidskompas.
- Modulaire overlayassets, die de proxy read-only uit de broncheckout serveert.
- Gegroepeerde workflowexports en een recursieve bootstrap. Bestaande workflow-IDs
  blijven hetzelfde; utility- en TOPdesk-exports blijven op hun dev-paden staan.
- Een nieuwe bootstrapmarker zodat de gewijzigde workflows eenmaal worden geladen.

## Uitrol

1. Lees de uiteindelijke PR-diff en maak een consistente back-up.
2. Controleer de samengestelde deployment inclusief eigen private overrides.
3. Hermaak de LibreChat-applicatie, proxy, bridge en eventuele overlay-admin zodat
   het extra endpoint, de routes en de modulaire assets worden geladen.
4. Start de workflowbootstrap en wacht op een succesvolle exit. Herstart daarna
   n8n wanneer de bootstrap aangeeft dat publicatiewijzigingen dat vereisen.
5. Controleer login/SSO, beide losse pagina's, de chattegel, eerdere casussen,
   gewone chat, document-/afbeeldingsverwerking en het gekozen model.

De proxy moet de modulaire bronassets read-only mounten. De overlay-admin publiceert
nu configuratie en handleidingen, geen kopieën van JavaScript of stylesheets.
Gebruik de nieuwe proxy en overlay-admin daarom samen. De startpagina is alleen
actief als de bestaande appconfiguratie die inschakelt en tegels selecteert.
Bij de eerste installatie zonder overlay-admin blijven de gewone chat en login
werken; een ontbrekende appconfiguratie mag geen redirectlus veroorzaken.

## Beperkingen van deze eerste versie

Beleidskompas-stap 1 gebruikt nog voorbeeldpassages. Stappen 2–4 zijn nog niet volledig
uitgewerkt. Feedbackopslag en verdere productiehardening verdienen afzonderlijke
review; deze conflictresolutie maakt van de eerste versie geen volledig afgeronde
beleidsapplicatie. Test echte modelaanroepen en interactieve SSO in de eigen omgeving.
