# Reverse-proxy and tenant-isolation hardening

This hardening targets the public LibreChat edge in `docker-compose.yml` and
`nginx/librechat-overlay.conf`. It is fail-closed for user-owned images and
image-job polling; it does not replace application-level authorization in
LibreChat, MongoDB, n8n, or the model gateway.

## What changed

- Nginx applies per-peer connection and request budgets, request/body timeouts,
  and endpoint-specific body/rate limits. These limits only become per-client
  behind an ingress after its source ranges are configured.
- Only `POST /n8n/webhook/versimpelaar` is proxied publicly. Other `/n8n/`
  requests receive 404. The n8n editor port is no longer published by Compose.
- The overlay-admin port is bound to loopback for host-side maintenance only;
  use an SSH tunnel or the Docker network instead of publishing it publicly.
- MongoDB, LiteLLM, the LibreChat Admin Panel, PgAdmin, and overlay-admin host
  ports default to loopback. If a remote MongoDB client
  is operationally required, set `MONGO_BIND_IP` deliberately and restrict that
  port at the host firewall/VPN to explicit source ranges.
- Per-user images are served only at `/images/<user-id>/<filename>`. An Nginx
  `auth_request` checks the signed LibreChat refresh cookie and requires the
  token subject to match the path's user id. Empty/missing/invalid cookies,
  mismatched owners, unsupported legacy global image paths, and auth-service
  failures are denied. `Referer` is not treated as an authorization control.
- Image-job APIs require a valid refresh token, enforce same-origin POSTs, bind
  every job to the verified user, return 404 when another user polls a job,
  cap active jobs per user, and do not use a shared browser-visible API token.
- The image workflow validates caller token using a timing-safe compare,
  validates the user-id and prompt/size/quality, checks upstream response and
  PNG/JPEG magic bytes, writes files into owner-specific directories, and uses
  an exclusive-lock rolling budget of six generations per user per hour across
  the workflow's internal entry points.
- Workflow execution without a trusted internal user identity fails closed;
  never expose `user_id` as a browser-supplied identity or model-controlled
  tool argument. Shared-chat guests do not receive access to private image
  files; public/shared image links need a separate expiring share authorization.
- `PUBLIC_BASE_URL` must be the browser-visible application origin. Refresh-token
  verification is signed with `JWT_REFRESH_SECRET` (falls back to `JWT_SECRET`).

## Required ingress configuration before production

The service may be behind an external TLS terminator. Do **not** copy arbitrary
`X-Forwarded-For` or `X-Forwarded-Proto` values from clients. Add the exact
source ranges of the trusted ingress to both files:

- `nginx/trusted-proxies.conf`: `set_real_ip_from <ingress-CIDR>;`
- `nginx/trusted-proxies.geo`: `<ingress-CIDR> 1;`

Use one line for each proxy/CDN source range. Never add `0.0.0.0/0` or `::/0`.
These files are mounted read-only into Nginx. Until ranges are configured,
Nginx intentionally ignores forwarded client addresses and uses its direct
peer address; `$scheme` is used as the upstream protocol. That default is safe
against spoofing but may make the application see HTTP behind TLS termination,
so determine the real ingress ranges before enabling the production change.
Also set the second, non-default Nginx `server_name` in
`nginx/librechat-overlay.conf` to the exact hostname(s) from `PUBLIC_BASE_URL`;
unknown Host headers are closed with status 444.

Keep the external proxy restricted to this Nginx listener. Do not also publish
`librechat:3080`, `govchat-overlay-admin:3002`, or `n8n:5678` directly. Set
`NGINX_IMAGE` to an approved, scanned immutable image reference (prefer a
version plus digest) during production deployments; the Compose fallback is a
versioned Alpine tag.

HSTS and a strict Content Security Policy are deliberately not enabled in this
container: TLS ends upstream and LibreChat/overlay compatibility needs a separate
end-to-end verification. Add HSTS only at the HTTPS ingress after all hostnames
and subdomains are confirmed HTTPS-only. Avoid enabling CSP without browser
testing OAuth, streaming, audio, uploads, and injected overlay scripts.

## Staged verification and rollout

1. Confirm the real external reverse-proxy CIDRs and HTTPS behavior; configure
   the two trusted-proxy files, then review the resulting proxy chain with the
   infrastructure owner.
2. Run `docker compose --env-file ../.env config -q` from this service directory.
   On the deployment host, run `docker compose --env-file .env run --rm --no-deps
   librechat-proxy nginx -t` (adjust the env-file path to the deployment layout).
3. Deploy to staging and check: Nginx starts with a read-only filesystem;
   LibreChat login/OAuth, file uploads, SSE/streaming, and realtime WebSocket;
   only the Versimpelaar webhook is reachable; direct n8n/admin ports are not
   externally reachable; allowed requests from trusted proxy ranges preserve
   the public scheme.
4. Verify image access using two separate accounts: owner can view their image;
   another signed-in user, a signed-out browser, a direct URL with no Referer,
   and a fabricated Referer cannot fetch it. Also test bad/expired refresh
   tokens and an unavailable overlay-admin service (must fail closed).
5. Verify image-job abuse boundaries: unauthenticated requests fail; owner can
   create/poll; user B cannot poll user A's UUID; wrong `Origin` fails; invalid
   prompt/size/quality fails; active-job cap and Nginx throttling return 429.
6. Import/deploy `agents/n8n/workflows/algemeen/image-generator-litellm.json` using the
   normal n8n bootstrap/release path. Test a successful generated PNG and JPEG,
   invalid webhook token, missing user identity, invalid/oversized provider
   payload, and disabled image generation.
7. Roll out first to a small user cohort, observe Nginx 401/403/404/429 rates,
   overlay auth failures, and storage permissions, then expand.

The request limits are initial safeguards, not a substitute for capacity tests.
Tune them from real chat/SSE/WebSocket traffic while retaining stricter budgets
for costly endpoints.

## Rollback

Use a reviewed revert commit for application changes and redeploy the previous
container/config revision. Do not restore globally readable image paths or
browser-shared tokens as a rollback shortcut. If owner-scoped images fail, keep
the image route denied, restore service availability for chat, and repair
refresh-cookie verification, proxy CIDRs, or filesystem permissions first.

The removed public n8n port, loopback-only admin/database ports, and new image
ownership checks are deliberate security boundaries; any temporary exception
must be firewall-restricted and time-bounded.
