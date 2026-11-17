# Waarschuwing via de ingebouwde LibreChat-footer

GovChat gebruikt de ingebouwde CUSTOM_FOOTER-instelling van de gepinde LibreChat-versie.
De standaard is:

> GovChat-NL kan fouten maken. Controleer belangrijke informatie.

De [Compose-configuratie](../docker-compose.yml) gebruikt de appnaam uit APP_TITLE bij
het aanmaken van LibreChat. De standaard blijft generiek; organisatiekeuzes horen in
de private omgeving, niet in de repository.

## Instellen en uitschakelen

- Niet ingesteld: de waarschuwing met de ingestelde APP_TITLE wordt gebruikt.
- Eigen tekst: stel CUSTOM_FOOTER in de private omgeving in op de gewenste tekst.
- Uitschakelen: stel CUSTOM_FOOTER expliciet in op een lege waarde. De hoofdtekst
  verdwijnt; eventueel geconfigureerde privacy- en voorwaardenlinks blijven bestaan.

Het [omgevingsvoorbeeld](../.env.example) laat de instelling bewust uitgecommentarieerd.
Een lege instelling is een bewuste override, geen verzoek om de standaard te gebruiken.
De Compose-interpolatie bewaart daarom expliciet lege waarden.

LibreChat rendert de footer zelf, ook in de minimale interface. De normale upstream
responsive zichtbaarheid blijft behouden: de standaard footer is verborgen op kleine
schermen en zichtbaar vanaf de sm-breakpoint. Er wordt geen extra zichtbaarheid afgedwongen.
De ingebouwde footer ondersteunt Markdown en gebruikt een verticale streep als
sectiescheiding; dit is geen gegarandeerde platte-tekstweergave. Gebruik voor een
eenvoudige waarschuwing gewone tekst. Raw HTML wordt niet als HTML uitgevoerd.

## Migratie vanaf de overlay uit PR #26

De aparte disclaimerloader, CSS, publieke UI-policy, admin-schakelaar en bijbehorende
polling/DOM-vervanging vervallen. Een oude showChatDisclaimer-instelling wordt niet
meer gelezen en wordt niet automatisch naar de omgeving gemigreerd. Stel bij een
eerder uitgeschakelde waarschuwing expliciet een lege CUSTOM_FOOTER in.

Na wijzigen van de omgeving moet LibreChat opnieuw worden aangemaakt via de werkelijk
gebruikte Compose-entrypoint; een gewone herstart laadt geen nieuwe containeromgeving.
Herlaad daarna de chatpagina. Voor het verwijderen van de oude overlay verwijzen
de nieuwe proxyconfiguratie en admin-assets niet meer naar de disclaimerbestanden:
laat de gebruikelijke releaseprocedure die aangepaste proxyconfiguratie en adminversie
activeren. Oude bestanden in persistente overlayvolumes mogen blijven staan, maar
worden niet meer geladen. Zorg dat private proxy-overrides geen oude disclaimerinjectie
behouden. Deze PR voert geen uitrol, bestandsverwijdering in private volumes of
containerhercreatie uit.

Er is geen directe admin-save/reset of automatische aanpassing bij runtimebranding
meer: tekst/appnaamwijzigingen vereisen de genoemde containerhercreatie. Auth, help/app
overlay, prompt-/naambeheer, tool-events en workflows worden niet gewijzigd.

## Tests

De [Compose-regressies](../tests/test_deployment_configuration.py) controleren standaard,
eigen appnaam, override, lege waarde en de minimale interface. De
[native footertests](../tests/native-chat-footer.test.js) controleren dat de oude laag
verdwijnt en renderen de echte footerbron uit het gepinde LibreChat-image met React SSR,
inclusief lege tekst, juridische links en veilige HTML-behandeling. Dit is geen volledige
browser-/Entra-test en geen live deploymenttest.
