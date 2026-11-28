# Optional marker-only client rebuild over the existing pinned official image.
# Backend, package lock, native disclaimer and legal-link configuration remain upstream.
FROM registry.librechat.ai/librechat-ai/librechat:v0.8.8 AS manual-native
USER root
WORKDIR /app
COPY scripts/patch-manual-native.js /tmp/patch-manual-native.cjs
RUN node /tmp/patch-manual-native.cjs /app
# The release prunes dev tools; restore from its own lockfile, not new dependencies.
RUN npm ci --include=dev --no-audit --no-fund
RUN npm run build:client && npm prune --omit=dev && rm /tmp/patch-manual-native.cjs
