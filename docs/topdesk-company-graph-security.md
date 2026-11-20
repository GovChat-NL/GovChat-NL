# TOPdesk: bedrijfsautorisatie via Microsoft Graph

## Werking en servergrenzen

TOPdesk-toegang vereist een verse, **exacte** vergelijking van de bedrijfsnaam van
de ingelogde gebruiker. De standaard is **Provincie Limburg**. Hoofdletters,
spaties, Unicode en regeleinden worden niet genormaliseerd. Dit organisatiebeleid
vervangt geen persoonlijke TOPdesk-ACL; de geïndexeerde kennisbank moet geschikt
zijn voor alle gebruikers van de toegestane organisatie.

1. LibreChat stuurt het server-owned gedelegeerde GovChat API-token naar de bridge.
   De native Entra-verifier controleert handtekening/JWKS, tenant, issuer, audience,
   toegestane client, gedelegeerde API-scope, identiteit en vervaltijd.
2. De [bridge-preload](../security/topdesk/bridge-preload.cjs:36) maakt uitsluitend
   na native verificatie een willekeurige 256-bit requesthandle in servergeheugen.
   Bodyvelden, headers, adminrollen en modelargumenten kunnen geen handle maken.
   De oorspronkelijke identiteit, inclusief onafhankelijk JEMS-groepsbeleid,
   blijft behouden.
3. Alleen de handle gaat naar n8n. API-/Graph-/refresh-tokens en het OBO-secret
   blijven buiten workflowpayloads, prompts en toolresultaten. De preload verwijdert
   credentialvelden en redigeert echoes van het ontvangen API-token vóór de
   logging-/payloadgrens. Houd request-/execution-debuglogging uitgeschakeld.
4. De orchestrator vraagt een beschikbaarheidscontrole aan de private service.
   De [toolpolicy](../scripts/n8n-orchestrator-tool-policy.js) verwijdert de
   TOPdesk-tool vóór modelbinding bij weigering of ontbrekende toestemming,
   zowel bij de normale orchestrator als bij de JEMS-geautoriseerde agent.
5. De [zoekguard](../scripts/topdesk-workflow-security.js:47) controleert
   onafhankelijk opnieuw, vóór zoekvalidatie, embeddings en Qdrant. De toolmapping
   gebruikt alleen de oorspronkelijke webhookhandle, nooit een AI-argument.
6. De [company-service](../security/topdesk/company-service.cjs:72) wisselt bij
   **iedere controle** het API-token via On-Behalf-Of (OBO) voor een Graph-token en
   leest [Graph /v1.0/me?$select=id,companyName](../security/topdesk/company-service.cjs:87),
   beperkt tot object-ID en bedrijfsnaam. Het
   object-ID moet overeenkomen met de geverifieerde gebruiker; de bedrijfsnaam moet
   een string zijn die exact gelijk is aan de ingestelde toegestane naam.

Er is geen positieve autorisatiecache of fallback via adminrechten, groepen of
bedrijfsclaims. Een ontbrekende/ongeldige/verlopen handle of identiteit, afwijkende
of ontbrekende bedrijfsnaam, OBO-/Graph-fout of timeout weigert TOPdesk. De zoekguard
stopt vóór embeddings/Qdrant. Gewone chat blijft beschikbaar; JEMS behoudt zijn
onafhankelijke autorisatie. Bridge-transportauthenticatie blijft verplicht.

De private listener op poort 3334 retourneert alleen booleaanse toestemming en
vereist zowel de private n8n-transportcredential als de onvoorspelbare handle.
Hij biedt geen handle-uitgifte op verzoek, user-ID-lookup of instelbare Graph-URL.
Publiceer deze poort niet via een hostpoort, proxy of management-ingress.
Een handle vervalt na maximaal vijf minuten, eerder bij tokenexpiry of het sluiten
van de oorspronkelijke HTTP-response; een bridge-restart verliest alle handles.
Behandel handles als gevoelige kortlevende capabilities. Beperk beheerrechten en
netwerktoegang tot bridge/n8n en bewaar geen execution-data voor deze keten.

De controle is vers aan de retrievalgrens, maar niet transactioneel met Graph.
Directoryreplicatie kan wijzigingen vertraagd zichtbaar maken; een al begonnen
retrieval wordt niet retroactief teruggedraaid.

## Entra inrichten

Behoud de bestaande login, redirect-URI’s, rollen, refresh-instellingen en
JEMS-groepsallowlist. Zie ook [de bestaande Entra-inrichting](jems-entra.md).

- Gebruik de **confidential GovChat API-resource** die het inkomende API-token als
  audience heeft. [ENTRA_EXPECTED_AUDIENCE](../.env.example:61) is het client-ID
  (UUID) van deze resource; hetzelfde client-ID wordt voor OBO gebruikt.
  Bij een aparte loginclient is het OBO-secret dus van de **API-resource**, niet
  automatisch van de loginclient.
- Zet [ENTRA_JWT_ENABLED](../.env.example:60) op true. Configureer de juiste
  [ENTRA_TENANT_ID](../.env.example:49), [ENTRA_EXPECTED_ISSUER](../.env.example:62)
  (v2 issuer), [ENTRA_REQUIRED_SCOPE](../.env.example:63) (gedelegeerde API-scope)
  en [ENTRA_ALLOWED_CLIENT_ID](../.env.example:64) (toegestane loginclient).
  Laat LibreChat via [OPENID_SCOPE](../.env.example:56) die API-scope aanvragen en het
  API-token via de bestaande OpenID-header doorgeven. Een ID-token of Graph-token
  is geen geldig vervangend GovChat API-token.
- Voeg bij de API-resource onder **API permissions → Microsoft Graph → Delegated
  permissions** **User.Read** toe en verkrijg consent volgens tenantbeleid,
  waar vereist administratorconsent. Application-permissions of brede
  gebruikers-/groepsleesrechten zijn voor deze controle niet nodig.
- Gebruik een geldig confidential client-secret van die resource. De service leest
  dit uitsluitend uit een private bestandmount, niet uit workflowconfiguratie.
  Conditional Access, consent en tenantbeleid moeten de gedelegeerde OBO-route
  toestaan; een geslaagde login alleen garandeert dat niet.
- Stel in Entra admin center onder **Identity → Users → All users → gebruiker →
  Properties → Job information → Company name** de toegestane bedrijfsnaam in.
  Microsoft Graph moet deze als string teruggeven. Standaard is dat exact
  **Provincie Limburg**; bij een ander organisatiebeleid moet de configuratie
  dezelfde exacte waarde bevatten.

## Configuratie en optionele activatie

De [environmentvoorbeelden](../.env.example:191) bevatten alleen defaults en lege
private instellingen, geen credentials. Bewaar echte configuratie en secretfiles
buiten Git; neem ook geen providersecrets op in een private Compose-override.
Gebruik daarvoor de bestaande private credentialvoorziening, niet workflowexports,
chat, logs of publieke token-decoderwebsites.

| Instelling | Contract |
| --- | --- |
| [N8N_ENABLE_TOPDESK_SEARCH](../.env.example:195) | Publiceert/koppelt alleen de managed zoekworkflow. Activeert geen ingest of individuele toegang. |
| [TOPDESK_COMPANY_GRAPH_ENABLED](../.env.example:200) | Standaard false. Alleen exact true activeert de bridge-preload; de optionele overlay moet ook opgenomen zijn. |
| [TOPDESK_ALLOWED_COMPANY_NAME](../.env.example:202) | Standaard Provincie Limburg; exacte stringvergelijking. Een lege waarde in directe serviceconfiguratie weigert startup; Compose gebruikt bij een lege envwaarde de standaard. |
| [TOPDESK_OBO_CLIENT_SECRET_PATH](../.env.example:207) | Hostpad naar een bestaand privaat API-resource client-secretbestand. Vereist zodra de overlay opgenomen wordt, ook als de serviceflag uitstaat. |
| [TOPDESK_OBO_CLIENT_SECRET_FILE](../docker-compose.topdesk-company-graph.yml:10) | Containerpad, door de overlay vastgezet op de read-only secretmount; dit is niet het hostpad. |

1. Richt Entra in en selecteer een goedgekeurde immutable bridge-image via de
   [bridge-image-instelling](../.env.example:106), passend bij het onderstaande
   verifiercontract. Activeer de feature niet met een bewegende image-tag.
2. Laat een beheerder het resource-secret via de private credentialvoorziening in
   een bestaand bestand plaatsen. Geef alleen de benodigde eigenaar/container-UID
   of groep leesrecht: bijvoorbeeld hostmodus 0600 voor de passende eigenaar, of
   0640 met een beperkte groep. Beperk ook toegang tot bovenliggende directories;
   gebruik geen world-readable permissies. De bridge moet het bestand onder zijn
   daadwerkelijke UID/GID kunnen lezen. De mount is read-only en maakt geen
   ontbrekend hostpad aan.
3. Stel in de private omgeving beide featureflags op true, kies de exacte
   toegestane bedrijfsnaam en vul het hostpad in. Zorg voor een private
   [n8n-webhooktoken](../.env.example:128) van minimaal 32 tekens, verschillend van
   het [bridge-transporttoken](../.env.example:104). De basis-Compose geeft dit door
   als de interne webhook-transportcredential; de bestaande n8n credential-ID wordt
   hergebruikt.
4. Neem de [Graph-overlay](../docker-compose.topdesk-company-graph.yml) op na de
   [basis-Compose](../docker-compose.yml) en behoud alle bestaande private overlays.
   Controleer de uiteindelijke Compose-configuratie vóór beheeracties. Latere
   overrides mogen de securitymounts, toolpolicy of preloads niet overschrijven.
   De [Node-options](../docker-compose.topdesk-company-graph.yml:12) bevatten zowel
   de bestaande tool-eventpreload als de bedrijfscontrole-preload. Beide
   securitymodules worden samen read-only gemount. De private listener blijft
   uitsluitend op het interne netwerk bereikbaar.
5. Hercreëer de bridge bij gewijzigde environment/mounts; alleen herstarten leest
   geen gewijzigde Compose-environment in. Gebruik de normale scoped bootstrap voor
   publicatie van de managed orchestrator en search, en laat n8n de gewijzigde
   CLI-publicatie laden. Deze stappen zijn beheeracties, geen automatische gevolgen
   van het aanpassen van een environmentbestand.

**Zonder activatie blijft TOPdesk geweigerd.** De basisworkflows en scoped migratie
bevatten de securityguards ook wanneer de optionele service uitstaat of ontbreekt.
De zoekflag alleen is dus niet voldoende. Veilig uitschakelen kan met de zoekflag;
ontbreken of uitvallen van de controleservice weigert retrieval eveneens. Verwijder
nooit de retrievalguard om een configuratiefout te omzeilen.

## Scoped workflowmigratie

[Bootstrap](../n8n/bootstrap.js) gebruikt een aparte TOPdesk-securitymarker met
versie 1. Een reeds volledig gezaaide installatie zonder deze marker importeert
alleen de managed orchestrator en TOPdesk Search, ook wanneer zoeken uitstaat.
Een herhaling importeert niets. Oudere ontbrekende MCP-/statistics-markers behouden
hun bestaande scoped upgrades; een nieuwe installatie behoudt de normale bootstrap.
Voor de securitymigratie is **geen force-import** nodig.

De [gedeelde workflowpatch](../scripts/topdesk-workflow-security.js) wordt door
bootstrap en de [workflowgenerator](../scripts/update-orchestrator-workflow.js)
gebruikt en behoudt de onafhankelijke retrievalguard bij herhaald genereren.
Behoud de [bootstrapmodulemount](../docker-compose.yml:743), bestaande owners,
projects en credential-ID’s. Deze securitypatch wijzigt geen ingestplanning,
registry/executor of database-tabellen en vereist geen owner-/credential-reset.

## Verifierpin en upgrades

De [preloadpin](../security/topdesk/bridge-preload.cjs:23) vereist SHA-256
**ad4265c44c02974e7611cb641d26cbf08cc255f00f5798725b6edc207ba9eeb7** voor de native
Entra-verifierbron in de bridge-image. Een andere hash weigert startup wanneer de
feature actief is; de hashcontrole mag niet worden uitgeschakeld.

Bij een bridge-upgrade moet de beheerder eerst de native verifier én de
payloadkoppeling laten beoordelen: alle tokencontroles, immutable serveridentiteit,
requesthandle-uitgifte, payloadredactie en beide onafhankelijke guards moeten
behouden blijven. Voer de [geautomatiseerde securitytests](../scripts/test-topdesk-security.sh)
uit tegen de beoogde goedgekeurde images en beoordeel het Entra/OBO-contract vóór
het wijzigen van de pin.
