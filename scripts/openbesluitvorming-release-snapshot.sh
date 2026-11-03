#!/usr/bin/env sh
# Create a versioned, immutable Qdrant collection snapshot and release manifest.
#
# This script deliberately does not upload anything. Review the generated
# manifest, governance acknowledgement, and checksum before attaching the two
# generated files to a GitHub Release or other immutable artifact store.
set -eu

usage() {
  cat <<'USAGE'
Usage:
  scripts/openbesluitvorming-release-snapshot.sh \
    --tag <release-tag> \
    --source-key <source-key> \
    --collection <collection-name> \
    --checkpoint-id <uuid> \
    --output-dir <directory>

Required governance acknowledgement:
  OPENBESLUITVORMING_RELEASE_GOVERNANCE_APPROVED=yes

Optional environment variables:
  QDRANT_URL=http://127.0.0.1:6333
  QDRANT_CONTAINER=librechat-qdrant
  EMBEDDING_MODEL=govchat-embedding
  QDRANT_VECTOR_SIZE=3072
  QDRANT_DISTANCE=Cosine

The script creates a native Qdrant snapshot plus a JSON manifest in --output-dir.
It never commits, uploads, publishes, modifies, or deletes Qdrant data.
USAGE
}

TAG=''
SOURCE_KEY=''
COLLECTION=''
CHECKPOINT_ID=''
OUTPUT_DIR=''

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag) TAG=${2:?missing value for --tag}; shift 2 ;;
    --source-key) SOURCE_KEY=${2:?missing value for --source-key}; shift 2 ;;
    --collection) COLLECTION=${2:?missing value for --collection}; shift 2 ;;
    --checkpoint-id) CHECKPOINT_ID=${2:?missing value for --checkpoint-id}; shift 2 ;;
    --output-dir) OUTPUT_DIR=${2:?missing value for --output-dir}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -n "$TAG" ] && [ -n "$SOURCE_KEY" ] && [ -n "$COLLECTION" ] && [ -n "$CHECKPOINT_ID" ] && [ -n "$OUTPUT_DIR" ] || {
  usage >&2
  exit 2
}

[ "${OPENBESLUITVORMING_RELEASE_GOVERNANCE_APPROVED:-}" = "yes" ] || {
  echo 'Refusing to create a distributable dataset without OPENBESLUITVORMING_RELEASE_GOVERNANCE_APPROVED=yes.' >&2
  echo 'Review provenance, redistribution terms, privacy/takedown policy, and refresh/withdrawal ownership first.' >&2
  exit 3
}

QDRANT_URL=${QDRANT_URL:-http://127.0.0.1:6333}
QDRANT_CONTAINER=${QDRANT_CONTAINER:-librechat-qdrant}
QDRANT_CURL_IMAGE=${QDRANT_CURL_IMAGE:-curlimages/curl:8.12.1}

qdrant_curl() {
  docker run --rm --network "container:${QDRANT_CONTAINER}" "${QDRANT_CURL_IMAGE}" --fail --silent --show-error "$@"
}
EMBEDDING_MODEL=${EMBEDDING_MODEL:-govchat-embedding}
QDRANT_VECTOR_SIZE=${QDRANT_VECTOR_SIZE:-3072}
QDRANT_DISTANCE=${QDRANT_DISTANCE:-Cosine}

command -v docker >/dev/null || { echo 'docker is required' >&2; exit 4; }
command -v sha256sum >/dev/null || { echo 'sha256sum is required' >&2; exit 4; }
command -v python3 >/dev/null || { echo 'python3 is required' >&2; exit 4; }

mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR=$(cd "$OUTPUT_DIR" && pwd)

COLLECTION_JSON_FILE=$(mktemp)
CHECKPOINT_JSON_FILE=$(mktemp)
trap 'rm -f "$COLLECTION_JSON_FILE" "$CHECKPOINT_JSON_FILE"' EXIT
qdrant_curl "$QDRANT_URL/collections/$COLLECTION" > "$COLLECTION_JSON_FILE"
qdrant_curl "$QDRANT_URL/collections/$COLLECTION/points/$CHECKPOINT_ID" > "$CHECKPOINT_JSON_FILE"

python3 - "$COLLECTION_JSON_FILE" "$CHECKPOINT_JSON_FILE" "$SOURCE_KEY" "$QDRANT_VECTOR_SIZE" "$QDRANT_DISTANCE" <<'PY'
import json
import sys
from pathlib import Path
collection = json.loads(Path(sys.argv[1]).read_text())
checkpoint = json.loads(Path(sys.argv[2]).read_text())
source_key, size, distance = sys.argv[3:]
result = collection.get('result', {})
params = result.get('config', {}).get('params', {}).get('vectors', {})
payload = checkpoint.get('result', {}).get('payload', {})
problems = []
if result.get('status') != 'green': problems.append('collection is not green')
if int(params.get('size', 0)) != int(size): problems.append('unexpected vector size')
if params.get('distance') != distance: problems.append('unexpected distance metric')
if payload.get('source_key') != source_key: problems.append('checkpoint source_key does not match')
if payload.get('completed') is not True: problems.append('initial snapshot is not complete')
if not payload.get('changes_cursor'): problems.append('changes_cursor is missing')
if problems:
    raise SystemExit('; '.join(problems))
PY

CREATE_RESPONSE=$(qdrant_curl -X POST "$QDRANT_URL/collections/$COLLECTION/snapshots")
SNAPSHOT_NAME=$(python3 -c "import json,sys; print(json.load(sys.stdin)['result']['name'])" <<EOF
$CREATE_RESPONSE
EOF
)
[ -n "$SNAPSHOT_NAME" ] || { echo 'Qdrant did not return a snapshot name' >&2; exit 5; }

SNAPSHOT_FILE="$OUTPUT_DIR/$SNAPSHOT_NAME"
docker cp "$QDRANT_CONTAINER:/qdrant/snapshots/$COLLECTION/$SNAPSHOT_NAME" "$SNAPSHOT_FILE"
SHA256=$(sha256sum "$SNAPSHOT_FILE" | awk '{print $1}')
BYTES=$(wc -c < "$SNAPSHOT_FILE" | tr -d ' ')
CREATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
MANIFEST_FILE="$OUTPUT_DIR/openbesluitvorming-${SOURCE_KEY}-${TAG}.manifest.json"

python3 - "$COLLECTION_JSON_FILE" "$CHECKPOINT_JSON_FILE" "$MANIFEST_FILE" "$TAG" "$SOURCE_KEY" "$COLLECTION" "$SNAPSHOT_NAME" "$SHA256" "$BYTES" "$CREATED_AT" "$EMBEDDING_MODEL" <<'PY'
import json
import sys
(
    collection_json, checkpoint_json, manifest_file, tag, source_key,
    collection_name, snapshot_name, sha256, bytes_, created_at, embedding_model,
) = sys.argv[1:]
from pathlib import Path
collection = json.loads(Path(collection_json).read_text())['result']
checkpoint = json.loads(Path(checkpoint_json).read_text())['result']['payload']
manifest = {
    'format_version': 1,
    'dataset': 'openbesluitvorming-qdrant-starter',
    'release_tag': tag,
    'created_at': created_at,
    'artifact': {
        'file_name': snapshot_name,
        'media_type': 'application/octet-stream',
        'sha256': sha256,
        'bytes': int(bytes_),
    },
    'qdrant': {
        'minimum_version': '1.16.2',
        'collection': collection_name,
        'vectors': collection['config']['params']['vectors'],
        'points_count': collection.get('points_count'),
        'indexed_vectors_count': collection.get('indexed_vectors_count'),
    },
    'embedding': {
        'model_alias': embedding_model,
        'vector_size': collection['config']['params']['vectors']['size'],
    },
    'source': {
        'provider': 'OpenBesluitvorming',
        'source_key': source_key,
        'source_snapshot_completed': checkpoint.get('completed'),
        'source_changes_cursor': checkpoint.get('changes_cursor'),
        'indexed_documents': checkpoint.get('indexed'),
        'dead_letters': checkpoint.get('failed'),
        'checkpointed_at': checkpoint.get('last_page_at'),
    },
    'governance': {
        'redistribution_review_required': True,
        'takedown_and_withdrawal_process_required': True,
        'refresh_owner_required': True,
        'notes': 'This artifact contains vectors and source metadata/content previews. Publish only after a documented provenance, terms, privacy and takedown review.',
    },
}
with open(manifest_file, 'w', encoding='utf-8') as handle:
    json.dump(manifest, handle, indent=2, ensure_ascii=False)
    handle.write('\n')
PY

printf '%s\n' "Created release candidates:" "  snapshot: $SNAPSHOT_FILE" "  manifest: $MANIFEST_FILE" "  sha256:   $SHA256"
printf '%s\n' 'Do not commit the snapshot to Git. Attach snapshot and manifest to an immutable GitHub Release only after review.'
