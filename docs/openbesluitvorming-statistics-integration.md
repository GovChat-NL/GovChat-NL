# OpenBesluitvorming statistics in normal chat

## Final feature verification

The feature was developed separately on **feat/openbesluitvorming-metadata-statistics**
from **dev**. Read-only count/group/discovery/status queries are integrated into the
normal published chat orchestrator, alongside (not replacing) RAG. Local validation
has now made **11 genuine chat requests**, including the final status check.

The final checkpoint reader classifies production **dead_letter** rows as failed
documents, separately from unfinished jobs, while recognizing legacy **dead** rows.
An additional actual status chat returned **203 failed**, **0 unfinished**, last
completed scan **2026-11-16T12:17:50.844091Z**, and successful full synchronization
not demonstrated. Earlier outputs in the evidence file are retained as historical
validation, not asserted as the final corrected status contract.

The core has 38 offline tests plus an opt-in isolated Qdrant fixture; the fixture
was also run successfully. The broader Linux Python OpenBesluitvorming suite and
agent regressions passed. The Compose rendering regression passed on the host;
it skips only when Docker CLI is absent from an isolated Node test image. Linux
deployment-configuration checks passed without changing the unrelated Windows
Docker-plugin environment assumptions. Full metadata discovery validated **199
fields over 56,475 documents**. Expensive schema/group queries can take tens of
seconds; the native total count avoids a full scan.

All valid, addressable metadata fields can be discovered/count-filtered/grouped,
including dynamic nested/array fields. Container/object values must be addressed
through their children for scalar grouping. Content, vectors, recognized credential
keys, invalid paths and out-of-budget requests are deliberately excluded or fail
explicitly. A paginated group response is not a truncated scan. No source ingest,
Qdrant mutation or actual remote server deployment was performed by this feature.

The always-on internal service in [docker-compose.yml](../docker-compose.yml) is
read-only and shares the existing worker checkpoint volume. It has no host port,
no ingestion schedule, no provider calls and no embeddings. Empty/missing/busy
checkpoint state is explicitly unavailable; Qdrant counts still work.

The actual [orchestrator](../agents/n8n/workflows/algemeen/orchestrator-litellm.json)
calls the published [statistics subworkflow](../agents/n8n/workflows/openbesluitvorming/govchat-openbesluitvorming-statistics.json)
using database ID `govchat-obv-statistics` (within n8n's 36-character limit).
Only a subworkflow trigger is present: publishing it cannot start ingestion.
Its explicit string input carries one normalized JSON query; a short Code step
validates it, then the HTTP node sends it to a fixed internal URI with the shared
token. Scope and URLs cannot be supplied by the model or user. HTTP timeout is
240 seconds versus the backend's 180-second scan budget; no long scan runs in a
Code runner. Agent maximum iterations remains at least eight.

Counts, groups, schema and sync questions use statistics, never counts from RAG
top-K. Content questions retain the existing search tool. Hybrid questions may
use both. Unknown nested fields require discovery first, with pagination;
tool data never becomes instructions. Source scope, exactness, pagination,
missing/null/invalid/overlapping memberships and source coverage remain explicit.

See the backend [contract](../services/openbesluitvorming-statistics/README.md)
for exact typed filters, date aliases, array semantics, budgets and error behavior.
A complete scan is not a successful full sync. Query time and indexing time are
never reported as sync time. With 203 dead-letter documents, successful full sync
remains unproven even when the scan is complete.

## Server rollout after parent review/merge

The parent owns branch operations, merge, commit, PR and CI approval. This change
does not transfer snapshots or alter Qdrant payloads, indexes, ingest state or
source data. Deploy the merged integration together with the reviewed backend.

1. On the server, use the existing application project directory and private
   environment; do not print tokens or overwrite the owner/masterprompt. Configure
   collection/run/source together as described in [.env.example](../.env.example).
   Prefer a Qdrant read-only API key. Keep statistics inaccessible to public proxies.
2. Always pass explicit Compose files: a private environment may contain an old
   absolute `COMPOSE_FILE`. Do not rely on it. For a normal application using its
   own worker volume:

   ```sh
   docker compose -f docker-compose.yml config --quiet
   docker compose -f docker-compose.yml up -d --build --no-deps openbesluitvorming-statistics
   docker compose -f docker-compose.yml up -d --no-deps n8n n8n-runners
   docker compose -f docker-compose.yml run --rm --no-deps n8n-bootstrap
   docker compose -f docker-compose.yml restart n8n n8n-runners
   ```

   Add your established application overrides to **each** command. Do not run a
   blanket force bootstrap on a customized deployment. Existing v8 deployments
   get a scoped migration of statistics + orchestrator (and TOPdesk only if its
   flag changed), then remain idempotent. All imports precede publication; tool
   subworkflows publish before the orchestrator. Intentionally inactive workflows
   are never briefly activated. Review local orchestrator customization against
   the new template before replacing it.
3. If the server imported a checkpoint into another existing Docker volume, use
   the [state override](../docker-compose.openbesluitvorming-statistics-state.yml).
   It changes **only** the statistics mount; the default worker volume is untouched.
   Example for a worker-only/imported-state server with an existing Qdrant network:

   ```sh
   export OBV_STATS_STATE_VOLUME=govchat-obv-server_openbesluitvorming-ingest-state
   export GOVCHAT_NETWORK_NAME=your-existing-qdrant-network
   export GOVCHAT_NETWORK_EXTERNAL=true
   docker volume inspect "$OBV_STATS_STATE_VOLUME" >/dev/null
   docker compose -f docker-compose.yml -f docker-compose.openbesluitvorming-statistics-state.yml config --quiet
   docker compose -f docker-compose.yml -f docker-compose.openbesluitvorming-statistics-state.yml up -d --build --no-deps openbesluitvorming-statistics
   ```

   Select the actual existing volume/network, not the example blindly. Qdrant must
   have the `qdrant` network alias. This does not start LibreChat, ingestion, n8n or
   embeddings; update the application's n8n separately if it is in another project.
   The external volume must already exist. State database/lock files must be
   readable by UID/GID 10001; preserve the existing files and writer permissions.
   Do not repair permissions by changing source data or resetting state.
4. On CLI-only n8n deployments, back up/export the current orchestrator privately,
   copy the reviewed two workflow exports to the container and use:

   ```sh
   n8n import:workflow --input=/tmp/obv-statistics.json
   n8n publish:workflow --id=govchat-obv-statistics
   n8n import:workflow --input=/tmp/obv-orchestrator.json
   n8n publish:workflow --id=govchat-orchestrator-litellm
   ```

   Restart n8n/runners afterwards for CLI publication changes to load. Do not
   enable retired ingestion schedules or use `publish --all`. Public API need not
   be enabled. Keep existing credentials and owner. The real prompt-management
   endpoint must be available and the existing published policy directory mounted
   read-only in n8n; do not replace it with a smoke-only prompt or bypass fail-closed
   behavior. See [prompt management](orchestrator-prompt-management.md).

## Tests and opt-in real chat

[Regression tests](../tests/agents/openbesluitvorming-statistics-workflow.test.js)
cover normalized filters, rejected overrides, trigger-only publication, tool
schema, prompt/stream-marker preservation, idempotent injection and Compose
security/default/external-volume configuration. The existing
[bootstrap regressions](../tests/agents/pr13-bootstrap-integration.test.js)
also exercise generator rendering without duplicate workflows.

```sh
node --test tests/agents/openbesluitvorming-statistics-workflow.test.js tests/agents/pr13-bootstrap-integration.test.js tests/agents/openbesluitvorming-search.test.js
```

Local [Compose override](../docker-compose.openbesluitvorming-local.yml) keeps the
real prompt service's private data and published policy persistent; it does not
reset the owner. Start that existing service with `--profile admin-overlay` and
the statistics service with explicit base + local files. Then run the
[opt-in smoke](../tests/agents/openbesluitvorming-statistics-chat-smoke.cjs) inside
the existing bridge, which already has its private token:

```sh
docker cp tests/agents/openbesluitvorming-statistics-chat-smoke.cjs govchat-obv-bridge:/tmp/obv-statistics-chat-smoke.cjs
docker exec -e OBV_STATS_CHAT_SMOKE=1 govchat-obv-bridge node /tmp/obv-statistics-chat-smoke.cjs
```

This makes at most six paid normal chat requests, decodes streamed tool events,
asserts statistics-only routing/completion and saves a report under `/tmp` without
changing execution-history privacy settings. Optional positional cases are
count/year/type/status/nested/zero; the default remains these six cases. Additional
focused cases are fields/supplier/nested_year/numeric, selected explicitly, for example:

```sh
docker exec -e OBV_STATS_CHAT_SMOKE=1 -e OBV_STATS_CHAT_REPORT=/tmp/obv-statistics-chat-final.json govchat-obv-bridge node /tmp/obv-statistics-chat-smoke.cjs fields supplier nested_year numeric
```

It is not a replacement agent or a test webhook.
Backend errors must be reported honestly, not treated as complete schema/counts.

## Actual local validation — 2026-11-17

See the [network report](openbesluitvorming-statistics-local-validation.json) for
decoded production chat tool calls, final answers, and independent backend HTTP
responses. Six real requests used the existing bridge, actual published
orchestrator, existing GPT-5.4 alias and external Code runner. No alternate agent,
embedded canned answer, test webhook or execution-data retention override was used.

| Dutch question | Production chat | Independent backend |
| --- | --- | --- |
| How many pieces? | HTTP 200, statistics count call, **56,475** | HTTP 200, native exact count, 56,475 |
| Per year | HTTP 200, statistics group call, 22 years **2005–2026**, sum 56,475 | HTTP 200, all 22 group counts match; ~28 seconds |
| Per document type | HTTP 200, statistics group call, six classifications | HTTP 200, all six counts match; ~29 seconds |
| Last sync / failures | HTTP 200, statistics status call, completed scan **2026-11-16T12:17:50.844091Z**, full sync unproven, **203 dead-letter/unfinished** | HTTP 200, successful full sync null, source complete false |
| Supplier ibabs | HTTP 200, two schema-discovery calls, explicit failure; no guessed count | HTTP **422**, exact false / truncated true, no partial schema |
| Nonexistent classification | HTTP 200, statistics count call, **0** | HTTP 200, exact count 0 |

No RAG tool was called in these six chats. Year/type group missing/null/invalid/
overlap diagnostics were zero and sums were 56,475. Classification counts:
Bijlage 36,357; Ingekomen stukken 11,733; Moties 3,337; Schriftelijke vragen van
Statenleden 3,233; Uitnodigingen 1,268; Amendementen 547.

The supplier failure above is **historical, before the parent's long-string fix**.
The original evidence is preserved in the report, but is superseded by the focused
runtime validation below. Long metadata strings remain discoverable; the separate
group-key byte budget and client filter limit are described in the
[current contract](../services/openbesluitvorming-statistics/README.md:223).

### Post-fix focused runtime validation — 09:35–09:59 UTC

Four additional paid requests used the existing bridge and actual published normal
orchestrator, with no supplied replacement tool definition or prompt. All returned
HTTP 200: **six statistics tool calls and six completion events, no RAG calls**.
The event boundary exposes call arguments and completion, not upstream tool outputs
(completion output strings are empty); the report separately preserves assistant
answers and independent backend responses. No hidden upstream content was dumped.

| Focused question | Genuine chat result / elapsed | Independent backend result / elapsed |
| --- | --- | --- |
| Available fields | **199**, full 56,475-document scan; 71.087 s | HTTP 200, **199**, scanned 56,475, no pagination; **62.632 s** |
| Supplier ibabs | fields then count, **56,475**; 76.866 s | top-level supplier count **56,475**, 6.986 s; nested supplier group **ibabs: 56,475**, 27.825 s |
| Nested classification, calendar 2020 | fields then nested array group with date range, **4,118**, six categories; 97.173 s | identical six rows, full 56,475 scan; 27.684 s |
| Numeric source sequence at least zero | count with numeric zero (not string), **56,475**; 11.852 s | streamed typed numeric count **56,475**; 7.721 s |

Nested 2020 counts: Bijlage **1,928**; Ingekomen stukken **1,227**;
Schriftelijke vragen van Statenleden **393**; Moties **347**; Uitnodigingen **115**;
Amendementen **108**. Missing/null/invalid/overlap diagnostics are all zero, and
the memberships sum to **4,118**. An additional independent nested Bijlage count
with the same year filter returned **1,928** in 27.128 s. Backend-only boolean
equality (text_truncated false) returned **56,475** in 6.760 s; it is **not** claimed
as a boolean chat test. All successful data responses were exact, untruncated,
uncached and bounded to at most 1,000 output rows. The independent full schema
includes the formerly problematic agenda description path as a string.

Fresh read-only status at **2026-11-17T09:59:43Z** still reports **56,475 indexed**
and **203 dead-letter/unfinished** documents. Its checkpoint/last completed source
scan remains **2026-11-16T12:17:50.844091Z**; successful full sync is null and source
complete is false. Generated report/query observation timestamps are not last-sync
timestamps. No runtime budget error occurred; budget exhaustion, arbitrary long
string grouping, every discovered type/operator and concurrent-write snapshot
consistency were not exhaustively validated. Scroll remains non-transactional.

Scope is local only. No server deployment, new public statistics port, source
ingestion start, branch change, commit or merge was performed. Backend files were
left to the parent. The report preserves the earlier six requests and appends this
four-request validation rather than falsely reclassifying the historical failure.

The captured status answer correctly reported the 203 dead-letter/unfinished jobs
and unproven full sync, but too literally described the separate zero
current-failure counter. The final prompt now explicitly calls dead-letter jobs
unsuccessful ingest documents and prevents a "no failed documents" summary. That
wording refinement and broader path grammar were republished and regression-tested
without a seventh paid request; the report preserves the original observed answer.

Initial-task targeted regressions: 43 passed, one opt-in Qdrant fixture skipped.
Focused post-fix regressions: 27 passed, one opt-in fixture skipped, zero failures;
includes full-schema pagination and long-string/numeric/boolean filter transport. A broader
Windows run exposed an unrelated POSIX permission assertion in the existing public
link backfill test; no backfill/source-data change was made. The backend Python
tests were not edited or rerun. The stopped full ingest container remained exited
0; the ingestion workflow remained unpublished/inactive. Statistics, n8n and bridge
were healthy, and both reviewed integration workflows were published locally.
