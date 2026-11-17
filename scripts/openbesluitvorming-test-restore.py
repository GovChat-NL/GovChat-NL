#!/usr/bin/env python3
"""Opt-in restore of the approved Limburg test snapshot into local Qdrant."""

import hashlib
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


RELEASE_TAG = "v2026.10.08"
MANIFEST_NAME = "openbesluitvorming-provincie_limburg-v2026.10.08.manifest.json"
EXPECTED_SOURCE = "provincie_limburg"
EXPECTED_COLLECTION = "openraadsinformatie_v1"
EXPECTED_QDRANT_VERSION = "1.16.2"
TEST_DATA_DIR = Path("/testdata")
SNAPSHOT_DIR = Path("/qdrant/snapshots")
QDRANT_URL = os.environ.get("QDRANT_URL", "http://qdrant:6333").rstrip("/")


def request_json(url, method="GET", payload=None):
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={"Content-Type": "application/json"} if body is not None else {},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        raw = response.read()
        return json.loads(raw) if raw else {}


def hash_file(path):
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return size, digest.hexdigest()


def wait_for_collection(collection, expected_points, timeout_seconds=900):
    deadline = time.monotonic() + timeout_seconds
    encoded_collection = urllib.parse.quote(collection, safe="")
    last_status = "not created yet"
    while time.monotonic() < deadline:
        try:
            result = request_json(f"{QDRANT_URL}/collections/{encoded_collection}").get("result", {})
            last_status = str(result.get("status", "unknown"))
            points = int(result.get("points_count", 0))
            if last_status == "green" and points == expected_points:
                return result
            if points and points != expected_points:
                raise RuntimeError(
                    f"Restored collection has {points} points; manifest expects {expected_points}"
                )
        except urllib.error.HTTPError as error:
            if error.code != 404:
                raise
        time.sleep(5)
    raise TimeoutError(f"Timed out waiting for Qdrant collection; last status: {last_status}")


def main():
    if os.environ.get("OPENBESLUITVORMING_TEST_RESTORE_APPROVED") != "yes":
        raise RuntimeError(
            "Refusing test snapshot restore: set OPENBESLUITVORMING_TEST_RESTORE_APPROVED=yes "
            "for this explicit Compose profile run"
        )

    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    manifest_path = TEST_DATA_DIR / MANIFEST_NAME
    if not manifest_path.is_file():
        raise RuntimeError(
            f"Missing {manifest_path}; provide the approved local test manifest and matching snapshot."
        )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    if manifest.get("format_version") != 1 or manifest.get("release_tag") != RELEASE_TAG:
        raise RuntimeError("Release manifest format/tag mismatch")
    if manifest.get("source", {}).get("source_key") != EXPECTED_SOURCE:
        raise RuntimeError("Release manifest has an unexpected source key")
    qdrant_manifest = manifest.get("qdrant", {})
    if qdrant_manifest.get("collection") != EXPECTED_COLLECTION:
        raise RuntimeError("Release manifest collection does not match this test restore")
    if qdrant_manifest.get("minimum_version") != EXPECTED_QDRANT_VERSION:
        raise RuntimeError("Release manifest Qdrant version is not the expected tested version")
    vector = qdrant_manifest.get("vectors", {})
    if vector.get("size") != 3072 or vector.get("distance") != "Cosine":
        raise RuntimeError("Release manifest vector schema is not supported by this test profile")

    artifact = manifest.get("artifact", {})
    filename = Path(str(artifact.get("file_name", ""))).name
    expected_size = int(artifact.get("bytes", 0))
    expected_hash = str(artifact.get("sha256", ""))
    if not filename.endswith(".snapshot") or expected_size <= 0 or len(expected_hash) != 64:
        raise RuntimeError("Release manifest artifact metadata is invalid")

    downloaded_snapshot = TEST_DATA_DIR / filename
    if not downloaded_snapshot.is_file():
        raise RuntimeError(
            f"Missing {downloaded_snapshot}; provide the approved local test snapshot named in the manifest."
        )
    actual_size, actual_hash = hash_file(downloaded_snapshot)
    if actual_size != expected_size or actual_hash != expected_hash:
        raise RuntimeError(
            f"Snapshot verification failed: size={actual_size}, sha256={actual_hash}"
        )
    print(f"Verified release snapshot SHA-256: {actual_hash}", flush=True)

    snapshot_path = SNAPSHOT_DIR / filename
    cached_size, cached_hash = (0, "")
    if snapshot_path.is_file():
        cached_size, cached_hash = hash_file(snapshot_path)
    if cached_size != expected_size or cached_hash != expected_hash:
        temporary_snapshot = snapshot_path.with_suffix(snapshot_path.suffix + ".part")
        shutil.copyfile(downloaded_snapshot, temporary_snapshot)
        copied_size, copied_hash = hash_file(temporary_snapshot)
        if copied_size != expected_size or copied_hash != expected_hash:
            temporary_snapshot.unlink(missing_ok=True)
            raise RuntimeError("Snapshot copy into the Qdrant volume failed checksum verification")
        temporary_snapshot.replace(snapshot_path)

    encoded_collection = urllib.parse.quote(EXPECTED_COLLECTION, safe="")
    collection_url = f"{QDRANT_URL}/collections/{encoded_collection}"
    collection_exists = True
    try:
        request_json(collection_url)
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
        collection_exists = False

    if collection_exists:
        if os.environ.get("OPENBESLUITVORMING_TEST_RESTORE_REPLACE_EXISTING") != "yes":
            raise RuntimeError(
                f"Collection {EXPECTED_COLLECTION} already exists. To replace it, explicitly set "
                "OPENBESLUITVORMING_TEST_RESTORE_REPLACE_EXISTING=yes for this test run."
            )
        request_json(collection_url, method="DELETE")
        for _ in range(60):
            try:
                request_json(collection_url)
            except urllib.error.HTTPError as error:
                if error.code == 404:
                    break
                raise
            time.sleep(1)
        else:
            raise TimeoutError(f"Could not delete existing collection {EXPECTED_COLLECTION}")

    request_json(
        f"{collection_url}/snapshots/recover",
        method="PUT",
        payload={"location": snapshot_path.as_uri()},
    )
    expected_points = int(qdrant_manifest.get("points_count", 0))
    if expected_points <= 0:
        raise RuntimeError("Release manifest has an invalid point count")
    result = wait_for_collection(EXPECTED_COLLECTION, expected_points)
    print(
        f"Restored {EXPECTED_SOURCE} into {EXPECTED_COLLECTION}: "
        f"{result.get('points_count')} points, status={result.get('status')}.",
        flush=True,
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # Keep a concise error in the one-shot Compose logs.
        print(f"[openbesluitvorming-test-restore] ERROR: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
