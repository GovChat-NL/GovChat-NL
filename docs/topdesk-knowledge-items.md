# TOPdesk-kennisitems: ingest en bevragen

GovChat bevat twee generieke, inactieve n8n-workflows voor het indexeren en semantisch bevragen van TOPdesk Knowledge Base-kennisitems:

- `topdesk-knowledge-items-ingest.json` haalt directe kinderen van een gekozen hoofdkennisitem op basis van het TOPdesk-ID op, voegt artikel- en optioneel bijlagetext samen, genereert embeddings en upsert de punten in Qdrant.
- `topdesk-knowledge-items-search.json` embedt een vraag, zoekt in een gekozen Qdrant-collectie en geeft resultaten met score, titel, TOPdesk-nummer, bron-id en URL terug.

Beide exports worden automatisch meegenomen door [`n8n/bootstrap.js`](../n8n/bootstrap.js). Bootstrap herstelt na publiceren de actieve status uit de workflow-export; de TOPdesk-workflows blijven dus ongepubliceerd/inactief totdat ze bewust na configuratie worden geactiveerd. Zo maakt een verse installatie geen verbinding met een nog niet ingerichte TOPdesk-omgeving.

## Vereisten

- n8n en Qdrant uit de GovChat Compose-stack.
- Een TOPdesk Knowledge Base API-account dat de gekozen kennisitems en bijlagen mag lezen.
- Een OpenAI-compatible embeddings-endpoint, bijvoorbeeld LiteLLM.
- Een Qdrant-collectie waarvan de vector size en distance overeenkomen met het embeddingmodel. Maak de collectie vooraf aan. De standaardconfiguratie gebruikt `3072` dimensies en `Cosine`; controleer dit voor het door jouw organisatie gekozen model.
- Apache Tika (`tika` in de Compose-stack) wanneer `includeAttachments` ingeschakeld is. Tika is alleen intern bereikbaar. Voor een extern Tika-endpoint kan `tikaUrl` worden aangepast.

## 1. Stel de workflowconfiguratie in

Stel in `.env` `TOPDESK_TENANT` en `TOPDESK_BASE_DOMAIN` in. Bootstrap bouwt de API-basis-URL als `https://<tenant>.<base-domain>` en rendert die in de workflow vóór import. Voor Provincie Limburg zijn de waarden bijvoorbeeld `prvlimburg` en `topdesk.net`, die samen `https://prvlimburg.topdesk.net` opleveren. De workflowtemplate bevat geen organisatie-URL.

Stel optioneel `TOPDESK_PUBLIC_BASE_URL` in voor de SSP-link naar kennisitems, bijvoorbeeld `https://topdesk.prvlimburg.nl/tas/public/ssp/content/detail/knowledgeitem`. Bootstrap voegt `?unid=<item-id>` toe. Zonder deze instelling wordt geen publieke URL in de payload opgenomen.

Bootstrap geeft deze waarden door aan de n8n-bootstrapcontainer en rendert workflowexports in een tijdelijke map; het wijzigt de repositorybestanden niet. Als n8n al eerder is gebootstrapt, forceer dan eenmalig een herimport met `AGENTS_BOOTSTRAP_FORCE=true` nadat je de `.env` hebt aangepast.

Open de workflow in n8n en pas in de node **1. Configuration (edit after import)** de overige niet-geheime defaults aan. Ze staan bewust in de workflow, zodat ze per organisatie zichtbaar en versieerbaar zijn:

| Instelling | Betekenis |
| --- | --- |
| `topdeskBaseUrl` | Wordt bij bootstrap opgebouwd uit `TOPDESK_TENANT` en `TOPDESK_BASE_DOMAIN`; niet hardcoded in het workflowtemplate. |
| `configuredRootKnowledgeItemId` | TOPdesk-ID voor handmatige/geplande runs. Bij subworkflow-aanroepen kan `root_knowledge_item_id` dit per run overschrijven. |
| `pageSize` | TOPdesk paginaomvang (standaard 500). De workflow vraagt één pagina op; verhoog de waarde niet boven de limiet van jouw TOPdesk-tenant. Gebruik bij grotere datasets de pagination-opties van de API/node of voer ingest in gecontroleerde batches uit. |
| `fields` | TOPdesk velden die nodig zijn voor inhoud en metadata. |
| `publicKnowledgeItemUrl` | Wordt gevuld vanuit `TOPDESK_PUBLIC_BASE_URL`; leeg laten om geen publieke URL in de bronpayload te zetten. |
| `configuredIncludeAttachments` | Default om bijlagen via Tika mee te nemen (standaard `true`); bij subworkflow-aanroepen kan `include_attachments` dit per run overschrijven. |
| `tikaUrl` | Tika endpoint, standaard `http://tika:9998/tika`. |
| `embeddingUrl`, `embeddingModel` | OpenAI-compatible embeddings endpoint en model. Gebruik de endpointvorm die jouw provider verwacht (`/embeddings` of `/v1/embeddings`). Dezelfde waarden moeten in de **1. Validate and configure search**-node van de zoekworkflow staan. |
| `qdrantUrl`, `collection`, `vectorSize` | Qdrant endpoint, collectie en vectorafmeting. |
| `visibleOnly` | Indexeer alleen items waarvan TOPdesk `sspVisibility` als `VISIBLE` rapporteert. |
| `top_k`, `score_threshold` | Optionele zoekinput voor maximum aantal resultaten en minimale Qdrant-score. De zoekworkflow begrenst `top_k` op 1–50. |

De meegeleverde endpoint-, model- en collectiewaarden zijn voorbeelden en wijzen niet naar een specifieke organisatie. Vul `configuredRootKnowledgeItemId` in voor handmatige/geplande runs. De query filtert op `parent.id` en verwerkt de directe kinderen van dat hoofditem; het hoofditem zelf wordt niet geïndexeerd. Pas de query aan als jouw TOPdesk-hiërarchie anders werkt.

### Runtime-parameters

De ingest-workflow heeft ook een **Run with parameters**-trigger zodat een bovenliggende agent/workflow per uitvoering een hoofditem kan kiezen en bijlage-extractie kan toggelen. Geef de TOPdesk UUID mee als `root_knowledge_item_id` en optioneel een boolean `include_attachments`:

```json
{
  "root_knowledge_item_id": "<TOPdesk-knowledge-item-UUID>",
  "include_attachments": false
}
```

Als `include_attachments` ontbreekt wordt `configuredIncludeAttachments` gebruikt (standaard `true`). De `root_knowledge_item_id` is vereist voor parameter-aanroepen; geplande/manual runs gebruiken `configuredRootKnowledgeItemId`.

## 2. Maak credentials aan in n8n

Geheimen worden **niet** in workflow-JSON, `.env`-bestanden of workflow-inputs gezet. Maak credentials aan in n8n en koppel ze in elke bijbehorende HTTP Request-node via **Authentication**. De workflow-exports bevatten herkenbare credential-placeholders; selecteer na import de echte credentials in de node(s).

### TOPdesk

De standaardnodes zijn ingesteld op **HTTP Basic Auth**. Maak een n8n HTTP Basic Auth-credential met de TOPdesk API-gebruikersnaam en het bijbehorende API-wachtwoord/application password. Koppel dezelfde credential aan de lijst-, bijlage- en downloadnodes.

Als jouw organisatie TOPdesk met een API-key/header gebruikt, maak dan een n8n **HTTP Header Auth**-credential met de door TOPdesk vereiste headernaam en waarde. Wijzig op alle TOPdesk HTTP Request-nodes de authentication-kind naar HTTP Header Auth en selecteer die credential. De API-key zelf blijft dan opgeslagen in n8n's versleutelde credential store.

### Embeddings en Qdrant

Maak voor het embeddings-endpoint een HTTP Header Auth-credential met header `Authorization` en waarde `Bearer <jouw API-key>` (of de header die jouw provider vereist). Koppel deze aan de embeddingnodes.

Voor Qdrant zonder API-key is geen credential nodig. Als Qdrant-authenticatie aanstaat, maak een HTTP Header Auth-credential aan, bijvoorbeeld header `api-key`, en koppel die aan de Qdrant-nodes. Configureer credentials afzonderlijk per n8n-omgeving; credential-inhoud wordt niet door bootstrap gedeeld of overschreven.

## 3. Controleer de Qdrant-collectie en activeer

Maak de collectie met de geconfigureerde vector size en `Cosine` distance aan vóór de eerste ingest-run. Gebruik een aparte collectie per dataset/organisatie als isolatie vereist is. De workflow gebruikt TOPdesk `id` als stabiele punt-id en bewaart de visibility-status, titel, beschrijving, trefwoorden, datums, inhoud en bronverwijzing in de payload.

Voer eerst **Test workflow** uit met een kleine testcollectie. Controleer de TOPdesk-response, embeddingdimensie, Tika-extractie en Qdrant-upsert. Activeer daarna de ingest-workflow om de ingestelde planning te gebruiken. De zoekworkflow is bedoeld om vanuit een bovenliggende n8n-workflow of tool aangeroepen te worden; voer bij het testen `question` mee en eventueel `top_k`, `collection` en `score_threshold`.

Voorbeeld zoekinput:

```json
{
  "question": "Hoe vraag ik ouderschapsverlof aan?",
  "top_k": 5
}
```

De zoekoutput bevat de gerangschikte bronnen; laat een antwoordagent de inhoud uitsluitend op basis van die bronnen formuleren en de TOPdesk-bronlink citeren.

## Operationele en privacy-aandachtspunten

- Geef TOPdesk alleen-lezen API-rechten en beperkte toegang tot de relevante kennisitems.
- Indexeer geen vertrouwelijke of niet-zichtbare items tenzij dit bewust is toegestaan. Controleer `visibleOnly` en de daadwerkelijke TOPdesk-visibilityvelden voor jouw tenant.
- Qdrant-payloads bevatten de geïndexeerde tekst en geëxtraheerde bijlage-inhoud. Beveilig opslag, backups en netwerktoegang volgens het bewaarbeleid van de organisatie.
- Tika verwerkt bestanden intern en krijgt geen publiek gepubliceerde Compose-poort. Beperk toegestane bestandstypen/grootte aan de bronzijde en voer software-updates volgens het reguliere patchbeleid uit.
- De workflows verwijderen geen punten die in TOPdesk zijn verwijderd of niet langer onder het hoofditem vallen. Plan voor productie een expliciete reconcile/cleanup-strategie voordat de bronstructuur verandert.
- `pageSize` en de API-paginering verschillen mogelijk per TOPdesk-release. Test met meer records dan één pagina voordat je de workflow voor een volledige dataset activeert.

