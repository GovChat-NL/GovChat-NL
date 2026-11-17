# OpenBesluitvorming read-only metadata/statistics

Small Python-standard-library backend, no framework, SDK, embeddings, MCP, or
additional dependencies. Qdrant's native exact count endpoint handles total
counts and safe keyword/boolean filters directly. Metadata discovery, grouping,
and filters with ambiguous native semantics use bounded scroll/evaluation.

Implementation: [metadata.py](metadata.py), [state.py](state.py),
[server.py](server.py), [Dockerfile](Dockerfile). Compose deployment, n8n tool
registration and normal-chat routing are documented in the
[integration guide](../../docs/openbesluitvorming-statistics-integration.md).

## Internal HTTP contract

- GET /healthz: unauthenticated, only reports service process health, not data readiness.
- POST /query: Authorization: Bearer followed by OBV_STATS_TOKEN. If unset,
  N8N_WEBHOOK_TOKEN is used. Startup fails without either. Never expose publicly.
- Content-Type: application/json; Content-Length required; no compressed/chunked bodies.
- Request is one JSON object. Unknown keys, duplicate keys, nonfinite numbers,
  invalid paths/operators, raw Qdrant filters, SQL, URLs, collection/run overrides,
  and executable expressions are rejected. No request/body/credential logs.

Accepted parameters:

| Parameter | Contract |
| --- | --- |
| operation | Required: fields, count, group, status, overview |
| field | Required for group; otherwise absent or null |
| interval | null, year, month; nonnull only for group |
| filters | Optional list, maximum 32; logical AND across filters |
| limit | Output rows only, integer 1–1000, default 100 |
| offset | Output rows only, integer 0–1000000, default 0 |

Each filter has field and operator. Operators:

| Operator | Additional parameters | Meaning |
| --- | --- | --- |
| eq | value | Exact typed scalar membership (including null) |
| in | values, 1–100 scalars | Union/OR within filter, document counted once |
| exists | none | Path exists, including null, false, zero, empty arrays |
| missing | none | Path does not exist |
| range | At least one of gt, gte, lt, lte | Numeric or strict ISO date/time bounds; one value must satisfy all bounds |

Booleans are not numbers; JSON 0 and 0.0 share numeric semantics. Strings remain
case-sensitive. Date bounds accept calendar dates or ISO timestamps with seconds
and an explicit timezone, normalized to UTC. Naive timestamps and epoch guesses
are rejected. Filters on separate array paths may match different array elements;
there is no correlated nested-object predicate or user DSL.

Examples (send the object itself, not a JSON-encoded string argument):

```json
{"operation":"count"}
```

```json
{"operation":"count","filters":[{"field":"classification","operator":"in","values":["Besluit","Voorstel"]}]}
```

```json
{"operation":"group","field":"classification","interval":null,"filters":[{"field":"date","operator":"range","gte":"2020-01-01","lt":"2021-01-01"}]}
```

```json
{"operation":"group","field":"date","interval":"year"}
```

```json
{"operation":"group","field":"reference_detail.date","interval":"month"}
```

```json
{"operation":"count","filters":[{"field":"entity_detail.custom[].name","operator":"eq","value":"Example"}]}
```

```json
{"operation":"fields","limit":1000,"offset":0}
```

```json
{"operation":"status"}
```

overview combines a scoped total, paginated schema discovery, and optional state
status in one full metadata pass. It does not secretly run multiple year/type scans.

## Paths and aliases

Paths consist of ASCII keys starting with a letter/underscore, dot-separated,
with optional [] or nonnegative [0] array traversal. Maximum 200 characters and
20 components. Discovery emits containers and dynamic nested paths, including
source_payload, source_record, entity_detail, reference_detail, extraction, arrays,
and names not known at implementation time. Objects cannot become raw JSON group
values: they contribute to invalid_documents. Unaddressable keys or excessive
schema/depth/scalar budgets fail explicitly rather than claiming complete schema.

Content (full_text, content_preview, markdownText), vectors/binary, and recognized
credential keys are not metadata and cannot be queried. Discovery excludes known
content paths on the Qdrant request; blocked keys are omitted from schema at every
depth. Targeted queries request only required leaves and array containers.
Qdrant has no recursive key-name exclusion wildcard: blocked siblings inside a
required container and unknown content locations can transit the bounded
response but are never returned as discovered
fields or grouped content. This is not a general DLP scanner; do not put secrets
in metadata values, titles or URLs. Responses never return raw payload objects.

Aliases use the first nonempty candidate (malformed nonempty dates become invalid,
not silently substituted). Null-only/empty paths remain distinguishable:

- date: date → entity_detail.sortDate → source_payload.date →
  source_payload.last_discussed_at → source_payload.date_modified →
  last_discussed_at → date_modified.
- year: same date alias, implicit year interval unless an interval is supplied.
- document_type: document_type → documentType → entity_detail.documentType →
  entity_detail.document_type → source_payload.documentType →
  source_payload.document_type → classification → source_payload.classification.
  Thus classification is used for the current dataset; explicit documentType wins.
- Other paths are literal and remain independently queryable, including reference dates.

Year/month buckets are UTC calendar strings, not year values invented from indexing
timestamps. Missing paths, explicit nulls, invalid dates/objects, and empty arrays
are not fake year/type values.

## Results and exactness

Successful data queries report source_kind=qdrant_exact_metadata, configured scope,
query_as_of, evidence observation/scan timestamps, exact, truncated, cached,
total_documents, matched_documents, scanned_documents, and coverage. No caching
is implemented: cached is always false and every response observes new evidence.

Native count is used for no filters and compatible literal keyword/boolean
membership filters; all other filters stream. Native counts rely on the ingest
worker's one-deterministic-point-per-source-document invariant. They count only
source_key + ingest_run_id + entity_type=Document, excluding control points.
Streaming uses source_id, falling back to stable point ID. Duplicate source IDs
or repeated point IDs fail explicitly rather than arbitrarily choosing a payload.
No payload-index creation is required. Strict-mode Qdrant servers prohibiting
unindexed filters must be configured to permit these read-only queries; the
service will return an upstream error, not mutate indexes.

### Generic scan optimization

Counts requiring evaluation and all groups project only document identity/scope,
the requested field and filter dependencies. Date and document-type aliases expand
to every candidate, preserving precedence, nulls and invalid values. Arbitrary
nested scalar leaves are projected directly. Indexed/array paths select their
first array container so positions, empty arrays and membership remain intact;
no raw payload objects or blocked sibling values enter the result. Fields and
overview retain full safe-metadata discovery, not a misleading narrow schema.

Projected scans start at OBV_STATS_PAGE_SIZE (256), then adapt to observed response
bytes up to OBV_STATS_MAX_PAGE_SIZE (1000). OBV_STATS_TARGET_PAGE_BYTES (4 MiB,
maximum 8 MiB) includes a 2x safety margin when estimating the next batch. Small
metadata uses fewer scrolls; large arrays/strings reduce batches. The hard 16 MiB
transport cap remains: oversized pages retry the same offset with half the batch
size before any points are accepted, within the original scan deadline. A single
oversized document still fails explicitly; no partial exact result is returned.
Discovery keeps its conservative page size (with bounded oversized-page retries).
Scan evidence reports scroll_requests and payload_selection.

No cached totals or groups are used: every query observes live scoped metadata and
checks counts before/after. Same-count concurrent edits remain a documented
consistency limitation. Preaggregation would require a trustworthy revision and
invalidation contract for every writer, not just a count or last-sync timestamp.

Group rows have value, value_type, count. Results also include total_groups,
limit/offset, groups_paginated, missing_documents, null_documents,
invalid_documents, documents_with_value (union), overlap_documents, and
group_memberships. Each document contributes once per distinct scalar value.
Multi-valued rows can sum above document totals; missing/null/invalid diagnostics
are not necessarily mutually exclusive with valid memberships. Empty arrays
exist but have no group memberships. Group rows sort by descending count, then
typed canonical value. Output pagination never reduces scanned counts or exactness.
Field rows have field, types, present_documents, missing_documents; total_fields
and fields_paginated distinguish output pagination from an incomplete scan.

Budget exhaustion returns HTTP 422 with exact=false, truncated=true and an error
code, **without partial counts/groups**. Upstream errors use 502; detected scope or
scroll changes use 409; overload uses 503; malformed/auth failures use 4xx.
Errors are structured and omit provider bodies, URLs and credentials.

**Consistency limitation:** Qdrant scroll is not a transaction/snapshot. Native
scope counts are checked before/after each scan (and scan size checked), but
same-count concurrent payload edits cannot be detected. Results are exact for
stable data, not an atomic snapshot across Qdrant and SQLite. For audited reports,
stop ingest/external Qdrant writers or use a separately frozen collection. The
service performs no datastore writes and never freezes a collection by mutating it.

## Checkpoint status / last synchronization

State is optional and always read-only: existing worker.lock, nonblocking shared
kernel lock (Windows read lock equivalent), SELECT-only transaction, never worker
imports or schema migrations. No WAL/empty WAL uses immutable mode only while the
lock is held. Populated WAL is never ignored; it requires an existing SHM and an
actual read-only filesystem/mount so SQLite cannot update source SHM read-marks.
Busy/missing/incompatible state is explicitly unavailable. Ingest holds an
exclusive full-lifetime lock; active writer state is therefore unavailable rather
than an unsafe fabricated live checkpoint. Qdrant statistics remain usable.

Status has source_kind=sqlite_readonly_checkpoint, availability/reason,
last_updated_checkpoint_at, last_attempt, last_completed_scan_at,
last_successful_full_sync_at, snapshot_exhausted, source_complete, failed/unfinished
documents, and checkpoint status/vector counts. Evidence is runs.updated_at and
completed refresh_generations.baseline.updated_at history for the configured run.
It is **not indexed_at**, query_as_of, or an unrelated collection/run.

Exhausted snapshot + complete phase with 203 dead jobs proves a completed scan,
not a successful full synchronization. source_complete remains false and
last_successful_full_sync_at remains null. Historical baselines prove scan
completion only: they lack preserved final failure counts, so historical success
is unknown. Current zero-error, zero-unfinished, zero-dead completed checkpoints
can establish a successful full sync. Future, malformed, timezone-naive, and
date-only state timestamps are rejected, never presented as last sync.

Qdrant totals count **available indexed documents**, not all upstream source
documents. Failed source documents are reported separately from state when
available. No claim that the whole upstream source is complete follows from a
Qdrant count or a completed scan alone.

## Runtime settings for integration

| Environment setting | Default |
| --- | --- |
| OBV_STATS_TOKEN | N8N_WEBHOOK_TOKEN fallback; required |
| OBV_QDRANT_URL | http://qdrant:6333, server-controlled only |
| OBV_QDRANT_API_KEY | optional; never logged |
| OBV_STATS_COLLECTION | limburg_full_20261111 |
| OBV_STATS_RUN_ID | limburg-full-20261111 |
| OBV_STATS_SOURCE_KEY | provincie_limburg |
| OBV_STATS_STATE_DIR | /state |
| OBV_STATS_HOST / OBV_STATS_PORT | 0.0.0.0 / 8092 |
| OBV_STATS_WORKERS | 4 bounded HTTP workers |
| OBV_STATS_MAX_REQUEST_BYTES | 32768 |
| OBV_STATS_PAGE_SIZE | 256, maximum 1000 |
| OBV_STATS_MAX_PAGES | 2000 |
| OBV_STATS_MAX_DOCUMENTS | 250000 |
| OBV_STATS_MAX_SECONDS | 180 per data query |
| OBV_STATS_HTTP_TIMEOUT | 20 per upstream request, capped by remaining budget |
| OBV_STATS_MAX_GROUPS | 100000 |
| OBV_STATS_MAX_FIELDS | 20000 |
| OBV_STATS_MAX_GROUP_BYTES | 33554432, unique group-key memory budget |

Build context is this service directory. The image runs as 10001:10001. Integration
must supply a read-only /state mount with readable existing lock/database files,
read-only container filesystem, an internal network to Qdrant, and no published
host port. Application permissions and network policy must deny Qdrant writes;
the service itself sends only POST count/scroll read operations. Use a Qdrant
read-only API key where supported. No source/provider or embedding calls occur.
Align n8n/tool HTTP timeout with the configured scan budget (plus headroom).

Long metadata strings, such as agenda descriptions, remain discoverable by type
and queryable for grouping. Discovery does not copy their values into results.
Group-key memory has a separate byte budget: exhaustion fails explicitly without
partial groups, rather than classifying a valid long string as invalid metadata.
Client filter values remain limited to 4096 characters and request size is bounded.

## Tests

From the repository root on Windows cmd:

```text
python -B -m unittest discover -s tests/agents -p "test_openbesluitvorming_statistics*.py" -v
```

The default suite uses mocked scroll/count, temporary SQLite fixtures and loopback
HTTP. It does not read real state or require Docker/Qdrant. The opt-in live test
requires OBV_STATS_LIVE_TEST=1 and optional OBV_STATS_LIVE_URL (default local port
6333), creates/deletes only a UUID-named obv_stats_fixture collection, and limits
queries to 16 fixture points/30 seconds. Never configure its fixture URL as a
production endpoint without explicit permission to create a scratch collection.
The current Limburg 56,475-document deployment verification belongs to integration.
