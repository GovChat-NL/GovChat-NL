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

### Inhoudelijke orkestrator-masterprompt beheren

Beheer de inhoudelijke masterprompt via **GovChat Admin → Orchestrator**, met veilige tekstpreview, actieve bron, opslaan en reset. Voorrang: private beheerdersoverride → omgevingsvariabele → bestaande GovChat-standaard. Beheerderswijzigingen werken vanaf het volgende verzoek; technische instructies en integraties blijven behouden. Zie [promptbeheer, beveiliging en gerichte uitrol](docs/orchestrator-prompt-management.md).

### Live aanroepen van n8n-hulpmiddelen in de chat

Wanneer een n8n-agent tijdens een gesprek een hulpmiddel gebruikt, toont LibreChat die aanroep direct als een ingebouwde kaart in de chat. De gebruiker ziet het hulpmiddel starten, de voortgang en het resultaat of de foutmelding; de gewone tekst van de assistent blijft leesbaar. Dit werkt door de samenwerking tussen de GovChat-bridge, n8n en de LibreChat-interface.

De architectuur en controlepunten staan in de uitleg over [live aanroepen van hulpmiddelen](docs/live-tool-calling.md).

De standaard orkestrator heeft ook vijf afzonderlijk configureerbare hulpmiddelen:
de standaard n8n-rekenmachine, NOS- en L1-nieuws per RSS-categorie, feestdagen via
OpenHolidays API en tijd-/datumrekenen met tijdzones en zomer-/wintertijd.
Ze staan standaard aan en worden beheerd via de Orchestrator-pagina van het
beheerportaal. Zie [configuratie, ingebruikname en tests](docs/orchestrator-utility-tools.md).

### Waarschuwing onder de chatinvoer

Onder de chatinvoer staat standaard: **&lt;appnaam&gt; kan fouten maken. Controleer
belangrijke informatie.** Beheerders kunnen deze waarschuwing via het dashboard
uitschakelen. Zie [de configuratie en tests](docs/chat-disclaimer.md).

## Verbonden systemen

| Systeem | Rol binnen GovChat-NL |
| --- | --- |
| [LibreChat](https://www.librechat.ai/) | Webomgeving voor gesprekken, bestanden en agents. |
| [GovChat-bridge voor n8n](https://github.com/GovChat-NL/n8n-openai-bridge) | Verbindt LibreChat via een OpenAI-compatibele koppeling met n8n en geeft gebeurtenissen van hulpmiddelen terug voor de live kaarten. |
| [n8n](https://n8n.io/) | Voert agenten, hulpmiddelen en andere geautomatiseerde workflows uit. De meegeleverde workflows worden bij het starten ingeladen. |
| [LiteLLM](https://github.com/BerriAI/litellm) | Verbindt GovChat-NL en n8n met de gekozen taalmodellen. |
| [OpenBesluitvorming](https://github.com/ontola/openbesluitvorming) · [website](https://openbesluitvorming.nl/) | Project voor het ontsluiten en doorzoeken van openbare besluitvormingsinformatie; GovChat-workflows kunnen hierop aansluiten. |
| [TOPdesk Knowledge Base](https://www.topdesk.com/) | Generieke workflows om directe kinderen van een gekozen hoofdkennisitem in Qdrant te indexeren en semantisch te bevragen. Zie de [configuratiehandleiding](docs/topdesk-knowledge-items.md). |
| Microsoft Entra ID | Optionele SSO-koppeling; vereist inrichting voor de eigen organisatie. |

## Apps en workflows

De installatie bevat onder andere workflows voor:

- **Versimpelaar** — helpt teksten begrijpelijker te maken.
- **Live transcriptie** — zet audio om naar tekst via de geconfigureerde spraak- en modeldiensten.
- **Afbeeldingsgeneratie** — optioneel in te schakelen.
- **OpenBesluitvorming** — workflows voor zoeken en werken met besluitvormingsinformatie; de organisatie configureert zelf de gegevensbron en toegang.
- **TOPdesk Knowledge Base** — optionele workflows voor ingest en semantisch zoeken van kennisitems; met `N8N_ENABLE_TOPDESK_SEARCH=true` koppelt bootstrap de zoekworkflow automatisch als tool aan de orchestrator. Hoofditem, credentials, endpoints en bijlageverwerking configureert de organisatie zelf. Zie [TOPdesk-kennisitems instellen](docs/topdesk-knowledge-items.md).

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

De drie configureerbare huisstijlopties en het plaatsen van eigen logo's staan in [Branding configureren](docs/BRANDING.md).

De LibreChat-overrides en de instelbare Nederlandse vertalingen staan in het [overzicht van overrides](docs/OVERRIDES.md) en [Nederlandse vertalingen](docs/TRANSLATIONS.md). De vertaaloverride staat standaard aan en kan met [`LIBRECHAT_NL_TRANSLATIONS_ENABLED`](.env.example:11) op `false` worden uitgezet.

### Eigen deployment zonder broncode-afwijkingen

Ingress-hostnamen en bindadres, vertrouwde proxies, dataroot, bestaand Docker-netwerk,
database-image, bridge-buildcontext, SSO/adminrolmapping en beheer-subpaden zijn
configureerbaar. Optionele Compose-bestanden voegen SSO-only beleid en
localhost-beheeradapters toe zonder installatiegegevens in de repo op te nemen.
Zie [deploymentconfiguratie](docs/deployment-configuration.md) voor opties, veilige
defaults, migratie van lokale overrides en de bijbehorende tests.

## Documentatie en bijdragen

- [GovChat-NL-documentatie](https://govchat-nl.github.io/)
- [Architectuur](https://govchat-nl.github.io/docs/architectuur/librechat)
- [Containeroverzicht](docs/services.md)
- [LibreChat-overrides](docs/OVERRIDES.md)
- [Nederlandse LibreChat-vertalingen](docs/TRANSLATIONS.md)
- [Bijdragen aan agents en workflows](agents/CONTRIBUTING.md)
- [Bridge voor n8n](https://github.com/GovChat-NL/n8n-openai-bridge)

De oude OpenWebUI-installatie staat in [GovChat-NL-legacy](https://github.com/GovChat-NL/GovChat-NL-legacy). Gesprekken, accounts en configuratie uit die installatie worden niet automatisch naar LibreChat overgezet.
# Chatweergavenaam

De publieke orkestratornaam is configureerbaar via N8N_ORCHESTRATOR_DISPLAY_NAME en GovChat Admin → Orchestrator.
Adminoverride gaat vóór omgeving en generieke standaard; reset verwijdert de override. Dit verandert geen model-ID of masterprompt.
Zie [naambeheer en veilige uitrol](docs/orchestrator-display-name.md).
