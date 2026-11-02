# Native live tool-call cards in LibreChat

This note documents the GovChat-NL implementation for showing tool calls made
inside n8n as native, live LibreChat tool cards. It records why the overlay is
needed, which repository owns each part, how events travel, and how to validate
and deploy the integration.

## Scope and design constraints

- LibreChat continues to use the official
  `registry.librechat.ai/danny-avila/librechat:v0.8.7` image. No forked or
  custom-built LibreChat image is needed.
- n8n continues to use the official `docker.n8n.io/n8nio/n8n` image. n8n
  JavaScript patches are mounted as read-only overlays.
- The bridge is the only application component whose source is built locally.
- Tool events must use LibreChat's existing `on_run_step*` event contract so
  the browser renders its native shimmer, arguments, and result card.

## Why a sideband is required

LibreChat calls the bridge through its OpenAI-compatible Chat Completions API.
That response is consumed inside LibreChat by an OpenAI/LangChain parser. The
parser accepts `data:` frames containing ordinary
`chat.completion.chunk` objects; it does not forward arbitrary named SSE events
or unknown fields. Sending `on_run_step` as a separate SSE frame therefore
loses the event before it reaches LibreChat's resumable stream.

The bridge encodes each allowed lifecycle event as a private content marker:

1. The event JSON is UTF-8 encoded and base64url encoded.
2. The marker is wrapped in record/unit separators with the `LCSTEP:` tag.
3. The marker is placed in `choices[0].delta.content` of an otherwise valid
   OpenAI streaming chunk.
4. The LibreChat runtime overlay incrementally decodes the marker in the
   existing `ON_MESSAGE_DELTA` callback. It forwards the event to LibreChat's
   existing run-step handlers and suppresses the marker from assistant text.
5. Text before and after markers is emitted normally and in its original order.

The incremental decoder handles markers split across arbitrary model token
boundaries. It only recognizes the four allowed event names, applies a size
limit, and preserves malformed marker-like content as text.

## Changes by repository

### `n8n-openai-bridge/`

- `src/n8nClient.js` parses streamed n8n NDJSON, tracks active tool calls, and
  creates start/completion/close lifecycle payloads. Serialized tool-call JSON
  embedded in assistant text is stripped incrementally (including across chunk
  boundaries); tool-call log lines are buffered and suppressed without hiding
  the final assistant answer. The n8n `tool_call`/`tool_result` chunks may themselves wrap a
  second typed JSON event in `content`; the bridge preserves that inner event
  type so a result cannot be mistaken for another start. Results and errors are
  matched by call ID or tool name.
  Tool-step indices increase across calls. The patched n8n event stream does not
  close a tool card merely because an individual model-event stream ended; when
  no result event is emitted, the bridge closes it with empty output only after
  the overall response stream ends.
- `src/utils/libreChatEvents.js` defines LibreChat-shaped lifecycle payloads.
- `src/utils/libreChatEventProtocol.js` validates and encodes the content
  sideband; its decoder is also exercised by tests.
- `src/handlers/streamingHandler.js` embeds lifecycle markers in valid OpenAI
  chunks while leaving normal text chunks compatible with LibreChat's model
  parser.
- `src/routes/chatCompletions.js` enables the streaming route for SSE clients
  and passes the response identity used by run-step events.
- `tests/` covers event parsing, lifecycle streaming, text preservation,
  malformed markers, and monotonic step indices.

The bridge repository's configured `origin` points at
`GovChat-NL/n8n-openai-bridge`. Confirm the authorized destination before pushing
this branch; do not publish this work to the upstream project by accident.

### `GovChat-NL/` (canonical stack)

- `scripts/librechat-tool-event-preload.js` installs a CommonJS loader hook
  before the API starts.
- `scripts/librechat-tool-event-overlay.js` patches the stock image's existing
  agent callbacks in memory. It supports both the pinned v0.8.7 callback API
  and the newer source layout used by the overlay tests. The patch fails closed
  if its required source anchors change, rather than silently rendering
  sideband control data as user-visible text.
- `scripts/librechat-tool-event-protocol.js` is the image-local decoder copy.
- `docker-compose.yml` mounts the LibreChat overlay files read-only, loads the
  preload through `NODE_OPTIONS`, mounts the n8n streaming patches, and builds
  the bridge from GovChat-NL's `main` branch. These settings are enabled by
  default and are required for sideband events to become native LibreChat steps.
- `scripts/n8n-processEventStream.patched.js` forwards actual `on_tool_end` and
  `on_tool_error` events. It no longer treats a tool-call log or final assistant
  text as a successful tool result.
- `docs/live-tool-calling.md` (this document) records the design and operations.

The overlay assigns tool steps the leading content indices and moves an
already-started assistant message step behind them. This keeps tool cards in
chronological order above the final answer, including when the assistant step
arrives before the tool event. When a later tool step claims an index already
used by streamed assistant text, the overlay moves that accumulated text with
the assistant step so the native aggregator can retain both tool cards.
LibreChat v0.8.7 does not handle
`on_run_step_closed`; the overlay suppresses that event for this version. The
completed event still supplies tool progress and any non-empty output.

### `GovChat-NL-Agents/`

The orchestrator's internal chat model must continue to use LiteLLM (or its
configured model provider). LibreChat calls the bridge; the bridge calls the
n8n orchestrator webhook; the orchestrator then calls its model provider. Do
not configure the orchestrator's model node to call the bridge: that creates a
recursive bridge → orchestrator → bridge call loop. No workflow model URL
change is required for live tool cards. The working copy had such a URL change;
it has been reverted. The `wait_test_tool` Code node is only a manual test
fixture, not a requirement for ordinary production conversations, and should
not be included in the production orchestrator workflow by default.

### LibreChat source checkout

No LibreChat source patch is required by this design. The official container
image is patched at runtime through the compose overlay. The current local diff
in `LibreChat/client/src/hooks/SSE/useStepHandler.ts` consists of temporary
diagnostic logging and is not part of this feature; do not include it in a
feature commit unless the diagnostics are separately requested.

## n8n runner prerequisite

The `wait_test_tool` fixture uses the JavaScript Code node. With external
task-runner mode, n8n must have a healthy JavaScript runner connected to broker
port 5679. If the JavaScript runner is unavailable, n8n reports
`No matching task offer ... type "javascript"` and Code-node requests time out;
the agent may then retry the tool. Check the runner logs for `Found runner
unresponsive` or `Task broker is down` before diagnosing this as a LibreChat
streaming problem. Restarting the runner can restore service, but recurring
runner failures need a separate infrastructure investigation.

## Verification

Bridge tests (run in the bridge repository):

```bash
npm test -- --runInBand tests/n8nClient.test.js tests/handlers/streamingHandler.test.js tests/utils/libreChatEventProtocol.test.js tests/routes/chatCompletions.test.js
npx eslint src/n8nClient.js src/handlers/streamingHandler.js src/utils/libreChatEventProtocol.js src/routes/chatCompletions.js tests/n8nClient.test.js tests/handlers/streamingHandler.test.js tests/utils/libreChatEventProtocol.test.js tests/routes/chatCompletions.test.js
```

Overlay tests and stock-image smoke check:

```bash
node --test tests/librechat-tool-event-overlay.test.js
```

The integration was also smoke-tested against the pinned v0.8.7 image by
loading the patched agent callback and initialize modules with the overlay
preload active. The complete browser flow should additionally be tested by
asking the configured agent to call a tool once, checking that the card appears
at start, the final assistant text remains visible, and the tool output appears
after completion.

## Deployment

From the GovChat-NL repository root, clone the bridge `main` branch beside this
repository once, then use the single standard Compose file:

```bash
git clone --depth 1 --branch main https://github.com/GovChat-NL/n8n-openai-bridge.git ../n8n-openai-bridge-main
docker compose --env-file .env up -d
docker compose --env-file .env logs -f librechat n8n-openai-bridge n8n n8n-runners
```

Compose builds the bridge from the local `../n8n-openai-bridge-main` checkout
when its image is missing. Keep that clone on `main`; no alternate Compose file
or feature-branch switch is required. To rebuild after changing bridge source,
run `docker compose --env-file .env build n8n-openai-bridge` explicitly. Keep the
LibreChat `NODE_OPTIONS` preload and n8n streaming-patch mounts enabled; they
are part of the default stack.

The runner is a separate service; restart it independently if its JavaScript
worker is stuck:

```bash
docker compose --env-file .env restart n8n-runners
```

The proxy may need a restart after LibreChat gets a new Docker IP, because nginx
can retain a cached upstream address:

```bash
docker compose --env-file .env restart librechat-proxy
```

Verify the overlay startup messages, the bridge `/health` endpoint, n8n `/healthz`,
and a fresh chat. Do not recreate unrelated database services merely to deploy
the overlay; an unhealthy dependency healthcheck can leave newly created
application containers waiting for Compose even when the dependency itself is
still reachable.

## Repository boundaries and rollout

LibreChat deployment configuration, its runtime overlays, n8n patches, workflows,
and stack documentation are maintained in this monorepo. The sideband event
producer remains in the separate `GovChat-NL/n8n-openai-bridge` repository. The
standard stack builds the local clone of GovChat-NL's `main` branch, which
includes the live tool-calling producer; no separate feature-branch build or
Compose override is needed.

No patch to the LibreChat source repository is needed. Keep the orchestrator
model pointed at LiteLLM; pointing it at the bridge would recurse back to the
same webhook. Do not stage `.env`, diagnostic-only edits, or the temporary
`wait_test_tool` fixture in production changes. The bridge source revision used
at deployment is the current commit checked out in `../n8n-openai-bridge-main`.
