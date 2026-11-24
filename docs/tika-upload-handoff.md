# Unfinished upload-extraction feature: failure and continuation notes

> Historical handoff from the original experiment. The subsequent repair and
> current activation instructions are in [Tika upload processing](tika-upload-processing.md).
> Statements about missing fixes below describe the original branch, not the repair.

## Status

This branch is a development handoff, **not a fixed upload pipeline**. The
experiment was withdrawn in favor of the established baseline after an
actual-client memory failure was reproduced. No successful correction was
deployed. All descriptions here are general; no uploaded-document details,
deployment identifiers, addresses, private configuration or runtime evidence
are included.

## Confirmed failure chain

1. LibreChat's installed extraction client sends the supported PDF to the adapter.
2. Normal extraction rejects the unreadable native text layer and OCR work starts.
3. A warm dedicated parser exceeds its container memory budget. A native process
   is killed and Tika's watchdog replaces the fork.
4. Extraction returns a service failure and the adapter latches uncertain work.
5. LibreChat invokes its built-in document fallback. That fallback can store
   nonempty text with no readable Unicode letters or numbers.
6. A model consequently receives unusable persisted text rather than useful OCR.

Repeated calls through the installed LibreChat client reproduced the memory kill
after earlier readable OCR successes. Native PDF, Word and plain text were also
exercised through that client. Healthy direct-parser tests alone had missed this
warm-process/application boundary.

Temporary-filename routing and native-provider delivery were checked and were
not the identified cause in this investigation. Preserve strict filename/MIME
and binary-signature handling rather than broadening it speculatively.

A smaller JVM heap was tried in isolated services under the same container cap.
It still failed on repeated OCR and was **not deployed or adopted as a fix**.
The committed template retains the experimental pre-attempt configuration.

## What remains unresolved

- Sustainable combined memory use of the watchdog JVM, parser JVM, OCR process,
  native image buffers, font caches and scratch on repeated/mixed workloads.
- Parser timeout/disconnect cleanup and safe recovery after indeterminate work.
- LibreChat's fallback acceptance of unreadable built-in extraction after an
  adapter failure. No broad security rule or upstream core patch is included.
- Authenticated browser upload, upload-handler persistence, subsequent attachment
  reuse and final model/bridge delivery after a future correction.
- Coverage/fidelity of large scans and legacy compound-document formats.

The reverted document-quality guard must stay absent. Its broader applicability
caused hydrated-context traversal failure even for ordinary pasted text.
Existing security settings and traversal limits must not be weakened to hide it.

## Recommended next checks

1. Reproduce with generated high-resolution scans and damaged native text layers,
   using the installed LibreChat client and actual upload-handler request shape.
   Reuse a warm parser; do not restart it between each case.
2. Record only aggregate character quality, timing, cgroup memory/OOM counters,
   process memory and request status. Do not log filenames, text, tokens or owners.
3. Measure memory by component before changing standard parser/runtime settings.
   Account for native OCR buffers and both JVMs, not only heap size. Any proposed
   architecture/security/resource-envelope change requires separate review.
4. Establish a failing-before/passing-after repeated-workload regression. Preserve
   native PDF, Word, Unicode/numeric/plain-text and media routing behavior.
5. Exercise an isolated real upload handler with a synthetic identity and captured
   persistence, without impersonating users or writing production databases.
6. Prove text persistence, owner checks, follow-up attachment reuse and final
   model delivery. Only then request a fresh browser upload for acceptance.

Do not rewrite historical file records, repair documents on every chat turn,
accept unreadable text, return fake success objects or declare completion from
parser-only tests. A future release must clearly distinguish client-level proof
from authenticated browser/persistence/model proof.
