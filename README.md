# GovChat-NL

<p align="center">
  <a href="https://govchat-nl.github.io/">
    <img src="https://govchat-nl.github.io/img/banner.png" alt="GovChat-NL — AI voor de Nederlandse overheid" width="100%" />
  </a>
</p>

GovChat-NL is een open platform waarmee Nederlandse overheidsorganisaties AI-toepassingen kunnen beheren en gebruiken. De webomgeving is gebaseerd op LibreChat. Workflows en agents draaien in n8n; LiteLLM verbindt de toepassing met taalmodelaanbieders.

## Wat kun je ermee?

- **Chatten met taalmodellen** vanuit de GovChat-NL-webomgeving.
- **Apps en agents gebruiken** die zijn opgebouwd uit n8n-workflows, waaronder de Versimpelaar en live transcriptie.
- **Zelf de modelaanbieder kiezen** via LiteLLM, bijvoorbeeld Azure OpenAI of andere ondersteunde aanbieders.
- **Verantwoord werken met AI** met aandacht voor AI-geletterdheid en de Nederlandse overheidscontext; zie de [AI-geletterdheidshandleiding](https://govchat-nl.github.io/docs/ai-geletterdheid).
- **De toepassing zelf beheren** met Docker Compose, inclusief de configuratie, verbindingen en workflow-import.

### Live tool-calling in de chat

Wanneer een n8n-agent tijdens een gesprek een tool gebruikt, toont LibreChat die aanroep direct als een eigen toolkaart in de chat. De gebruiker ziet de tool starten, de voortgang en het resultaat of de foutmelding; de gewone tekst van de assistent blijft leesbaar. Dit werkt door de samenwerking tussen de GovChat-bridge, n8n en de LibreChat-interface.

De architectuur en controlepunten staan in [Live tool-calling](docs/live-tool-calling.md).

## Verbonden systemen

| Systeem | Rol binnen GovChat-NL |
| --- | --- |
| [LibreChat](https://www.librechat.ai/) | Webomgeving voor gesprekken, bestanden en agents. |
| [GovChat n8n-bridge](https://github.com/GovChat-NL/n8n-openai-bridge) | Verbindt LibreChat via een OpenAI-compatibele koppeling met n8n en geeft toolgebeurtenissen terug voor de live toolkaarten. |
| [n8n](https://n8n.io/) | Voert agents, tools en andere geautomatiseerde workflows uit. De meegeleverde workflows worden bij het starten ingeladen. |
| [LiteLLM](https://github.com/BerriAI/litellm) | Verbindt GovChat-NL en n8n met de gekozen taalmodellen. |
| [OpenBesluitvorming](https://github.com/ontola/openbesluitvorming) · [website](https://openbesluitvorming.nl/) | Project voor het ontsluiten en doorzoeken van openbare besluitvormingsinformatie; GovChat-workflows kunnen hierop aansluiten. |
| Microsoft Entra ID | Optionele SSO-koppeling; vereist inrichting voor de eigen organisatie. |

## Apps en workflows

De installatie bevat onder andere workflows voor:

- **Versimpelaar** — helpt teksten begrijpelijker te maken.
- **Live transcriptie** — zet audio om naar tekst via de geconfigureerde spraak- en modeldiensten.
- **Afbeeldingsgeneratie** — optioneel in te schakelen.
- **OpenBesluitvorming** — workflows voor zoeken en werken met besluitvormingsinformatie; de organisatie configureert zelf de gegevensbron en toegang.

## Snel starten

1. Installeer Docker Engine met de Compose-plugin.
2. Maak een lokale `.env` op basis van [`.env.example`](.env.example) en vul sterke, unieke wachtwoorden, tokens en providergegevens in. Deel of commit dit bestand niet.
3. Haal de GovChat-bridge op naast deze repository:

   ```sh
   git clone --depth 1 --branch main https://github.com/GovChat-NL/n8n-openai-bridge.git ../n8n-openai-bridge-main
   ```

4. Controleer de Compose-instellingen en start de toepassing:

   ```sh
   docker compose --env-file .env config --quiet
   docker compose --env-file .env up -d
   ```

Lees daarna de [omgevingsvariabelen](https://govchat-nl.github.io/docs/handleidingen/librechat-omgevingsvariabelen), de [snelle start](https://govchat-nl.github.io/docs/handleidingen/librechat-pre-release) en het [overzicht van de containers](docs/services.md). Open poorten, SSO, secrets, gegevensbewaring en back-ups moeten bij de eigen organisatie-inrichting passen.

## Documentatie en bijdragen

- [GovChat-NL-documentatie](https://govchat-nl.github.io/)
- [Architectuur](https://govchat-nl.github.io/docs/architectuur/librechat)
- [Containeroverzicht](docs/services.md)
- [Bijdragen aan agents en workflows](agents/CONTRIBUTING.md)
- [Bridge voor n8n](https://github.com/GovChat-NL/n8n-openai-bridge)

De oude OpenWebUI-installatie staat in [GovChat-NL-legacy](https://github.com/GovChat-NL/GovChat-NL-legacy). Gesprekken, accounts en configuratie uit die installatie worden niet automatisch naar LibreChat overgezet.
