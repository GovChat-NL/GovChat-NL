# GovChat-NL

<p align="center">
  <a href="https://govchat-nl.github.io/">
    <img src="https://govchat-nl.github.io/img/banner.png" alt="GovChat-NL — AI voor de Nederlandse overheid" width="100%" />
  </a>
</p>

GovChat-NL is een open platform waarmee Nederlandse overheidsorganisaties AI-toepassingen kunnen beheren en gebruiken. De webomgeving is gebaseerd op LibreChat. Workflows en agents draaien in n8n; LiteLLM verbindt de toepassing met taalmodelaanbieders.

## Waarom GovChat-NL?

- **Chatten met taalmodellen** vanuit de GovChat-NL-webomgeving.
- **Toepassingen en agenten gebruiken** die zijn opgebouwd uit n8n-workflows, waaronder de Versimpelaar en live transcriptie.
- **Zelf de modelaanbieder kiezen** via LiteLLM, bijvoorbeeld Azure OpenAI of andere ondersteunde aanbieders.
- **Verantwoord werken met AI** met aandacht voor AI-geletterdheid en de Nederlandse overheidscontext; zie de [AI-geletterdheidshandleiding](https://govchat-nl.github.io/docs/ai-geletterdheid).
- **De toepassing zelf beheren** met Docker Compose, inclusief de configuratie, verbindingen en workflow-import.

### Live aanroepen van n8n-hulpmiddelen in de chat

Wanneer een n8n-agent tijdens een gesprek een hulpmiddel gebruikt, toont LibreChat die aanroep direct als een ingebouwde kaart in de chat. De gebruiker ziet het hulpmiddel starten, de voortgang en het resultaat of de foutmelding; de gewone tekst van de assistent blijft leesbaar. Dit werkt door de samenwerking tussen de GovChat-bridge, n8n en de LibreChat-interface.

De architectuur en controlepunten staan in de uitleg over [live aanroepen van hulpmiddelen](docs/live-tool-calling.md).

## Verbonden systemen

| Systeem | Rol binnen GovChat-NL |
| --- | --- |
| [LibreChat](https://www.librechat.ai/) | Webomgeving voor gesprekken, bestanden en agents. |
| [GovChat-bridge voor n8n](https://github.com/GovChat-NL/n8n-openai-bridge) | Verbindt LibreChat via een OpenAI-compatibele koppeling met n8n en geeft gebeurtenissen van hulpmiddelen terug voor de live kaarten. |
| [n8n](https://n8n.io/) | Voert agenten, hulpmiddelen en andere geautomatiseerde workflows uit. De meegeleverde workflows worden bij het starten ingeladen. |
| [LiteLLM](https://github.com/BerriAI/litellm) | Verbindt GovChat-NL en n8n met de gekozen taalmodellen. |
| [OpenBesluitvorming](https://github.com/ontola/openbesluitvorming) · [website](https://openbesluitvorming.nl/) | Project voor het ontsluiten en doorzoeken van openbare besluitvormingsinformatie; GovChat-workflows kunnen hierop aansluiten. |
| Microsoft Entra ID | Optionele SSO-koppeling; vereist inrichting voor de eigen organisatie. |

## Apps en workflows

De installatie bevat onder andere workflows voor:

- **Versimpelaar** — helpt teksten begrijpelijker te maken.
- **Live transcriptie** — zet audio om naar tekst via de geconfigureerde spraak- en modeldiensten.
- **Afbeeldingsgeneratie** — optioneel in te schakelen.
- **OpenBesluitvorming** — workflows voor zoeken en werken met besluitvormingsinformatie; de organisatie configureert zelf de gegevensbron en toegang.
- **Beleidskompas** — ondersteunt beleidsafwegingen in vier stappen (SiS 4.0), op een eigen pagina. De gebruiker werkt een casus deelstap voor deelstap uit. Beleidskompas bewaart elke casus in een eigen database.

Na het inloggen komt de gebruiker op een startscherm, met een tegel voor de chat en voor elke app.

## Snel starten

1. Installeer Docker Engine met de Compose-plugin.
2. Maak een lokale `.env` op basis van [`.env.example`](.env.example) en vul sterke, unieke wachtwoorden, tokens en providergegevens in. Voor Beleidskompas zijn dat ook `BELEIDSKOMPAS_POSTGRES_PASSWORD`, het wachtwoord van zijn database, en `BELEIDSKOMPAS_STORE_TOKEN`, waarmee n8n de casussen opslaat via de beheeromgeving. Deel of commit dit bestand niet.
3. Haal de GovChat-bridge op naast deze repository:

   ```sh
   git clone --depth 1 --branch main https://github.com/GovChat-NL/n8n-openai-bridge.git ../n8n-openai-bridge-main
   ```

4. Controleer de Compose-instellingen en start de toepassing:

   ```sh
   docker compose --env-file .env --profile admin-overlay config --quiet
   docker compose --env-file .env --profile admin-overlay up -d
   ```

   Het profiel `admin-overlay` start de beheeromgeving. Beleidskompas heeft die nodig, want de casussen worden daar opgeslagen. Zonder de beheeromgeving beantwoordt Beleidskompas geen berichten.

De [`Makefile`](Makefile) bundelt de gebruikelijke commando's, zoals `make up` om de toepassing te starten. Die start de beheeromgeving altijd mee. Met `make help` zie je ze allemaal.

Lees daarna de [omgevingsvariabelen](https://govchat-nl.github.io/docs/handleidingen/librechat-omgevingsvariabelen), de [snelle start](https://govchat-nl.github.io/docs/handleidingen/librechat-pre-release) en het [overzicht van de containers](docs/services.md). Open poorten, SSO, secrets, gegevensbewaring en back-ups moeten bij de eigen organisatie-inrichting passen.

## Documentatie en bijdragen

- [GovChat-NL-documentatie](https://govchat-nl.github.io/)
- [Architectuur](https://govchat-nl.github.io/docs/architectuur/librechat)
- [Containeroverzicht](docs/services.md)
- [Een bestaande installatie bijwerken](UPGRADE.md)
- [Bijdragen aan agents en workflows](agents/CONTRIBUTING.md)
- [Bridge voor n8n](https://github.com/GovChat-NL/n8n-openai-bridge)

De oude OpenWebUI-installatie staat in [GovChat-NL-legacy](https://github.com/GovChat-NL/GovChat-NL-legacy). Gesprekken, accounts en configuratie uit die installatie worden niet automatisch naar LibreChat overgezet.
