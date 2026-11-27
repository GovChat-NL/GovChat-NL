# Isolated browser acceptance

This suite launches **real headless Chromium through Playwright**. It does not
use the deterministic DOM fixtures from the unit tests.

## Run

From the handleiding worktree:

```sh
sh tests/manual/browser-run.sh
```

The runner downloads Node **22.16.0**, installs Playwright **1.58.2**, Express
**4.21.2**, cookie-parser **1.4.7** and htmlparser2 **10.0.0**, and downloads
Chromium inside the ignored `.manual-tools` directory. Nothing is installed
system-wide. The tested host is Linux x86_64 / Ubuntu 26.04; Playwright needs
`PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64` on this host. Chromium
**145.0.7632.6** successfully launches with that fallback. Other operating
systems/architectures are not covered by this bootstrap script.

After bootstrap the direct command used for acceptance is:

```sh
NODE_PATH="$PWD/.manual-tools/node_modules" \
PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 \
PLAYWRIGHT_BROWSERS_PATH="$PWD/.manual-tools/browsers" \
.manual-tools/node-v22.16.0-linux-x64/bin/node tests/manual/browser-acceptance.cjs
```

The process returns nonzero on a failed scenario. It runs sequentially, closes
browser contexts, stops its loopback server, and deletes its disposable store
under `.manual-tools/tmp`. No commit or push is performed.

## Actual code exercised

- [Fixture server](browser-fixture.cjs) publishes synthetic content with the
  actual manual model/compiler, store and route registration. Admin saves,
  publication, preview, conflicts, disable and internal reads use their real
  HTTP implementations. The public API has the same alias mapping as the
  deployed proxy.
- The actual trusted-context adapter performs HTTP requests to stub LibreChat
  `/api/user`, `/api/config`, `/api/roles/:role` and `/api/files/config` endpoints.
  The actual browser token helper obtains its bearer token through the stub
  `/api/auth/refresh` endpoint. Restricted and privileged synthetic identities
  have different trusted prompt-sharing rights.
- [Browser harness](browser-harness.js) imports the unchanged shared help,
  client, preferences, render, theme and native-marker adapter ES modules.
- The actual start and Beleidskompas HTML, modules and styles are served at
  their normal asset URLs. The app's conversation-list endpoint returns an
  empty synthetic result. No conversation generation/backend execution runs.
- The actual admin editor HTML, script and stylesheet are served with a
  test-only `authfixture` cookie. The production admin API handlers are used;
  this is **not** the complete admin server or its production login middleware.

The server binds only to `127.0.0.1` on an ephemeral port. Browser routing blocks
requests to every other origin. Trusted-context fetches are allowlisted to the
fixture's local API. Setup downloads use the public Node/npm/Playwright hosts;
acceptance uses no production, Entra, real user identity or private content.

## Coverage

The [acceptance runner](browser-acceptance.cjs) covers:

1. Desktop opening, fullscreen toggle, keyboard focus containment, Escape,
   return focus, newly mounted inert elements, and exact prior inert/overflow
   restoration.
2. Hidden chapters and their children, hidden topics, hidden categories,
   chapter-owned error categories, hidden articles and trusted rights across
   TOC/search/get/document, printed content and internal-tool reads. Hidden
   links lose destinations; ordinary prose mentioning a hidden topic can remain.
3. Compiler-canonical citations preserving the current conversation URL and
   unsent composer text. Stale, hidden and unknown targets show no passage.
   Refreshing the TOC does not silently reopen a stale citation. Arbitrary,
   external and noncanonical extra-parameter links are not intercepted.
4. Mobile navigation/toggle and viewport bounds, and actual dark styles.
5. Repeated native-marker synchronization without duplicate buttons; fixed
   exact codes/messages resolve contextual help, unknown/substrings use general
   fallback, ordinary chat prose is never scanned, and native open events work.
6. Published revision/focus rechecks clear old text; disable removes entries
   and contextual buttons while leaving close/focus/inert restoration intact.
7. Initial canonical deep links, actual route transitions and popstate hooks.
8. Global error-reference hiding across reads, print and contextual controls.
9. All four automatic policies with **full page** chat → start → Beleidskompas
   transitions, same-session suppression and fresh browser-session behavior.
   New revisions, opt-out and restoring preferences are exercised.
10. Denied browser-storage access disables auto on every full-page route while
    manual opening remains available; preferences are visibly unavailable.
11. Opaque account-specific storage with no identity/token/content payload,
    and a different verified user is not suppressed by the first user's state.
12. Another app dialog and an explicit manual click win over automatic opening;
    removing a competing dialog does not cause automatic polling/reopening.
13. Shared start/app integration and app container inert restoration.
14. Real editor draft/live separation, server preview, publication and conflict
    preservation of local changes; unauthenticated admin API access is denied.
15. Independent bounded passage history, explicit TOC fallback and zoom-equivalent
    720 × 500 / 360 × 250 reflow with reachable controls and no horizontal overflow.
16. Automatic authenticated TOC preflight, late login-response invalidation and
    current rights changes on focus without a new content revision.
17. Complete repository-backed admin catalog (684 articles), the trusted fixture's
    permitted subset (668 articles), server/user search and editor article search.
18. Explicitly caught Beleidskompas error components, validated contextual links
    and unchanged app route/state.

## Evidence and limitations

Selected screenshots and the machine-readable last-run result are in
[evidence](evidence). Screenshots are browser captures of **synthetic test
fixtures**, not production deployment or user-session evidence. Only modal
viewport captures are used except the full-page editor and print-media capture.
The editor's hidden passages and empty contact fields are also synthetic.

- Native desktop/mobile/error markers are fixture elements, not the complete
  ingelogde native browser. The full patched native production client **was
  compiled separately**; see [compile and source/render evidence](../../docs/manual-native-build-validation.md).
- Real shared native-marker adapter logic runs, but the complete parent overlay
  route-loop bundle and deployment proxy are not built in this fixture.
- Window lifecycle focus/popstate/native-open events are explicitly dispatched
  inside Chromium to exercise registered browser hooks. Modal keyboard/pointer
  interactions and focus/inert behavior use the actual browser engine.
- Print invokes the real permitted-document loading/rendering path, with only
  `window.print` replaced to avoid an OS dialog. Print CSS is exercised through
  browser print-media emulation; OS PDF/printer output is not tested.
- Chromium only; no Firefox, WebKit, production SSO, Entra, live persistence,
  full app chat generation, deployment TLS/proxy or native mobile app coverage.
- Setup encountered an unsupported-host browser-download error; selecting the
  supported fallback resolved it. Early runner/selector/overbroad print assertion
  mistakes were corrected in test-owned files. The parent subsequently extended
  both production frontend and coverage; machine results refer to the final run.

Read [browser-results.json](evidence/browser-results.json) for the exact browser
version, timestamp and per-scenario outcomes of the latest completed run.
