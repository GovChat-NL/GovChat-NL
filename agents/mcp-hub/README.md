# Minimal native JEMS route

See the [Entra setup, testing and deployment guide](../../docs/jems-entra.md).

Three workflows: the existing [orchestrator](../n8n/workflows/algemeen/orchestrator-litellm.json), the [approved registry](workflows/mcp-registry-sync.workflow.json), and the [executor](workflows/mcp-executor-hub.workflow.json). No custom package, second dispatch model, database migration, HMAC, proxy, or scheduled discovery.

## Approved registry, not autonomous discovery

The registry retains its stable historical ID but returns **operator-reviewed static metadata** when called. The regular native MCP Client has no workflow discovery operation. Refresh the registry manually after an operator performs authenticated legacy-SSE discovery and reviews the returned schema and policy. Do not use a stateless HTTP POST to the SSE endpoint as discovery.

Only the language-list capability is enabled. Its description and empty object schema match the previously discovered metadata. The operator confirmed that it returns language codes without business mutation, despite inaccurate remote default annotations. The other four discovered tools remain unavailable. Future tools or parameterized schemas require explicit operator review and implementation; this executor intentionally supports only the reviewed no-argument schema.

## Trust and execution

The orchestrator webhook requires the shared bridge bearer through native header authentication. Keep n8n private to the bridge and trusted operators: same-owner workflow policy is not cryptographic proof of bridge origin. Do not give untrusted workflows the same owner or editor access. Registry and executor must share the orchestrator owner.

The parent bridge must verify Entra delegated tokens and forward these top-level authenticated request-body fields: user_authorization_verified (strict true), user_authorization_mode (entra_delegated), user_authorized_groups (verified UUID array), user_tid, user_oid, user_sub, and user_token_expires_at (integer epoch seconds). Identity is never read from messages, roles, nested bodies, model arguments, or caller-supplied registry data. No Entra token is mapped to tools or prompts.

The orchestrator reads the registry, checks tenant/identity/expiry/group intersection, and offers only approved metadata to its authorized agent branch. Ordinary chat follows the original agent with **no JEMS tool**; existing document/image processing and unrelated tools remain intact. The model supplies only server name, tool name, and tool arguments. All identity mappings reference the original authenticated webhook body.

The executor independently calls the same authoritative registry and repeats policy checks. It rejects unknown/disabled tools, malformed JSON, non-object inputs, arrays, and non-empty objects. The exact accepted empty object goes directly to native MCP Client version 1.1 over the fixed staging SSE endpoint; the native SDK manages the session and message path. The model cannot select an endpoint. Both native error paths return a controlled unavailability response without forwarding raw error details. Execution-data saving is disabled; maintain deployment log redaction and do not enable verbose secret/payload logging.

## Bootstrap settings and review

Required settings, to be wired by the parent deployment owner (deployment configuration is unchanged here):

| Setting | Destination / purpose |
| --- | --- |
| JEMS_MCP_API_KEY, JEMS_MCP_USERNAME, JEMS_MCP_PASSWORD | Bootstrap only; all three or none. Native credential headers: X-API-Key, X-Jems-Email, X-Jems-Password. Never pass secrets to model prompts or Code runners. |
| N8N_WEBHOOK_TOKEN | Bridge and bootstrap; native Authorization header credential with Bearer prefix. |
| ENTRA_TENANT_ID | n8n and Code runners; expected verified tenant UUID. |
| MCP_HUB_JEMS_REQUIRED_GROUP_IDS | n8n and Code runners; JSON array of allowed group UUIDs. Absent/empty configuration disables JEMS capability exposure, not ordinary chat. |

The [bootstrap](../../n8n/bootstrap.js) recursively includes the hub directory from the existing agents mount. Old version-8 seed markers get a one-time scoped import of these three stable workflow IDs. Later manual registry/workflow changes use the existing reviewed force-import mechanism (AGENTS_BOOTSTRAP_FORCE=true); **back up first**, since force imports all discovered templates. Inactive registry/executor exports are callable subworkflows, not scheduled jobs. Existing Data Tables and rows are untouched.

Credential import uses the supported native CLI and its existing-owner personal-project default, matching workflow import. JEMS credential ID ends in 777; bridge bearer credential ID ends in 444. TOPdesk retains its existing ID ending in 222. Temporary credential files are private and deleted, and managed-import errors suppress raw details. Existing owners are never reset on login mismatch.

The initial feature reused TOPdesk's ID; this candidate gives JEMS a distinct ID instead of replacing or migrating TOPdesk. Bootstrap refuses any existing cross-type/name collision at either managed ID. Existing credentials are preserved. With all JEMS secrets absent, normal chat bootstrap has no JEMS import or active sync. The shared bridge token remains mandatory.

## Verification limits

The [focused tests](../../tests/agents/mcp-hub-minimal.test.js) execute the exported policy/filter code, verify the workflow graph and pinned native class contract, and check bootstrap planning/collision behavior. Run them and the [existing validator](../../tests/agents/validate-workflows.js) in the pinned n8n 2.25.7 image with networking disabled and only this checkout mounted read-only.

These are policy/contract checks, **not end-to-end acceptance**. Prior native legacy-SSE dummy verification is the transport basis. No real JEMS call, live credential import, deployment, or real Entra acceptance was performed for this change. Real Entra/LibreChat acceptance and any explicitly authorized staging read remain pending parent instruction.
