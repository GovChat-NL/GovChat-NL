#!/usr/bin/env sh
# Publish a weekly immutable Qdrant starter-dataset release after the
# OpenBesluitvorming delta sync has caught up. Designed for Sunday 20:00 UTC.
set -eu

usage() {
  cat <<'USAGE'
Usage:
  scripts/openbesluitvorming-weekly-release.sh [--dry-run]

Required environment variables:
  OPENBESLUITVORMING_RELEASE_GOVERNANCE_APPROVED=yes
  OPENBESLUITVORMING_WEEKLY_RELEASE_APPROVED=yes

Optional environment variables:
  GOVCHAT_REPOSITORY=GovChat-NL/GovChat-NL
  QDRANT_CONTAINER=librechat-qdrant
  QDRANT_URL=http://127.0.0.1:6333
  OPENBESLUITVORMING_COLLECTION=openraadsinformatie_v1
  OPENBESLUITVORMING_SOURCE_KEY=provincie_limburg
  OPENBESLUITVORMING_CHECKPOINT_ID=11111111-1111-5111-8111-111111111111
  OPENBESLUITVORMING_RELEASE_TARGET=feature/openbesluitvorming-dev-rebased
  OPENBESLUITVORMING_RELEASE_DIR=/var/lib/govchat/openbesluitvorming-releases
  OPENBESLUITVORMING_WEEKLY_LOCK=/var/lock/govchat-openbesluitvorming-weekly-release.lock

The script runs locally against the private Docker Qdrant container. It never
publishes a Qdrant URL, host IP, API key, or other deployment secret.
USAGE
}

DRY_RUN=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ "${OPENBESLUITVORMING_RELEASE_GOVERNANCE_APPROVED:-}" = "yes" ] || { echo 'Missing OPENBESLUITVORMING_RELEASE_GOVERNANCE_APPROVED=yes' >&2; exit 3; }
[ "${OPENBESLUITVORMING_WEEKLY_RELEASE_APPROVED:-}" = "yes" ] || { echo 'Missing OPENBESLUITVORMING_WEEKLY_RELEASE_APPROVED=yes' >&2; exit 3; }

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
REPOSITORY=${GOVCHAT_REPOSITORY:-GovChat-NL/GovChat-NL}
QDRANT_CONTAINER=${QDRANT_CONTAINER:-librechat-qdrant}
QDRANT_URL=${QDRANT_URL:-http://127.0.0.1:6333}
COLLECTION=${OPENBESLUITVORMING_COLLECTION:-openraadsinformatie_v1}
SOURCE_KEY=${OPENBESLUITVORMING_SOURCE_KEY:-provincie_limburg}
CHECKPOINT_ID=${OPENBESLUITVORMING_CHECKPOINT_ID:-11111111-1111-5111-8111-111111111111}
RELEASE_TARGET=${OPENBESLUITVORMING_RELEASE_TARGET:-feature/openbesluitvorming-dev-rebased}
RELEASE_DIR=${OPENBESLUITVORMING_RELEASE_DIR:-/var/lib/govchat/openbesluitvorming-releases}
LOCK_FILE=${OPENBESLUITVORMING_WEEKLY_LOCK:-/var/lock/govchat-openbesluitvorming-weekly-release.lock}
TAG="openbesluitvorming-limburg-$(date -u +%G-W%V)"

command -v docker >/dev/null || { echo 'docker is required' >&2; exit 4; }
command -v gh >/dev/null || { echo 'gh is required' >&2; exit 4; }
command -v python3 >/dev/null || { echo 'python3 is required' >&2; exit 4; }
command -v flock >/dev/null || { echo 'flock is required' >&2; exit 4; }

mkdir -p "$(dirname "$LOCK_FILE")" "$RELEASE_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || { echo 'Another weekly release is already running; exiting.' >&2; exit 0; }

qdrant_curl() {
  docker run --rm --network "container:${QDRANT_CONTAINER}" curlimages/curl:8.12.1 --fail --silent --show-error "$@"
}

CHECKPOINT_FILE=$(mktemp)
trap 'rm -f "$CHECKPOINT_FILE"' EXIT
qdrant_curl "$QDRANT_URL/collections/$COLLECTION/points/$CHECKPOINT_ID" > "$CHECKPOINT_FILE"

python3 - "$CHECKPOINT_FILE" "$SOURCE_KEY" <<'PY'
import json
import sys
from pathlib import Path
payload = json.loads(Path(sys.argv[1]).read_text()).get('result', {}).get('payload', {})
source_key = sys.argv[2]
problems = []
if payload.get('source_key') != source_key: problems.append('checkpoint source mismatch')
if payload.get('completed') is not True: problems.append('initial snapshot is incomplete')
if not payload.get('changes_cursor'): problems.append('initial changes cursor missing')
if not payload.get('sync_changes_cursor'): problems.append('delta sync has never committed a cursor')
if payload.get('sync_has_more') is not False: problems.append('delta sync is not caught up')
if problems: raise SystemExit('; '.join(problems))
print(json.dumps({'source_key': payload['source_key'], 'sync_changes_cursor': payload['sync_changes_cursor'], 'sync_last_at': payload.get('sync_last_at'), 'sync_runs': payload.get('sync_runs')}))
PY

if gh release view "$TAG" --repo "$REPOSITORY" >/dev/null 2>&1; then
  echo "Release '$TAG' already exists; immutable releases are never overwritten." >&2
  exit 5
fi

if [ "$DRY_RUN" = true ]; then
  printf '%s\n' "Dry run passed: would create and publish '$TAG' after verified caught-up delta sync." "Repository: $REPOSITORY" "Collection: $COLLECTION"
  exit 0
fi

ARTIFACT_DIR="$RELEASE_DIR/$TAG"
rm -rf "$ARTIFACT_DIR"
mkdir -p "$ARTIFACT_DIR"
OPENBESLUITVORMING_RELEASE_GOVERNANCE_APPROVED=yes QDRANT_CONTAINER="$QDRANT_CONTAINER" QDRANT_URL="$QDRANT_URL" \
  "$ROOT_DIR/scripts/openbesluitvorming-release-snapshot.sh" \
    --tag "$TAG" --source-key "$SOURCE_KEY" --collection "$COLLECTION" \
    --checkpoint-id "$CHECKPOINT_ID" --output-dir "$ARTIFACT_DIR"

MANIFEST=$(find "$ARTIFACT_DIR" -maxdepth 1 -name '*.manifest.json' -type f -print -quit)
SNAPSHOT=$(find "$ARTIFACT_DIR" -maxdepth 1 -name '*.snapshot' -type f -print -quit)
[ -n "$MANIFEST" ] && [ -n "$SNAPSHOT" ] || { echo 'Expected manifest or snapshot was not generated' >&2; exit 6; }
SHA256=$(python3 - "$MANIFEST" <<'PY'
import json,sys
print(json.load(open(sys.argv[1], encoding='utf-8'))['artifact']['sha256'])
PY
)

gh release create "$TAG" "$SNAPSHOT" "$MANIFEST" --repo "$REPOSITORY" --target "$RELEASE_TARGET" \
  --title "OpenBesluitvorming Provincie Limburg starter dataset $TAG" \
  --notes "Weekly immutable Qdrant starter-dataset snapshot created only after the delta sync was caught up.\n\n- Source key: \`$SOURCE_KEY\`\n- Collection: \`$COLLECTION\`\n- Checksum: \`$SHA256\`\n\nSee the attached manifest for provenance, cursor, compatibility and withdrawal policy."
echo "Published weekly OpenBesluitvorming release '$TAG'."
