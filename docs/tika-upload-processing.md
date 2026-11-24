# Experimental Tika-only upload processing

**Status: unfinished; not production-ready.** Repeated OCR requests can exhaust
the dedicated parser's memory budget. LibreChat can then persist unreadable
built-in fallback text. Direct-adapter contract success is not proof that browser
uploads, persistence and model delivery work reliably. Read the
[failure and continuation notes](tika-upload-handoff.md) before development.

## Intended boundary

The independently owned [adapter](../services/document-extractor/app.py) implements
LibreChat's extraction protocol: an authenticated multipart upload with exactly
one file and one file identifier, returning a text object on successful extraction.
LibreChat remains responsible for file authorization, persistence, retention,
attachment resolution and subsequent text delivery. There is no document cache,
URL fetching, embedding, user database access or per-turn parsing in the adapter.

The experiment uses standard Apache Tika with bundled Dutch OCR data, not Docling.
The [format manifest](../services/document-extractor/routes.json) covers PDF, DOCX,
PPTX, XLSX, MSG, EML, ODT, DOC and RTF. Native text is handled separately. A declared
extension and MIME route must agree with bounded binary preflight; unsupported,
encrypted, malformed and oversized documents are rejected.

Normal Tika parsing runs first. Only an eligible PDF whose completed extraction
fails Unicode quality screening can receive one bounded OCR-only retry. This
avoids retaining a broken native text layer in the recovered result. It does not
guarantee exact transcription, layout fidelity or complete OCR coverage.

## Limits and known boundaries

The current adapter limits input size, page count, output size, concurrent work
and total processing time. Temporary files are request-scoped. Unknown parser
termination sets a fault latch; health then rejects future extraction. This latch
must not be removed or automatically cleared without evidence of native cleanup.

The experimental [Compose template](../docker-compose.tika-upload.yml) contains
dedicated parser/adapter services with private networking, no public ports,
read-only filesystems, bounded scratch, dropped capabilities and memory/process
limits. **These limits have not established reliable warm-process OCR behavior.**
Do not increase resource limits, disable security controls or force OCR globally
as an unverified workaround.

LibreChat's installed document-upload path may catch extraction failures and use
its built-in document parser. That fallback can produce nonempty but unreadable
text. The adapter itself never represents failure as successful empty text.
There is no supported selective fallback-disable switch implemented here.

Do not reintroduce a broad document-quality policy as a fallback workaround: an
earlier approach activated model-bound context traversal and broke ordinary
pasted-text chat. The [compatibility renderer](../scripts/add-extraction-quality-policy.py)
therefore preserves input policies without adding or removing any rule.

## Configuration and development

The [configuration renderer](../scripts/render-document-processing-config.py)
generates an experimental configuration from the current caller-supplied source,
without overwriting it. It narrows supported document routes to text, preserves
media/tool configuration and leaves existing security policies intact. The
template targets the project's example orchestrator endpoint; verify the actual
endpoint and installed schema in an isolated test deployment.

Keep generated configurations, operational overlays and all authentication values
outside Git. The [environment template](../.env.tika-upload.example) contains only
a placeholder. Extraction tokens must follow the installed LibreChat helper's
claim contract; do not relax signature or owner validation for testing.

Use independent synthetic credentials and disposable services disconnected from
production databases. Generate fixtures with the
[synthetic generator](../tests/document-processing/fixtures.py); never commit
uploaded documents, exported requests, runtime logs or database records.

## Validation scope

[Adapter contracts](../tests/document-processing/test_adapter.py) cover protocol,
authentication, routing, preflight, text screening, one bounded PDF recovery,
deadlines, parser failures and scratch cleanup. They do not prove native resource
cleanup or application persistence.

The [installed-client test](../tests/document-processing/client-extraction.test.cjs)
calls LibreChat's actual extraction client using temporary streams and independent
synthetic fixtures. It reports counts only and fails on unreadable output or
unhealthy extraction. It requires a disposable parser pair and installed
LibreChat dependencies; it is not a browser upload or a database test.

The [configuration contract](../tests/document-processing/live-config.test.cjs)
and [policy regression contract](../tests/document-processing/fallback-quality.test.cjs)
check schema/routing preservation and ordinary-text behavior with synthetic inputs.
They are not substitutes for authenticated upload-handler and model-flow checks.

## Rollback principle

Restore only the experiment's extraction-origin override and generated-config
mount against a verified pre-experiment baseline. Recreate only the affected
application service without dependencies, verify application/authentication
health, then retire the dedicated experiment parser services. Preserve user data,
later unrelated settings and legacy attachments. Never perform global shutdown,
orphan removal, shared-parser restart or database repair as a feature rollback.

Previously persisted bad extraction is not repaired by changing parser code or
rolling back deployment. New-upload verification remains a separate acceptance
step after a confirmed correction.
