#!/usr/bin/env python3
"""Secret-free official release check; preparation changes only two image pins."""

import argparse
import hashlib
import json
import os
import re
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = "librechat-ai/librechat"
REGISTRY = "registry.librechat.ai"
IMAGE = f"{REGISTRY}/{REPOSITORY}"
API = "https://api.github.com/repos/LibreChat-AI/LibreChat/releases"
TAG = re.compile(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z")
MEDIA = (
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
)


class ReleaseError(ValueError):
    pass


def version(tag):
    match = TAG.fullmatch(tag) if isinstance(tag, str) else None
    if not match:
        raise ReleaseError("Expected an exact vX.Y.Z tag (no rc/dev/latest/digest/interpolation)")
    return tuple(map(int, match.groups()))


def service_block(text, service):
    # Deliberately support only the committed, literal block-style Compose layout.
    # Ambiguous YAML (anchors, duplicate service/image keys, substitutions) fails closed.
    mappings = list(re.finditer(r"(?m)^[\"']?services[\"']?[ \t]*:", text))
    if len(mappings) != 1 or not re.match(r"services:[ \t]*\n", text[mappings[0].start():]):
        raise ReleaseError("Expected one literal services mapping")
    start = mappings[0].start()
    content_start = text.index("\n", start) + 1
    next_mapping = re.search(r"(?m)^\S", text[content_start:])
    end = content_start + next_mapping.start() if next_mapping else len(text)
    section = text[start:end]
    keys = re.findall(rf"(?m)^  [\"']?{re.escape(service)}[\"']?[ \t]*:", section)
    blocks = list(re.finditer(rf"(?ms)^  {re.escape(service)}:\n(.*?)(?=^\S|^  [\w\"'-]+[ \t]*:|\Z)", text))
    if len(keys) != 1 or len(blocks) != 1 or not start <= blocks[0].start() < start + len(section):
        raise ReleaseError(f"Expected one literal service: {service}")
    return blocks[0]


def read_pins(text):
    pins = []
    for service in ("librechat", "govchat-retention"):
        block = service_block(text, service).group(1)
        images = re.findall(r"^    image: ([^\s#]+)[ \t]*$", block, re.M)
        if len(images) != 1 or len(re.findall(r"^    [\"']?image[\"']?[ \t]*:", block, re.M)) != 1 or re.search(r"^    [\"']?<<[\"']?[ \t]*:", block, re.M):
            raise ReleaseError(f"Expected one literal image for {service}")
        image = images[0]
        if not image.startswith(IMAGE + ":"):
            raise ReleaseError("LibreChat must use the official registry/repository")
        version(image[len(IMAGE) + 1:])
        pins.append(image)
    if pins[0] != pins[1]:
        raise ReleaseError("LibreChat and retention images must be exactly equal")
    return pins[0], pins[0][len(IMAGE) + 1:]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ReleaseError("Unexpected redirect from official API/registry")


def request(url, headers=None):
    """No environment proxy, credentials, redirects or local configuration."""
    parsed = urllib.parse.urlsplit(url)
    official = parsed.hostname in ("api.github.com", REGISTRY)
    # The official registry currently delegates anonymous pull auth to GHCR.
    # Only this token endpoint is allowed; image requests stay on the new registry.
    delegated_auth = parsed.hostname == "ghcr.io" and parsed.path == "/token"
    if parsed.scheme != "https" or not (official or delegated_auth) or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ReleaseError("Refusing non-official HTTPS endpoint")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    req = urllib.request.Request(url, headers={"User-Agent": "GovChat-release-check", **(headers or {})})
    try:
        with opener.open(req, timeout=30) as response:
            body = response.read(8 * 1024 * 1024 + 1)
            if len(body) > 8 * 1024 * 1024:
                raise ReleaseError("Response too large")
            return response.status, dict(response.headers.items()), body
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers.items()), b""
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ReleaseError("Official endpoint unavailable") from exc


def get_json(url, fetch=request):
    status, _, body = fetch(url, {"Accept": "application/vnd.github+json"})
    if status != 200:
        raise ReleaseError(f"GitHub release request failed: HTTP {status}")
    try:
        return json.loads(body)
    except (ValueError, TypeError) as exc:
        raise ReleaseError("Malformed GitHub JSON") from exc


def validate_release(release):
    if not isinstance(release, dict) or type(release.get("draft")) is not bool or type(release.get("prerelease")) is not bool:
        raise ReleaseError("Missing/invalid GitHub release flags")


def select_release(explicit=None, allow_prerelease=False, fetch=request):
    if allow_prerelease and not explicit:
        raise ReleaseError("Prerelease opt-in requires --version")
    if explicit:
        version(explicit)
        release = get_json(f"{API}/tags/{explicit}", fetch)
        validate_release(release)
        if release.get("tag_name") != explicit or release["draft"]:
            raise ReleaseError("Requested version does not match a published release")
        if release["prerelease"] and not allow_prerelease:
            raise ReleaseError("GitHub marks this release as prerelease; explicit --allow-prerelease required")
        return release
    candidates = []
    # Fetch every page before selecting: never silently select from an incomplete list.
    for page in range(1, 101):
        releases = get_json(f"{API}?per_page=100&page={page}", fetch)
        if not isinstance(releases, list):
            raise ReleaseError("GitHub release list is not an array")
        for release in releases:
            validate_release(release)
            tag = release.get("tag_name")
            if not release["draft"] and not release["prerelease"] and isinstance(tag, str) and TAG.fullmatch(tag):
                candidates.append(release)
        if len(releases) < 100:
            break
    else:
        raise ReleaseError("Release pagination limit exceeded")
    if not candidates:
        raise ReleaseError("No published non-prerelease exact vX.Y.Z release")
    return max(candidates, key=lambda item: version(item["tag_name"]))


def verify_manifest(tag, fetch=request):
    version(tag)
    url = f"https://{REGISTRY}/v2/{REPOSITORY}/manifests/{tag}"
    headers = {"Accept": ", ".join(MEDIA)}
    status, response_headers, body = fetch(url, headers)
    if status == 401:
        challenge = {k.lower(): v for k, v in response_headers.items()}.get("www-authenticate", "")
        if not challenge.startswith("Bearer "):
            raise ReleaseError("Unsupported registry authentication")
        params = dict(re.findall(r'(\w+)="([^"\r\n]+)"', challenge[7:]))
        realm = params.get("realm", "")
        parsed = urllib.parse.urlsplit(realm)
        trusted_realm = parsed.hostname == REGISTRY or (realm == "https://ghcr.io/token" and params.get("service") == "ghcr.io")
        if parsed.scheme != "https" or not trusted_realm or parsed.username or parsed.password or parsed.port not in (None, 443) or parsed.query or parsed.fragment:
            raise ReleaseError("Untrusted registry token realm")
        scope = f"repository:{REPOSITORY}:pull"
        if params.get("scope", scope) != scope:
            raise ReleaseError("Unexpected registry token scope")
        query = urllib.parse.urlencode({"service": params.get("service", REGISTRY), "scope": scope})
        token_status, _, token_body = fetch(realm + "?" + query, {})
        try:
            token_data = json.loads(token_body)
            token = token_data.get("token") or token_data.get("access_token")
        except (ValueError, AttributeError, TypeError) as exc:
            raise ReleaseError("Invalid anonymous registry token") from exc
        if token_status != 200 or not isinstance(token, str) or not token or any(c.isspace() for c in token):
            raise ReleaseError("Anonymous registry authentication failed")
        status, response_headers, body = fetch(url, {**headers, "Authorization": f"Bearer {token}"})
    if status != 200:
        raise ReleaseError(f"Official image manifest unavailable: HTTP {status}")
    try:
        manifest = json.loads(body)
    except (ValueError, TypeError) as exc:
        raise ReleaseError("Invalid image manifest JSON") from exc
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 2 or manifest.get("mediaType") not in MEDIA:
        raise ReleaseError("Unsupported image manifest")
    def valid_digest(value):
        return isinstance(value, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", value)

    if "manifests" in manifest:
        entries = manifest["manifests"]
        if not isinstance(entries, list) or not any(isinstance(entry, dict) and isinstance(entry.get("platform"), dict) and entry["platform"].get("os") == "linux" and entry["platform"].get("architecture") == "amd64" and valid_digest(entry.get("digest")) for entry in entries):
            raise ReleaseError("Manifest index lacks linux/amd64 image")
    elif not isinstance(manifest.get("config"), dict) or not valid_digest(manifest["config"].get("digest")) or not isinstance(manifest.get("layers"), list):
        raise ReleaseError("Incomplete image manifest")
    digest = "sha256:" + hashlib.sha256(body).hexdigest()
    reported = {k.lower(): v for k, v in response_headers.items()}.get("docker-content-digest")
    if reported != digest:
        raise ReleaseError("Missing or mismatched registry manifest digest")
    return digest


def prepare(compose, original, tag):
    _, current = read_pins(original)
    if version(tag) <= version(current):
        raise ReleaseError("Preparation requires a newer release; no downgrade or no-op")
    updated = original
    for service in ("librechat", "govchat-retention"):
        match = service_block(updated, service)
        block = re.sub(r"(?m)^    image: [^\s#]+[ \t]*$", f"    image: {IMAGE}:{tag}", match.group(1))
        updated = updated[:match.start(1)] + block + updated[match.end(1):]
    read_pins(updated)
    if compose.read_text() != original:
        raise ReleaseError("Compose changed during verification; refusing overwrite")
    name = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=compose.parent, prefix=".release-", delete=False) as handle:
            name = handle.name
            handle.write(updated)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(name, compose.stat().st_mode & 0o777)
        os.replace(name, compose)
    finally:
        if name and os.path.exists(name):
            os.unlink(name)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", help="Exact official GitHub release tag")
    parser.add_argument("--allow-prerelease", action="store_true")
    parser.add_argument("--prepare", action="store_true", help="Opt in to updating only the two Compose image pins")
    parser.add_argument("--check-current", action="store_true", help="Check committed image tag instead of discovery")
    args = parser.parse_args(argv)
    try:
        compose = ROOT / "docker-compose.yml"
        original = compose.read_text()
        image, current = read_pins(original)
        if args.check_current and (args.version or args.prepare):
            raise ReleaseError("--check-current cannot be combined with --version or --prepare")
        release = select_release(current if args.check_current else args.version, args.allow_prerelease, request)
        tag = release["tag_name"]
        digest = verify_manifest(tag, request)
        result = {"current": current, "candidate": tag, "github_prerelease": release["prerelease"],
                  "newer": version(tag) > version(current), "image": f"{IMAGE}:{tag}",
                  "manifest_digest": digest, "prepared": False}
        if args.prepare:
            prepare(compose, original, tag)
            result["prepared"] = True
        print(json.dumps(result, indent=2))
        return 0
    except (ReleaseError, OSError) as exc:
        parser.exit(1, f"Release check failed: {exc}\n")


if __name__ == "__main__":
    raise SystemExit(main())
