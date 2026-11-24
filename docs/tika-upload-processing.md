# Tika document uploads: upload → extract → chat context

**Status: repair candidate, not an accepted release.** Contract tests and three
complete warm client/upload-handler cycles pass. Authenticated browser, real
persistence, actual document bridge/model delivery and native image analysis now pass in
the [retained local UI](tika-local-app.md). Broad corpus/lifecycle and production acceptance
remain open. Read the
[current repair status](tika-upload-repair-status.md) before
activation. Commands below describe the intended integration, not a deployment
already performed or approved by acceptance tests.

## Direction and ownership

Use the [opt-in Compose overlay](../docker-compose.tika-upload.yml) with the
regular stack. Documents go to the private [extraction adapter](../services/document-extractor/app.py)
and standard Apache Tika 3.2.3 with Dutch/English OCR. The adapter returns extracted
text. LibreChat v0.8.8 stores it with the authenticated file owner and text-delivery
metadata, then reuses the stored text on subsequent turns. No embedding service,
vector store, retrieval, per-turn extraction, document cache or database access
is needed in the adapter. The upstream environment variable is named RAG_API_URL,
but this adapter implements extraction only, not RAG endpoints.

The [format manifest](../services/document-extractor/routes.json) covers PDF,
DOCX, PPTX, XLSX, MSG, EML, ODT, DOC and RTF. Native UTF-8 text and existing media
routes are preserved. PDF parsing uses normal auto OCR first; only a completed
unreadable result gets one bounded OCR-only recovery attempt.

## What was broken and what changed

- The original standalone experimental Compose did not activate the LibreChat
  extraction route. The overlay now sets the private origin, shares the regular
  JWT signing key, and waits for extractor health. Do not create a second key.
- A high-resolution generated scan reproduced Java heap exhaustion in PDFBox's
  image decoding through the real client. Increasing container memory while
  keeping a 256 MiB heap did **not** fix it. The tested configuration uses a
  512 MiB maximum heap and 1536 MiB container cap, accounting for both JVMs,
  native OCR and scratch. OCR remains at the standard 300 DPI. Sandbox controls,
  CPU/process limits and swap prohibition remain intact.
- LibreChat catches configured extraction errors and otherwise invokes its own
  document parser, which can store nonempty replacement-character garbage.
  The [selective upload preload](../scripts/librechat-tika-upload-preload.js)
  throws before that fallback for manifest document MIME types only, when this
  feature is explicitly enabled. It does not add content-security filters or
  traverse ordinary chat. Its exact source anchor is checked against v0.8.8;
  incompatible upstream code fails startup instead of silently dropping the guard.
- One parser remains active at a time. Up to three additional authenticated
  requests can wait without their bodies being read/spooled. Waiting counts
  against the original deadline; excess callers receive a busy response. A
  waiting timeout does not poison a parser that was never called.
- Uploads are limited to 12 MiB, 60 PDF pages and 15 MiB extracted UTF-8 text.
  Binary preflight has up to 30 seconds within the same 270-second request
  deadline; an overloaded/timed-out validator returns a temporary service error
  and is killed/reaped, not classified as an invalid document or a parser fault.
  The renderer also caps the endpoint upload-size setting at 12 MiB. Actual model
  context/token limits are inherited, not increased or bypassed.

## Activation

Render from the **current configuration used by the deployment**, not an old
example. Python with PyYAML is needed for the [renderer](../scripts/render-document-processing-config.py).
From the repository root on a Linux deployment:

```sh
python3 scripts/render-document-processing-config.py --source librechat.yaml --output .tika-upload-local/librechat.generated.yaml --stt-configured false
```

Replace the source path with the deployment's actual current configuration and
declare whether upload transcription is configured. The renderer refuses to
overwrite its source and rejects overlapping configured OCR routes. It preserves
media delivery, tool settings, security policies and existing context limits.
Regenerate the opt-in output after changing the source configuration.

Copy the [feature environment example](../.env.tika-upload.example) to a private
feature environment file. Keep the existing regular private environment file;
it provides LibreChat's JWT_SECRET. Start only the task's parsers, wait for health,
and then recreate only LibreChat:

```sh
docker compose --env-file .env --env-file .env.tika-upload -f docker-compose.yml -f docker-compose.tika-upload.yml up -d --build upload-tika document-extractor
docker compose --env-file .env --env-file .env.tika-upload -f docker-compose.yml -f docker-compose.tika-upload.yml ps document-extractor
docker compose --env-file .env --env-file .env.tika-upload -f docker-compose.yml -f docker-compose.tika-upload.yml up -d --no-deps --force-recreate librechat
```

Do not point an embedding/file-search feature at this extraction-only adapter.
If a deployment needs both, a separately reviewed split of upstream origins is
required. This change does not deploy itself or modify a production database.

## Reproducible isolated tests

Build the images in dependency order; no host Node/Python installation is needed:

```sh
docker build -t govchat-tika-upload-adapter:local services/document-extractor
docker build -t govchat-tika-nl:3.2.3 services/tika
docker build -t govchat-tika-contract-tests -f tests/document-processing/Dockerfile .
docker compose -p govchat-tika-validation -f tests/document-processing/compose.yml config --quiet
docker compose -p govchat-tika-validation -f tests/document-processing/compose.yml run --rm contracts
docker compose -p govchat-tika-validation -f tests/document-processing/compose.yml run installed-contracts
docker compose -p govchat-tika-validation -f tests/document-processing/compose.yml run client
docker compose -p govchat-tika-validation -f tests/document-processing/compose.yml run --no-deps upload-handler
docker compose -p govchat-tika-validation -f tests/document-processing/compose.yml run --no-deps client
docker compose -p govchat-tika-validation -f tests/document-processing/compose.yml run --no-deps upload-handler
```

Run each command only after the preceding command succeeds. These commands also
work in Windows Command Prompt from the repository root. Do not run heavy builds
alongside OCR workloads. Use this project name only for an exclusively owned,
disposable test project; choose another explicit name consistently if it is already
in use. Do not add existing private environment files or the regular stack Compose.

The network-free installed-contract service renders the tracked public configuration
into an owned volume, preserving secret placeholders. It runs the installed
schema/routing/branding checks, ordinary Unicode/chat-filter checks, three selective
preload tests and existing document-context regressions. Its dependency lookup uses
the installed LibreChat image, not host modules. The optional external document-context
live test is skipped in this network-free service; it is not a browser acceptance test.

Keep client and upload-handler containers after failure: inspect their exit status
and safe test output before cleanup. There are no test retries. Subsequent runs use
the same warm adapter/parser; the no-dependency option prevents accidental restarts
or fixture regeneration after the first successful startup. Each complete client run
must finish with 53 passed cases, and each upload-handler run with eight passed tests
(three preload and five handler tests), including the live-handler case with no skip.

The [test Compose](../tests/document-processing/compose.yml) has no public ports,
production databases or credentials. It generates synthetic documents into its
own volume. The [client workload](../tests/document-processing/client-extraction.test.cjs)
reuses a warm parser for office documents, plain text, ten repeated scan/broken-layer/
mixed/native cycles, a 30-page noisy scan, and four high-resolution scans.
The [upload-handler tests](../tests/document-processing/upload-handler.test.cjs)
execute the actual installed handler/client with captured storage/DB calls and
actual stored-text context formatting. They prove the failing-before/passing-after
fallback boundary, text-delivery metadata, owner assignment, multiple attachments,
follow-up reuse and persistence-error behavior. Storage and DB are test doubles:
this is **not** an authenticated browser or production MongoDB/model test.

Remove only these disposable test services and their synthetic volume afterwards:

```sh
docker compose -p govchat-tika-validation -f tests/document-processing/compose.yml down --remove-orphans -v
```

This removes only the explicitly named disposable project, its retained test
containers and owned fixture/configuration volumes. Never use this cleanup command
for a retained UI/database project or prune shared images, caches or volumes.

## Failure handling, acceptance and rollback

Malformed, encrypted, unreadable, oversized and partially extracted documents
produce errors, never fake successful text. Unknown parser termination still
latches an unhealthy adapter. Do not clear it automatically just because the
watchdog's replacement JVM responds; native cleanup is not established by that.
Recover deliberately by stopping the dedicated adapter and parser, then starting
the parser and adapter afresh. Do not restart any shared parser or unrelated stack.

OCR is not exact transcription. Extremely large raster images can still exceed
the bounded resource envelope; those uploads fail rather than persisting junk.
Legacy DOC/MSG/RTF fidelity and arbitrary scans are not guaranteed by the generated
PDF/DOCX/PPTX/XLSX/ODT/EML fixtures. Model limits can truncate context independently
of extraction/storage. Historical bad file records are not rewritten: upload the
document afresh after activation.

After deployment, acceptance still requires an authenticated new browser upload,
owner-scoped attachment resolution, subsequent-turn reuse and actual final bridge/
model delivery. For rollback, restore the pre-feature config/origin and recreate
only LibreChat without the feature overlay, then retire only these dedicated
parser services. Preserve user files, later unrelated settings and security rules.
