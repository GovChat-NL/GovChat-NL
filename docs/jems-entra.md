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

For this test, only the operator-confirmed read-only language-list capability is
enabled. It takes no parameters. Other discovered tools remain unavailable until
reviewed. Privacy redaction remains enabled at JEMS; discovery alone does not
prove project permissions or redaction of returned project data.

The [registry workflow](../agents/mcp-hub/workflows/mcp-registry-sync.workflow.json)
contains reviewed metadata; the orchestrator loads that configuration dynamically.
It is **not autonomous remote discovery**. The regular native MCP Client has no
workflow discovery operation. Review fresh authenticated discovery metadata and
update/reimport this small registry when adding or removing a tool. Do not claim
that a stateless POST to the SSE URL implements legacy SSE discovery. This is an
explicit restriction of the minimal implementation, not a passed automatic-sync
acceptance criterion.

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
- The authorized account gets supported language codes from the native JEMS
  language-list operation; no project or financial mutation is allowed.
- Missing/forged/expired/wrong-resource tokens, spoofed roles/groups and direct
  unauthenticated backend requests cannot grant access. Unknown tools, disabled
  tools and nonempty language-list arguments are denied.
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

To disable JEMS, clear its group allowlist or disable the approved tool, reload
affected runtime settings/reimport the reviewed registry, and verify denial.
Do not disable Entra verification or the existing login to solve an access issue.

Record prior source commits, image digests, Compose overrides and restricted
configuration backups before candidate testing. Application rollback restores the
previous services/configuration and retains current user data. Database restoration
is a separate reviewed decision, not an automatic rollback step.
