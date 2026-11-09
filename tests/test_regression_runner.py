"""Runner isolation/command tests; subprocess and Docker execution are mocked."""

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from scripts import run_regressions as runner
from scripts.librechat_release import ReleaseError, ROOT


class RunnerTests(unittest.TestCase):
    def test_environment_drops_secrets_and_integration_settings(self):
        with patch.dict(os.environ, {"OPENID_CLIENT_SECRET": "sentinel", "NODE_OPTIONS": "bad",
                         "NODE_PATH": "/private", "GOVCHAT_DOCKER_TESTS": "1", "COMPOSE_FILE": ".env",
                         "PUBLIC_BASE_URL": "https://private.example", "DOCKER_HOST": "tcp://private.example"}):
            env = runner.clean_env()
        self.assertEqual(set(env), {"PATH", "LANG", "CI", "PYTHONDONTWRITEBYTECODE", "GOVCHAT_DOCKER_TESTS"})
        self.assertEqual(env["GOVCHAT_DOCKER_TESTS"], "0")

    def test_public_path_allowlist_excludes_private_and_local_paths(self):
        for name in (".env", ".env.production", "runtime/config.json", "overlay/data/token.json",
                     "services/admin-overlay/data/config.json", "overlay/publish/policy.json",
                     "overlay/private/config.json", "docker-compose.upgrade-test.local.yml",
                     "nginx/ingress.local.conf", "tests/node_modules/package.json", "../scripts/a.js",
                     "/scripts/a.js", "scripts/.env", "scripts/__pycache__/a.pyc"):
            with self.subTest(name=name):
                self.assertFalse(runner.public_path(name))
        for name in (".env.example", "docker-compose.yml", "scripts/librechat_release.py", "overlay/defaults/apps.json"):
            self.assertTrue(runner.public_path(name))

    def test_snapshot_copies_only_public_tracked_files_and_committed_override(self):
        with tempfile.TemporaryDirectory() as directory:
            root, dest = Path(directory) / "repo", Path(directory) / "snapshot"
            root.mkdir()
            dest.mkdir()
            compose = (ROOT / "docker-compose.yml").read_bytes()
            (root / "docker-compose.yml").write_bytes(compose)
            (root / ".env").write_text("PRIVATE_SENTINEL")
            (root / ".env.example").write_text("PUBLIC_FIXTURE")
            (root / "docker-compose.override.yml").write_text("LOCAL_SENTINEL")
            (root / "scripts").mkdir()
            (root / "scripts/untracked.js").write_text("UNTRACKED_SENTINEL")
            tracked = b"docker-compose.yml\0.env\0.env.example\0docker-compose.override.yml\0"
            with patch.object(runner, "NEW_FILES", set()), patch.object(runner, "run"), patch.object(runner.subprocess, "check_output", side_effect=[tracked, b"services: {}\n"]):
                runner.snapshot(dest, root)
            self.assertEqual((dest / "docker-compose.yml").read_bytes(), compose)
            self.assertEqual((dest / "docker-compose.override.yml").read_text(), "services: {}\n")
            self.assertFalse((dest / ".env").exists())
            self.assertFalse((dest / "scripts/untracked.js").exists())

    def test_snapshot_refuses_symlinks_and_missing_tracked_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root, dest = Path(directory) / "repo", Path(directory) / "snapshot"
            root.mkdir()
            dest.mkdir()
            (root / "scripts").mkdir()
            (root / "scripts/link.js").symlink_to("/nonexistent-private-file")
            for name in ("scripts/link.js", "scripts/missing.js"):
                with patch.object(runner, "NEW_FILES", set()), patch.object(runner.subprocess, "check_output", return_value=(name + "\0").encode()), self.assertRaises(ReleaseError):
                    runner.snapshot(dest, root)

    def test_n8n_pin_and_exact_overlay_mounts_derive_from_compose(self):
        text = (ROOT / "docker-compose.yml").read_text()
        image, mounts = runner.n8n_spec(text)
        self.assertEqual(image, "docker.n8n.io/n8nio/n8n:2.25.7")
        self.assertEqual(len(mounts), 4)
        self.assertIn(("scripts/n8n-orchestrator-tool-policy.js", "/opt/govchat/n8n-orchestrator-tool-policy.js"), mounts)
        for invalid in (text.replace("${N8N_VERSION:-2.25.7}", "latest"),
                        text.replace("./scripts/n8n-toolCalculator.patched.js:", "./scripts/missing.js:"),
                        text.replace("/opt/govchat/n8n-orchestrator-tool-policy.js:ro", "/tmp/policy.js:ro")):
            with self.assertRaises(ReleaseError):
                runner.n8n_spec(invalid)

    def test_container_commands_have_no_network_secrets_or_writable_source(self):
        args = runner.container_args(Path("/tmp/public-snapshot"), "example:image", ["node", "--test", "tests/a.test.js"])
        self.assertEqual(args[args.index("--network") + 1], "none")
        self.assertIn("type=bind,source=/tmp/public-snapshot,target=/repo,readonly", args)
        self.assertIn("CI=true", args)
        self.assertIn("NODE_PATH=/app/node_modules", args)
        self.assertNotIn("--env-file", args)
        self.assertNotIn("--publish", args)
        self.assertNotIn("--privileged", args)
        self.assertNotIn("/var/run/docker.sock", " ".join(args))

    def test_docker_commands_use_temporary_empty_client_configuration(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(runner.subprocess, "run") as execute:
            runner.run(["docker", "image", "inspect", "example:image"], Path(directory))
            config = Path(directory) / ".regression-docker-config"
            self.assertTrue(config.is_dir())
            self.assertEqual(list(config.iterdir()), [])
            self.assertEqual(config.stat().st_mode & 0o777, 0o700)
            self.assertEqual(execute.call_args.kwargs["env"]["DOCKER_CONFIG"], str(config))

    def test_offline_never_runs_builds_or_pulls_containers(self):
        with patch.object(runner, "run") as run:
            runner.execute_suite(ROOT, offline=True)
        for call in run.call_args_list:
            args = list(map(str, call.args[0]))
            self.assertNotEqual(args[0], "docker")
            self.assertNotIn("run-image-loader-test.js", " ".join(args))

    def test_full_suite_commands_use_unique_admin_image_and_isolated_python(self):
        with patch.object(runner, "run") as run, patch.object(runner.subprocess, "run") as cleanup:
            runner.execute_suite(ROOT)
        commands = [call.args[0] for call in run.call_args_list]
        self.assertTrue(any(command[-1] == "tests/orchestrator/run-document-smoke.js" for command in commands))
        builds = [command for command in commands if command[:2] == ["docker", "build"]]
        self.assertEqual(len(builds), 1)
        admin_image = builds[0][3]
        self.assertTrue(admin_image.startswith("govchat-regression-admin:"))
        self.assertEqual(cleanup.call_args.args[0], ["docker", "image", "rm", admin_image])
        python_call = run.call_args_list[-1]
        self.assertEqual(python_call.args[2]["GOVCHAT_DOCKER_TESTS"], "1")
        for command in commands:
            self.assertNotIn("up", command)
            self.assertNotIn(".env", command)

    def test_build_failure_still_cleans_only_unique_test_image(self):
        def fail_build(args, *unused):
            if args[:2] == ["docker", "build"]:
                raise runner.subprocess.CalledProcessError(1, args)
        with patch.object(runner, "run", side_effect=fail_build), patch.object(runner.subprocess, "run") as cleanup, self.assertRaises(runner.subprocess.CalledProcessError):
            runner.execute_suite(ROOT)
        self.assertEqual(cleanup.call_args.args[0][:3], ["docker", "image", "rm"])
        self.assertTrue(cleanup.call_args.args[0][3].startswith("govchat-regression-admin:"))


if __name__ == "__main__":
    unittest.main()
