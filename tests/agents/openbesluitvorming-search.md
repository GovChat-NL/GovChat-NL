# OpenBesluitvorming search regression contract

The inactive [search workflow](../../agents/n8n/workflows/openbesluitvorming/openbesluitvorming-search.json) still queries the existing unnamed 3,072-dimensional document vector in the existing default collection. It needs no re-ingest, vector migration, workflow activation or payload-index creation. Limburg public viewer links and download provenance remain compatible with the existing link renderer.

## Optional filters

Supply the optional [filters object](../../agents/n8n/workflows/openbesluitvorming/openbesluitvorming-search.json:28), or the corresponding explicit top-level parameters. Omitted or null individual values impose no constraint. All supplied values must be non-empty strings, no more than 300 characters, with no control characters. Conflicting aliases or nested/top-level values fail before embedding. Unknown nested keys, arrays, objects, booleans and raw Qdrant filter objects are rejected.

| Parameter | Meaning |
| --- | --- |
| [source_key](../../agents/n8n/workflows/openbesluitvorming/openbesluitvorming-search.json:28) | Exact source identifier; letters, digits, underscores and hyphens. The existing [sourceKey alias](../../agents/n8n/workflows/openbesluitvorming/openbesluitvorming-search.json:28) is retained. Example value: provincie_limburg. |
| [organization](../../agents/n8n/workflows/openbesluitvorming/openbesluitvorming-search.json:28) | Exact organisation display name, from the legacy payload or entity detail. The top-level [organisation alias](../../agents/n8n/workflows/openbesluitvorming/openbesluitvorming-search.json:28) is accepted. **Unlike the old workflow, this no longer means a source key**; callers using it as a source identifier must use the source parameter instead. |
| [supplier](../../agents/n8n/workflows/openbesluitvorming/openbesluitvorming-search.json:28) | Exact supplier name. |
| [document_type](../../agents/n8n/workflows/openbesluitvorming/openbesluitvorming-search.json:28) | Exact document type in the legacy payload, preserved source payload or entity detail. No inferred classification-to-type conversion. |
| [meeting_id](../../agents/n8n/workflows/openbesluitvorming/openbesluitvorming-search.json:28) | Exact meeting identifier in the legacy payload or entity detail; use the complete stored ID. |
| [referenced_by](../../agents/n8n/workflows/openbesluitvorming/openbesluitvorming-search.json:28) | Exact reference ID, including motion references, from the legacy or source payload. |
| [classification](../../agents/n8n/workflows/openbesluitvorming/openbesluitvorming-search.json:28) | Exact classification value, including membership in a stored string array. |
| [date_from / date_to](../../agents/n8n/workflows/openbesluitvorming/openbesluitvorming-search.json:28) | Document date/sort-date bounds; strict calendar dates or ISO timestamps including seconds and timezone. Calendar dates mean UTC days, with the upper day inclusive. Exact timestamp bounds are inclusive. Not meeting dates, discussion dates or ingestion timestamps. |

For example, search for water policy with source identifier provincie_limburg and calendar dates 2024-01-01 through 2024-12-31. Add organisation name, type or meeting only when their exact stored values are known. Comparisons are case-sensitive. Predicates are ANDed across filter categories and ORed across the documented legacy/new paths within a category. Explicit filters exclude documents lacking the relevant metadata; broaden or remove filters when investigating completeness.

## Retrieval and output

- [Candidate formatting](../../agents/n8n/workflows/openbesluitvorming/openbesluitvorming-search.json:116) adds known title, date, organisation, source, type, meeting, references, classification and attachment names/MIME type to reranker input. Entire source/entity/attachment objects are not serialized into prompts or results.
- Content preference is preserved full text, text/content, entity-detail markdown/text, stored text chunks, then legacy preview. Chunks can be strings or objects containing text/content. At most 48 stored chunks and 300,000 characters are scanned. Long documents provide a leading passage plus query-keyword windows, with a maximum 6,000-character excerpt and 10,000-character total reranker document. These are deliberate recall limits, not a claim of full-text search or completeness.
- Document identity includes source identifier. Repeated document/chunk hits contribute at most one reciprocal-rank vote per query variant; the highest-semantic-score hit supplies the representative payload. The original 500-document rerank ceiling and excluded-score coverage remain observable. Checkpoint/dead-letter control points are excluded, without requiring a document-type marker on older payloads.
- [Output provenance](../../agents/n8n/workflows/openbesluitvorming/openbesluitvorming-search.json:163) includes source identifier, type, meeting, bounded attachment names, file/MIME information and text/chunk coverage metadata. Applied filters are echoed in the response and candidate coverage report. The existing [include_content option](../../agents/n8n/workflows/openbesluitvorming/openbesluitvorming-search.json:28) remains opt-in and returns at most 3,000 characters of the retrieval excerpt under the existing preview property. It does not return whole raw payloads or full documents.
- Reranker errors, partial responses, duplicate/out-of-range indices or nonfinite/invalid scores use consistent RRF fallback rather than mixing incomparable RRF and reranker scores. The response exposes whether fallback was used. Existing cut-off behavior is unchanged.

## Tests

Run [node --test tests/agents/openbesluitvorming-search.test.js](openbesluitvorming-search.test.js:1) from the repository root. Tests execute the actual embedded workflow JavaScript with n8n-shaped inputs; no LiteLLM calls are made.

For live integration, set [OBV_SEARCH_TEST_QDRANT_URL](openbesluitvorming-search.test.js:188) to an explicitly selected local Qdrant URL and rerun. The integration test creates a uniquely named temporary collection, inserts synthetic 3,072-dimensional document-vector points, executes the generated requests and deletes only that collection afterward. It never restores a production snapshot or touches existing collections. Without that setting, only the live integration test is skipped. Tested against Qdrant 1.16.2, including legacy date-only payloads.

Also run the unchanged [public-link regressions](openbesluitvorming-public-links.test.js). Their private-backup permission assertion requires POSIX file modes; Windows reports a different mode, so use a Linux Node environment to run that assertion without altering the test. Renderer byte-for-byte idempotence also expects an LF checkout. All 25 search/public-link tests passed in an isolated Linux, LF-normalized copy with live Qdrant; the repository's other files were not normalized or changed.

These tests validate request construction, payload compatibility and result handling, not retrieval quality against a production corpus or ingest throughput. Payload-index tuning and slow-ingest investigation remain separate tasks.
