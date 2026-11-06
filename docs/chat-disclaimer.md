# Waarschuwing onder de chatinvoer

De LibreChat-versie en slogan onder de chatinvoer worden vervangen door:

> &lt;appnaam&gt; kan fouten maken. Controleer belangrijke informatie.

De appnaam komt uit de bestaande brandinginstelling. De tekst is gewone tekst,
zonder link of versienummer. De waarschuwing staat **standaard aan**.

## Aan- of uitzetten

Open het beheerdashboard, wijzig onder **Chatwaarschuwing** de optie
**Waarschuwing onder chatinvoer tonen** en kies **Opslaan**. Dit is een
omgevingsbrede instelling, geen persoonlijke gebruikersvoorkeur.

Open chats nemen de wijziging binnen 30 seconden over; na vernieuwen van de
pagina wordt de instelling direct opgehaald. Uitgeschakeld verdwijnt de hele
waarschuwing, inclusief de oorspronkelijke LibreChat-tekst.

De instelling wordt opgeslagen in de overlay-configuratie en blijft behouden na
een herstart. Zonder beheerportaal kan een beheerder de onderstaande configuratie
in de gepubliceerde overlay-map plaatsen. Bij gebruik van het beheerportaal is de
opgeslagen beheerconfiguratie leidend.

```json
{
  "showChatDisclaimer": false
}
```

Bij een ontbrekende configuratie blijft de waarschuwing standaard zichtbaar. Bij
een tijdelijke ophaalfout blijft de laatst geladen instelling actief.

## Ingebruikname

Herbouw het overlay-beheerportaal en start het met de gebruikelijke
deploymentconfiguratie. Het portaal synchroniseert bij het starten de nieuwe
overlay-assets en publiceert de instelling. Er is geen LibreChat-fork of
wijziging aan de database nodig. Vernieuw de chatpagina om de nieuwe loader op te
halen; de bestaande proxycache voor overlay-assets heeft maximaal vijf minuten
levensduur.

## Tests

De tests controleren de Nederlandse tekst, appnaam, standaardwaarde, aan/uit,
routewisselingen, opnieuw renderen, tijdelijke ophaalfouten, toegangscontrole,
validatie en behoud van de instelling na herstart.

```sh
NODE_PATH=services/admin-overlay/admin/node_modules node --test tests/chat-disclaimer.test.js
```

De geïsoleerde Chromium-test controleert ook de daadwerkelijke zichtbaarheid,
routewisselingen, opnieuw renderen en veilige weergave van de appnaam. Hiervoor
zijn Python, Playwright en Chromium nodig.

```sh
python tests/test_chat_disclaimer_browser.py
```
