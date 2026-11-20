#!/bin/sh
# Creates the two Secrets the deployment needs. The values are generated here and go
# straight to the cluster: not into Git, not into a file, not onto the screen.
#
#   AZURE_MODEL_KEY=... OPENID_CLIENT_SECRET=... scripts/create-secrets.sh [namespace]
#
# A Secret that already exists is left alone. That is on purpose: with a new CREDS_KEY
# stored data can no longer be decrypted, and a new database password no longer
# matches the database.
set -eu

namespace=${1:-govchat}

kubectl get namespace "$namespace" >/dev/null 2>&1 || kubectl create namespace "$namespace"

create() { # name, then the arguments for `kubectl create secret generic`
  name=$1; shift
  if kubectl -n "$namespace" get secret "$name" >/dev/null 2>&1; then
    echo "Secret $name already exists in $namespace; nothing changed."
  else
    kubectl -n "$namespace" create secret generic "$name" "$@" >/dev/null
    echo "Secret $name created in $namespace."
  fi
}

# Loaded into LibreChat as environment variables (the chart's default Secret name).
create librechat-credentials-env \
  --from-literal=CREDS_KEY="$(openssl rand -hex 32)" \
  --from-literal=CREDS_IV="$(openssl rand -hex 16)" \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=JWT_REFRESH_SECRET="$(openssl rand -hex 32)" \
  --from-literal=OPENID_SESSION_SECRET="$(openssl rand -hex 32)" \
  --from-literal=OPENID_CLIENT_SECRET="${OPENID_CLIENT_SECRET:-not-set}" \
  --from-literal=AZURE_MODEL_KEY="${AZURE_MODEL_KEY:-not-set}"

# The root password of the bundled MongoDB (hex, because it ends up in a URL).
create librechat-mongodb-auth \
  --from-literal=mongodb-root-password="$(openssl rand -hex 24)"
