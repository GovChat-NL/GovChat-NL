# Documentbijlagen in de n8n-chatagent

## Oorzaak en oplossing

LibreChat verstuurt een PDF naar een OpenAI-compatible custom endpoint als een
native `file`-blok met inline base64-bytes. De n8n-agent maakt een tekstprompt van
de berichten. Alleen tekstblokken lezen betekende dat een upload wel zichtbaar
was in de chat, maar de documentinhoud ontbrak in de prompt.

De **Extract Document Context**-node draait vóór **Detect Image Messages**. Hij
zet native `file`, `input_file` en base64 `document`-blokken via Apache Tika om
naar benoemde tekstblokken. Daardoor krijgen ook gemengde PDF/afbeelding-vragen
en vervolgvragen met opnieuw meegestuurde bijlagen de documenttekst. Bestaande
tekst, berichtvolgorde, afbeeldingsblokken en tool-instellingen blijven behouden.

Ondersteund: PDF, platte tekst, CSV, Markdown, RTF, Word en OpenDocument-tekst.
Dit is geen RAG/indexeringsfunctie: het document wordt per meegestuurde beurt
gelezen. Voor ontbrekende inline bytes, onleesbare of te grote documenten wordt
de hele documentbeurt afgewezen met een leesbare melding. Er wordt geen gedeeltelijke
context doorgestuurd waarmee de agent ten onrechte volledige leestoegang suggereert.
Een scan zonder extraheerbare tekst moet als tekst-PDF worden aangeleverd.

## Veiligheid en limieten

- Alleen door LibreChat aangeleverde inline bytes; geen opzoeken van `file_id`,
  ophalen van `file_url` of redirects. De node leest geen lokale bestandsnamen.
- Geen nieuwe publieke upload-/extractie-API, geheime sleutel of gedeelde opslag.
- Bestaande eigendomscontrole en autorisatie van uploads blijven bij LibreChat.
- Alleen de ingestelde interne Tika-URL krijgt bytes. Tika is niet publiek bereikbaar.
- Maximaal 10 bijlagen, samen standaard 10 MiB en 120.000 teksttekens per beurt.
- Eén extractietermijn voor de hele beurt: standaard 30 seconden.
- Native bytes worden vervangen door tekst en niet naar het tekstmodel doorgestuurd.
- Diagnostiek bevat uitsluitend aantallen/status/foutcode, geen documentinhoud.
- Bestandslabels behandelen de inhoud als bronmateriaal, niet als instructies.

De opties in `.env.example` zijn `N8N_DOCUMENT_TIKA_URL`,
`N8N_DOCUMENT_MAX_BYTES`, `N8N_DOCUMENT_MAX_CHARS` en `N8N_DOCUMENT_TIMEOUT_MS`.
De Compose-configuratie geeft ze door aan n8n én de externe JavaScript-runner;
de runner-allowlist bevat dezelfde namen.

## Uitrollen

1. Maak een privéback-up/export van de huidige live workflow.
2. Pas `applyDocumentContext` uit `scripts/orchestrator-document-workflow.js`
   toe op de live export. Importeren van de volledige repository-workflow kan
   anders lokale prompts, tools, modellen of credentials overschrijven.
3. Importeer die aangepaste export in hetzelfde n8n-project en publiceer de nieuwe
   versie. Een herstart zonder import/publicatie verandert de opgeslagen workflow niet.
4. Controleer dat Tika beschikbaar is. Maak n8n en de task-runner opnieuw aan
   wanneer de omgevingsinstellingen of runner-allowlist gewijzigd zijn; een gewone
   herstart leest gewijzigde omgevingsvariabelen niet opnieuw uit het omgevingsbestand.
5. Test een PDF-vraag en een gestreamd antwoord. De PR deployt niet automatisch.

De applicator is idempotent, behoudt overige live workflowinstellingen en wordt
ook toegepast door `scripts/update-orchestrator-workflow.js`, zodat opnieuw
genereren de documentnormalisatie niet verwijdert.

## Regressietests

De openbare tests genereren een synthetische PDF met het getal 13; geen upload
van een gebruiker wordt opgenomen in Git. Tests gebruiken ook andere inhoud en
bestandsnamen, meerdere documenten, gemengde afbeeldingen, foutpaden en limieten.

```sh
node --test tests/document-context.test.js
node tests/orchestrator/run-document-smoke.js
```

Voer de tweede opdracht uitsluitend uit in een tijdelijke n8n-container. Hij
gebruikt een eigen SQLite-database, synthetische credentials en een lokaal
modelantwoord dat **alleen** slaagt wanneer de echte agentprompt de gelezen
documentinhoud bevat. Er worden geen productieworkflows geïmporteerd.

Voor echte Tika-extractie kan de testcontainer
`GOVCHAT_DOCUMENT_TIKA_TEST_URL` krijgen. Een expliciet alleen-lezen gekoppelde
test-PDF kan via `GOVCHAT_DOCUMENT_TEST_PDF` worden opgegeven. De inhoud moet voor
de 13-regressietest het getal 13 bevatten; de implementatie kent dat getal niet.

Voor een aparte Tika-testcontainer met netwerkalias `tika`:

```sh
GOVCHAT_DOCUMENT_TIKA_TEST_URL=http://tika:9998/tika node --test tests/document-context.test.js
GOVCHAT_DOCUMENT_TIKA_TEST_URL=http://tika:9998/tika node tests/orchestrator/run-document-smoke.js
```
