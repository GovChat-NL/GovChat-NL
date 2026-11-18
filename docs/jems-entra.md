# JEMS: Entra identity and native n8n execution

## Architecture and current scope

The existing Entra login remains the login for LibreChat. The request chain is
LibreChat → authenticated bridge → authenticated n8n orchestrator → registry and
executor → native MCP Client → JEMS staging over legacy SSE. No custom MCP
execution package, second dispatch model, extra reauthorization workflow or
registry database migration is required.

The bridge verifies the user's **Entra access token**, not a LibreChat session
token, ID token, decoded token payload, arbitrary group header or admin role.
Only verified groups and identity are forwarded. The model chooses tool names
and arguments, never identity or rights. n8n checks the approved registry,
tenant, token expiry, group membership, tool enablement and argument schema
before the native node executes.

All five currently discovered JEMS tools are enabled with the remote names,
descriptions, input schemas and annotations preserved. The registry does not
fabricate project-writing, user-management or other undiscovered functions.
Privacy redaction remains enabled at JEMS; discovery alone does not prove the
service account's project permissions or redaction of returned project data.

The [registry workflow](../agents/mcp-hub/workflows/mcp-registry-sync.workflow.json)
contains reviewed metadata; the orchestrator loads that configuration dynamically.
It is **not autonomous remote discovery**. The regular native MCP Client has no
workflow discovery operation. Review fresh authenticated discovery metadata and
update/reimport this small registry when adding or removing a tool. Do not claim
that a stateless POST to the SSE URL implements legacy SSE discovery. This is an
explicit restriction of the minimal implementation, not a passed automatic-sync
acceptance criterion.

## Tool registry, maintenance and injection

### Where tools are kept

The [registry workflow](../agents/mcp-hub/workflows/mcp-registry-sync.workflow.json)
is the authoritative configuration consumed by both orchestrator and executor.
Its Code node contains the server name, fixed SSE endpoint and complete discovered
tool objects. It adds only server-owned enablement, tenant and required-group
policy. JEMS credentials remain in the encrypted n8n credential, never in the
registry, model description or Git export.

The current snapshot contains language listing, authentication status, call
listing, project search and project fetch. An enabled registry entry is a
capability advertisement, not proof that the JEMS account may read every project.

### How an operator updates the metadata

1. Perform authenticated **legacy-SSE** discovery against the fixed staging server
   using the managed credential: open the stream, initialize the MCP session and
   collect every tool-list page until discovery is complete. A stateless POST to
   the SSE URL is not this protocol.
2. Compare names, descriptions, schemas and annotations with the current registry.
   Preserve the remote definitions; do not quietly remove required fields or
   change types to make a call pass.
3. Replace the complete tool snapshot only after discovery succeeds. Include new
   tools and remove or disable tools absent from the successful snapshot. A failed
   or partial discovery must not replace the previous registry.
4. Review the change, run the focused tests and import/publish the registry in its
   existing n8n owner project. Import affected orchestrator/executor definitions
   only when their logic changed; do not force-import unrelated user workflows.
5. Reload the n8n runtime when CLI publication changes are not hot-reloaded, then
   check the callable registry's actual output and perform a permitted read test.

There is currently **no scheduled automatic discovery or background registry
refresh**. Publishing the registry makes an internal subworkflow callable; it
does not add a timer. Upstream additions/removals require the operator procedure
above. The historical registry workflow ID does not imply that a sync job runs.

### How tools reach the model

The [orchestrator](../agents/n8n/workflows/algemeen/orchestrator-litellm.json)
calls the registry for each request. Its capability filter reads identity only
from the original service-authenticated webhook body, checks tenant, expiration
and required-group intersection, and retains enabled tool definitions for that
user. These definitions populate the generic MCP hub tool's description and
tool-name hint. They are model context, not authorization evidence or instructions
to override application policy.

Only server name, tool name and ordinary arguments are model-selected. Identity,
verified status, groups and expiration use fixed server-context mappings outside
AI-generated arguments. An unauthorized user follows the normal agent branch
without JEMS capabilities. The model cannot manufacture rights by mentioning an
admin role, email, group ID or authorization mode in a message.

### How the executor dispatches

The [executor](../agents/mcp-hub/workflows/mcp-executor-hub.workflow.json)
independently calls the same registry and rechecks the verified identity, mode,
tenant, expiry and group intersection. It rejects unknown or disabled tools and
validates arguments against the selected registered schema. Supported assertions
cover the current object/string/array/integer/enum definitions, required fields
and nested items; int64 values must be exactly representable safe integers.
Unsupported assertions/references fail closed. Undeclared arguments are rejected
conservatively unless an explicit additional-property schema permits them.

Validated arguments are passed unchanged to the regular native MCP Client 1.1,
which manages the SSE session and invokes the selected tool. There is no second
dispatch model, argument coercion or schema-default insertion. Controlled errors
do not return credentials or raw backend diagnostics. When prose says a field is
optional but the remote schema requires it, the schema is retained and that
upstream inconsistency remains visible; no guessed IDs or dates are inserted.

## Entra group checks across the chain

1. **LibreChat:** the established OpenID login supplies server-owned federated
   credentials. The native access-token header forwards the actual user API token,
   not a role header, ID token or client-provided body value.
2. **Bridge:** trusted tenant-specific Microsoft JWKS and RS256 signature validation
   establish token authenticity. Exact token version, issuer, tenant, API audience,
   delegated scope, calling application, user identity and validity are checked.
   Caller-supplied authorization/group aliases are removed before payload creation.
3. **Groups:** only group object IDs from the verified access-token group array are
   used. Roles and display names are not substituted. Missing/malformed groups or
   group-overage claims grant no JEMS groups; no implicit Graph lookup is performed.
4. **Propagation:** immutable bridge-owned context supplies verified status,
   delegated mode, groups, tenant/object/subject identity and expiration to n8n.
   The access token itself is not forwarded to model arguments or tool results.
5. **Orchestrator and executor:** both intersect verified groups with the configured
   required group IDs and check expiry. The executor repeats this before every
   call; hiding a tool description or a prompt instruction is not the access check.

LibreChat admin status alone gives no JEMS permission. Bridge and webhook shared
bearer credentials protect backend transport; they are not a user's group claim.
Restrict n8n workflow/editor access and retain same-owner caller policy. Group
claims describe membership when a token was issued, so removal is bounded by
token/authorization lifetimes rather than an instantaneous directory check.

## Security decisions and their rationale

| Decision | Threat addressed and reason |
| --- | --- |
| Verify signature using fixed tenant-specific Microsoft JWKS and RS256 | Decoding JWT JSON does not establish authenticity. An attacker must not obtain rights by putting a group ID in a fabricated payload. Token-supplied key URLs are not used. |
| Check exact tenant, issuer, API audience, scope, caller and lifetime | Prevents accepting a token from another tenant/resource/client, an expired token, a Graph token, an application-only token or an ID token as delegated GovChat API authority. Sharing the login/API registration makes the scope check particularly important because audiences may coincide. |
| Use group object IDs only from verified access-token claims | Names, role headers and LibreChat admin status can be confused with group membership or supplied by a caller. Missing or overage claims deny access rather than becoming a fallback grant. No extra broad Graph group-reading permission is silently requested. |
| Keep identity outside model-selected arguments | Prompt injection must not let the model choose a user's identity, group list or authorization mode. A prompt saying "do not call" is not an access-control mechanism; server and executor policy decide. |
| Reauthorize and validate against the registry immediately before native execution | Hiding a tool in the prompt is insufficient. Unknown/disabled tools and malformed or schema-invalid arguments must fail before execution, without coercion/default insertion or schema rewriting. |
| Separate backend bearer authentication and private n8n networking | Blocks direct unauthenticated webhook calls with fabricated verified/group fields. n8n trusts context supplied by the authenticated bridge, not an arbitrary public request. Backend tokens must be strong, distinct and restricted. |
| Use the regular native MCP Client rather than a second model dispatcher | Keeps tool selection and arguments deterministic after validation, reduces maintenance surface and uses n8n's supported credential/session mechanism. No model prompt is treated as a guarantee of unchanged dispatch. |
| Store JEMS credentials only in encrypted n8n credentials | Prevents keys/passwords becoming registry metadata, workflow exports, model inputs or Code-runner environment. Entra group permission and the JEMS service account's own permissions are separate controls. |
| Preserve all discovered metadata but treat it as untrusted data | Tool descriptions and annotations are not identity proofs or safe system instructions. Incorrect read-only/destructive hints are not silently rewritten. Availability does not authorize destructive testing; project mutations need separate approval. |
| Keep registry refresh explicit and complete | Avoids publishing a partial snapshot or claiming an unsupported native discovery operation. New or removed upstream tools need a complete operator refresh; failed discovery preserves the old configuration. This is a maintenance limitation, not automatic synchronization. |
| Disable routine execution-data/payload logging and use restricted backups | Reduces exposure of user context, credentials and project data. Diagnostics use fixed error categories, not raw tokens/claims. Database restoration is separate from application rollback to avoid deleting newer user data. |
| Pin tested source and exact local image ID on this testserver | Avoids a moving image/source reference changing unnoticed. The operator approved local builds instead of additional private-registry credentials; this does not establish a production registry-release policy. |

### Trust boundaries and limits

- Possession of a backend bearer token and n8n owner/editor access is privileged.
  Compromise of the bridge, those credentials or a trusted owner workflow is not
  mitigated merely by checking a JSON verified flag. Protect these services and
  credentials; the same-owner policy is not a user-authentication substitute.
- The shared JEMS service account limits what the adapter can do. An allowed
  Entra group does not independently grant project rights inside JEMS. Use the
  least permissions that the integration needs and keep staging/privacy redaction.
- Group claims are not a fresh directory lookup for every request. Token expiry,
  renewal and any authorization caching bound revocation latency; this design
  does not promise immediate revocation of already-issued tokens.
- Native transport behavior and the pinned n8n version remain dependencies.
  Retest on upgrades. Schema validation supports the actual current schemas;
  unsupported assertions fail closed rather than being ignored.
- Complete five-tool parity is parity with the discovered snapshot. It does not
  promise automatic discovery of future tools, unlimited output size, successful
  access to every project, or permission to execute business-data mutations.

## Entra setup

An administrator can expose the GovChat API on the existing single-tenant login
registration, or use a separate resource registration for cleaner separation.
Do not replace existing login credentials, redirect URIs, role checks or group
assignments. A registration shared with production requires its owner's approval.

1. In **App registrations → registration → Expose an API**, set an approved
   Application ID URI and create an enabled delegated scope such as
   **access_as_user**, with administrator consent. Record the full scope URI.
2. Configure the resource to issue **version-2 access tokens** using the API's
   requested access-token-version setting in the current Entra manifest.
3. Under **Token configuration → Add groups claim**, include the intended security
   group category and emit **group object IDs in access tokens**, not names or
   groups emitted as roles. ID-token groups alone are insufficient.
4. Grant the existing LibreChat client the delegated permission and obtain the
   required administrator consent. Preserve existing Graph permissions.
5. Record tenant ID, API Application (client) ID, full delegated scope URI,
   calling LibreChat client ID and exact existing JEMS group object ID.

For version-2 tokens, the expected audience is the **API Application (client) ID**,
not the scope URI. When client and API use the same registration, they share that
ID; scope and calling-client checks are still mandatory to reject ID tokens and
application-only tokens. Missing group claims or group overage deny JEMS; no
automatic Graph membership lookup or authorization bypass is implemented.

The API resource needs no new client secret merely to verify signed tokens.
Never paste access/refresh tokens, client secrets or JEMS keys into Git, chat,
logs or online token-decoding sites.

## Server configuration

Use private deployment configuration, not real values in the
[environment example](../.env.example). Preserve current settings and passwords.
The example preserves normal SSO defaults. For JEMS, explicitly request the full
approved API scope plus refresh capability and enable token reuse and user-info
OBO in private candidate configuration; do not infer activation from defaults.

| Setting | Purpose |
| --- | --- |
| OpenID requested scopes | Existing login scopes, refresh scope and full GovChat API scope |
| OpenID token reuse | Enabled for native server-owned token forwarding |
| OpenID user-info OBO | Obtain a separate Graph token when the login access token targets GovChat |
| Entra verifier enable setting | Enable only with the compatible tested bridge and actual token route |
| Expected tenant, issuer and audience | Exact approved resource configuration; tenant-specific Microsoft signing keys |
| Required scope and allowed client ID | Bare delegated scope name and trusted calling application ID |
| JEMS group allowlist | JSON array of group object IDs; empty denies JEMS without disabling login |
| Three JEMS credential values | Bootstrap only; encrypted n8n multiple-header credential |

The [LibreChat endpoint](../librechat.yaml) uses its native server-side OpenID
access-token placeholder. No static token or client-supplied credential variable
is used. The bridge verifies signature, algorithm, issuer, tenant, audience,
scope, caller and lifetime. Invalid supplied tokens are rejected; absent identity
has no JEMS groups. Normal chat and presentation metadata remain separate.

Keep Graph user-info/people tokens separate from GovChat API tokens. Required
Graph delegated consent remains an Entra administrator task. Token renewal and
ordinary login must be tested using the actual account; synthetic header tests
do not establish a functioning cloud refresh flow.

## Bootstrap and deployment

Back up databases and private persistent configuration first. Use the existing
deployment procedure and exact reviewed source/images. Do not reset owners,
overwrite passwords, remove volumes or force-import unrelated user workflows to
obtain a clean deployment.

Bootstrap imports the two small hub workflows and updates the managed
orchestrator despite old seed markers. JEMS uses a distinct credential ID from
TOPdesk; any existing incompatible ID fails before replacement. The supported
CLI's credential/workflow project ownership must match. Existing registry tables
and rows are not migrated or deleted. Registry and executor are callable
subworkflows, not periodic jobs that retry missing credentials.

Native execution uses the fixed operator-confirmed staging endpoint
**https://emr-jems-stage.rechenwerk.com/sse** and the encrypted **JEMS MCP Auth**
credential. Bridge and webhooks require distinct backend bearer authentication
and private networking. Same-owner workflow policy is not HTTP authentication;
restrict workflow/editor access accordingly.

## Essential acceptance checks

- Existing validation and the focused bridge/workflow/header tests pass.
- Fresh bootstrap, repeat and reviewed seeded upgrade preserve existing users,
  credentials and workflows. Restore-test backups separately before relying on
  recovery; never restore over newer user data automatically.
- Actual Entra login issues the correct API access token and forwards verified
  identity/groups over the real LibreChat → bridge → n8n route.
- The authorized account can use the discovered native JEMS tools according to
  JEMS-account permissions. Use a small read-only language/project test; no project
  or financial mutation is allowed without separate authorization.
- Missing/forged/expired/wrong-resource tokens, spoofed roles/groups and direct
  unauthenticated backend requests cannot grant access. Unknown tools, disabled
  tools and invalid registered-schema arguments are denied.
- Ordinary chat, token renewal and streaming/tool presentation remain working.

Do not merge merely because synthetic checks pass. The real user's browser test
is mandatory and never requires passwords or tokens pasted into a conversation.
The test-server result does not authorize production deployment.

Group claims are a token-time snapshot. Rights removed in Entra may remain in an
already-issued token until expiry; do not claim immediate directory revocation.
Expired credentials require controlled refresh or reauthentication, never an
admin fallback.

## Inspection, disablement and rollback

Inspect the three managed workflows in the restricted n8n editor and the approved
registry output. Normal execution data saving is disabled; enable only narrowly
scoped, secret-safe diagnostics when needed. A configured registry is not evidence
of successful execution or verified Entra membership.

To disable JEMS, clear its group allowlist or disable its registry entries, reload
affected runtime settings/reimport the reviewed registry, and verify denial.
Do not disable Entra verification or the existing login to solve an access issue.

Record prior source commits, image digests, Compose overrides and restricted
configuration backups before candidate testing. Application rollback restores the
previous services/configuration and retains current user data. Database restoration
is a separate reviewed decision, not an automatic rollback step.

## Verified testserver result and local image policy

The testserver operator explicitly approved use of the existing local build
procedure, with the tested source commit and exact local Docker image ID, instead
of private GHCR access. No new registry credentials or package-visibility change
is needed. The optional bridge-image setting in the environment example accepts
that exact local ID; the private server override disables pulling/rebuilding it.
A local image ID is **not** a published registry manifest digest. This exception
applies to the testserver, not to a production release policy.

The real operator's existing Entra login and native hub language call succeeded:
fallback **EN**, supported languages **DE, EN, FR, NL**, with a visible tool
execution. A repeated language call from the same session also succeeded. No
project, financial or submission mutation was performed. This does not by itself
prove refresh across an independently observed token-expiry boundary.

Two deployment issues were resolved without authorization bypasses: the private
LibreChat configuration needed runtime-readable ownership while retaining mode
0600, and the existing API registration needed version-2 access tokens rather
than its previous null/1 setting. The native registry and executor must be
published even though their only triggers are internal workflow-call triggers;
the scoped bootstrap marker upgrades this publication state without a schedule.

Keep reviewed-registry/manual-refresh and the [current five-tool schema limitations](../agents/mcp-hub/README.md)
explicit. Successful testserver use does not authorize production deployment.
