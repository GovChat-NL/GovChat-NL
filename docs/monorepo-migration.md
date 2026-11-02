# GovChat-NL monorepo migration

## Migration plan and ownership map

| Source | Destination | Ownership / rationale |
|---|---|---|
| Current local stack checkout root (`GovChat-NL-LibreChat/`) | Canonical `GovChat-NL` monorepo root | Kept in place: Compose entrypoints, LibreChat config, Nginx, stack overlay, LiteLLM, n8n runtime settings, tests, fixtures, scripts and deployment docs retain root-relative paths. |
| `GovChat-NL-Agents` repository | [`agents/`](../agents/) | Workflow exports and agent documentation. Bootstrap reads `agents/n8n/workflows` from the monorepo. |
| `GovChat-AdminOverlay` repository | [`services/admin-overlay/`](../services/admin-overlay/) | Keeps standalone source and provenance. Compose builds `services/admin-overlay/admin` only when the `admin-overlay` profile is enabled; it is WIP and off by default. |
| Stack-owned bridge model configuration | [`bridge/models.json`](../bridge/models.json) | Deployment config only, not bridge service source. |
| `n8n-openai-bridge` repository | External repository | Separate GovChat-NL-maintained service with its own releases and tests. Standard Compose builds its `main` branch directly. |

### Admin Overlay ownership audit

The optional `govchat-overlay-admin` Compose service builds `services/admin-overlay/admin` only under profile `admin-overlay`; it is WIP and disabled by default. When enabled, it mounts the monorepo's `overlay/defaults/` at `/app/defaults`. Its admin server/views and API endpoints (including image jobs, crawler, transcript sessions and policy editor features) are distinct from the always-on LibreChat overlay assets served by Nginx. Nginx resolves this optional API upstream at request time, so the proxy itself can start while the profile is disabled.

The imported Admin Overlay project also contains standalone Open WebUI deployment artifacts: root-level `loader.js`, `custom.css`, `apps.json`, `help-content.json`, Open WebUI Compose examples, and `admin/defaults/`. Those files are preserved for provenance/standalone use, but are **not** the active LibreChat defaults: Compose bind-mounts the stack's `overlay/defaults` over `/app/defaults`. Similar names do not make these assets interchangeable.

## Paths and architecture decisions

- Root Compose files remain at repository root to avoid changing deployment entrypoints and the existing `/opt/librechat` host mounts.
- [`n8n/bootstrap.js`](../n8n/bootstrap.js) is mounted into the n8n image and run as the one-shot bootstrap. It scans sorted top-level `*.json` exports from `./agents/n8n/workflows` and derives workflow IDs from each export; a per-file environment list and external workflow source are not needed.
- Admin build context is `./services/admin-overlay/admin`; LibreChat runtime defaults stay at `./overlay/defaults`.
- Bridge config moved from a directory whose name resembled the external bridge checkout to `bridge/models.json`.
- Clone the bridge repository beside this checkout on `main`, then start the standard stack:

  ```sh
  git clone --depth 1 --branch main https://github.com/GovChat-NL/n8n-openai-bridge.git ../n8n-openai-bridge-main
  docker compose --env-file .env up -d
  ```

  The standard [`docker-compose.yml`](../docker-compose.yml) builds from that local sibling clone if the image is not present locally; no extra Compose override is needed. Rebuild after bridge source changes with `docker compose --env-file .env build n8n-openai-bridge`.
- The request flow remains LibreChat → bridge → n8n webhook; n8n calls LiteLLM directly; the stream and tool-lifecycle events return through the bridge to LibreChat's native tool cards.

## Bridge source and compatibility record

The standard Compose configuration builds from `../n8n-openai-bridge-main` and tags the resulting local image `govchat-nl/n8n-openai-bridge:main`. Clone that checkout from GovChat-NL's `main` branch; it includes the bridge sideband events used for native tool cards. The older upstream integration digest is historical only and is no longer used by Compose.

The GovChat-NL bridge `main` branch contains the promotion of the live tool-calling protocol. Compose now builds that maintained source branch rather than consuming the legacy upstream `pr-72` artifact; the exact source revision follows the local clone's checked-out commit rather than a pinned digest.

Reference configuration baseline from the LibreChat checkout: LibreChat image `v0.8.7`; n8n default `2.25.7`; GovChat-NL bridge main source; LibreChat stack/overlay source commit `a4b9e67`. This is a configuration record, **not evidence of completed end-to-end or production acceptance testing**. Native tool cards require a compatible bridge, streaming n8n workflow, and LibreChat runtime overlay tested together.

## Git provenance, source of truth and migration safety

| Repository | Remote / default branch | HEAD at audit | Worktree |
|---|---|---|---|
| GovChat-NL default stack | `https://github.com/GovChat-NL/GovChat-NL.git` (after repository rename); local checkout currently named `GovChat-NL-LibreChat`, branch `feature/monorepo-migration` | `a4b9e67` | Canonical LibreChat stack; update local `origin` after the GitHub-side rename. |
| Agents | `https://github.com/GovChat-NL/GovChat-NL-Agents.git`; default `main` | `58319d0` | Clean. The workspace description said this was not a Git checkout, but audit found a valid Git repository and the full workflow tree. |

## GitHub repository rename cutover

Repository slugs are GitHub-side settings and are not changed by editing this checkout. Perform the cutover in this order:

1. Rename the existing OpenWebUI repository `GovChat-NL/GovChat-NL` to `GovChat-NL/GovChat-NL-legacy`.
2. Rename the LibreChat stack repository `GovChat-NL/GovChat-NL-LibreChat` to `GovChat-NL/GovChat-NL`.
3. Confirm the new canonical repository default branch, branch protections, Actions secrets/variables, releases, and deployment settings.
4. In each canonical stack checkout, update the local remote after the GitHub rename: `git remote set-url origin https://github.com/GovChat-NL/GovChat-NL.git`.
5. Open the renamed legacy repository and confirm its README directs new users to the canonical LibreChat stack.

The old repository slug is intentionally reused by the new canonical repository. Do not rely on GitHub's automatic rename redirect to preserve an OpenWebUI landing page at that URL; the legacy repository's new `GovChat-NL-legacy` README is its explicit user-facing redirect.
| Admin Overlay | `https://github.com/GovChat-NL/GovChat-AdminOverlay.git`; default `main` | `8d36b5e` | Clean. |
| Bridge | `https://github.com/GovChat-NL/n8n-openai-bridge.git`; default `main` | `8003d03` | Clean; remains separate. |

Agents and Admin Overlay were imported with non-squashed Git subtree imports at `agents/` and `services/admin-overlay/`; their source commit histories remain reachable. Local recovery checkpoint: `backup/pre-monorepo-migration-20261022` at `a4b9e67`. From migration review/merge onward, this monorepo is the source of truth for deployment, workflows and the integrated Admin service. No push, remote repository creation, source-repository archival or deletion was performed.

The task described two uncommitted edits in the LibreChat Compose and Nginx files. `git status`, `git diff` and `git diff --cached` showed the checkout clean at audit time, so those edits were not present to preserve. The checkpoint retains the audited original HEAD. Reconcile against any other checkout before synchronizing it.

The live tool-calling producer is maintained in the bridge repository and its `main` branch; the corresponding LibreChat and n8n runtime overlays are enabled by the standard Compose stack.

Only `.env.example` and tracked configuration belong in source control. Keep real `.env` files, credentials, database volumes, uploads/user data, runtime logs and build products local. The stack root ignore rules cover `.env` and `.env.*`; recheck staged files and secrets before any future commit.

## Verification checklist

From a clean monorepo clone:

```sh
docker compose --env-file .env.example config --quiet
node tests/agents/validate-workflows.js
node --check n8n/bootstrap.js
node --check services/admin-overlay/admin/server.js
```

The existing orchestrator and transcript validation scripts require a running stack and provider credentials. After startup, run `node tests/orchestrator/run-validation.js` (or `--only-text`) and `node tests/transcript/run-validation.js`. The imported Admin project defines no standalone test script; syntax/build and service-route checks are required. A real deployment also requires environment-specific host paths under `/opt/librechat` and secrets copied into the ignored `.env` from `.env.example`.

### Results from this migration session

| Check | Result |
|---|---|
| Standard Compose and local bridge override using `.env.example` | Passed (`docker compose ... config --quiet`, without unresolved-variable warnings). |
| Local workflow import tree | Passed: 11 configured exports present, valid JSON/workflow structure, 11 unique stable IDs. |
| Admin Overlay and changed JavaScript syntax | Passed with Node 20 in a disposable container. |
| Admin Overlay Docker build | Passed; `govchat-overlay-admin:local` image was created. |
| Compose bind/build paths | Required component paths checked. Removed the stale `./n8n/bootstrap` mount; the maintained one-shot bootstrap now lives in `n8n/bootstrap.js` and is bind-mounted explicitly. |
| Secret scan/status | No common key/private-key patterns found in tracked content; `.env`/`.env.local` are ignored and no local `.env` or staged source changes were present. This pattern check is not a substitute for an organizational secret scanner. |
| Subtree history | Passed: both source HEADs are ancestors of the monorepo branch; checkpoint branch retained. |
| Bridge protocol unit tests | Blocked: npm registry certificate validation failed in the disposable Node container (`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`), so Jest dependencies were unavailable. No bridge source checkout was altered. |
| Live orchestrator, transcript and native tool-card E2E | Not run: no configured provider credentials/live test deployment. The checkout also contains no `LCSTEP` runtime parser or dedicated live-card test; this compatibility gap remains documented. |

Do not force-push, create a remote repository, archive or delete old source repositories without explicit review and approval.
