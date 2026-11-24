# Tika upload repair: verified status and continuation

## Source and status

The repair starts from the current upstream Tika experiment, commit
d9520748bc0255080275f587ac8d4315e8121c4a. This status accompanies the unfinished
review branch fix/tika-upload-processing, based on feat/tika-upload-processing.
Use the actual fetched review-branch tip for continuation; do not assume the
original experiment branch contains the candidate changes.

**Warm client/handler and local document/image app gates passed; not fully accepted yet.**
Do not merge or deploy as a validated release. Broad corpus, lifecycle/recovery and
production networking/authentication acceptance remain separate open gates.
There was no production deployment or production database write. The transferred
candidate had no browser proof; the subsequently operator-approved local deployment
and its document/browser/model checks are described below.

## Verified findings and implemented repair

- Standard upload-time Tika extraction plus LibreChat-owned stored text is the
  correct direction for direct document context without embeddings/RAG. Existing
  shared ingestion/native-document processing must remain separate.
- A generated high-resolution PDF reproduces Java heap exhaustion through the
  installed LibreChat client. A 256 MiB heap also fails with a larger container.
  A 512 MiB heap within 1536 MiB container memory passes four consecutive uploads
  of that same scan, with readable markers, healthy extraction and no cgroup OOM
  events. This is targeted proof, not proof for arbitrary or repeated workloads.
- The installed v0.8.8 upload handler can persist replacement-character garbage
  from its built-in parser after configured extraction fails. The before/after
  handler regression reproduces this and proves the selective preload prevents
  fallback and storage for manifest document types after extraction errors.
- The opt-in overlay wires the private origin and shared LibreChat signing key.
  Its dedicated upload-tika service does not overwrite the existing shared tika
  service. The rendered Compose contract was checked for both identities and key
  agreement. Existing media/tool/security/context settings are preserved.
- Bounded admission now queues three additional callers behind one parser without
  reading their bodies. Queue expiry/cancellation does not latch an uncalled parser.
  Actual parser uncertainty still latches health; no automatic reset was introduced.
- Binary preflight timeouts return temporary service errors and kill/reap the
  validator. Its budget is at most 30 seconds within the original 270-second request
  deadline. This addresses observed validation aborts under the half-CPU adapter
  limit; reliability of the complete workload still needs confirmation.

## Actually passed checks

- 81 Python adapter/deployment contracts, including concurrent uploads, waiting
  timeout/cancellation, validation-process cleanup and shared-parser preservation.
  The last run passed after the 30-second preflight change. One upstream test-client
  deprecation warning remains.
- Three Node preload tests against the installed v0.8.8 source, including explicit
  activation, private-origin enforcement and incompatible-source refusal.
- Five installed-handler tests, including real client → Tika → captured storage/DB
  calls → actual file-context formatting for PDF, DOCX, scans and broken text layers.
  This live handler run preceded the final validation-timeout adjustment; repeat
  against the final image. Storage/DB were test doubles, not real persistence.
- Installed LibreChat schema/routing/branding-renderer and ordinary Unicode/chat
  filter contracts, using the generated configuration with secret placeholders.
- Real composed deployment contract: shared parser preserved, dedicated upload
  parser added, feature flag enabled, extraction origin set, signing keys matched.

## Historical incomplete warm runs before transfer

At the transferred commit, the full 53-case installed-client workload had **not**
completed successfully.
Earlier runs failed during preflight under load and during additional healthchecks
while Tika remained healthy and cgroup OOM counters stayed zero. The test now uses
the installed client's Axios stack for those healthchecks instead of leaving fetch
response bodies unread. The last attempted run failed at its initial healthcheck;
a standalone repeat of that same Axios healthcheck then returned healthy.
The cause of that intermittent behavior remains unidentified. The clean continuation
runs below do not prove that PC resources alone were responsible. Preserve strict
failures; do not mark partial runs successful or add retries merely to make tests green.

Use a sufficiently provisioned, isolated host for clean repeatable build, OCR and
full application testing. Resource headroom does not establish the cause of the
remaining intermittent failures. Environment-specific measurements and runtime
evidence are deliberately not included in this handoff.

## Continuation results (2026-11-24)

The remote review branch was fetched and its tip verified as
6a89ad7282de319118e544b9b6427920c5b882f1. A separate clean worktree was created,
preserving unrelated, uncommitted Docling work and all existing services/data.
Images were built from the transferred source in dependency order. Only the
disposable synthetic validation project was started; no regular stack, existing
private configuration, signing secrets, user records or production services were used.

| Check | Result |
| --- | --- |
| Transferred Python adapter/deployment contracts | 81 passed; same upstream test-client deprecation warning |
| Final Python contracts, including new isolated installed-contract wiring regression | 82 passed; same warning |
| Installed LibreChat schema, routing, branding renderer and media/settings preservation | Passed |
| Existing policies, ordinary Unicode and pasted-chat filter behavior | Passed |
| Installed selective preload contracts | Three passed, no skips |
| Existing document-context regressions | 15 passed; one optional external live test skipped in the network-free service |
| Complete installed-client workloads | Three consecutive runs of 53/53 cases; all expected source markers present, zero replacement characters, health passed before and after every case |
| Installed upload-handler workloads | Eight tests passed after each client run, including five handler tests and the real client/Tika/captured-persistence/context case; no skips |
| Warm continuity | Same dedicated parser and adapter throughout all three client/handler cycles; no restarts or latch resets |
| Dedicated parser cgroup checks | OOM kill count and allocation-failure count zero; no container OOM or restart recorded |

This includes ten scan/broken-layer/mixed/office cycles, a 30-page noisy scan and
four high-resolution scans **per client run**, followed by five real handler
extractions per cycle. No health/preflight intermittency was reproduced, no retries
were added, and no runtime, security, resource or deadline limits were changed.
Do not generalize these synthetic runs to arbitrary/near-limit documents or lifetime
memory stability, and do not infer the cause of the earlier failures from them.

One standalone installed-configuration invocation initially failed because mounted
source could not resolve the image's YAML dependency. Explicit installed dependency
lookup corrected that test setup. The validation Compose now provides a network-free
installed-contract service plus owned generated configuration and a regression test
for their isolation/dependency wiring. No runtime repair was needed in this continuation.

## Remaining acceptance gates

- The [retained local UI](tika-local-app.md) now proves normal Chromium login/upload,
  actual stored DOCX text, cross-owner preview rejection, reload/follow-up, actual
  document bridge/model delivery and native image analysis. The full local image gate
  passed after the separately verified and authorized local visionmodelalias correction.
  A real image-only PDF OCR/upload/stored-text/model probe also passed.
  Browser OCR/legacy/near-limit corpus and negative attachment-resolution coverage
  beyond preview remain separate gaps.
- Production networking/authentication and full application acceptance are not implied
  by the local email-login test. Installed-handler storage/DB calls remain test doubles;
  the new local app proof uses its own actual MongoDB and the approved local bridge.
- The historical health/preflight failure cause, indeterminate-job recovery/lifecycle,
  adversarial resource tests and arbitrary/legacy-document extraction fidelity remain
  unproved. No automatic latch reset, weaker validation or broader quality filter was added.

The candidate remains WIP and not cleared for rollout. No merge, push, deployment,
existing file-record repair or retained-environment reset was performed in this continuation.
The disposable validation containers, network and synthetic fixture/configuration
volumes were removed after verification. Safe test summaries remain only in the ignored
local output directory; existing Docling UI/services and unrelated work were preserved.
The initial continuation kept changes local and uncommitted. The operator subsequently
requested source publication and a PR to dev after a final local review. Selected source
changes are prepared for a regular review PR; no merge or server deployment is authorized.

### Operator-approved retained local app continuation

The operator subsequently requested local deployment for manual testing and explicitly
approved connecting the existing local bridge credential. A separate local application
was started on loopback with independent app keys and dedicated persistent Mongo/upload
volumes. Existing stacks/data were preserved. **This local application remains running
for manual testing and is not disposable.** No server deployment, merge, push or existing
user-record repair was performed.

The completed document API, OCR and full Chromium image/document checks are in
[local app operation and evidence](tika-local-app.md). The expanded Python contract suite
passed 87 tests. Private local runtime/browser caches are excluded from Git and testimage
builds. Normal signup/login limits were observed, not weakened; two test-harness setup
errors (browser User-Agent and native-provider image metadata expectation) were corrected.
The image fault was then traced to an unavailable local visionmodelalias (HTTP 400),
not a Tika image override. Only the approved local modelalias was corrected; workflow
logic, signing/parser configuration and existing user records were not modified.

### Final local review and PR boundary

The operator reported that manual local testing appeared to work well after the image
alias correction. This agrees with the recorded automated document/image/OCR checks;
it is not claimed as formal coverage of arbitrary documents or production authentication.

A subsequent bounded service/log review found no selected recent extractor/bridge/n8n
error codes, container OOM or unexpected restarts. LibreChat readiness returned HTTP 200
and the stored browser/API/OCR reports remained successful. App and parser container
logging is deliberately disabled, so missing logs are not presented as proof of semantic
extraction quality or absence of every possible application error.

The source is suitable for a **regular PR to dev for review**, with the 87 Python contracts,
installed routing/preload checks, three 53-case warm-client cycles plus handler tests,
real local browser/model/persistence checks and image-only PDF OCR proof clearly separated.
The broad corpus, remote-job lifecycle/recovery and production-auth/networking gates above
remain open. Publication must exclude private environment files, local data, account
credentials, browser caches and recovery snapshots. PR review is not merge/deployment
approval; existing retained local services/data stay intact.

## Continuation

1. Fetch and check out fix/tika-upload-processing in the current GovChat-NL
   repository. Verify its actual commit and working tree; do not merge it as accepted.
2. Build from the transferred source in the documented dependency order and run
   the Python contracts, installed schema/routing checks and preload tests.
3. Run the full client workload and then the installed upload-handler tests on
   the same warm dedicated parser. Do not run heavy builds in parallel. Record
   exit status and aggregate timing/quality/cgroup counters only. Keep failed test
   containers long enough to inspect the exact failed phase/status/error code.
4. If health/preflight intermittency persists on the better-provisioned host,
   diagnose that boundary rather than increasing resource/time limits blindly.
5. Only after a clean failing-before/passing-after repeat, verify authenticated
   browser upload, real owner-scoped persistence, attachment resolution/reuse,
   ordinary chat/images and actual final bridge/model delivery in a disposable
   deployment. Do not impersonate users or repair production file records.

See [implementation and test commands](tika-upload-processing.md). Generated
fixtures/runtime outputs and signing keys stay outside Git. Historical failed
document records are not rewritten by this repair.
