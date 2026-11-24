# Tika upload repair: verified status and continuation

## Source and status

The repair starts from the current upstream Tika experiment, commit
d9520748bc0255080275f587ac8d4315e8121c4a. This status accompanies the unfinished
review branch fix/tika-upload-processing, based on feat/tika-upload-processing.
Use the actual fetched review-branch tip for continuation; do not assume the
original experiment branch contains the candidate changes.

**Not fully working/accepted yet.** Do not merge or deploy as a validated fix.
There was no production deployment, browser login or production database write.

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

## Not passed or not proved

The full 53-case installed-client workload has **not** completed successfully.
Earlier runs failed during preflight under load and during additional healthchecks
while Tika remained healthy and cgroup OOM counters stayed zero. The test now uses
the installed client's Axios stack for those healthchecks instead of leaving fetch
response bodies unread. The last attempted run failed at its initial healthcheck;
a standalone repeat of that same Axios healthcheck then returned healthy.
This remains unresolved intermittent behavior, not proof that PC resources alone
are responsible. Preserve the strict failures; do not mark partial runs successful
or add retries merely to make the test green.

Use a sufficiently provisioned, isolated host for clean repeatable build, OCR and
full application testing. Resource headroom does not establish the cause of the
remaining intermittent failures. Environment-specific measurements and runtime
evidence are deliberately not included in this handoff.

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
