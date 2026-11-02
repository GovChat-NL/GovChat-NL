# Containers in de GovChat-NL-installatie

De hoofdconfiguratie staat in [`docker-compose.yml`](../docker-compose.yml). Zonder profiel start Compose de hoofdtoepassing en de containers die nodig zijn voor chat, agents, modelkoppeling, gegevensopslag en beheer.

## Standaard gestart

| Container | Functie |
| --- | --- |
| `librechat` | Webomgeving voor gesprekken, bestanden en agents. |
| `librechat-proxy` | Ontvangt webverkeer en levert de LibreChat-overlay. |
| `admin-panel` | Beheerpaneel van LibreChat. |
| `n8n-openai-bridge` | Verbindt LibreChat met n8n en geeft live toolgebeurtenissen terug aan de webomgeving. |
| `n8n` | Voert workflows en agents uit. |
| `n8n-runners` | Voert JavaScript-taken voor n8n uit. |
| `n8n-bootstrap` | Laadt de workflows uit `agents/n8n/workflows/` eenmalig in n8n. |
| `litellm` | Verbindt LibreChat en n8n met de ingestelde taalmodellen. |
| `litellm-postgres` | Slaat de gegevens van LiteLLM op. |
| `n8n-postgres` | Slaat n8n-gegevens en -instellingen op. |
| `mongodb` | Slaat de gegevens van LibreChat op. |
| `redis` | Levert sessie- en cacheopslag voor LibreChat. |
| `meilisearch` | Ondersteunt het zoeken binnen LibreChat. |
| `qdrant` | Interne vectoropslag voor de daarvoor ingerichte workflows. De container heeft geen gepubliceerde hostpoort. |
| `govchat-retention` | Ruimt gegevens op volgens het ingestelde bewaarbeleid; zie [`retention-policy.md`](retention-policy.md). |
| `n8n-log-pruner` | Beperkt de bewaartermijn en omvang van n8n-logbestanden. |
| `librechat-permissions` | Eenmalige voorbereiding van de rechten op gegevensmappen. |
| `librechat-seed-admin` | Hulpprogramma voor de eerste beheerder in een lokale testomgeving; alleen actief wanneer de ontwikkelinstelling is ingeschakeld. |

## Optionele profielen

| Profiel | Extra container(s) | Gebruik |
| --- | --- | --- |
| `rag` | `pgvector`, `rag-api` | Optionele documentzoekfunctie. |
| `admin` | `pgvector`, `pgadmin` | Beheer van de optionele RAG-database. |
| `admin-overlay` | `govchat-overlay-admin` | Experimentele GovChat-beheerinterface; standaard uitgeschakeld. |

Een profiel start je alleen wanneer de bijbehorende functie is ingericht. Bijvoorbeeld:

```sh
docker compose --env-file .env --profile rag up -d
```

## Gegevens en netwerk

De containers verbinden elkaar via interne Docker-netwerken. Stel alleen de gebruikersinterface en expliciet benodigde beheerroutes beschikbaar. Publiceer databases, n8n en LiteLLM niet rechtstreeks op het internet. De hostpaden, geheimen, proxyinstellingen en back-upafspraken verschillen per organisatie; controleer die vóór ingebruikname.
