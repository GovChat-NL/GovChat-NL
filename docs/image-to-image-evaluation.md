# Secure image-to-image evaluation

This feature was developed on **feature/image-to-image-evaluation**, based on dev
8f249f6, and deployed to the development environment for authorized UI evaluation.
On 9 November 2026, the maintainer reported that the live evaluation works and
authorized opening a PR targeting dev. This is maintainer-reported acceptance,
not an automated test of every upstream provider or request variant. Merge still
requires normal PR review. Never use the old unmerged implementation as a
deployment patch.

## Offline patch API for reviewed LIVE exports

Use parsed copies of the current exported workflows, not the tracked templates
as wholesale replacements. Unwrap an export array to its workflow object first.
Keep backups private: LIVE exports may contain integrations or sensitive data.
Apply builders to clones; if a builder rejects an unknown layout, discard those
clones and review the difference rather than falling back to a full generator.

- [`applyImageEvaluationWorkflows(orchestrator, image)`](../scripts/enable-image-to-image.js:9)
  applies all four scoped builders below and returns the same two objects.
- [`applyImageTriggerInputs(image)`](../scripts/orchestrator-image-workflow.js:41)
  updates only **When Executed by Another Workflow**: trigger version 1.1,
  explicitly named prompt, size, quality, userId, operation and sourceImage inputs.
- [`applyImageEditWorkflow(image)`](../scripts/image-edit-workflow.js:80)
  requires the hardened **Prepare Image Request** guard and existing generation
  and response nodes. It adds source/operation passthrough to prepare, preserves
  its authentication and budget code, and adds a storage-directory symlink check
  to **Build Image Response** without replacing its output checks or modes.
- [`applyImageToolInputs(orchestrator)`](../scripts/orchestrator-image-workflow.js:19)
  updates only **image_generation_tool** inputs. Owner comes from the original
  authenticated **Webhook Orchestrator**; operation, source and edit prompt come
  from **Detect Image Messages**. Only prompt, size and quality remain in the AI
  schema. Generation prompt remains model-provided; edit prompt is fixed.
- [`applyOrchestratorImageEdits(orchestrator)`](../scripts/orchestrator-image-edit-workflow.js:36)
  injects contextual classification into the current **Detect Image Messages**
  code, wraps the current **AI Agent Orchestrator** text/system expressions, and
  updates the image tool description. It does not rebuild the detector or replace
  organization prompts, document nodes, other tools, credentials or connections.

All builders are idempotent on the supported current layout. Both workflows
disable success/error/manual/progress execution persistence to avoid retaining
inline image data, organization prompts or provider keys in execution history.

### Image nodes and connections added

Seven new nodes:

1. **Prepare Image Edit** (Code; source validation and n8n binary).
2. **Route Image Operation** (IF; edit versus generation).
3. **Route Image Edit Model** (Switch; four supported request variants).
4. **Call Image Edits API** (HTTP; GPT image, bearer).
5. **Call Image Edits API (azure-gpt)** (HTTP).
6. **Call Image Edits API (dalle2)** (HTTP).
7. **Call Image Edits API (azure-dalle2)** (HTTP).

**Prepare Image Request → Prepare Image Edit → Route Image Operation** replaces
the direct prepare-to-generation edge. The false branch still goes to unchanged
**Call Images API → Build Image Response**. The true branch goes through
**Route Image Edit Model** to exactly one matching multipart HTTP node; all four
edit nodes connect to existing **Build Image Response**. No orchestrator nodes or
connections are added. Its visible tool remains the only image-provider caller.

Multipart fields are statically defined per request variant. An expression-backed
fixed-collection array was rejected during real n8n smoke testing because n8n
interpreted it as characters and sent empty fields. Do not simplify these nodes
back into that invalid configuration.

## Maintainer evaluation deployment recipe (not executed)

1. Back up the current evaluation workflows and private configuration. Inspect
   current exports for custom connections before applying the scoped builders.
2. Patch cloned exports offline with the combined API above. Review the complete
   diff: retain workflow IDs, current integrations/credentials, organization
   prompt loader, document policy/limits, chronology and stream correlation.
3. Ensure tracked [`docker-compose.yml`](../docker-compose.yml) image/vision
   environment additions reach **both** n8n main and its JavaScript runners.
   Preserve every private override and existing document setting. The additive
   [`n8n/task-runners.json`](../n8n/task-runners.json) allowlist must also be
   deployed; existing fs/path/crypto/url/http/https builtins remain allowed.
4. Keep image generation off by default. Enable the visible image tool only in
   the authorized evaluation environment and admin tool policy. Configure the
   image model family, provider base/key, vision model, and public base privately.
   Azure deployment URLs need an API version supported by the actual deployment;
   the backwards-compatible default 2024-02-01 is **not** a claim of GPT image edit
   support. See public defaults in [`.env.example`](../.env.example).
5. The maintainer may then recreate evaluation services with private overrides
   preserved and import the reviewed patches using the established deployment
   process. Do not run the full source update generator against a LIVE database.
6. Perform actual UI evaluation: upload/edit, repeated edits of generated results,
   normal image analysis, new-image requests with image history, text-to-image,
   documents plus images, visible tool/stream events, disabled tool behavior and
   another user's image denial. Verify actual provider compatibility separately.
7. Retain the separate branch and evaluation deployment until user acceptance.
   No PR, merge or production rollout before that acceptance.

The CLI in [`enable-image-to-image.js`](../scripts/enable-image-to-image.js) writes
**only tracked source templates**. Full source generators now also reapply the
scoped edit builders; orchestrator generation restores the runtime prompt loader
after detector regeneration. They are not LIVE migration entry points.

## Security and behavior

- Classification is language-model/context based, not a language-specific keyword
  list. It uses bounded recent text context, never inline image bytes. No available
  source means no classification call. Edit uses the visible tool; generate skips
  forced vision; analyze preserves normal multimodal answering. Invalid responses,
  missing authentication or classifier errors block the action. Existing document
  failures block classification and vision too.
- Source is the latest user attachment or subsequent assistant generated-image
  markdown in chronological normalized messages. User text URL hints and tool
  arguments cannot select a source. Follow-up editing uses the latest result.
  Explicit selection of an older image among multiple candidates is not supported.
- Input accepts canonical inline PNG/JPEG/WebP, at most 10 MiB decoded, with magic
  bytes matching its declared MIME; or an exact generated filename under the
  authenticated owner's image path. Absolute URLs must match the configured
  public base and the same owner path, and resolve **locally without fetching**.
  External/private URL hints, other owners, encoded paths, traversal, queries,
  symlink files/directories and oversized files are denied. Local reads are bounded
  and use no-follow file opens. Storage directories remain service-controlled;
  these checks are not a sandbox against a hostile process owning the filesystem.
- The existing timing-safe webhook guard, trusted tool identity, exclusive rolling
  per-user budget, response base64/magic/size checks, and 0700/0600 owner output
  permissions remain. Failed requests still consume the existing reserved budget.
- GPT image and DALL-E 2 edit families are explicit; DALL-E 3 and arbitrary model
  aliases are rejected for edits. DALL-E 2 requires PNG; upstream dimension and
  transparency constraints still apply. No mask editing is implemented. GPT image
  omits response_format; DALL-E 2 omits quality; Azure omits model and uses api-key
  and the configured api-version. Non-Azure uses bearer authentication.

## Local validation

All Node execution used the installed pinned n8n 2.25.7 image ID
**sha256:761374d4eb841b0a22771d6bd68f0e8d827b4979ae4e490045517b13fc1259dd**, with
network disabled, sanitized public snapshots, and no deployment DB or credentials.

- [`image-edit-workflow.test.js`](../tests/image-edit-workflow.test.js): 32 tests
  pass, including source rejection, actual guards, intent routing and idempotence.
- Image identity/compatibility, documents and prompt management after running
  each full source generator twice: 71 pass, 1 real-Tika test skipped. Both
  generators produce identical output on repeated runs and preserve runtime
  prompts/document failures; no source generator touched a LIVE database.
- Final broader supported source subset: 107 pass, 1 real-Tika test skipped.
- Pinned n8n image/utility integration: 8 pass, including actual schema exclusion
  and fixed edit source/prompt/operation despite forged model arguments.
- [`run-image-edit-smoke.js`](../tests/orchestrator/run-image-edit-smoke.js): six
  real n8n Code/IF/Switch/HTTP executions pass: GPT bearer/Azure edit, DALL-E 2
  bearer/Azure edit, GPT JSON generation, and absolute public owner-file follow-up.
  Verifies actual multipart source bytes, omitted unsupported fields, headers,
  endpoint routing, exactly one API call and owner output permissions.
- [`run-document-smoke.js`](../tests/orchestrator/run-document-smoke.js): real
  n8n document Code → agent → answer 13 passes with Tika/model stubs.
- Python public regressions: 53 run, 43 pass, 10 opt-in integration tests skipped,
  including existing image delivery/jobs/workflow security tests.

Tests are integrated into [`run_regressions.py`](../scripts/run_regressions.py),
including pre-commit source allowlisting and an empty tmpfs image-smoke mount.
The full LibreChat/admin/proxy suite was **not** validated: attempts to run its
runtime-dependent tests in the n8n image fail on missing LibreChat files/admin
dependencies. No actual provider call, live external runner recreation, visible
UI acceptance or real upstream image-to-image test was performed.
