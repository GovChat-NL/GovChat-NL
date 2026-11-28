# Independent frontend/native acceptance review

> Preserved independent sibling review. [The combined final review](manual-final-review.md) supersedes the catalog, current backend safe-state/auth details and combined regression counts below. It reruns both browser suites against the final 692-article catalog and the existing native build; this review's native patch/build evidence remains valid and unchanged. Full trusted agent user context and the three optional availability adapters remain unaccepted.

Reviewed on **2026-11-27 UTC**, only in the handleiding worktree, on branch **feat/configurable-user-manual**, base **b87a6c7345a6484a2400b39661498b1a4171416c**. No commit, push, deployment, production authentication, private runtime inspection, or workflow installation was performed.

## Decision and ownership

**Frontend/native acceptance passes within the isolated scope below.** Concrete UI, focus, asynchronous-read and native-mobile findings were fixed. This is not permission to activate production or a claim of live Entra/agent acceptance.

The pre-existing sibling changes to backend context/routes, workflows, tool policy and backend/agent tests were preserved. This review did not edit backend model/store/routes/context/workflow, content, catalog or generator. The [earlier frontend handoff](manual-frontend.md), [historical native validation](manual-native-build-validation.md), browser evidence, actual shared modules, admin assets, native patch and optional recipe were inspected. The repository catalog was exercised through the existing compiler/API, not regenerated.

## Findings and fixes

| Finding | Resolution and acceptance |
| --- | --- |
| Preference footer occupied reader space even with automatic opening set to never; everyday copy mentioned technical policy acceptance | [Shared dialog](../overlay/src/shared/help.js) now completely hides preferences for never/disabled. For enabled policies, a single checkbox row switches to a short opt-out status and **Opnieuw toestaan** control. Policy-acceptance copy was removed. At 390 × 844, measured footer heights are **0 px / 57 px / 57 px** for never/enabled/opt-out, versus the reported approximately 165 px baseline. [Machine measurements](../tests/manual/evidence/browser-results.json) and [opt-out capture](../tests/manual/evidence/manual-mobile-preferences.png). |
| Configuration rechecks removed/recreated native triggers before an asynchronous opening captured return focus | [Dialog lifecycle](../overlay/src/shared/help.js) captures the trigger before awaiting. [Adapter](../overlay/src/shared/manual-entrypoints.js) refreshes contextual indexes without unnecessarily removing desktop/mobile controls. A replaced contextual button is resolved through its original action host. Native desktop, mobile and contextual return focus are browser-tested. |
| The real native mobile button was covered by the composer, despite fixture marker tests passing | [Pinned native patch](../scripts/patch-manual-native.js) additionally fingerprints the actual composer source and reserves a 56 px mobile band only while manual activation is true. Mobile slot stacking is explicit; the [shared stylesheet](../overlay/src/shared/manual.css) supplies a 44 px target rather than relying on an overlay-only utility class absent from the native build. Normal pointer clicks pass on welcome and existing-conversation pages. [Native shell capture](../tests/manual/evidence/manual-native-mobile-shell.png). |
| Overlay deactivation unconditionally erased the manual's restored body-overflow value | [Overlay teardown](../overlay/src/overlay.js) only clears its unrelated app scroll lock when an overlay app actually owns it. Manual closing restores previous overflow/inert values and returns focus without scrolling the page. |
| Error matching inspected translated/rendered text nodes within error components | [Exact-value adapter](../overlay/src/shared/manual-entrypoints.js) reads only explicit source code/message attributes. No translated leaf-text scan, substring diagnosis or generated-chat scan remains. Components without stable source values use permitted general help. Exact/unknown/ambiguous/hidden targets and the actual native failed-turn renderer are tested. |
| A late TOC response could update a closed/replacement dialog | TOC responses are bound to dialog identity, lifecycle and operation. Cancelled responses are ignored rather than disabling an otherwise healthy session. Late TOC/print responses cannot populate a replacement modal. |
| Printed content and after-print listeners could outlive a permissions/lifecycle change | Print teardown removes its listener as well as its DOM. Same-revision focus/rights checks also clear print DOM. Printing reads the current authenticated document, rejects preview/revision failures, excludes hidden-reason passages defensively and uses the inert HTML allowlist. Print response identity/operation checks prevent cross-dialog reuse. |
| Automatic opening did not explicitly consider alert dialogs/auth routes in its own final gate | Both scheduling and the post-authenticated-TOC-preflight gate reject competing alert/dialog surfaces and auth routes. Denied storage, unavailable authenticated content, late login responses, manual-click precedence and no delayed polling are tested. |

## Acceptance counts — latest complete runs, not additive reruns

| Check | Passed | Failed | Skipped / boundaries |
| --- | ---: | ---: | --- |
| [Chromium fixture acceptance](../tests/manual/evidence/browser-results.json) | **29** | **0** | None; real ES modules and production model/store/routes/editor, synthetic trusted identity/configuration |
| [Complete compiled native Chromium acceptance](../tests/manual/evidence/native-browser-results.json) | **5** | **0** | None; complete Vite client plus real production overlay route loop; synthetic API/auth responses |
| Complete manual Node suite | **68** | **0** | None; includes the sibling's six agent-review tests, native source/render/transpilation tests and the new no-translated-text test |
| Start/Beleidskompas Node regressions | **18** | **0** | None |
| Selected broad Node regressions | **166** | **0** | **1** explicit live Tika/external PDF extraction skip; 167 total tests |
| Python static/config/security/runner suite | **50** | **0** | **13** explicit proxy-integration skips; **63** total tests |
| Final native production compilation | Successful | — | **9,733 modules; 20.77 seconds**, 54 service-worker precache entries; locked dependency restoration and offline production prune also passed |
| Syntax/whitespace and deployment recipe inspection | Successful | — | No production deployment or final image export |

The Node suites total **252 passed and 1 skipped**, not counting Python/browser tests or diagnostic attempts. Browser tests are separate scenario counts, not unit-test totals. Live-production/Entra/LLM/agent executions: **0**.

The fixture browser covers all four automatic policies across full chat/start/app page changes, unavailable and denied storage, opaque account preferences, competing dialogs, current/stale/hidden/unknown/noncanonical citations, permission changes without publication, print media/trust, focus/inert/reflow, chapter/category visibility, complete catalog management and editor publication/conflict behavior. The allowed subset is determined by synthetic trusted context; it is not a production permissions audit.

The complete native browser covers:

1. Real desktop footer, unchanged native warning/Markdown/legal links, shared reader, internal citation navigation, unchanged native composer/URL, keyboard containment and return focus.
2. Real 44 px mobile control, normal pointer access on welcome **and existing conversation**, conditional preferences and return focus.
3. A synthetic persisted failed turn rendered by the real bundled native error component, exact structured code extraction, permitted context navigation and contextual return focus; ordinary chat prose is not scanned.
4. Real account Help submenu/manual event and disable invalidation; external FAQ fallback opens a popup, with outbound navigation deliberately blocked.
5. The actual anonymous native login page; no automatic manual popup or authenticated content. Its synthetic refresh returns the expected 401.

No native markers are inserted by the native browser harness. The native index fingerprint is recorded in its machine report. Screenshots were regenerated after UI fixes, and separate native shell/reader/error captures were added. No screenshot is a production session.

## Isolation, compilation and reproduction

The optional [compose override](../docker-compose.manual-native-build.yml) and [recipe](../scripts/manual-native.Dockerfile) remain opt-in and unchanged. The regular compose deployment remains unchanged. The pinned source guard checks every native file before writing and rejects drift; applying twice is byte-idempotent. Six existing native files plus one small helper are now affected, including the newly checked composer. Default disabled behavior does not reserve the mobile band.

Actual compilation used the cached official release digest:

**registry.librechat.ai/librechat-ai/librechat@sha256:5b706bcee1ca154a1e2987303aaeca0eb27f97919cccee4bb604226c2f8abf61**

Both compile attempts used disposable containers, a 3 GiB memory limit, no published ports and only the native patch mounted read-only. Dependencies were restored from the image's own lock. The bridge was disconnected at dependency readiness, before compilation/pruning. The final container was named govchat-manual-frontend-final-20261127; emitted assets were copied into the ignored validation directory before automatic removal. The substantive optional recipe was executed; **no final image build/export or deployed native server was performed**.

Core in-container steps, with the same offline gate as the [historical recipe validation](manual-native-build-validation.md:46):

```sh
sha256sum package-lock.json > /tmp/lock-before
node /tmp/patch-manual-native.cjs /app
node /tmp/patch-manual-native.cjs /app
npm ci --include=dev --no-audit --no-fund
sha256sum -c /tmp/lock-before
# Host disconnects this validation container from bridge before releasing the gate.
npm run build:client
sha256sum -c /tmp/lock-before
npm prune --omit=dev --no-audit --no-fund --offline
```

Test containers were network-disabled from creation. A public tracked-source/example-config snapshot was mounted read-only, copied into the container's temporary layer, and aliased at the test fixture's expected workspace location. Existing browser test dependencies and declared admin dependencies were mounted read-only; no environment secrets, private store/runtime, Docker socket or production container mounts were supplied. Native dependencies/source came from the pinned image. The [raw regression output](../.manual-tools/frontend-review/regressions.tap) records all three complete suites. Commands inside the corrected harness:

```sh
export NODE_PATH=/app/node_modules:/app/api/node_modules:/admin-deps/node_modules
export GOVCHAT_TEST_LIBRECHAT_ROOT=/app GOVCHAT_DOCKER_TESTS=0
node --test --test-concurrency=1 tests/manual/*.test.js
node --test tests/overlay/start-page.test.js overlay/src/apps/beleidskompas/tests/*.test.js
node --test --test-force-exit --test-concurrency=1 --test-timeout=60000 \
  tests/native-chat-footer.test.js tests/minimal-ui.test.js tests/branding/*.test.js \
  tests/librechat-entra.test.cjs tests/librechat-release-pin.test.js \
  tests/librechat-runtime-compatibility.test.js tests/govchat-retention-policy.test.js \
  tests/govchat-retention-worker.test.js tests/librechat-tool-event-overlay.test.js \
  tests/n8n-processEventStream.patched.test.js tests/document-context.test.js \
  tests/image-request-compatibility.test.js tests/image-tool-identity.test.js \
  tests/image-edit-workflow.test.js tests/orchestrator/name*.test.js \
  tests/orchestrator/prompt*.test.js
```

Browser reproduction with existing ignored tools and the independently built native directory:

```sh
export PATH="$PWD/.manual-tools/node-v22.16.0-linux-x64/bin:$PATH"
export NODE_PATH="$PWD/.manual-tools/node_modules"
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.manual-tools/browsers"
node tests/manual/browser-acceptance.cjs
GOVCHAT_NATIVE_DIST="$PWD/.manual-tools/frontend-review/native-dist-final" \
  node tests/manual/native-browser-acceptance.cjs
python3 -m unittest discover -s tests -p 'test_*.py'
```

The [native fixture](../tests/manual/browser-fixture.cjs) serves real compiled assets and injects only the normal production overlay module into the HTML shell. API responses and persisted messages are explicitly synthetic. Chromium blocks every other origin and service workers are blocked in the native run. Browser APIs use loopback-only servers with disposable local manual stores.

Local ignored evidence: [final compile](../.manual-tools/frontend-review/compile.log), [fixture browser](../.manual-tools/frontend-review/browser.log), [native browser](../.manual-tools/frontend-review/native-browser-final.log), [Python](../.manual-tools/frontend-review/python.log), [input fingerprints](../.manual-tools/frontend-review/inputs.sha256). Native patch SHA-256: **2c22f2e18ef59eed2de88df17dcdb0725d871b1d17e4e8e77a596f1fe87fa3f9**. Recipe SHA-256 remains **652e1cb90011f5357f4c2107ea7628b3b2f0cf4967030edc85ceff15ed41a03c**. Upstream lock SHA-256 remains **af5f9a7a73a1ec056f796eea736a3e0026b5c7c53813439f093ec51b2a7cb023**.

## Diagnostic attempts and limits

- Early browser diagnostics exposed the real native trigger-focus and mobile pointer-overlap problems, which were fixed. An old restore-button selector, opt-out layout expectation, late route-callback teardown and old six-file footprint assertion were corrected in test-owned files. Earlier failed runs are not counted as passes.
- Initial container harness attempts used an incorrect dependency mount layout and then omitted the declared temporal admin dependency required by sibling backend edits. The final harness supplied the existing declared dependency and all 68 manual tests passed; no backend fix was made for these harness issues.
- Native compilation is a complete production Vite build, **not** a standalone whole-repository TypeScript check or all upstream tests. Existing non-fatal warnings include ambiguous Tailwind easing, upstream VM evaluation and large chunks. Pruning was successful and offline.
- Native browser auth is synthetic, not an official API server plus Mongo/Entra deployment. It validates the actual compiled React client/overlay integration, not upstream production identity/session configuration, reverse proxy, TLS or final image installation. External fallback pages are not loaded.
- Screen-reader hardware, Firefox/WebKit, actual OS printer/PDF output, native mobile app, full live LLM/SSE generation, n8n tool execution and formal WCAG certification were not tested. Print uses the actual fresh-document/safe-DOM path with the OS invocation suppressed, plus print-media emulation.
- Preference scope remains origin/account, and session semantics remain tab/session storage. No cross-device or centralized policy-acceptance feature is implied. All auth/error component families are not browser-scenario-exhaustive; exact pinned-source/render tests supplement the failed-turn browser case. Unmarked toast/other surfaces retain only the general entrypoint.

**Residual blocker for production activation:** the normal separately authorized installation/auth/deployment smoke test remains outside this task. No known unresolved frontend/native acceptance defect remains in the exercised isolated scope.
