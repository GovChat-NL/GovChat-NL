# Limburg full-document ingestion: operator guide

For a portable checkpoint/native-snapshot bundle and an empty-target restore, see
the [safe transfer and server runbook](openbesluitvorming-transfer.md). Transfer
does not start ingestion, export credentials, or switch search aliases.

## All-document refresh started: 2026-11-16

The user authorized resuming ingestion for **all document categories**, after
observing 4,590 motions on the public website. That website number is not directly
comparable with our 3,337 documents classified "Moties". The original archived
snapshot contained 2,125 **Motion entities**, alongside 56,646 Documents and
3,048 Meetings. Current snapshot probing returned change cursor **111358**, versus
the original **111032**, confirming later source changes but not their type/count.

**Refresh generation 1** started in the same run/collection on **2026-11-16 at
10:58:43 UTC** (11:58:43 Europe/Amsterdam), in container **govchat-obv-full-run**.
The old exited container/logs were retained as **govchat-obv-full-run-20261112**.
No collection was emptied, restored or switched.

The refresh performs a complete snapshot inventory with page size 100, preserving
all raw pages and the prior generation checkpoint. It compares entire canonical
source records, not only text hashes. Unchanged acknowledged documents do not
trigger new detail/download/embedding requests. New/changed documents queue
durably. Changed Meeting/Motion records queue affected documents after the entire
inventory has been traversed, including conservative handling of older detail-only
meeting references. Reference caches are invalidated. Missing snapshot records
remain retained and flagged for review; absence is not inferred to be deletion.
An explicit source tombstone is handled with acknowledged deletion and a backup
of the old vector/payload. Before any changed-vector upsert, the previous point is
archived durably under the state volume's vector history.

The dashboard separates **BESCHIKBAAR** (existing/current retained vectors) from
refresh work: rescanned, unchanged, new, changed/parent-changed, queued, indexed
this generation, and unresolved failures. During inventory, changed document jobs
can be pending while their previous vectors remain available. Processing starts
after the complete parent inventory is known; zero new indexing during this phase
is expected. Close/reopen pre-existing monitor windows to load the new counters.

The local download budget is now 256 MiB, with two pipelines and a 2 GiB worker
memory cap. The **80 prior size-budget failures** are eligible for exactly one new
attempt when encountered unchanged. Unchanged permanent download/parser/OCR
failures remain visible instead of blindly resetting their attempts. Documents
whose source record changed receive a normal bounded retry budget. Oversized,
invalid or unextractable files still fail explicitly without tail truncation.

First production observation at 11:00 UTC: 9,000 Documents rescanned, 8,940 unchanged,
6 new, 21 changed, 9 size retries queued, and 24 unchanged earlier failures retained.
All **56,371 existing Qdrant points** were still present. These are partial audit
counts, not a complete updated corpus or confirmation of the website motion total.
Tests passed: **77 Python ingestion/refresh tests** on Windows and Linux, plus
**25 Node monitor/search/probe tests**, including direct live-Qdrant filtering.

### Future refresh and resume

Run from the repository directory using the same explicit Compose prefix described
below. Generation initialization does not process documents:

```bat
%OBV% run --rm --no-deps openbesluitvorming-ingest refresh --run-id limburg-full-20261111 --approve-full-run --retry-size-failures-once
```

**Do not repeat initialization while generation 1 is active.** An interrupted
generation resumes with the ordinary run command, retaining its inventory cursor:

```bat
%OBV% run -d --name govchat-obv-refresh-resume --no-deps openbesluitvorming-ingest run --run-id limburg-full-20261111 --max-documents 1000000 --max-pages 100000 --page-size 100 --workers 2 --approve-full-run
```

The dashboard targets govchat-obv-full-run; if deliberately resuming under a new
container name, adjust its target or reuse the name after retaining the old exited
container. Baseline/current state and vector-history backups share the persistent
state volume. Do not run an old worker image against the migrated refresh state.

## Latest verification: 2026-11-16

The full snapshot traversal ended normally on **2026-11-12 at 22:13:12 UTC**
(23:13:12 Europe/Amsterdam), after approximately 28 hours 8 minutes. Docker and
the supporting services remain healthy; the one-shot ingestion container exited 0.

- **56,646 Document records** were discovered in **3,091 snapshot pages**.
  The earlier 100k figure was an estimate, not the actual count in this snapshot.
- **56,371 successfully indexed**, **275 dead letters**, zero pending/processing/
  scheduled-retry jobs. Snapshot complete is true; overall ingestion complete is
  **false**, because unresolved dead letters prevent a complete-corpus claim.
- Exact Qdrant count agrees with the durable indexed count: **56,371**. A ten-point
  verification sample passed full-text/source-metadata and vector checks.
- Unresolved evidence groups: 80 size-budget errors; 68 HTTP 422; 54 empty/HTML
  downloads; 34 empty-Tika-text plus HTTP 422; 30 empty-Tika-text; 9 HTTP 404.
  Retry only after addressing the relevant limit/parser/source issue.
- No new ingestion or failure requeue was started during this status inspection.

The monitor's stopped-container fallback was repaired: a read-only SQLite database
in WAL mode can require missing sidecar files even when no WAL remains after a
clean shutdown. For a stopped worker with no WAL, the helper takes the shared
kernel ingestion lock and reads the checkpointed database immutably, without
creating sidecars or writing volumes. A live worker still uses normal read-only
WAL access. Reopen existing monitor windows to load the repaired code.

## Current operational state: full run started on 2026-11-11

The user explicitly authorized starting the full ingest after power and storage
checks. Earlier statements in this guide that the full collection is empty refer
to the pre-launch validation and benchmark stages, not the current state.

- Windows plugged-in sleep and hibernation are explicitly set to Never and verified.
  Battery settings and screen-off settings are unchanged. Keep the laptop plugged
  in, do not manually sleep/reboot it, and keep Docker Desktop running. These power
  settings do not prevent Windows Update restarts or power outages. Review Windows
  Update's pause/restart settings before leaving a multi-day job unattended.
- Non-destructive Ubuntu virtual-disk compaction recovered approximately **263 GiB**
  on C:, increasing physical free space from 9.77 to approximately 272.81 GiB.
  The Ubuntu disk shrank from 294.20 to 31.32 GiB. Ubuntu subsequently mounted
  successfully, still reported 29 GiB of used data, and its home directory was
  verified present. No user files, packages, Docker images, containers or volumes
  were deleted. Docker/WSL were temporarily stopped for compaction and the original
  nine running containers were restored.
- Container **govchat-obv-full-run** started at **2026-11-11 17:57:16 UTC**
  (**18:57:16 Europe/Amsterdam**), targeting the already prepared run
  **limburg-full-20261111** and collection **limburg_full_20261111**.
- The worker runs detached with two document pipelines. Invocation ceilings are
  1,000,000 document attempts and 100,000 pages, with page size 20. These are safety
  ceilings, not a target number of documents: the source's terminal snapshot page
  determines corpus completion. The higher ceiling avoids stopping at exactly
  100,000 attempts if the corpus is larger or retries consume attempts.
- Process failures have a bounded Docker **on-failure:5** restart policy. Normal
  completion does not restart the container. This is not a guarantee of resuming
  automatically after a Windows reboot or Docker daemon restart; inspect status
  and use the documented resume procedure after those interruptions.
- First live checkpoint after launch: **12 indexed**, 7 pending, 1 processing,
  one page queued and **zero failures**. This is a dated progress observation,
  not a current total. Full corpus completion has not been claimed.
- Optimized ingestion regressions: 55 passed. Search/probe regressions after
  restoring Docker: 18 passed, including live-Qdrant filtering.

Operational follow-up at **2026-11-11 20:10 UTC**: the ingest remained running with
**3,939 indexed documents across 198 queued pages**. Fifteen documents had entered
dead-letter state for size budgets, empty/invalid source downloads, or Tika/OCR
extraction failures; these remain explicitly recorded and require investigation
before declaring the corpus complete. They have not been silently discarded.

After Docker/WSL restarted, additional virtual-disk space was reclaimed: the Docker
data file measured **116.12 GiB**, down from **339.76 GiB**, while Ubuntu remained
at **31.32 GiB**. A final host check reported **496.26 GiB physically free on C:**,
approximately **486 GiB more than before the maintenance**. This was virtual-disk
space reclamation, not deletion of user files or Docker datasets.

An early object-storage URL issue was fixed after the first pages exposed literal
spaces in attachment filenames. Network requests now percent-encode spaces and
Unicode without decoding existing escapes or reordering signed query parameters;
raw source URLs remain unchanged in stored provenance. Invalid controls/ports
produce typed download errors. Four regressions were added (**59 ingestion tests
passed**). Seven early URL failures were explicitly requeued, and the same run
resumed in a rebuilt worker at **18:05:17 UTC**. The stopped pre-fix container was
renamed **govchat-obv-full-run-before-url-fix** to preserve its logs; it is not an
additional running worker. All monitoring continues to target **govchat-obv-full-run**.

### Follow progress without starting another ingest

Double-click [`openbesluitvorming-progress.cmd`](../scripts/openbesluitvorming-progress.cmd)
in Windows Explorer. It displays container state and durable counts, refreshing
every 10 seconds. The Dutch dashboard prominently displays **GEINDEXEERD**,
pending/processing/retry/dead-letter counts, fetched pages and recent throughput.
It reads a consistent SQLite snapshot in read-only mode, without source API calls
or changes to the running ingest. Node.js is required on the Windows host and is
already available on this machine. Closing the monitor does not stop the detached ingest. Indexed
documents are successful; pending/processing documents remain in progress, and
retry/dead-letter counts are unresolved failures. Completion requires the terminal
snapshot and no outstanding jobs: **complete=true** in status.

For live per-document logs, open **Docker Desktop → Containers →
govchat-obv-full-run → Logs**, or run from this repository directory:

```bat
scripts\openbesluitvorming-progress.cmd logs
```

For a compact, continuously updating counter instead of per-document logs:

```bat
scripts\openbesluitvorming-progress.cmd --lines
```

The default double-click opens the full dashboard. An already open legacy log
terminal remains a per-document log view; open the monitor again to use counters.
The displayed "already discovered" count covers only fetched snapshot pages, not
the full source corpus, so no overall completion percentage is invented.

The logs show document identity, indexed/retry/dead-letter outcome and stage
timings. No reliable percentage or full-run ETA is available before the source's
total corpus size is known. Monitoring is in the dedicated worker, not a long
n8n execution. Do not run fresh initialization again or start a second worker.

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
**Arrange bulk access with the source provider first.** The published
[API guide](https://openbesluitvorming.nl/docs/api), backed by
[its public Markdown source](https://openbesluitvorming.nl/API.md), asks users not
to mirror/index whole folders or organisations on demand-download infrastructure
and to ask first for more than about 500 files or 1 GB per user per day, or all
files of an organisation. The local approval flag is **not provider permission**.
No such bulk arrangement or 100k-load validation is established by these samples.
It begins processing the prepared fresh run, or resumes that same run:

```bat
%OBV% run -d --name govchat-obv-full-run --no-deps openbesluitvorming-ingest run --run-id limburg-full-20261111 --max-documents 100000 --max-pages 20000 --page-size 20 --workers 2 --approve-full-run
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

### Bounded concurrency and performance metrics

The default is **two document pipelines**, configured by the worker-only
`OBV_WORKERS` environment setting in Compose. The run command's `--workers`
argument overrides it. Accepted values are **1 through 4**; one reproduces a
sequential pipeline, and four is an opt-in ceiling, not a recommended speed
setting for every corpus. At most that many jobs are durably claimed/inflight;
there is no unbounded executor queue. Per-invocation page and document-attempt
limits remain exact, including retries and existing queued jobs.

All threads share one HTTP client and one source limiter: snapshot, document
detail, reference detail and retries start at least 1.1 seconds apart. Source
requests are serialized through the response read; downloads, Tika, embeddings
and completed Qdrant upserts can overlap. A source 429/503 establishes a shared
cooldown even on the final failed HTTP attempt. Retry-After numeric seconds and
HTTP dates are honoured without shortening a longer provider-requested wait.

Attachment downloads have a separate global ceiling of **two concurrent requests
and one start every 0.5 seconds**, including retries and allowlisted redirects.
Their 429/503 cooldown is shared too. These guards apply conservatively to all
attachment hosts, not only the source's object storage. Tika and embedding calls
remain bounded by the document-worker count; embedding batches still contain at
most eight windows. No text truncation, attachment skipping or OCR bypass was
introduced, and document-vector pooling/upsert semantics are unchanged.

Only the coordinator writes SQLite. Reference reads use short-lived thread-owned
connections; reference results are deduplicated and the in-memory cache is limited
to 128 entries, backed by durable context rows. One shared tokenizer initializes
under a lock, then is reused. On an ordinary document error, the coordinator
persists retry/dead-letter evidence. On a pagination/coordinator exception it
stops scheduling, waits for the bounded outstanding jobs, persists their successes
and failures, then propagates the error. Kernel/process death still uses durable
claim replay, protected by the unchanged global mutation lock.

Every document log includes elapsed seconds and stage timing seconds. The final
result adds a performance object: worker count, peak inflight, elapsed seconds,
documents per second, and call counts/summed seconds for source snapshot, entity
detail (including references), attachment download, Tika, embedding and upsert.
Times use a monotonic high-resolution performance clock. They include HTTP retry
and limiter waits; embedding timing also includes tokenization/pooling. Stage
seconds overlap and can exceed wallclock: **do not add them to predict duration**.
Documents per second means **completed attempts**, including failures, not only
new indexed documents. These diagnostic timings do not change point metadata.

The production invocation's elapsed time includes collection validation, recovery,
pagination and checkpoint work, but not container startup. A cold tokenizer is
included if initialized during execution. The comparison harness instead warms
the same encoder before every experiment and excludes initialization/verification
for both implementations, avoiding startup/warm-up comparison bias.

For a newly initialized **isolated sample**, not the prepared full run:

```bat
%OBV% run --rm --no-deps openbesluitvorming-ingest fresh --run-id my-perf-sample --collection limburg_my_perf_sample
%OBV% run --rm --no-deps openbesluitvorming-ingest run --run-id my-perf-sample --max-documents 5 --max-pages 1 --page-size 5 --workers 2
%OBV% run --rm --no-deps openbesluitvorming-ingest verify --run-id my-perf-sample --sample-size 5
```

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

- The published source budget is 60 units/minute, continuously refilling. Export
  and ordinary entity requests cost one unit each. A live five-record probe on
  2026-11-11 returned HTTP 200 and RateLimit-Limit 60, Remaining 59, Reset 1;
  Reset means seconds until the bucket is full, **not** a fixed-window boundary.
  The retained 1.1-second pace is about 54.5 starts/minute. 100k detail requests
  alone take about **30.56 hours**, before references, snapshot pages and downstream
  bottlenecks. Concurrency cannot remove this floor. Other clients sharing the
  provider's client identity may still consume its bucket; honour cooldowns.
  No production-duration/100k load test was performed.
- Reserve substantial disk headroom for full text, duplicated raw metadata, SQLite
  pages, indexes and Qdrant snapshots. The vector data alone is about 1.23 GB at
  100k × 3072 float32 values. Twenty GB free is a starting planning allowance, not
  a guarantee. Monitor Docker Desktop disk, memory and provider quota.
- Worker memory is capped at 1 GiB; two pipelines are the conservative default,
  four require deliberate memory/quota review. This is a job-count bound, not a
  worst-case byte/RSS guarantee: simultaneous large attachments, token lists,
  JSON/fulltext copies and embedding responses can still exhaust the cap. Reduce
  workers to one for unusually large documents and monitor worker/Tika separately.
  Documents above 64 MiB download or ten million
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

## Recorded performance comparison (2026-11-11)

The final code was measured against the unchanged sequential worker from parent
commit **d9b48e8**, on the same running Docker Desktop stack. The live ABBA order
was old/one worker, new/two, new/two, old/one. All four trials ran in one 1 GiB
worker container, each with a fresh isolated collection and independent SQLite
context/checkpoint state. The same initialized tokenizer was passed to both
implementations. A high-resolution performance clock enclosed only execution;
fresh collection/index initialization, the equal 1.1-second inter-trial pause,
tokenizer warm-up and read-only verification were outside every timed interval.
Both implementations had identical HTTP-only timing instrumentation.

| Final live trial | Implementation / workers | Wall seconds | Documents/second |
| --- | --- | ---: | ---: |
| A1 | d9b48e8 / 1 | 12.728259 | 0.392827 |
| B1 | optimized / 2 | 9.819624 | 0.509184 |
| B2 | optimized / 2 | 10.002370 | 0.499882 |
| A2 | d9b48e8 / 1 | 12.923725 | 0.386885 |

Mean wall time: **12.825992 seconds sequential vs 9.910997 seconds with two**.
That is **1.294× observed throughput, 22.73% less wall time** for this sample,
not a production-duration prediction. Each trial fetched exactly **one five-record
snapshot page**, indexed exactly **five documents**, used **two Tika extractions
and three source-markdown paths**, and passed five-point complete metadata,
fulltext, dimension and vector-normalization verification with no retries/failures.
The first five source IDs were identical across trials. Entire point payloads
matched exactly across all four, including raw metadata, extraction evidence and
full text, excluding only the necessarily different run ID and indexing timestamp.
Vector values were validated individually, not assumed byte-identical across
separate provider calls.

Each trial required eight entity/detail HTTP calls (five documents plus three
references), two attachment downloads, two Tika calls, six embedding HTTP batches
and five acknowledged upserts. Comparable **summed HTTP-call seconds**, including
limiter waits, averaged:

| HTTP stage | Sequential | Two workers |
| --- | ---: | ---: |
| Source snapshot | 0.078 | 0.063 |
| Document/reference detail | 6.828 | 10.558 |
| Attachment | 0.375 | 0.400 |
| Tika | 3.672 | 3.698 |
| Embedding | 1.698 | 1.735 |
| Completed upsert | 0.091 | 0.069 |

Detail call-time totals grow because both threads can wait for the same source
limiter. The speedup comes from overlap, not faster source requests, reduced text,
fewer embedding batches or a skipped parser. Tika's similar totals and ABBA order
also limit cache/warm-up comparison bias. Provider/network noise still exists and
there are only two trials per mode. Four workers were **not live-benchmarked**;
the source floor already dominates this sample. No cross-document embedding or
Qdrant batching was introduced without supporting measurements.

The benchmark process's cumulative RSS high-water mark reached **119.48 MiB**
across the four small-document trials (including harness/tokenizer), not a separate
per-trial peak or a 100k memory test. Production tokenizer/JSON/token-list memory
on large documents remains a limitation. The 1 GiB worker cap was retained.

The offline fixed-latency experiment measured **1.754166 seconds** mean sequential,
**1.076388 seconds** mean with two (**1.630×**) and **0.727463 seconds** with four
(a single maximum-concurrency trial, approximately **2.411×** vs sequential mean).
Its synthetic source starts are spaced 50 ms with 20 ms response latency;
downstream calls sleep 100 ms. These deliberately scaled latencies are only a
deterministic offline overlap experiment, **not production rate settings or a
claim about real throughput**. Production pacing/attachment limits have separate
regression tests.

Reproducible harness and raw final measurements:

- [`benchmark_openbesluitvorming_ingest.py`](../tests/agents/benchmark_openbesluitvorming_ingest.py)
- [`openbesluitvorming-performance-live.json`](../tests/agents/fixtures/openbesluitvorming-performance-live.json)
- [`openbesluitvorming-performance-offline.json`](../tests/agents/fixtures/openbesluitvorming-performance-offline.json)

The final four collections and their retained isolated state directories are
listed in the live report. A preceding exploratory ABBA round also used the same
five documents in four distinct benchmark collections; those collections were
not deleted or substituted for the final results. In total, only the same **five
distinct source documents** were fetched repeatedly, never the full corpus.
The old sample still has five points with unchanged checkpoint state/count.
The prepared full run's entire status is identical before/after: zero pages,
null cursors, empty job counts, unchanged preparation timestamps, **zero points**.
No search/chat configuration or alias was changed; no full run was started.

### Reproduce without starting the full run

The offline benchmark is safe by default and uses no network. Extracting the
parent into a temporary file avoids maintaining a second worker implementation:

```bat
git show d9b48e8:services/openbesluitvorming-ingest/worker.py > tests/agents/.obv-benchmark-baseline.py
python tests/agents/benchmark_openbesluitvorming_ingest.py --baseline tests/agents/.obv-benchmark-baseline.py --output tests/agents/fixtures/openbesluitvorming-performance-offline.json
```

The explicitly enabled live harness is tied to this prepared runtime: it verifies
the full run is empty first, holds the global mutation lock, creates **four new
isolated collections**, and rejects any sample not containing exactly two Tika
and three markdown documents or any metadata/fulltext divergence. It has no
full-run start option. It does make paid embeddings and repeated small downloads;
use it deliberately rather than in CI. Run from the repository directory with
the explicit Compose prefix defined above; it inherits credentials without
reading/printing the environment file:

```bat
%OBV% run --rm --no-deps -v "%cd%:/workspace:ro" --entrypoint python openbesluitvorming-ingest /workspace/tests/agents/benchmark_openbesluitvorming_ingest.py --live --baseline /workspace/tests/agents/.obv-benchmark-baseline.py --output /state/openbesluitvorming-performance-live.json
%OBV% run --rm --no-deps --entrypoint python openbesluitvorming-ingest -c "from pathlib import Path; print(Path('/state/openbesluitvorming-performance-live.json').read_text())" > tests/agents/fixtures/openbesluitvorming-performance-live.json
del tests\agents\.obv-benchmark-baseline.py
```

An individual retained optimized benchmark can be verified read-only, using the
state directory from the report (do not use the full-run ID in an ingest command):

```bat
%OBV% run --rm --no-deps openbesluitvorming-ingest --state-dir /state/performance-benchmarks/perf-397990b962b5-1-w2 verify --run-id perf-397990b962b5-1-w2 --sample-size 5
```

Final regression results: **55 ingestion tests passed** on Windows Python and
again inside the rebuilt Linux worker image, and
**18 search/probe tests passed with no skips**, including the isolated live-Qdrant
fixture test at loopback port 16333. The rebuilt worker image matches the reviewed
worker source. The app stack remains running with the documented local ports;
the one-shot benchmark exits rather than starting a daemon.

## Regression verification

The public, bounded fixtures and offline ingestion tests live in
[`test_openbesluitvorming_ingest.py`](../tests/agents/test_openbesluitvorming_ingest.py).

```bat
python -m unittest discover -s tests/agents -p test_openbesluitvorming_ingest.py
node --test tests/agents/openbesluitvorming-search.test.js
```

They cover real schema, malformed pagination, attachment/Tika fallback, multi-media
documents, full metadata, long-document traversal, response validation, durable
retry/dead letters, crash replay, locking, resource limits and safety approval,
parallel inflight/attempt/page bounds, global API pacing/retry cooldowns, attachment
slots/start pace/redirects, shared tokenizer/cache and exception-time sibling
outcome persistence.
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
