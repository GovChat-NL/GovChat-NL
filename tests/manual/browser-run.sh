#!/bin/sh
# Linux x86_64, worktree-local runtime, packages, browser and disposable store.
set -eu
cd "$(dirname "$0")/../.."
TOOLS="$PWD/.manual-tools"
NODE_VERSION=22.16.0
NODE_DIR="$TOOLS/node-v$NODE_VERSION-linux-x64"
mkdir -p "$TOOLS"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" -o "$TOOLS/node.tar.xz"
  tar -xJf "$TOOLS/node.tar.xz" -C "$TOOLS"
fi
PATH="$NODE_DIR/bin:$PATH"
NODE_PATH="$TOOLS/node_modules"
PLAYWRIGHT_BROWSERS_PATH="$TOOLS/browsers"
# Playwright 1.58.2 does not identify Ubuntu 26.04. Use its 24.04 build.
PLAYWRIGHT_HOST_PLATFORM_OVERRIDE="${PLAYWRIGHT_HOST_PLATFORM_OVERRIDE:-ubuntu24.04-x64}"
export PATH NODE_PATH PLAYWRIGHT_BROWSERS_PATH PLAYWRIGHT_HOST_PLATFORM_OVERRIDE
if [ ! -f "$TOOLS/node_modules/playwright/package.json" ]; then
  npm install --prefix "$TOOLS" --no-audit --no-fund playwright@1.58.2 express@4.21.2 cookie-parser@1.4.7 htmlparser2@10.0.0
fi
"$TOOLS/node_modules/.bin/playwright" install chromium
node tests/manual/browser-acceptance.cjs
