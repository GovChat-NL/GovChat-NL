# TOPdesk-kennisitems: ingest en bevragen

GovChat bevat twee generieke, inactieve n8n-workflows voor het indexeren en semantisch bevragen van TOPdesk Knowledge Base-kennisitems:

- `topdesk-knowledge-items-ingest.json` haalt directe kinderen van een gekozen hoofdkennisitem op basis van het TOPdesk-ID op, voegt artikel- en optioneel bijlagetext samen, genereert embeddings en upsert de punten in Qdrant.
- `topdesk-knowledge-items-search.json` embedt een vraag, zoekt in een gekozen Qdrant-collectie en geeft resultaten met score, titel, TOPdesk-nummer, bron-id en URL terug.

Beide exports worden automatisch meegenomen door [`n8n/bootstrap.js`](../n8n/bootstrap.js). Bootstrap herstelt na publiceren de actieve status uit de workflow-export; de TOPdesk-workflows blijven dus ongepubliceerd/inactief totdat ze bewust na configuratie worden geactiveerd. Zo maakt een verse installatie geen verbinding met een nog niet ingerichte TOPdesk-omgeving.

## Vereisten

- n8n en Qdrant uit de GovChat Compose-stack.
- Een TOPdesk Knowledge Base API-account dat de gekozen kennisitems en bijlagen mag lezen.
- Een OpenAI-compatible embeddings-endpoint, bijvoorbeeld LiteLLM.
- Qdrant bereikbaar vanuit n8n. De ingest controleert de gekozen collectie en maakt die automatisch aan als hij ontbreekt. De standaardconfiguratie gebruikt `3072` dimensies en `Cosine`.
- Apache Tika (`tika` in de Compose-stack) wanneer `includeAttachments` ingeschakeld is. Tika is alleen intern bereikbaar. Voor een extern Tika-endpoint kan `tikaUrl` worden aangepast.

## 1. Stel de workflowconfiguratie in

Stel in `.env` `TOPDESK_TENANT` en `TOPDESK_BASE_DOMAIN` in. Bootstrap bouwt de API-basis-URL als `https://<tenant>.<base-domain>` en rendert die in de workflow vóór import. Voor Provincie Limburg zijn de waarden bijvoorbeeld `prvlimburg` en `topdesk.net`, die samen `https://prvlimburg.topdesk.net` opleveren. De workflowtemplate bevat geen organisatie-URL.

Stel optioneel `TOPDESK_PUBLIC_BASE_URL` in voor de SSP-link naar kennisitems, bijvoorbeeld `https://topdesk.prvlimburg.nl/tas/public/ssp/content/detail/knowledgeitem`. Bootstrap voegt `?unid=<item-id>` toe. Zonder deze instelling wordt geen publieke URL in de payload opgenomen.

Bootstrap geeft deze waarden door aan de n8n-bootstrapcontainer en rendert workflowexports in een tijdelijke map; het wijzigt de repositorybestanden niet. Als n8n al eerder is gebootstrapt, forceer dan eenmalig een herimport met `AGENTS_BOOTSTRAP_FORCE=true` nadat je de `.env` hebt aangepast.

Open de workflow in n8n en pas in de node **1. Configuration (edit after import)** de overige niet-geheime defaults aan. Ze staan bewust in de workflow, zodat ze per organisatie zichtbaar en versieerbaar zijn:

| Instelling | Betekenis |
| --- | --- |
| `topdeskBaseUrl` | Wordt bij bootstrap opgebouwd uit `TOPDESK_TENANT` en `TOPDESK_BASE_DOMAIN`; niet hardcoded in het workflowtemplate. |
| `configuredRootKnowledgeItemNumber` | TOPdesk-nummer voor handmatige/geplande runs; staat standaard op `KI 0975`. Een ID kan in plaats daarvan worden ingesteld met `configuredRootKnowledgeItemId`. |
| `pageSize` | TOPdesk paginaomvang (standaard 500). De workflow vraagt één pagina op; verhoog de waarde niet boven de limiet van jouw TOPdesk-tenant. Gebruik bij grotere datasets de pagination-opties van de API/node of voer ingest in gecontroleerde batches uit. |
| `fields` | TOPdesk velden die nodig zijn voor inhoud en metadata. |
| `publicKnowledgeItemUrl` | Wordt gevuld vanuit `TOPDESK_PUBLIC_BASE_URL`; leeg laten om geen publieke URL in de bronpayload te zetten. |
| `configuredIncludeAttachments` | Default om bijlagen via Tika mee te nemen (standaard `true`); bij subworkflow-aanroepen kan `include_attachments` dit per run overschrijven. |
| `tikaUrl` | Tika endpoint, standaard `http://tika:9998/tika`. |
| `embeddingUrl`, `embeddingModel` | OpenAI-compatible embeddings endpoint en LiteLLM-modelalias. GovChat gebruikt `govchat-embedding`, geconfigureerd in `litellm/config.yaml` als Azure `text-embedding-3-large`. Gebruik bij een andere provider diens modelnaam/alias en endpointvorm (`/embeddings` of `/v1/embeddings`). Dezelfde waarden moeten in de **1. Validate and configure search**-node van de zoekworkflow staan. |
| `qdrantUrl`, `collection`, `vectorSize` | Qdrant endpoint, collectie en vectorafmeting. |
| `vectorDistance` | Qdrant afstandsmaat; standaard `Cosine`. Een ontbrekende collectie wordt met deze vectorconfiguratie aangemaakt. |
| `visibleOnly` | Indexeer alleen items waarvan TOPdesk `sspVisibility` als `VISIBLE` rapporteert. |
| `top_k`, `score_threshold` | Optionele zoekinput voor maximum aantal resultaten en minimale Qdrant-score. De zoekworkflow begrenst `top_k` op 1–50. |

De query filtert standaard op `parent.number=='KI 0975'` en verwerkt de directe kinderen van dat hoofditem; het hoofditem zelf wordt niet geïndexeerd. Voor een andere tenant kun je het standaardnummer vervangen. Als een `root_knowledge_item_id` wordt meegegeven, gebruikt de workflow `parent.id` in plaats daarvan. Pas de query aan als jouw TOPdesk-hiërarchie anders werkt.

### Runtime-parameters

De ingest-workflow heeft ook een **Run with parameters**-trigger zodat een bovenliggende agent/workflow per uitvoering een hoofditem kan kiezen en bijlage-extractie kan toggelen. Geef `root_knowledge_item_number` óf `root_knowledge_item_id` mee, plus optioneel een boolean `include_attachments`:

```json
{
  "root_knowledge_item_number": "KI 0975",
  "include_attachments": false
}
```

Als `include_attachments` ontbreekt wordt `configuredIncludeAttachments` gebruikt (standaard `true`). Een rootnummer of ID is vereist voor runtime-aanroepen; geplande/handmatige runs gebruiken standaard `configuredRootKnowledgeItemNumber`.

## 2. Configureer TOPdesk Basic Auth via environment

Zet de gebruikersnaam en application password in de lokale `.env`:

- `TOPDESK_API_USERNAME` — bijvoorbeeld `APILAICA`.
- `TOPDESK_API_PASSWORD` — TOPdesk application password.

De n8n-bootstrap leest beide waarden, importeert een HTTP Basic Auth-credential met een stabiel ID in de versleutelde n8n credential store en verwijdert daarna het tijdelijke credentialbestand. De ingestnodes voor kennisitems, bijlagen en downloads refereren aan die credential. De geheimen worden niet in workflow-JSON of Code-node inputs opgeslagen en worden niet als runtimevariabelen aan de n8n Code-node doorgegeven. Zorg dat `N8N_ENCRYPTION_KEY` ingesteld is.

Als beide TOPdesk-variabelen leeg zijn, slaat bootstrap het aanmaken van de credential over; als slechts één is ingevuld, stopt bootstrap met een duidelijke configuratiefout. Na het wijzigen van een credential kun je een herimport forceren met `AGENTS_BOOTSTRAP_FORCE=true`.

De meegeleverde nodes gebruiken HTTP Basic Auth. Als een TOPdesk-tenant uitsluitend een API-key/header accepteert, moet die auth-methode apart worden ingericht in n8n en in de nodes geselecteerd worden; deze bootstrapcredential is Basic Auth.

### Embeddings en Qdrant

Bootstrap maakt ook automatisch de HTTP Header Auth-credential voor embeddings aan: header `Authorization`, waarde `Bearer <LITELLM_API_KEY>`, beheerd in de versleutelde n8n credential store. De ingest- en zoeknodes verwijzen naar deze credential. De endpoint/modelalias blijven configureerbaar in de workflow; voor een andere embeddingsprovider kun je een eigen credential maken en de nodes daarnaar omzetten.

Voor Qdrant zonder API-key is geen credential nodig. Als Qdrant-authenticatie aanstaat, maak een HTTP Header Auth-credential aan, bijvoorbeeld header `api-key`, en koppel die aan de Qdrant-nodes. Configureer credentials afzonderlijk per n8n-omgeving; credential-inhoud wordt niet door bootstrap gedeeld of overschreven.

## 3. Test de ingest en activeer

De ingest controleert eerst of de ingestelde collectie bestaat. Bij een 404 maakt hij die aan met de ingestelde vector size en distance. Als de collectie al bestaat maar een andere vectorconfiguratie heeft, stopt hij met een mismatch-fout; hij wijzigt of verwijdert geen bestaande collectie. Gebruik een aparte collectienaam per dataset/organisatie als isolatie vereist is. De workflow gebruikt TOPdesk `id` als stabiele punt-id en bewaart de visibility-status, titel, beschrijving, trefwoorden, datums, inhoud en bronverwijzing in de payload.

Voer ingest één keer uit voordat je de zoekworkflow test, zodat de collectie bestaat en punten bevat.

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

