# Native manual entrypoints adapter

> Historical subtask handoff. Parent integration is now implemented in the shared manual/overlay/app modules. Full production client compilation subsequently passed; see [native build validation](manual-native-build-validation.md) and [current frontend delivery/migration](manual-frontend.md). The original stopped image-export attempt below is not the final compile result.

Parent-owned overlay/help/start/Beleidskompas files are not changed by this task.

## Parent integration

- Import [`syncManualEntrypoints()`](../overlay/src/shared/manual-entrypoints.js:153) and [`cleanupManualEntrypoints()`](../overlay/src/shared/manual-entrypoints.js:184).
- Call sync from the existing one-second route loop with current `enabled`, an `open({id, revision})` wrapper, and `onError`. General footer/menu clicks pass an empty object. The wrapper must validate contextual destinations through authenticated `/get` under the current user before rendering.
- Optionally supply a **stable** `getDocument({signal})` callback returning the authenticated permitted `/document` response. No callback means no contextual error reads/links. It is invoked only when a marked native error exists, at most once per callback identity/enable lifecycle, with an eight-second deadline. Forward its abort signal to the API request.
- Replace that callback identity (or cleanup) on auth/config/revision changes. No admin preview, public/default catalog, or hidden content is a permitted document. The adapter rejects preview/disabled/malformed responses. Parent owns freshness and API error recovery.
- Disable/logout/teardown must cleanup. Sync with disabled also cleans up. In-flight stale reads are ignored. Native links and text are never removed.

## Native build

[`patch-manual-native.js`](../scripts/patch-manual-native.js) checks exact source fingerprints from the pinned official v0.8.8 image, matching the inventory error sources. It validates all files before writing and is byte-idempotent. Only a tiny activation hook, footer/action slots, Help & FAQ branching, and actual error-component markers are added. No observer or polling is introduced. Existing footer warning/empty overrides/Markdown/legal links stay native; mobile has a separately labelled button in a mobile-only slot. The footer hook also reserves its native composer band when manual help is enabled without configured footer content.

[`docker-compose.manual-native-build.yml`](../docker-compose.manual-native-build.yml) and [`manual-native.Dockerfile`](../scripts/manual-native.Dockerfile) provide an explicit opt-in client rebuild using the official image's own locked dependencies. Normal deployment is unchanged unless the override is selected. Never patch an arbitrary upstream checkout or a production bundle. Source drift intentionally fails the build for review.

The Dockerfile-specific ignore file restricts BuildKit's context to the patch/build recipe. On hosts without BuildKit/buildx, use a restricted tar stream instead of sending the whole repository to the legacy builder: `tar -cf - scripts/patch-manual-native.js scripts/manual-native.Dockerfile | docker build -f scripts/manual-native.Dockerfile -t govchat-manual-native:v0.8.8 -`. Build the image before selecting the Compose override; adding it does not itself start a build or change a running stack.

Context matching is case-sensitive and exact against permitted passages' codes/messages/aliases, using only structured code/message markers and visible leaf text inside designated native errors. Multiple matches or unknown errors use `probleem-algemeen` only when present in the permitted document. No generated chat scanning or automatic diagnosis is performed. Context buttons pass canonical ID/revision to the parent's validator; no hard-coded content or navigation href is exposed.

Focused tests are deterministic DOM/source/transpilation tests, not live browser, SSO or accessibility acceptance. Parent owns modal/API integration, browser acceptance, citations and preferences.

## Validation

- 17 focused adapter/native tests passed locally with temporary Node 22 and the inventory-matching cached sources.
- All 26 focused plus existing native-footer tests passed in a network-disabled official v0.8.8 container, using its actual sources/dependencies and a read-only worktree mount. No skips.
- Compose override validation and whitespace checks passed. Tests cover patch byte-idempotence, source drift before writes, warning/empty/legal content preservation, enabled-only FAQ branching, actual error renderer markers, exact matches, permitted fallback, repeat cleanup, stale read cancellation, and the bounded read deadline.
- A full validation-only image build was attempted with a restricted tar context. This host lacks buildx; the legacy builder spent minutes exporting intermediate layers before frontend compilation. That build was stopped. Full client/image compilation and browser/mobile/a11y acceptance are **not verified**.
- No commit, deployment restart, parent-owned module edits, or cached upstream source mutations were made.
