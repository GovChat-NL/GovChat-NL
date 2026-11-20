#!/bin/sh
# Offline tests only. No Compose up, image pull/build, npm install or deployment.
set -eu
cd "$(dirname "$0")/.."
root=$(pwd)
bridge_image=${GOVCHAT_TOPDESK_TEST_BRIDGE_IMAGE:-861226adf184}
n8n_image=${GOVCHAT_TOPDESK_TEST_N8N_IMAGE:-761374d4eb84}
librechat_image=${GOVCHAT_TOPDESK_TEST_LIBRECHAT_IMAGE:-5b706bcee1ca}
dist=/usr/local/lib/node_modules/n8n/node_modules/.pnpm/@n8n+n8n-nodes-langchain@file+packages+@n8n+nodes-langchain_8bf81e0cdf1fe65cc684d3daaa3ca5c1/node_modules/@n8n/n8n-nodes-langchain/dist

docker run --rm --pull never --network none --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$root:/workspace:ro" -w /workspace --entrypoint node "$bridge_image" --test \
  tests/topdesk-company-graph.test.cjs tests/topdesk-bridge-runtime.test.cjs \
  tests/agents/topdesk-orchestrator.test.js tests/agents/pr13-bootstrap-integration.test.js \
  tests/n8n-bridge-tool-events.test.js

docker run --rm --pull never --network none --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$root:/workspace:ro" -v "$root/scripts:/opt/govchat:ro" \
  -v "$root/scripts/n8n-createAgentSequence.patched.js:$dist/nodes/agents/Agent/agents/ToolsAgent/V3/helpers/createAgentSequence.js:ro" \
  -v "$root/scripts/n8n-toolCalculator.patched.js:$dist/nodes/tools/ToolCalculator/ToolCalculator.node.js:ro" \
  -w /workspace --entrypoint node "$n8n_image" --test \
  tests/topdesk-n8n-runtime.test.cjs tests/orchestrator/n8n-utility-integration.test.js \
  tests/agents/mcp-hub-minimal.test.js

docker run --rm --pull never --network none --cap-drop ALL --security-opt no-new-privileges:true \
  -e NODE_PATH=/app/node_modules -v "$root:/workspace:ro" -w /app/api \
  --entrypoint node "$librechat_image" --test --test-force-exit --test-timeout=60000 \
  /workspace/tests/librechat-entra.test.cjs /workspace/tests/native-chat-footer.test.js \
  /workspace/tests/librechat-runtime-compatibility.test.js

docker run --rm --pull never --network none --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$root:/workspace:ro" -w /workspace --entrypoint node "$bridge_image" tests/agents/validate-workflows.js
