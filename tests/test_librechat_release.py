"""Release policy, network failures and preparation; no Docker or live network."""

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from scripts import librechat_release as release


def published(tag, prerelease=False, draft=False):
    return {"tag_name": tag, "prerelease": prerelease, "draft": draft}


def response(data, status=200):
    return status, {}, json.dumps(data).encode()


def compose(tag="v0.8.8"):
    return ("services:\n  librechat:\n    image: " + release.IMAGE + ":" + tag +
            "\n    restart: unless-stopped\n\n  govchat-retention:\n    image: " + release.IMAGE + ":" + tag + "\n")


def manifest_response(manifest=None):
    data = manifest or {"schemaVersion": 2, "mediaType": release.MEDIA[0], "manifests": [
        {"digest": "sha256:" + "a" * 64, "platform": {"os": "linux", "architecture": "amd64"}}]}
    body = json.dumps(data).encode()
    return 200, {"Docker-Content-Digest": "sha256:" + hashlib.sha256(body).hexdigest()}, body


class ReleaseSelectionTests(unittest.TestCase):
    def test_default_uses_flags_not_tag_shape_and_orders_numerically(self):
        fetch = Mock(return_value=response([published("v0.8.8", True), published("v0.10.0"),
                    published("v0.9.0"), published("v9.0.0", draft=True), published("v20.0.0-rc1"),
                    published("latest"), published("v01.0.0"), published("v30.0.0-dev")]))
        self.assertEqual(release.select_release(fetch=fetch)["tag_name"], "v0.10.0")

    def test_explicit_prerelease_needs_opt_in_even_for_v088(self):
        fetch = Mock(return_value=response(published("v0.8.8", True)))
        with self.assertRaisesRegex(release.ReleaseError, "prerelease"):
            release.select_release("v0.8.8", fetch=fetch)
        self.assertTrue(release.select_release("v0.8.8", True, fetch)["prerelease"])
        with self.assertRaisesRegex(release.ReleaseError, "requires --version"):
            release.select_release(allow_prerelease=True, fetch=fetch)

    def test_explicit_tag_must_match_and_never_allows_drafts(self):
        for data in (published("v0.8.7"), published("v0.8.8", draft=True)):
            with self.subTest(data=data), self.assertRaises(release.ReleaseError):
                release.select_release("v0.8.8", True, Mock(return_value=response(data)))

    def test_invalid_tags_rejected_before_network(self):
        fetch = Mock()
        for tag in ("0.8.8", "v0.8.8-rc1", "v0.8.8-dev", "latest", "v01.8.8", "v0.8.8\n", "v0.8.8+meta"):
            with self.subTest(tag=tag), self.assertRaises(release.ReleaseError):
                release.select_release(tag, True, fetch)
        fetch.assert_not_called()

    def test_pagination_includes_later_pages_and_does_not_choose_on_failure(self):
        page = [published("v0.8.7")] * 100
        fetch = Mock(side_effect=[response(page), response([published("v0.9.0")])])
        self.assertEqual(release.select_release(fetch=fetch)["tag_name"], "v0.9.0")
        self.assertIn("page=2", fetch.call_args.args[0])
        with self.assertRaises(release.ReleaseError):
            release.select_release(fetch=Mock(side_effect=[response(page), (503, {}, b"")]))

    def test_no_stable_and_bad_api_fail_closed(self):
        failures = [response([published("v0.8.8", True)]), response([]), response({}),
                    response([{"tag_name": "v0.8.8", "draft": False}]),
                    response([{"tag_name": "v0.8.8", "draft": "false", "prerelease": False}]),
                    (403, {}, b""), (404, {}, b""), (429, {}, b""), (200, {}, b"not-json")]
        for item in failures:
            with self.subTest(item=item), self.assertRaises(release.ReleaseError):
                release.select_release(fetch=Mock(return_value=item))
        with self.assertRaisesRegex(release.ReleaseError, "pagination"):
            release.select_release(fetch=Mock(return_value=response([published("v0.8.7")] * 100)))


class ManifestTests(unittest.TestCase):
    def test_exact_tag_and_official_registry_with_digest(self):
        fetch = Mock(return_value=manifest_response())
        digest = release.verify_manifest("v0.8.8", fetch)
        self.assertRegex(digest, r"^sha256:[0-9a-f]{64}$")
        self.assertEqual(fetch.call_args.args[0], "https://registry.librechat.ai/v2/librechat-ai/librechat/manifests/v0.8.8")

    def test_official_anonymous_auth_delegation_only(self):
        challenge = {"www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:librechat-ai/librechat:pull"'}
        fetch = Mock(side_effect=[(401, challenge, b""), response({"token": "anonymous-token"}), manifest_response()])
        release.verify_manifest("v0.8.8", fetch)
        self.assertTrue(fetch.call_args_list[1].args[0].startswith("https://ghcr.io/token?"))
        self.assertEqual(fetch.call_args.args[1]["Authorization"], "Bearer anonymous-token")
        self.assertTrue(fetch.call_args.args[0].startswith("https://registry.librechat.ai/"))

    def test_bad_auth_challenges_are_not_followed(self):
        for realm in ("https://evil.example/token", "http://registry.librechat.ai/token", "https://ghcr.io/other", "https://user@registry.librechat.ai/token"):
            fetch = Mock(return_value=(401, {"WWW-Authenticate": f'Bearer realm="{realm}"'}, b""))
            with self.subTest(realm=realm), self.assertRaises(release.ReleaseError):
                release.verify_manifest("v0.8.8", fetch)
            self.assertEqual(fetch.call_count, 1)
        for challenge in ('Basic realm="registry"', 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:other/repo:pull"'):
            with self.assertRaises(release.ReleaseError):
                release.verify_manifest("v0.8.8", Mock(return_value=(401, {"www-authenticate": challenge}, b"")))

    def test_token_and_manifest_failures(self):
        challenge = {"www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io"'}
        for token_reply in (response({}), response({"token": "bad\ntoken"}), (403, {}, b""), (200, {}, b"bad")):
            with self.subTest(token_reply=token_reply), self.assertRaises(release.ReleaseError):
                release.verify_manifest("v0.8.8", Mock(side_effect=[(401, challenge, b""), token_reply]))
        for item in ((404, {}, b""), (503, {}, b""), (200, {}, b"bad"), response({"schemaVersion": 1}),
                     manifest_response({"schemaVersion": 2, "mediaType": release.MEDIA[0], "manifests": []}),
                     manifest_response({"schemaVersion": 2, "mediaType": release.MEDIA[1], "config": {"digest": 1}, "layers": []}),
                     manifest_response({"schemaVersion": 2, "mediaType": release.MEDIA[0], "manifests": [{"platform": []}]})):
            with self.subTest(item=item), self.assertRaises(release.ReleaseError):
                release.verify_manifest("v0.8.8", Mock(return_value=item))
        status, headers, body = manifest_response()
        for digest in (None, "sha256:" + "0" * 64):
            with self.assertRaisesRegex(release.ReleaseError, "digest"):
                release.verify_manifest("v0.8.8", Mock(return_value=(status, {"Docker-Content-Digest": digest} if digest else {}, body)))

    def test_http_client_rejects_untrusted_endpoints_without_network(self):
        for url in ("http://api.github.com/test", "https://example.org/test", "https://ghcr.io/v2/test", "https://user:secret@registry.librechat.ai/test"):
            with self.subTest(url=url), self.assertRaises(release.ReleaseError):
                release.request(url)
        with patch.object(release.urllib.request, "build_opener") as builder:
            builder.return_value.open.side_effect = release.urllib.error.URLError("offline")
            with self.assertRaisesRegex(release.ReleaseError, "unavailable"):
                release.request(release.API)
        with self.assertRaisesRegex(release.ReleaseError, "redirect"):
            release.NoRedirect().redirect_request(None, None, 302, "", {}, "https://example.org")


class PinAndPreparationTests(unittest.TestCase):
    def test_committed_pins_and_future_versions(self):
        image, tag = release.read_pins((release.ROOT / "docker-compose.yml").read_text())
        self.assertEqual(image, release.IMAGE + ":" + tag)
        self.assertEqual(release.read_pins(compose("v1.20.3")), (release.IMAGE + ":v1.20.3", "v1.20.3"))

    def test_pins_fail_closed(self):
        failures = [compose().replace("v0.8.8", "latest"), compose().replace("v0.8.8", "v0.8.8-rc1"),
                    compose().replace("v0.8.8", "v0.8.9", 1), compose().replace(release.REGISTRY, "ghcr.io"),
                    compose().replace("  librechat:", "  librechat:\n  librechat:"),
                    compose().replace("    restart:", "    image: duplicate\n    restart:"),
                    compose().replace("    restart:", "    image : duplicate\n    restart:"),
                    compose().replace("    restart:", "    'image': duplicate\n    restart:"),
                    compose().replace("    restart:", "    <<: *other\n    restart:"),
                    compose().replace("  govchat-retention:", "  removed:"),
                    compose().replace("services:", "services:\nservices:"),
                    compose().replace("services:", "'services': {}\nservices:"),
                    compose().replace("  librechat:", "  librechat : {}\n  librechat:"),
                    compose().replace("  librechat:", "  'librechat': {}\n  librechat:"),
                    compose().replace("services:", "services: {}\nnetworks:")]
        for text in failures:
            with self.subTest(text=text), self.assertRaises(release.ReleaseError):
                release.read_pins(text)

    def test_prepare_only_two_pins_preserves_mode_and_other_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "docker-compose.yml"
            original = compose() + "# keep this comment\n"
            path.write_text(original)
            path.chmod(0o640)
            release.prepare(path, original, "v0.9.0")
            self.assertEqual(path.read_text(), original.replace(":v0.8.8", ":v0.9.0"))
            self.assertEqual(path.stat().st_mode & 0o777, 0o640)
            self.assertEqual(list(Path(directory).iterdir()), [path])

    def test_no_downgrade_noop_or_concurrent_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "docker-compose.yml"
            original = compose()
            path.write_text(original)
            for tag in ("v0.8.7", "v0.8.8"):
                with self.assertRaises(release.ReleaseError):
                    release.prepare(path, original, tag)
                self.assertEqual(path.read_text(), original)
            path.write_text(original + "# changed\n")
            with self.assertRaisesRegex(release.ReleaseError, "changed"):
                release.prepare(path, original, "v0.9.0")

    def test_cli_never_prepares_after_network_failure_or_default_check(self):
        candidate = published("v0.9.0")
        with patch.object(release, "select_release", return_value=candidate), patch.object(release, "prepare") as prepare:
            with patch.object(release, "verify_manifest", side_effect=release.ReleaseError("missing")), self.assertRaises(SystemExit):
                release.main(["--prepare"])
            prepare.assert_not_called()
            with patch.object(release, "verify_manifest", return_value="sha256:" + "a" * 64), patch("builtins.print"):
                self.assertEqual(release.main([]), 0)
            prepare.assert_not_called()


if __name__ == "__main__":
    unittest.main()
