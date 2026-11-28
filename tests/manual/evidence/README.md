# Selected browser evidence

**Verified final fixture run:** 2026-11-27T16:24:42.449Z · Chromium 145.0.7632.6 · Playwright 1.58.2 · **29 passed, 0 failed**, exit code **0**. Final repository catalog: **692 total, 466 ordinary, 226 default-hidden appendix, 450 visible under synthetic trusted fixture permissions**. The runner explicitly checks that the default document excludes every appendix entry; these counts are recorded in [machine results](browser-results.json).

**Verified final complete native-client run:** 2026-11-27T16:20:59.613Z · same Chromium · **5 passed, 0 failed**, exit code **0**. See [native machine results](native-browser-results.json), [combined acceptance summary](final-acceptance.json) and [final review](../../../docs/manual-final-review.md). This run loads the existing independently compiled pinned native client and actual overlay route loop, not inserted marker fixtures. Native patch/runner/build were not changed for cross-review. API/auth and persisted messages remain synthetic.

Run from the worktree with:

```sh
sh tests/manual/browser-run.sh
```

See [reproduction and coverage](../browser-README.md), [machine-readable results](browser-results.json), and [current implementation/migration](../../../docs/manual-frontend.md).

These are direct Playwright captures of synthetic fixtures or public generic repository content served through the real authenticated compiler/API. They contain no actual user identity, token, private contact, production conversation, runtime data or Entra session. Admin hidden/preview data is synthetic. Ordinary fixture captures use marker fixtures; separately named native captures show the actual complete compiled client. Native build and browser boundaries are documented in the [independent review](../../../docs/manual-frontend-review.md).

| Capture | Browser pixels | Demonstrates |
| --- | --- | --- |
| [Desktop modal](manual-desktop.png) | 1440 × 1000 | TOC, article and no unused never-policy footer |
| [Mobile modal](manual-mobile.png) | 390 × 844 | Responsive mobile viewport |
| [Compact mobile preferences](manual-mobile-preferences.png) | 390 × 844 | Opt-out status/restore; 57 px footer (never: 0 px) |
| [Complete native desktop](manual-native-desktop.png) | 1440 × 1000 | Shared reader over real compiled native chat |
| [Complete native mobile shell](manual-native-mobile-shell.png) | 390 × 844 | Reserved footer band; actual reachable 44 px help target |
| [Complete native mobile reader](manual-native-mobile.png) | 390 × 844 | Shared reader opened by the actual native button |
| [Complete native error context](manual-native-error.png) | 1440 × 1000 | Permitted context from a synthetic persisted native failed turn |
| [Dark modal](manual-dark.png) | 1440 × 1000 | Actual dark stylesheet |
| [Search](manual-search.png) | 1440 × 1000 | Server search for an exact fixture code |
| [Repository catalog search](manual-catalog-search.png) | 1440 × 1000 | Permitted article from the complete repository-backed catalog |
| [Admin article search](manual-editor-search.png) | 1440 × 1000 | Ordinary editor filtering and editing of a repository-backed article |
| [Canonical citation](manual-citation.png) | 1440 × 1000 | Current validated passage; conversation unchanged |
| [Stale citation](manual-stale-citation.png) | 1440 × 1000 | Explicit fallback; changed passage not silently displayed |
| [Print-media content](manual-print.png) | 1440 × 1000 | All permitted-document content with print CSS |
| [Start integration](manual-start.png) | 1440 × 1000 | Shared modal above the real start page |
| [Beleidskompas integration](manual-beleidskompas.png) | 1440 × 1000 | Shared modal above the real app |
| [Admin editor and preview](manual-editor.png) | 1440 × 3235 | Full editor with synthetic private preview |

Modal/search captures use viewport screenshots; the main editor and print use full-page capture. Print replaces only the OS print invocation and exercises actual permitted-document rendering plus browser print-media CSS; it is not OS printer/PDF-output evidence. Lifecycle events are explicitly dispatched; pointer, keyboard, focus and inert handling run through Chromium.

Coverage includes hierarchy and trusted rights, rights changes without new revision, all 692 catalog articles in private management with the permitted default 450-article user subset and excluded 226-entry appendix, citation current/stale/hidden/unknown behavior, all auto policies and denied storage across full routes, conflicting dialogs, revision/disable, independent passage history, 200–400% equivalent viewport reflow, contextual native/app errors, and editor draft/preview/publication/conflict handling. Earlier diagnostic runs are not counted as passes. Node/Python/browser suites and repeated runs overlap and are not summed into one acceptance total.

Readiness is **partial safe-fallback acceptance, not full requirements or activation approval**. Full trusted per-user agent context across LibreChat/bridge/n8n/backend and verified availability adapters for OpenBesluitvorming, TOPdesk and transcription remain blockers. Private publication locks/markers block current reads on failure, including across processes/restarts; failed marker persistence retains the lock. Previously delivered citations/exports/browser memory cannot be recalled. Public activation metadata is neither authorization nor manual content.

No deployment, live Entra/SSO, real LLM generation, production native authentication, external service, or OS printer was used. Screenshots and machine reports are retained in the worktree; this review created no commit. Temporary tooling/build artifacts/logs remain ignored.
