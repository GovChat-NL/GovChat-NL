# Native manual client compile and selected regression validation

Validated on **2026-11-27 UTC**, exclusively from the handleiding worktree.

Parent follow-up: the complete manual suite was rerun with the new frontend helper tests: **61 passed, 0 failed/skipped**. Separate start/Beleidskompas regressions passed **18/18**, Python static/config/security tests completed **63 tests, 13 explicit skips, 0 failures**, and final real Chromium acceptance passed **24/24** (see [machine results](../tests/manual/evidence/browser-results.json)). The table below preserves the original native-build subtask's counts and is not an additional duplicate total.

## Result

| Validation | Actual result |
| --- | --- |
| Native marker patch, applied twice to official source | Passed; exact pinned source assertions and repeat application succeeded |
| Locked development dependency restoration | Passed; 2,982 packages added; upstream lock checksum unchanged |
| Full native frontend production compile | **Passed**; Vite 8.2.2 transformed **9,733 modules**, completed in **24.82 seconds** |
| Service worker generation | Passed; PWA 1.3.0 generated worker assets; 54 precache entries, 13,150.41 KiB |
| Compiled marker evidence | Manual slot marker present in emitted client asset |
| Offline production dependency prune | Passed; 1,177 packages removed in 15 seconds |
| Manual tests, final corrected harness | **54 tests: 54 passed, 0 failed, 0 cancelled, 0 skipped**; 59.818 seconds |
| Selected broad regressions, final corrected harness | **167 tests: 166 passed, 0 failed, 0 cancelled, 1 skipped**; 22.271 seconds |

Final successful suites total **220 passed, 1 skipped, 0 failed**. These totals exclude earlier diagnostic attempts, not additive reruns of the same tests.

No compilation fix was required. Neither the [native patch](../scripts/patch-manual-native.js) nor the [optional build recipe](../scripts/manual-native.Dockerfile) was changed.

## Isolation and inputs

- Cached official image tag: registry.librechat.ai/librechat-ai/librechat:v0.8.8.
- Every container used its exact cached digest: registry.librechat.ai/librechat-ai/librechat@sha256:5b706bcee1ca154a1e2987303aaeca0eb27f97919cccee4bb604226c2f8abf61.
- Image runtime: Node v24.16.0, npm 11.13.0. The image already contains native source and built upstream workspace packages.
- The worktree was mounted read-only. Source patching, dependency installation, compilation, test fixture writes, logger writes, and pruning took place only inside disposable container writable layers.
- The compile container had a 3 GiB memory limit and no additional swap allowance. Networking was enabled only for locked dependency installation, then its bridge attachment was disconnected before starting compilation. Its route table was empty during the subsequent offline phase.
- Test containers used networking disabled from creation, no published ports, synthetic credentials, and local loopback HTTP only. No production application or external service was started.
- Only public source directories and example/configuration fixtures were copied into the test container. No local environment file, private data, deployment container, or Docker socket was mounted. Existing temporary Express 4 dependencies were consumed read-only from [ignored tooling](../.manual-tools/package.json).
- No image build/export, deployment command, commit, change to another worktree, or inspection of private containers was performed. Containers used automatic removal; earlier diagnostic runs were terminated through their own CLI/process or explicit validation-container name. Named validation containers were confirmed removed.

Input SHA-256 fingerprints:

| Input | SHA-256 |
| --- | --- |
| [Native patch](../scripts/patch-manual-native.js) | c1c497969ca4a58419e063ae392b68e0c57d769c519d10dc08228fd66242e3d7 |
| [Build recipe](../scripts/manual-native.Dockerfile) | 652e1cb90011f5357f4c2107ea7628b3b2f0cf4967030edc85ceff15ed41a03c |
| [Active parent frontend file, not edited](../overlay/src/shared/help.js) | 2251d7577b4925737cff635a86fef95500b407c8bdc15a3e9ba401986ac32d8c |
| [Temporary source lock, not edited](../.manual-tools/LibreChat-0.8.8/package-lock.json) | af5f9a7a73a1ec056f796eea736a3e0026b5c7c53813439f093ec51b2a7cb023 |

All four checksums were rechecked successfully after validation. Before adding this report, worktree status was identical to its initial status, including existing uncommitted parent changes.

## Actual compile commands

Working directory for host commands was the handleiding worktree. The validation container was started as follows; its output was followed into the [ignored compile log](../.manual-tools/native-validation/compile.log).

```sh
docker run --rm -d --name govchat-manual-native-validation-20261127 \
  --memory 3g --memory-swap 3g --user root --network bridge \
  --mount type=bind,src=/opt/app/GovChat-NL-handleiding,dst=/repo,readonly \
  --entrypoint sh \
  registry.librechat.ai/librechat-ai/librechat@sha256:5b706bcee1ca154a1e2987303aaeca0eb27f97919cccee4bb604226c2f8abf61 \
  -c 'set -eu
    cp /repo/scripts/patch-manual-native.js /tmp/patch-manual-native.cjs
    sha256sum package-lock.json > /tmp/lock-before
    node /tmp/patch-manual-native.cjs /app
    node /tmp/patch-manual-native.cjs /app
    echo PATCH_OK
    npm ci --include=dev --no-audit --no-fund
    sha256sum -c /tmp/lock-before
    echo DEPENDENCIES_READY
    touch /tmp/deps-ready
    while [ ! -f /tmp/compile-go ]; do sleep 1; done
    echo OFFLINE_COMPILE_START
    npm run build:client
    echo FULL_CLIENT_COMPILE_OK
    sha256sum -c /tmp/lock-before
    grep -rl "data-govchat-manual-slot" client/dist/assets | head -5
    npm prune --omit=dev --no-audit --no-fund --offline
    rm /tmp/patch-manual-native.cjs
    echo RECIPE_PRUNE_OK'
docker logs -f govchat-manual-native-validation-20261127 \
  > .manual-tools/native-validation/compile.log 2>&1 &
```

After dependency readiness was confirmed, these commands released the offline compile gate:

```sh
docker exec govchat-manual-native-validation-20261127 test -f /tmp/deps-ready
docker network disconnect bridge govchat-manual-native-validation-20261127
docker exec govchat-manual-native-validation-20261127 touch /tmp/compile-go
```

The log records both success sentinels after the full build and prune, and two successful lockfile checksum checks. The emitted marker search found [the compiled event-selection asset](../.manual-tools/native-validation/compile.log:377); the build also emitted a dedicated manual-entrypoint hook chunk.

This executes the substantive steps of the optional recipe without the slow image export. The prune used offline mode deliberately to maintain dependency-only network access.

## Test harness and actual commands

The common test container command was:

```sh
docker run --rm --network none --user root \
  --mount type=bind,src=/opt/app/GovChat-NL-handleiding,dst=/source,readonly \
  --entrypoint sh \
  registry.librechat.ai/librechat-ai/librechat@sha256:5b706bcee1ca154a1e2987303aaeca0eb27f97919cccee4bb604226c2f8abf61 \
  -c 'set -eu
    mkdir /tmp/repo
    cd /source
    for p in agents branding custom-branding overlay scripts tests services nginx litellm n8n bridge cron; do
      [ ! -d "$p" ] || cp -R "$p" /tmp/repo/
    done
    cp .env.example .gitignore librechat.yaml docker-compose*.yml /tmp/repo/
    ln -s /tmp/repo /workspace
    ln -s /source/.manual-tools/node_modules /tmp/repo/node_modules
    cd /tmp/repo
    export NODE_PATH=/app/node_modules:/app/api/node_modules
    export GOVCHAT_TEST_LIBRECHAT_ROOT=/app
    export GOVCHAT_DOCKER_TESTS=0
    # Execute one of the suite commands below.
  '
```

The final manual suite command inside that container was:

```sh
node --test --test-concurrency=1 tests/manual/*.test.js
```

This ran all eight manual test files: model, routes, store, workflow, editor, editor-route, entrypoints, and entrypoints-native. Native tests used the actual image source and image React, React DOM, Markdown, and TypeScript dependencies, including pinned-source drift checks, idempotency, native footer rendering, and failed-turn wrapper behavior. Admin route/editor tests used Express 4 from the existing ignored tools instead of the image's unrelated Express 5.

The final broad suite used the same container setup, additionally named govchat-manual-broad-final-20261127, and ran:

```sh
node --test --test-force-exit --test-concurrency=1 --test-timeout=60000 \
  tests/native-chat-footer.test.js tests/minimal-ui.test.js \
  tests/branding/*.test.js tests/librechat-entra.test.cjs \
  tests/librechat-release-pin.test.js tests/librechat-runtime-compatibility.test.js \
  tests/govchat-retention-policy.test.js tests/govchat-retention-worker.test.js \
  tests/librechat-tool-event-overlay.test.js tests/n8n-processEventStream.patched.test.js \
  tests/document-context.test.js tests/image-request-compatibility.test.js \
  tests/image-tool-identity.test.js tests/image-edit-workflow.test.js \
  tests/orchestrator/name*.test.js tests/orchestrator/prompt*.test.js
```

Coverage includes native footer text, explicit empty overrides/legal links, minimal UI, branding metadata and isolated crawler responses, native Entra token forwarding and reauthentication, release/runtime contracts, retention policy/worker logic, tool events, document context, image compatibility/identity/edit logic, and orchestrator name/prompt management and authenticated HTTP routes.

## Diagnostic attempts and harness corrections

1. Initial manual attempt: **54 tests, 53 passed, 1 failed, 0 skipped**. The isolated manual routes fixture resolved the image's Express 5, whose route parser rejects the admin service's Express 4 parameter syntax. The admin dependency manifest declares Express 4. The corrected harness supplies existing temporary Express 4.21.2; the complete rerun passed **54/54**, without changing source or tests.
2. Initial broad attempt failed the Entra test-file bootstrap because its fixed public configuration path was absent. The corrected harness provided a container-local alias to the copied public repository. The final run passed both native Entra assertions with synthetic credentials.
3. Broad diagnostic runs retained open handles after all three real runtime compatibility assertions passed. Those incomplete runs were stopped and are not counted as successful complete suites. The final broad run used the native runner's force-exit option and a 60-second safety timeout. It completed with **no failures or cancellations**; force-exit is a harness accommodation, not proof that upstream runtime handles naturally close.

## Skip, warnings, and limitations

- The sole skip was **“real Tika extracts 13 from external dummy.pdf or a generated synthetic PDF”** in [document-context regressions](../tests/document-context.test.js). Live Tika/external extraction is intentionally unavailable in this network-disabled validation.
- Non-fatal build warnings: upstream deprecated dependency notices; an ambiguous Tailwind easing class; direct evaluation in an upstream browser VM dependency; and large minified chunks. These did not prevent compilation.
- The image's frontend build is a full production Vite compile, not a separate whole-repository TypeScript typecheck. No claim is made that an additional standalone typecheck or all upstream test suites passed.
- Native rendering/transpilation unit tests and actual bundled compilation passed. A real-browser acceptance run against the newly built native artifacts was **not** performed.
- No final Docker image export, deployed runtime/SSO smoke test, external bridge/n8n integration, live extraction service, or production/deployment regression run was performed. Those are outside this requested isolated scope.
- The parent frontend work was not edited; its checksum remained unchanged. The tests exercised copies of the in-progress worktree, including uncommitted manual/editor assets.

## Local evidence

Ignored raw outputs remain available in this worktree only:

- [Compile and offline prune](../.manual-tools/native-validation/compile.log)
- [Initial manual diagnostic](../.manual-tools/native-validation/manual.log)
- [Complete passing manual rerun](../.manual-tools/native-validation/manual-rerun.log)
- [Initial broad diagnostic](../.manual-tools/native-validation/broad.log)
- [Stopped corrected broad diagnostic](../.manual-tools/native-validation/broad-rerun.log)
- [Complete passing broad run](../.manual-tools/native-validation/broad-final.log)
- [Input fingerprints](../.manual-tools/native-validation/inputs.sha256)
- [Initial worktree status](../.manual-tools/native-validation/status-before.txt) and [pre-report final status](../.manual-tools/native-validation/status-after.txt)

Only this report was added by the validation task; temporary evidence is ignored. No commit was created.
