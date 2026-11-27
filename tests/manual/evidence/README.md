# Selected browser evidence

**Verified final run:** 2026-11-27T15:05:50.432Z · Chromium 145.0.7632.6 · Playwright 1.58.2 · **24 passed, 0 failed**, exit code **0**.

Run from the worktree with:

```sh
sh tests/manual/browser-run.sh
```

See [reproduction and coverage](../browser-README.md), [machine-readable results](browser-results.json), and [current implementation/migration](../../../docs/manual-frontend.md).

These are direct Playwright captures of synthetic fixtures or public generic repository content served through the real authenticated compiler/API. They contain no actual user identity, token, private contact, production conversation, runtime data or Entra session. Admin hidden/preview data is synthetic. Native slots are fixture markers, not browser evidence of the complete native client. The full pinned native client was separately [compiled successfully](../../../docs/manual-native-build-validation.md).

| Capture | Browser pixels | Demonstrates |
| --- | --- | --- |
| [Desktop modal](manual-desktop.png) | 1440 × 1000 | TOC, article and preferences |
| [Mobile modal](manual-mobile.png) | 390 × 844 | Responsive mobile viewport |
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

Coverage includes hierarchy and trusted rights, rights changes without new revision, full catalog management with the permitted user subset, citation current/stale/hidden/unknown behavior, all auto policies and denied storage across full routes, conflicting dialogs, revision/disable, independent passage history, 200–400% equivalent viewport reflow, contextual native/app errors, and editor draft/preview/publication/conflict handling. Earlier fixture-size/assertion/mock issues were corrected; final results above are the complete successful rerun.

No deployment, live Entra/SSO, real LLM generation, complete native browser session, external service, or OS printer was used. All selected evidence is committed with the feature implementation; temporary tooling/logs remain ignored in the worktree.
