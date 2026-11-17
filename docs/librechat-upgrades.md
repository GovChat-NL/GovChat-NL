# Repeatable LibreChat upgrades (maintainer-controlled)

The current pin remains **v0.8.8**. Follow upstream releases promptly, but change
the pin in a reviewed maintainer commit, never by automatic deployment or merge.
Both the app and retention worker must use the same exact official registry image
in [`docker-compose.yml`](../docker-compose.yml:13). Exact `vX.Y.Z` tag shape is a
pinning constraint, **not** proof that GitHub considers a release stable.

## Release discovery and verification

Run from the repository root with Python 3.10+ (standard library only):

```sh
python3 scripts/librechat_release.py
```

[`librechat_release.py`](../scripts/librechat_release.py) queries only the official
LibreChat-AI/LibreChat GitHub releases API. Default discovery reads all pages and
chooses the numerically highest exact `vX.Y.Z` release whose **draft and prerelease
flags are both false**. It rejects floating, rc, dev, metadata, leading-zero and
unprefixed tags. It does not use GitHub's ambiguous latest endpoint or registry
tag ordering. Failed requests, incomplete pagination, malformed flags, no stable
release, mismatched explicit release tags and missing manifests fail closed.

The selected manifest is fetched from registry.librechat.ai/librechat-ai/librechat,
validated as an OCI/Docker schema-v2 manifest or index, checked for a linux/amd64
entry when an index is returned, and verified against the registry's SHA-256
content digest. The new official registry currently delegates anonymous pull
authentication to **ghcr.io/token**: only that exact HTTPS token endpoint and the
LibreChat pull scope are accepted. Images are never resolved at the old registry.
No credentials, environment proxy, secret environment file, redirect or real
integration is used. An unknown future auth realm fails closed pending review.

**GitHub marks v0.8.8 as prerelease=true**, despite the exact semver-shaped tag.
Default discovery must not silently select it. To verify the currently authorized
pin, the maintainer must explicitly opt in:

```sh
python3 scripts/librechat_release.py --check-current --allow-prerelease
python3 scripts/librechat_release.py --version v0.8.8 --allow-prerelease
```

Checks emit JSON containing current/candidate tags, the GitHub prerelease flag,
whether the candidate is newer, the official image and manifest digest. A stable
candidate older than the current authorized prerelease is reported as not newer;
it is **not** a downgrade recommendation. Manifest verification is not proof of
the image's package version: the regression image preflight and runtime contract
test check that separately against the exact Compose tag.

At implementation validation, discovery found no release meeting all default
stable criteria and exited nonzero; the explicit authorized v0.8.8 check passed.
This is deliberate fail-closed behavior, not a reason to weaken the GitHub flag
policy. The scheduled check will fail visibly until a qualifying release exists.

## Preparing a future pin

After reviewing upstream release notes, either hand-edit **both** literal image
pins or explicitly invoke preparation. These commands do not commit or deploy:

```sh
# Discover and verify a newer actual stable release, then update the two pins.
python3 scripts/librechat_release.py --prepare

# Example ONLY: first replace the example tag with a reviewed published release.
python3 scripts/librechat_release.py --version v0.9.0 --prepare

# Only when deliberately accepting a GitHub-marked prerelease:
python3 scripts/librechat_release.py --version v0.9.0 --allow-prerelease --prepare
git diff -- docker-compose.yml
```

Preparation refuses a no-op or downgrade, verifies the release and manifest
**before writing**, checks for intervening Compose edits, and atomically replaces
only the two image lines while preserving permissions. The script never creates
a branch, commit, PR, merge or deployment. The examples are not claims that those
future releases exist. Manually edited pins need the same verification and gates.

## Regression runner

[`run_regressions.py`](../scripts/run_regressions.py) requires Git, Python 3.10+,
Docker Engine and the Docker Compose v2 CLI; full tests obtain Node dependencies
from their pinned test images. Run the full suite only on a disposable CI runner
or a host explicitly authorized for isolated regression containers:

```sh
python3 scripts/run_regressions.py
```

It copies tracked public working-tree source into a temporary snapshot, plus this
change set's explicitly named tooling/tests before the maintainer's first commit.
It excludes secrets, private/data/publish directories, ignored files, arbitrary
untracked files, local overrides and symlinks. The tracked public branding override
is taken from HEAD rather than a possible local override. It creates a temporary
empty Git repository only for publication-safety tests, with no commits or staging.
The original checkout is never mounted into a container. Future new test files
must be tracked before running (or deliberately added to the bootstrap allowlist).

The full runner:

1. Pulls the exact Compose LibreChat image, the pinned n8n default (currently
   2.25.7) and the pinned nginx proxy-test image. Builds a uniquely tagged admin
   test image from [`admin/Dockerfile`](../services/admin-overlay/admin/Dockerfile).
2. Runs public top-level, branding and agents tests using Node's test runner in
   the official image with CI=true, NODE_PATH=/app/node_modules, no network and
   read-only public source. A preflight requires the exact image package version
   and native footer source, preventing silent upstream-contract skips.
3. Runs both translation runners in disposable official-image filesystems; loader
   writes are confined to the container, not the source snapshot or deployed app.
4. Runs name, prompt and utility tests in the admin image without external network.
5. Runs the n8n utility integration test in the Compose-pinned n8n image with the
   **three exact patched-module mount destinations** and the policy helper at
   /opt/govchat, all read-only and derived from public Compose, with no network.
6. Runs Python unittest discovery with GOVCHAT_DOCKER_TESTS=1. Compose rendering
   explicitly uses the public example environment. Proxy tests create uniquely
   named containers on an internal test network, with synthetic upstreams and no
   published ports; their cleanup touches only those test resources.

All child commands receive an allowlisted environment, not inherited integration
settings, tokens or Docker/Compose overrides. Docker run/build/pull use an empty
temporary Docker client configuration rather than local registry credentials or
contexts, and the default local Docker Engine. No deployment Compose start/stop,
existing container access, database connection or live browser smoke test occurs.
The uniquely tagged admin image and temporary source are removed on completion.
Official pulled images remain cached. Interrupted proxy integration may leave its
uniquely prefixed test resources; cleanup must never target existing deployments.
Do not run the full command while another maintainer prohibits container activity.

For fast tooling/fixture checks without container run/build/pull (requires local
Node 20+ but no npm packages):

```sh
python3 scripts/run_regressions.py --offline
```

Offline mode runs pin-parser tests, translation fixtures and all Python unit tests.
Docker Compose configuration rendering may still run if the CLI is installed;
the opt-in proxy integration is disabled. This is **not** the full acceptance
suite. Individual focused tests, with all network mocked:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'test_librechat_release.py' -v
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'test_regression_runner.py' -v
node --test tests/librechat-release-pin.test.js
node tests/translations/run-tests.js
```

## CI and future acceptance gates

[`librechat-regression.yml`](../.github/workflows/librechat-regression.yml) runs the
full isolated suite on push, normal pull requests and manual dispatch on GitHub-
hosted runners. [`librechat-release-check.yml`](../.github/workflows/librechat-release-check.yml)
checks availability daily and on manual dispatch, and only logs a report/job
summary. It never prepares changes or opens PRs. Both have read-only repository
permissions and credential-free checkout; neither uses elevated PR events,
repository secrets, real integrations or deployment environments. The schedule
runs from the default branch once the maintainer merges it; no bot installation
or unknown application permissions are required. Endpoint/rate-limit failures
produce a failed check rather than assuming that no upgrade exists.

Before accepting a future upgrade:

- Review upstream release notes, migration/security changes and GitHub flags.
  Record explicit authorization if accepting a GitHub prerelease.
- Verify an exact official release and manifest; inspect the two-pin-only diff.
- Pass the **full** regression workflow, including real runtime interfaces,
  retention deletion paths, native footer, translation loader, admin routes,
  n8n overlay paths/tool policy and isolated proxy tests. Do not relax interface,
  footer or loader assertions merely to accept an upstream incompatibility.
- Runtime and deployment expected versions derive from Compose; do not hand-edit
  an expected-version constant. Registry changes or upstream API/path changes
  require reviewed tooling/overlay updates and new regression coverage.
- Separately complete a user-authorized rollout acceptance check with backups and
  rollback planning. Secret-free CI cannot prove live SSO, real integrations,
  migration behavior or production retention outcomes. Never supply production
  data to the regression runner.
- Only the maintainer commits, reviews/merges and authorizes deployment. A green
  availability report or regression job is not deployment authorization.
