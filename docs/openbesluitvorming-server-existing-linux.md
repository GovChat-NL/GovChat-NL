# Snapshot importeren naast een bestaande Linux GovChat/Qdrant-installatie

Deze stappen maken **geen nieuwe Qdrant-server** en wijzigen geen bestaande
GovChat-containers, collecties, volumes, configuratie of zoekalias. Er komt een
aparte ingest-opslag bij. De importer weigert de collectie als die al bestaat.
Gebruik deze instructies niet voor Qdrant met API-key-authenticatie: de huidige
transferhelper ondersteunt die configuratie nog niet. Zet authenticatie niet uit.

## 1. Voorbereiden: SSH en bestaande containers controleren

Log in op de Linux-server via SSH. Ga naar een directory waarin je een aparte
toolscheckout kunt aanmaken. De live GovChat-checkout hoeft niet te worden gewijzigd.
Je account moet Docker mogen gebruiken. Kopieer de blokken één voor één, niet alles
in één keer. Stop bij een fout.

```bash
set -e
docker version
docker compose version
python3 --version
git --version
df -h .
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
```

Vereist: Linux-containers, Compose v2, Python 3.12+, Git en voldoende vrije opslag.
De foutstop geldt voor deze SSH-shell: bij een mislukte opdracht stopt de sessie
in plaats van stil met latere importstappen door te gaan. Log dan opnieuw in en
onderzoek eerst de fout; zet de foutstop niet uit om een controle te omzeilen.
Reserveer minimaal 15-20 GB voor bundel, twee herstelde collecties en werkruimte.
De stagingcollectie blijft bewust staan. Controleer de bestaande Qdrant-image:
deze import vereist **1.16.2**. Als je server een andere versie of API-key-auth
gebruikt, stop hier; upgrade/downgrade of beveiligingswijzigingen horen niet bij
deze import en mogen niet blind op de bestaande installatie worden uitgevoerd.

## 2. Aparte, vertrouwde toolscheckout ophalen

De verbeteringen staan in PR #45 naar dev. Gebruik de featurebranch zolang de PR
nog niet is gemerged. Deze clone staat naast je deployment en schakelt geen branch
in de live checkout om. Als de gekozen toolsdirectory bestaat, kies een andere
lege directory; overschrijf hem niet.

```bash
export OBV_TOOLS="$PWD/obv-transfer-tools"
test ! -e "$OBV_TOOLS" || { echo 'STOP: toolsdirectory bestaat al'; false; }
git clone --single-branch --branch fix/openbesluitvorming-limburg-full-ingest https://github.com/GovChat-NL/GovChat-NL.git "$OBV_TOOLS"
cd "$OBV_TOOLS"
git log -1 --oneline
mkdir -p exports
chmod 700 exports
```

## 3. De hele bundelmap uploaden

Gebruik WinSCP met gecontroleerde SSH-hostkey. Kopieer de **hele** lokale map
[openbesluitvorming-limburg-20261116](../exports/openbesluitvorming-limburg-20261116/)
naar de toolscheckout onder **exports**. De serverstructuur wordt:

```text
obv-transfer-tools/
  scripts/openbesluitvorming-transfer.py
  docker-compose.openbesluitvorming-worker.yml
  exports/openbesluitvorming-limburg-20261116/
    manifest.json
    dataset.snapshot
    ingest-state.tar.gz
    code.tar.gz
    README.md
    server-guide.md
```

Geen Windows/WSL-schijfbestand, lokale credentials of live GovChat-configuratie
kopiëren. Het codearchief hoeft niet handmatig te worden uitgepakt: we gebruiken
de vertrouwde checkout uit stap 2. De bundel blijft als versievaste backup bewaard.

```bash
export OBV_BUNDLE="$PWD/exports/openbesluitvorming-limburg-20261116"
test -f "$OBV_BUNDLE/manifest.json"
python3 -B scripts/openbesluitvorming-transfer.py validate --bundle "$OBV_BUNDLE"
```

Verwacht: **bundle_validated_offline_snapshot_semantics_require_import_staging**.
Dit controleert checksums, archieven en SQLite; de native snapshot wordt pas tijdens
de staged import door Qdrant zelf gecontroleerd. Deel de bundel niet publiek.
De importer draait als UID10001: zorg dat deze gebruiker de bundel kan lezen en
alleen de benodigde directories kan doorlopen. Een gerichte ACL, indien aanwezig:

```bash
setfacl -m u:10001:--x "$PWD" "$PWD/exports"
setfacl -R -m u:10001:r-X "$OBV_BUNDLE"
```

Als ACL's ontbreken, laat de serverbeheerder beperkte lees-/traverserechten regelen;
verander niet recursief de rechten van je bestaande GovChat-data.

## 4. Bestaande Qdrant en netwerk selecteren

Pas **alleen** de containernaam hieronder aan als stap 1 een andere naam laat zien.
Dit moet je bestaande, draaiende Qdrant zijn, niet een nieuw aangemaakte server.

```bash
export OBV_QDRANT_CONTAINER=librechat-qdrant
docker inspect --format 'Image={{.Config.Image}} Running={{.State.Running}}' "$OBV_QDRANT_CONTAINER"
docker inspect --format '{{range $name, $config := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$OBV_QDRANT_CONTAINER"
```

Noteer een bestaand netwerk dat ook door je LiteLLM wordt gebruikt. Als er meerdere
netwerken zijn, kies niet willekeurig. De importer praat intern via de geselecteerde
Qdrant-container; de worker heeft straks het gedeelde netwerk nodig voor queries/
embeddings/Tika. Controleer desgewenst de netwerken van je bestaande LiteLLM:

```bash
docker inspect --format '{{range $name, $config := .NetworkSettings.Networks}}{{println $name}}{{end}}' librechat-litellm
```

## 5. Eigen serverconfiguratie maken

Maak in de toolscheckout een **nieuwe** private environmentfile. Gebruik hierin de
netwerknaam uit stap 4, de bestaande Qdrant-container en de LiteLLM-configuratie van
de server. De LiteLLM-key blijft privé en hoort niet in chat of Git. Pas container-
en servicenamen aan waar je bestaande deployment daarvan afwijkt.

```bash
test ! -e .env.server || { echo 'STOP: .env.server bestaat al; controleer hem eerst'; false; }
umask 077
touch .env.server
chmod 600 .env.server
nano .env.server
```

Inhoud (de waarden tussen hoekhaken moet je vervangen; voer die niet letterlijk uit):

```dotenv
OBV_DOCKER_NETWORK=<gedeeld netwerk uit stap 4>
OBV_QDRANT_URL=http://librechat-qdrant:6333
LITELLM_URL=http://librechat-litellm:4000
LITELLM_API_KEY=<bestaande server LiteLLM-key>
OBV_EMBEDDING_MODEL=govchat-embedding
OBV_TIKA_URL=http://obv-ingest-tika:9998/tika
```

De embedding-alias moet verwijzen naar het passende onderliggende model:
**Azure text-embedding-3-large, 3072 dimensies**. Alleen dezelfde aliasnaam is niet
genoeg. De nieuwe workerconfig heeft dezelfde 256 MiB download-/2 GiB workerlimiet
als de laatst gevalideerde refresh. Geen credentials van de pc hergebruiken.

## 6. Nieuwe ingest-opslag maken, worker NIET starten

Projectnaam en state-volume zijn apart van de bestaande deployment. Laat deze
waarden in de rest van de stappen gelijk. Als het volume al bestaat, stop en
controleer: kies eventueel een echt nieuwe project-/volumenaam in alle opdrachten.

```bash
export OBV_PROJECT=govchat-obv-server
export OBV_STATE_VOLUME="${OBV_PROJECT}_openbesluitvorming-ingest-state"
if docker volume inspect "$OBV_STATE_VOLUME" >/dev/null 2>&1; then echo 'STOP: doelvolume bestaat al'; false; else echo 'Doelvolumenaam is vrij'; fi
```

Ga alleen verder als **Doelvolumenaam is vrij** werd getoond. Definieer een handige
functie voor de nieuwe, beperkte Compose-configuratie:

```bash
obvcompose() { docker compose --env-file .env.server -p "$OBV_PROJECT" -f docker-compose.openbesluitvorming-worker.yml "$@"; }
obvcompose build openbesluitvorming-ingest
obvcompose create --no-deps openbesluitvorming-ingest
docker volume inspect "$OBV_STATE_VOLUME" --format '{{.Name}}'
```

Dit maakt alleen een niet-gestarte worker en een lege, UID10001-owned state-opslag.
Er wordt **geen Qdrant/LiteLLM/n8n/mongodb gestart of aangepast**. Start ook geen
status-opdracht op de lege state vóór import: die zou de database initialiseren.

## 7. Eerst dry-run

```bash
python3 -B scripts/openbesluitvorming-transfer.py import --bundle "$OBV_BUNDLE" --compose-project "$OBV_PROJECT" --qdrant-container "$OBV_QDRANT_CONTAINER" --state-volume "$OBV_STATE_VOLUME" --dry-run
```

Alleen bij een geslaagde dry-run ga je verder. Bij melding over bestaande collectie
**limburg_full_20261111**, bestaande state, versie/auth of rechten: stop. Geen
collecties/volumes verwijderen, geen authenticatie uitschakelen en geen force-optie
zoeken. Bestaande gegevens moeten behouden blijven.

## 8. Snapshot en checkpoints daadwerkelijk importeren

```bash
python3 -B scripts/openbesluitvorming-transfer.py import --bundle "$OBV_BUNDLE" --compose-project "$OBV_PROJECT" --qdrant-container "$OBV_QDRANT_CONTAINER" --state-volume "$OBV_STATE_VOLUME"
```

Dit kan minuten duren. Snapshot/state worden eerst gestaged en gecontroleerd; pas
daarna wordt de nieuwe eindcollectie en state gepubliceerd. De bestaande collecties
blijven staan. De succesvolle diagnostische stagingcollectie blijft ook staan,
vandaar de tijdelijke dubbele opslag. Noteer de geprinte diagnostische identifiers.
Bij een fout niet blind opnieuw importeren: er kan bewust bewaarde partial state
staan. Raadpleeg dan de uitgebreide [transferhandleiding](openbesluitvorming-transfer.md).

## 9. Resultaat controleren, nog geen nieuwe ingest

```bash
obvcompose run --rm --no-deps openbesluitvorming-ingest status --run-id limburg-full-20261111
obvcompose run --rm --no-deps openbesluitvorming-ingest verify --run-id limburg-full-20261111 --sample-size 10
```

Verwacht: **56.475 Qdrant-punten**, **56.678 documentrecords**, **203 dead letters**,
geen pending/processing/retries en afgeronde snapshot/refreshgeneratie 1.
**complete=false** is door de 203 fouten correct; het betekent niet dat import
mislukt is. Verificatie moet wel pointaantallen en samplemetadata/vectors goedkeuren.
De historische samplerun zit in de checkpointgeschiedenis, maar diens aparte
Qdrant-collectie is niet meegenomen. Gebruik alleen de full-run-ID hierboven.

## 10. Alleen na verificatie: toekomstige ingests vanaf deze server

Als je bestaande Tika wilt gebruiken, zet de juiste interne URL in .env.server.
Anders kan de aparte parser uit deze kleine Compose-config worden gestart:

```bash
obvcompose up -d obv-ingest-tika
```

Dit start geen worker. Zorg voor voldoende RAM naast je bestaande GovChat-diensten;
worker en parser hebben elk maximaal 2 GiB. Controleer eerst de server-provider/
embeddingmapping en spreek zo nodig bulktoegang af met de bronbeheerder.
Vervolgens, alleen als je nu een nieuwe refresh wilt starten:

```bash
obvcompose run --rm --no-deps openbesluitvorming-ingest refresh --run-id limburg-full-20261111 --approve-full-run
obvcompose run -d --no-deps --name govchat-obv-server-run openbesluitvorming-ingest run --run-id limburg-full-20261111 --max-documents 1000000 --max-pages 100000 --page-size 100 --workers 2 --approve-full-run
```

Dit controleert alle documentcategorieën; geen nieuwe, lege full-ingest initialiseren.
Opnieuw verbinden via SSH is geen reden een tweede worker te starten. Om een reeds
gestopte container met dezelfde opdracht te hervatten, na controle dat er geen
andere writer draait, kan **docker start govchat-obv-server-run** worden gebruikt.
Een volgende refreshgeneratie vraagt eerst een geëindigde/settled eerdere queue;
bewaar oude logs voordat je een reeds gebruikte containernaam opnieuw kiest.

## 11. Dashboard op de server

Met Node.js op de server, open dit in een tweede SSH-terminal in dezelfde toolsmap:

```bash
node scripts/openbesluitvorming-progress.js --container govchat-obv-server-run --run-id limburg-full-20261111 --lines
```

Zonder Node.js kun je de Python-workerstatus uit stap 9 periodiek opvragen, of logs:

```bash
docker logs --tail 50 -f govchat-obv-server-run
```

De originele pc-monitor controleert nog steeds de pc, niet automatisch de server.
Dit is geen browserdashboard; het is dezelfde teller via de SSH-terminal.

## 12. Zoekworkflow pas bewust omschakelen

De import wijzigt geen bestaande zoekworkflow. Na verificatie kun je die op de
nieuwe collectie **limburg_full_20261111** richten. Laat de oude collectie intact
voor rollback. Een eventuele aliaswissel moet expliciet worden gekozen en
gecontroleerd, niet door het importscript. De datasetoverdracht is daarmee veilig
gescheiden van de zoek-publicatie en van nieuwe ingest-runs.
