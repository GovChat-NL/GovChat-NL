#!/usr/bin/env sh
# Download, verify and recover an explicitly selected OpenBesluitvorming Qdrant
# starter-dataset release artifact. This never runs automatically at Compose start.
set -eu

usage() {
  cat <<'USAGE'
Usage:
  scripts/openbesluitvorming-restore-release-snapshot.sh \
    --manifest-url <https-url> \
    --snapshot-url <https-url> \
    --collection <collection-name>

Required acknowledgement:
  OPENBESLUITVORMING_RESTORE_APPROVED=yes

Optional environment variables:
  QDRANT_URL=http://127.0.0.1:6333
  QDRANT_CONTAINER=librechat-qdrant
  WORK_DIR=./.openbesluitvorming-release

Safety rules:
  - Downloads both manifest and snapshot over HTTPS.
  - Verifies the snapshot SHA-256 before recovery.
  - Refuses an existing target collection unless
    OPENBESLUITVORMING_RESTORE_REPLACE_EXISTING=yes is explicitly set.
  - Does not activate ingestion or delta-sync workflows.
USAGE
}

MANIFEST_URL=''
SNAPSHOT_URL=''
COLLECTION=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --manifest-url) MANIFEST_URL=${2:?missing value for --manifest-url}; shift 2 ;;
    --snapshot-url) SNAPSHOT_URL=${2:?missing value for --snapshot-url}; shift 2 ;;
    --collection) COLLECTION=${2:?missing value for --collection}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -n "$MANIFEST_URL" ] && [ -n "$SNAPSHOT_URL" ] && [ -n "$COLLECTION" ] || { usage >&2; exit 2; }
[ "${OPENBESLUITVORMING_RESTORE_APPROVED:-}" = "yes" ] || {
  echo 'Refusing restore without OPENBESLUITVORMING_RESTORE_APPROVED=yes.' >&2
  exit 3
}

case "$MANIFEST_URL,$SNAPSHOT_URL" in
  https://*,https://*) ;;
  *) echo 'Both artifact URLs must use HTTPS.' >&2; exit 3 ;;
esac

QDRANT_URL=${QDRANT_URL:-http://127.0.0.1:6333}
QDRANT_CONTAINER=${QDRANT_CONTAINER:-librechat-qdrant}
QDRANT_CURL_IMAGE=${QDRANT_CURL_IMAGE:-curlimages/curl:8.12.1}

qdrant_curl() {
  docker run --rm --network "container:${QDRANT_CONTAINER}" "${QDRANT_CURL_IMAGE}" --fail --silent --show-error "$@"
}
WORK_DIR=${WORK_DIR:-./.openbesluitvorming-release}
MANIFEST_FILE="$WORK_DIR/manifest.json"
SNAPSHOT_FILE="$WORK_DIR/snapshot.snapshot"

command -v docker >/dev/null || { echo 'docker is required' >&2; exit 4; }
command -v sha256sum >/dev/null || { echo 'sha256sum is required' >&2; exit 4; }
command -v python3 >/dev/null || { echo 'python3 is required' >&2; exit 4; }
command -v curl >/dev/null || { echo 'curl is required' >&2; exit 4; }

mkdir -p "$WORK_DIR"
curl --fail --location --proto '=https' --tlsv1.2 --output "$MANIFEST_FILE" "$MANIFEST_URL"
curl --fail --location --proto '=https' --tlsv1.2 --output "$SNAPSHOT_FILE" "$SNAPSHOT_URL"

python3 - "$MANIFEST_FILE" "$COLLECTION" "$SNAPSHOT_FILE" <<'PY'
import hashlib
import json
import pathlib
import sys
manifest_path, collection, snapshot_path = map(pathlib.Path, [sys.argv[1], sys.argv[2], sys.argv[3]])
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
if manifest.get('format_version') != 1:
    raise SystemExit('Unsupported manifest format')
if manifest.get('qdrant', {}).get('collection') != str(collection):
    raise SystemExit('Manifest collection does not match --collection')
if manifest.get('governance', {}).get('redistribution_review_required') is not True:
    raise SystemExit('Manifest is missing governance safeguards')
expected = manifest.get('artifact', {}).get('sha256')
actual = hashlib.sha256(snapshot_path.read_bytes()).hexdigest()
if not expected or actual != expected:
    raise SystemExit('Snapshot SHA-256 verification failed')
print(json.dumps({'verified_collection': str(collection), 'sha256': actual, 'bytes': snapshot_path.stat().st_size}))
PY

if qdrant_curl "$QDRANT_URL/collections/$COLLECTION" >/dev/null 2>&1; then EXISTS=0; else EXISTS=1; fi
if [ "$EXISTS" = "0" ]; then
  [ "${OPENBESLUITVORMING_RESTORE_REPLACE_EXISTING:-}" = "yes" ] || {
    echo "Collection '$COLLECTION' already exists. Refusing to replace it without OPENBESLUITVORMING_RESTORE_REPLACE_EXISTING=yes." >&2
    exit 5
  }
  qdrant_curl -X DELETE "$QDRANT_URL/collections/$COLLECTION" >/dev/null
fi

docker cp "$SNAPSHOT_FILE" "$QDRANT_CONTAINER:/tmp/openbesluitvorming-release.snapshot"
qdrant_curl -X PUT -H 'Content-Type: application/json' --data '{"location":"file:///tmp/openbesluitvorming-release.snapshot"}' "$QDRANT_URL/collections/$COLLECTION/snapshots/recover" >/dev/null

echo "Restored verified OpenBesluitvorming release artifact into '$COLLECTION'."
echo 'Start the incremental sync only after validating collection provenance and checkpoint compatibility.'
