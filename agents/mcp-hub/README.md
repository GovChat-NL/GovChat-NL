# Minimal native JEMS route

See the [Entra setup, testing and deployment guide](../../docs/jems-entra.md).

Three workflows: the existing [orchestrator](../n8n/workflows/algemeen/orchestrator-litellm.json), the [approved registry](workflows/mcp-registry-sync.workflow.json), and the [executor](workflows/mcp-executor-hub.workflow.json). No custom package, second dispatch model, database migration, HMAC, proxy, or scheduled discovery.

## Approved registry, not autonomous discovery

The registry retains its stable historical ID but returns **operator-reviewed static metadata** when called. The regular native MCP Client has no workflow discovery operation. Refresh the registry manually after an operator performs authenticated legacy-SSE discovery and reviews the returned schema and policy. Do not use a stateless HTTP POST to the SSE endpoint as discovery.

All five currently published tools are enabled: jems_languages_list, jems_auth_status, jems_calls_list, jems_project_fetch, and jems_project_search. Names, descriptions, inputSchema and annotations match the operator-confirmed staging tools/list snapshot exactly. Future upstream tools do **not** automatically appear: refresh this snapshot manually and review unsupported schema assertions before enabling them. There is no additional language-only role or operator filter.

Remote annotations currently say readOnlyHint=false and destructiveHint=true for **all five**, contradicting their read/status descriptions. Preserve these annotations as source data; warn operators/UI consumers rather than silently rewriting them or treating descriptions as identity instructions. Exposure is explicitly authorized; it is not blanket authorization for mutations. Actual project access depends on account permissions; keep server privacy redaction enabled.

## Trust and execution

The orchestrator webhook requires the shared bridge bearer through native header authentication. Keep n8n private to the bridge and trusted operators: same-owner workflow policy is not cryptographic proof of bridge origin. Do not give untrusted workflows the same owner or editor access. Registry and executor must share the orchestrator owner.

The parent bridge must verify Entra delegated tokens and forward these top-level authenticated request-body fields: user_authorization_verified (strict true), user_authorization_mode (entra_delegated), user_authorized_groups (verified UUID array), user_tid, user_oid, user_sub, and user_token_expires_at (integer epoch seconds). Identity is never read from messages, roles, nested bodies, model arguments, or caller-supplied registry data. No Entra token is mapped to tools or prompts.

The orchestrator reads the registry, checks tenant/identity/expiry/group intersection, and offers only approved metadata to its authorized agent branch. Ordinary chat follows the original agent with **no JEMS tool**; existing document/image processing and unrelated tools remain intact. The model supplies only server name, tool name, and tool arguments. All identity mappings reference the original authenticated webhook body.

The executor independently calls the same authoritative registry and repeats policy checks freshly before each call. It rejects unknown/disabled tools, malformed JSON, non-object inputs and schema-invalid arguments. A small checker handles object properties/required, strings, arrays/items, integer/int64 and enums recursively; unsupported assertions/formats and remote references fail closed. Integers must be safely and exactly representable; rounded numeric JSON literals are rejected. Additional properties with an explicit schema are validated; false rejects extras. As conservative tool-argument policy, omitted/true additionalProperties also rejects undeclared fields (stricter than default JSON Schema). No coercion, defaults or argument rewriting occur. The model must supply a serialized JSON object; its validated object goes unchanged to native MCP Client version 1.1 over the fixed staging SSE endpoint, not another model dispatcher. The native SDK manages the session and message path. The model cannot select an endpoint or authentication fields. Both native error paths and tool-level error results return controlled unavailability without raw details. Execution-data saving is disabled; maintain deployment log redaction and do not enable verbose secret/payload logging.

The published schema wins over prose: call status, fetch version/language, and **every** search field are required despite descriptions calling them optional. Empty strings/arrays are valid where their types allow them, but server acceptance is separate; do not invent dates/IDs or automatically insert fields. Search dates are plain strings in the actual schema, not date-time assertions. Discover real IDs via permitted calls/search results, never guesses. The focused test contains unit-only dummy fixtures: calls {"status":"PUBLISHED"}, fetch {"projectId":12345,"version":"","language":"EN"}, and a search fixture supplying all nine required fields, including arrays/enums/dates. These fabricated values are **not** approved remote queries.

## Bootstrap settings and review

Required settings, to be wired by the parent deployment owner (deployment configuration is unchanged here):

| Setting | Destination / purpose |
| --- | --- |
| JEMS_MCP_API_KEY, JEMS_MCP_USERNAME, JEMS_MCP_PASSWORD | Bootstrap only; all three or none. Native credential headers: X-API-Key, X-Jems-Email, X-Jems-Password. Never pass secrets to model prompts or Code runners. |
| N8N_WEBHOOK_TOKEN | Bridge and bootstrap; native Authorization header credential with Bearer prefix. |
| ENTRA_TENANT_ID | n8n and Code runners; expected verified tenant UUID. |
| MCP_HUB_JEMS_REQUIRED_GROUP_IDS | n8n and Code runners; JSON array of allowed group UUIDs. Absent/empty configuration disables JEMS capability exposure, not ordinary chat. |

The [bootstrap](../../n8n/bootstrap.js) recursively includes the hub directory from the existing agents mount. Old version-8 or MCP-version-1 seed markers get a one-time scoped import of these three stable workflow IDs. MCP marker 2 is unchanged here: an already-seeded parent must back up and manually import/publish **only** govchat-mcp-registry-sync, govchat-mcp-executor-hub and govchat-orchestrator-litellm using the supported native CLI after review. Do not use broad AGENTS_BOOTSTRAP_FORCE for this update: it imports all discovered templates. Published registry/executor exports are callable subworkflows, not scheduled jobs; publication is required by the native runtime. Existing Data Tables and rows are untouched.

Credential import uses the supported native CLI and its existing-owner personal-project default, matching workflow import. JEMS credential ID ends in 777; bridge bearer credential ID ends in 444. TOPdesk retains its existing ID ending in 222. Temporary credential files are private and deleted, and managed-import errors suppress raw details. Existing owners are never reset on login mismatch.

The initial feature reused TOPdesk's ID; this candidate gives JEMS a distinct ID instead of replacing or migrating TOPdesk. Bootstrap refuses any existing cross-type/name collision at either managed ID. Existing credentials are preserved. With all JEMS secrets absent, normal chat bootstrap has no JEMS import or active sync. The shared bridge token remains mandatory.

## Verification limits

The [focused tests](../../tests/agents/mcp-hub-minimal.test.js) execute the exported policy/filter code, verify the workflow graph and pinned native class contract, and check bootstrap planning/collision behavior. Run them and the [existing validator](../../tests/agents/validate-workflows.js) in the pinned n8n 2.25.7 image with networking disabled and only this checkout mounted read-only.

These are policy/contract checks, **not end-to-end acceptance**. Prior native legacy-SSE dummy verification is the transport basis. No real JEMS call, live credential import, deployment, or real Entra acceptance was performed for this change. Real Entra/LibreChat acceptance and any explicitly authorized staging read remain pending parent instruction.
