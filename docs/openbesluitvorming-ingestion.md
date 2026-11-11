# Limburg full-document ingestion: operator guide

## Safety and implementation

The supported ingestion path is the one-shot service in
[`docker-compose.yml`](../docker-compose.yml), implemented by
[`worker.py`](../services/openbesluitvorming-ingest/worker.py).
It is opt-in, has no listener or scheduler, and defaults to a read-only status
command. Starting the normal application does **not** start ingestion.

The three legacy ingestion/sync/document-worker exports are retired and inactive:
their schedule triggers have been removed and their entrypoints fail before any
network work. Their remaining nodes are historical reference, not the supported
pipeline. The search export and search regression suite have been preserved.
Bootstrap imports inactive workflows without briefly publishing them first.

Fresh initialization requires a new Limburg-prefixed collection and unique run
ID. It refuses an existing collection and never deletes, restores or switches an
alias. New collections use unnamed 3072-dimensional Cosine vectors, disk-backed
vectors/HNSW/payload, and metadata indexes. Search remains document-vector
compatible: one normalized, token-weighted full-document mean vector per document.
Every content token contributes once; batches contain at most eight 2000-token
windows plus a bounded title/organisation prefix. There is no 48-chunk cap and no
silent tail truncation.

## Actual source schema and content

The source is the public snapshot endpoint at
<https://openbesluitvorming.nl/api/export/snapshot?source=provincie_limburg&limit=5>.
It returns UTF-8 NDJSON and pagination headers, **not** a JSON array.
All records are archived. Document records become durable jobs. The first observed
change cursor was 111032; a fresh full run captures its own cursor when started.

Each snapshot Document already represents an attachment. Some have no derived
markdown; the first two live fixtures contain only iBabs download links. For each
document the worker:

1. Fetches and validates the corresponding entity detail by exact identity.
2. Preserves the entire snapshot record, source payload and entity-detail response,
   including unknown fields and null/false/zero values, not just a field allowlist.
3. Enriches meeting/motion references using a cached entity-detail response.
   Organisation IDs are **not** resources exposed by this API (live HTTP 404).
   Their exact ID and the document's organisation label remain preserved, with an
   explicit reference-only status rather than invented organisation metadata.
4. Uses complete source markdown when present; otherwise downloads the first media
   object or original attachment and extracts it using Tika. Alternative stored,
   iBabs and entity-detail download links are fallback candidates for that object.
   Additional media objects and explicit attachment arrays are all processed;
   exact duplicate URLs are deduplicated. A required attachment failure fails the
   document, even if other content was available.
5. Preserves full extracted text, extraction method, byte/character counts, binary
   digest and fallback-error evidence, and stable public Limburg portal links
   separately from original download provenance.
6. Embeds all text in bounded token batches, validates every index/dimension/finite
   number, pools by content-token weight, and waits for completed Qdrant upsert.

Malformed NDJSON, missing/malformed headers, repeated/backtracking cursors,
unordered/duplicate records and a cursor not matching the last page record abort
the whole page. The raw rejected response and error remain in durable state. The
cursor is not advanced on rejection. Valid pages, raw records and jobs commit in
one SQLite transaction **before** cursor advancement. Cursor advancement therefore
means durably queued, not necessarily already embedded. Completion requires both
the terminal snapshot page and zero unfinished/failed jobs.

The worker does not invent inaccessible metadata. A missing meeting entity, blank
Tika/OCR text, unsupported attachment schema or oversized document is visible in
retry/dead-letter state, never silently treated as successfully ingested.

## This machine: prepared runtime and observed results

Validation performed on 2026-11-11, Windows CMD + Docker Desktop:

- n8n and external runners 2.25.7, the locally built sibling bridge, LiteLLM,
  Qdrant 1.16.2 and Tika 3.2.3.0-full were started.
- The old stopped deployment belongs to a different Compose project. The local
  override uses distinct n8n/bridge/LiteLLM container names and separate database
  volumes; the old stopped deployment and test Qdrant at loopback port 16333 were
  not modified or restored.
- The environment's Linux-style Compose file list and absent external LiteLLM
  configuration are bypassed with explicit file arguments and a minimal checked-in
  configuration. The secret-bearing environment file was not printed or changed.
- LiteLLM embedding smoke: HTTP 200, 3072 dimensions, all finite. The worker's own
  credentials also worked during live ingestion.
- Local chat routes retain the development branch's GPT-5.4 deployment mapping.
  Embeddings are independently validated and do not depend on chat completion.
- Exactly **five distinct documents** were attempted, never a full ingestion.
  Two used Tika and three used source markdown. Two organisation-reference jobs
  initially entered retry; after the schema fix they were explicitly requeued and
  both indexed without advancing to new documents.
- Final sample: five Qdrant points, five durable indexed jobs, zero failures.
  All five passed exact raw-metadata, full-text-length, dimension and normalization
  checks; a live embedding/Qdrant query returned the coronavirus documents first.
- Sample run: **live-sample-20261111**, collection **limburg_sample_20261111**.
- Prepared full run: **limburg-full-20261111**, collection **limburg_full_20261111**.
  This full collection is empty: zero pages fetched and **no full run executed**.
- OpenBesluitvorming search, ingestion, document worker and sync remain inactive
  in the n8n database. No ingestion schedule was activated.
- A temporary token-protected webhook confirmed actual external Code-runner
  execution and Tika HTTP 200, without starting ingestion; it was subsequently
  unpublished. Its reproducible fixture is outside the bootstrap workflow tree.
- Offline ingestion suite: 40 tests passed. Linux agent suite: 36 passed, one
  optional live-Qdrant test skipped. The separate live-Qdrant search run passed
  all 15 tests with no skips. Whitespace validation passed.

Local endpoints: n8n <http://localhost:15678>, bridge
<http://localhost:13333/health>, LiteLLM <http://localhost:14000/health/liveliness>.
Qdrant and Tika remain internal. An n8n owner was not automatically provisioned
because owner credentials are absent; complete the local owner setup in the UI
before interactive workflow administration. This is not required by the worker.
This guide validates the ingestion pipeline and vector retrieval, not a complete
LibreChat/orchestrator search roundtrip.

### Final actual n8n search smoke (2026-11-11)

An authenticated production webhook executed the search definition through n8n's
Execute Workflow node and the external Code runner against the existing sample.
The deployed search nodes and connections were verified identical to the source;
the core workflow was neither modified nor published.

| Fixed coronavirus query mode | HTTP | Unique documents / results |
| --- | --- | --- |
| Source `provincie_limburg` | 200 | 5 / 5 |
| Nonexistent source negative control | 200 | 0 / 0, explicit no-results |
| Limburg plus inclusive 2020 date range | 200 | 1 / 1 |

The first result was **Provinciale maatregelen tegen de gevolgen van het
Coronavirus**, GS letter of 23 June 2020, indexed date 24 June 2020. Its public link
was <https://limburg.bestuurlijkeinformatie.nl/Document/View/0004be00-2a6a-4f04-8a07-2754dd13a5d4>.
The second result concerned the creative/cultural sector, possible lockdown and
cancelled performances/carnival events, GS letter of 2 December 2021. The date
filter retained only the first document. Both query variants reached Qdrant:
10 raw candidates fused into five documents for the source-only search; two raw
candidates fused into one for the date-filtered search.

Assertions verified source/organisation, nonempty bounded text (at most 3000
returned characters), document-character/chunk metadata, Limburg portal URLs,
and retained original iBabs download URLs for all returned sample documents.
LiteLLM's actual rerank response was HTTP 400: no mapping for
`cohere-rerank-v4.0-fast`. n8n continued through the HTTP-error output, retained
the candidates and returned `applied=false`, `fallback_used=true`; no model
configuration was changed. This validates fallback, not successful Cohere reranking.

Important n8n 2.25.7 limitation: the initial database-ID subworkflow call failed
with **Workflow is not active and cannot be executed**. A production caller
requires a published database subworkflow. To preserve the core inactive state,
the successful probe used **Define Below / parameter** with the unchanged search
nodes/connections. Only the temporary snapshot's diagnostic success/error
retention differed. This is real n8n subworkflow execution, not proof that an
unpublished database-ID call works. Parent/child execution pairs **14/15, 16/17,
18/19** all persisted `success`, `finished=true`. The earlier progress-only
rows were caused by globally disabled success retention; the temporary probe
enabled final retention without changing deployment settings.

Missing bearer authentication was rejected before the subworkflow (HTTP 500
from the temporary Code-node guard, not a structured HTTP 401). The temporary
probe was subsequently unpublished. No full ingest was run; the prepared full
run still had zero pages, empty job counts, unchanged preparation timestamps,
and the full collection remained empty.

Reproducible probe assets are outside the bootstrap workflow tree:
`tests/agents/fixtures/openbesluitvorming-search-runtime-smoke.json` is an inactive
template, **not directly importable for execution**: its empty workflow parameter
must first be populated by
`tests/agents/build-openbesluitvorming-search-smoke.cjs`. The builder accepts an
output path and optional CLI workflow-export path, rejects active or divergent
deployed search nodes/connections, and injects only the search definition. Import
and publish only the generated temporary probe, restart only n8n with the explicit
Compose files, and call its production webhook with the runtime bearer token.
The only allowed body modes are `limburg`, `wrong_source` and `date_2020`;
collection, query and limits cannot be overridden. Always unpublish the temporary
probe and restart n8n afterward. Regression coverage includes the authentication,
sample bounds, snapshot execution mode and actual HTTP-error fallback shape:
17 tests passed, with the optional standalone direct-Qdrant test skipped in this
host test run; the production-webhook Qdrant queries above actually ran.

## Operator commands: current Windows runtime

Run from the GovChat-NL repository directory in **CMD**. The following convenience
variable contains no secrets and ensures every command targets the same Compose
files/project/volumes. Do not mix it with the older stopped deployment.

```bat
set OBV=docker compose -f docker-compose.yml -f docker-compose.openbesluitvorming-local.yml --profile openbesluitvorming-ingest
%OBV% build openbesluitvorming-ingest n8n-openai-bridge
%OBV% up -d qdrant tika litellm n8n n8n-runners n8n-openai-bridge
%OBV% run --rm --no-deps openbesluitvorming-ingest status
```

The profile is needed to discover the worker, not to activate a daemon.
For a Linux/production deployment omit the local override, supply the actual
deployment's validated Compose overrides, and retain its project name and volume
names consistently. The commands after the Compose prefix are the same. The base
configuration supports a configured bridge build context; the local override uses
the existing sibling checkout without modifying that separate repository.

### Fresh initialization (no ingestion)

On a new deployment, or for a genuinely new isolated dataset:

```bat
%OBV% run --rm --no-deps openbesluitvorming-ingest fresh --run-id limburg-full-20261111 --collection limburg_full_20261111
%OBV% run --rm --no-deps openbesluitvorming-ingest verify --run-id limburg-full-20261111
```

**Initialization already succeeded on this machine. Skip the first command here.**
Repeating it intentionally refuses, protecting existing collections. For another
fresh run choose both a new run ID and a new Limburg-prefixed collection name.
An interrupted initialization can leave an unregistered empty collection; do not
delete it automatically. Inspect it and choose a new unique name if necessary.

### Explicit operator start: up to 100k attempts

**This command is documented only; it was not executed during validation.**
It begins processing the prepared fresh run, or resumes that same run:

```bat
%OBV% run -d --name govchat-obv-full-run --no-deps openbesluitvorming-ingest run --run-id limburg-full-20261111 --max-documents 100000 --max-pages 20000 --page-size 20 --approve-full-run
docker logs --tail 50 -f govchat-obv-full-run
```

The limits are per invocation, not total unique corpus sizes. Processing retries
also counts toward the attempt budget. A 100k attempt limit is not evidence of
completeness: use status and the terminal snapshot flag. More than ten attempts or
ten pages requires the explicit approval flag. The five-attempt default is safe
for a later bounded sample, but **do not run it on the full run until you intend
to start that run**.

### Status, failure inspection and verification

These do not start ingestion:

```bat
%OBV% run --rm --no-deps openbesluitvorming-ingest status --run-id limburg-full-20261111
%OBV% run --rm --no-deps openbesluitvorming-ingest failures --run-id limburg-full-20261111 --limit 100 --offset 0
%OBV% run --rm --no-deps openbesluitvorming-ingest verify --run-id limburg-full-20261111 --sample-size 10
docker inspect --format "{{.State.Status}} exit={{.State.ExitCode}}" govchat-obv-full-run
```

Status shows counts, cursor, pages, terminal snapshot state and the first twenty
failures. Paginate failure listings by increasing the offset. Verification counts
all acknowledged points and checks a bounded sample, not a 100k payload download.
Run verification while ingestion is stopped to avoid a concurrent count race.
An optional query argument performs a small paid embedding and read-only retrieval.
An exit code of zero means the bounded invocation finished normally, **not** that
the entire corpus is complete. Always inspect counts and the completion flag.

### Stop and resume

```bat
docker stop -t 150 govchat-obv-full-run
%OBV% run -d --name govchat-obv-full-resume-1 --no-deps openbesluitvorming-ingest run --run-id limburg-full-20261111 --max-documents 100000 --max-pages 20000 --page-size 20 --approve-full-run
```

Use a new container name for each detached invocation, or deliberately remove an
already exited one-shot container before reusing its name. State is in the named
volume, not the container. Never resume with a different project, state volume,
run ID, collection, embedding provider/deployment or embedding alias mapping.
The persisted run model is retained on resume.

A shared kernel lock covers every mutating command and automatically releases on
process/container death. An overlapping run or retry refuses. On resume, a job
left in processing is replayed; deterministic IDs and completed upserts make this
safe even after a crash between Qdrant acknowledgement and SQLite commit.

### Retry failures

HTTP requests retry transient errors/429 with bounded backoff and Retry-After.
Document failures are scheduled durably with 60/120/... second backoff; after three
processing failures they become dead letters. Due retries are processed by later
run invocations. If only future retries remain, an invocation can finish before
they become due: wait and resume, or explicitly requeue after fixing the cause.
Requeue does not execute jobs and retains error evidence until successful replay:

```bat
%OBV% run --rm --no-deps openbesluitvorming-ingest retry --run-id limburg-full-20261111
%OBV% run -d --name govchat-obv-full-retry-1 --no-deps openbesluitvorming-ingest run --run-id limburg-full-20261111 --max-documents 100000 --max-pages 20000 --page-size 20 --approve-full-run
```

Use the optional entity-ID argument to requeue just one known failed document.
Do not continually reset attempts without investigating a permanent error.

## Capacity, security, publication and limitations

- Source API requests are paced at 1.1 seconds each (observed API budget 60/minute).
  100k detail requests alone take over 30 hours; downloads, references, Tika and
  embedding quota add time. No production-duration/100k load test was performed.
- Reserve substantial disk headroom for full text, duplicated raw metadata, SQLite
  pages, indexes and Qdrant snapshots. The vector data alone is about 1.23 GB at
  100k × 3072 float32 values. Twenty GB free is a starting planning allowance, not
  a guarantee. Monitor Docker Desktop disk, memory and provider quota.
- Worker memory is capped at 1 GiB. Documents above 64 MiB download or ten million
  text characters fail visibly rather than truncate. A very large payload may
  require a deliberately reviewed limit change. Tika blank text may require an
  OCR-enabled parser configuration; OCR quality was not validated on scanned files.
- Downloads require allowlisted HTTPS hosts and every redirect is checked. Add
  only trusted public storage hosts after reviewing failures, not arbitrary URLs.
  Error logs avoid response bodies, secrets and signed URL strings. Raw public
  source metadata and download provenance are intentionally retained in state and
  vector payloads; protect backups accordingly.
- State uses SQLite WAL with full synchronization and separate durable jobs/pages/
  rejected-page evidence. Back up both the named ingestion-state volume and Qdrant
  storage/snapshots. Do not use volume-deleting teardown commands.
- The original snapshot change cursor is retained for a later change-feed pipeline.
  Incremental synchronization is **not implemented by this worker**; the unsafe
  legacy sync is disabled. Entity detail can change during a long snapshot run;
  this is not a source-side point-in-time transactional snapshot. Raw snapshot
  record and fetched detail are both retained so differences are auditable.
- No search alias or existing collection was switched. After complete validation,
  an operator must explicitly point the deployed search workflow at the new
  collection, or use a deliberately managed alias when no concrete collection of
  that name conflicts. Keep a rollback path; do not delete the old dataset. The
  source search file remains unchanged by this ingestion deployment.
- Long-document mean pooling preserves vector compatibility, but query recall on
  long mixed-topic documents may be lower than a future multi-vector/chunk index.
  Such an index would require a separate search change and was not introduced here.

## Regression verification

The public, bounded fixtures and offline ingestion tests live in
[`test_openbesluitvorming_ingest.py`](../tests/agents/test_openbesluitvorming_ingest.py).

```bat
python -m unittest discover -s tests/agents -p test_openbesluitvorming_ingest.py
node --test tests/agents/openbesluitvorming-search.test.js
```

They cover real schema, malformed pagination, attachment/Tika fallback, multi-media
documents, full metadata, long-document traversal, response validation, durable
retry/dead letters, crash replay, locking, resource limits and safety approval.
The old public-link renderer now preserves an existing specialized search helper.
Some pre-existing Node file-permission tests require Linux filesystem semantics;
run the broader suite in a Linux container rather than interpreting Windows mode
bits as Unix permissions.

```bat
docker run --rm --network none -v "%cd%:/workspace:ro" -w /workspace node:24-alpine node --test tests/agents/*.test.js
set OBV_SEARCH_TEST_QDRANT_URL=http://127.0.0.1:16333
node --test tests/agents/openbesluitvorming-search.test.js
```

The latter uses uniquely named temporary fixture collections on the dedicated
test Qdrant instance, not the fresh full-run collection.
