#!/usr/bin/env python3
"""Run public regressions in a secret-free snapshot, never deployment Compose up."""

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

if __package__:
    from .librechat_release import ROOT, ReleaseError, read_pins, service_block
else:
    from librechat_release import ROOT, ReleaseError, read_pins, service_block

# Only public, tracked source is copied. No ignored/untracked integration assets.
DIRECTORIES = {"agents", "branding", "custom-branding", "overlay", "scripts", "tests",
               "services", "nginx", "litellm", "n8n", "bridge", "cron", "n8n-openai-bridge"}
FILES = {".env.example", ".gitignore", ".gitattributes", "librechat.yaml", "docker-compose.yml",
         "docker-compose.override.yml", "docker-compose.sso-only.yml", "docker-compose.management.yml",
         "docker-compose.admin-panel-build.yml"}
# Permit this change set before the maintainer's first commit, not arbitrary untracked files.
NEW_FILES = {"scripts/librechat_release.py", "scripts/librechat-release-pin.js", "scripts/run_regressions.py",
             "tests/test_librechat_release.py", "tests/test_regression_runner.py", "tests/librechat-release-pin.test.js",
             "scripts/orchestrator-image-workflow.js", "tests/image-tool-identity.test.js",
             "tests/orchestrator/n8n-image-integration.test.js"}
SOURCE_TEST_PATTERNS = ["tests/*.test.js", "tests/branding/*.test.js", "tests/agents/*.test.js",
                        "agents/beleidskompas/*.test.js",
                        "overlay/src/apps/beleidskompas/tests/*.test.js", "tests/overlay/*.test.js"]


def clean_env():
    # Do not inherit integration URLs/tokens, NODE_OPTIONS, Compose or test overrides.
    return {"PATH": os.environ.get("PATH", ""), "LANG": "C.UTF-8", "CI": "true",
            "PYTHONDONTWRITEBYTECODE": "1", "GOVCHAT_DOCKER_TESTS": "0"}


def run(args, cwd, env=None):
    print("+ " + " ".join(map(str, args)), flush=True)
    environment = env or clean_env()
    if str(args[0]) == "docker":
        config = Path(cwd) / ".regression-docker-config"
        config.mkdir(mode=0o700, exist_ok=True)
        environment = {**environment, "DOCKER_CONFIG": str(config)}
    subprocess.run(list(map(str, args)), cwd=cwd, env=environment, check=True)


def public_path(name):
    path = Path(name)
    return (not path.is_absolute() and ".." not in path.parts
            and (name in FILES or path.parts[0] in DIRECTORIES)
            and not any(part in {"node_modules", "runtime", "data", "private", "publish", ".git", "__pycache__"}
                        or part == ".env" or part.startswith(".env.") and name != ".env.example"
                        or ".local." in part for part in path.parts))


def snapshot(destination, root=ROOT):
    # TemporaryDirectory defaults to 0700. The sanitized public source mount
    # must be traversable by the official images' non-root users.
    destination.chmod(0o755)
    tracked = subprocess.check_output(["git", "ls-files", "-z"], cwd=root, env=clean_env()).decode().split("\0")
    for name in sorted(set(filter(None, tracked)) | NEW_FILES):
        if not public_path(name):
            continue
        source = root / name
        # Reject symlinks (including parent directories) rather than follow them.
        if any((root / Path(*Path(name).parts[:i])).is_symlink() for i in range(1, len(Path(name).parts) + 1)):
            raise ReleaseError(f"Refusing source symlink: {name}")
        if not source.is_file():
            raise ReleaseError(f"Missing public source: {name}")
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if name == "docker-compose.override.yml":
            # This public override is a regression fixture, never a local override.
            target.write_bytes(subprocess.check_output(["git", "show", "HEAD:" + name], cwd=root, env=clean_env()))
        else:
            shutil.copy2(source, target)
    # Existing publication safety tests need a repository for git check-ignore.
    # No stage, commit, push or access to the original repository metadata.
    run(["git", "init", "--quiet", destination], destination)
    read_pins((destination / "docker-compose.yml").read_text())


def n8n_spec(text):
    block = service_block(text, "n8n").group(1)
    images = re.findall(r"^    image: docker\.n8n\.io/n8nio/n8n:\$\{N8N_VERSION:-(\d+\.\d+\.\d+)\}[ \t]*$", block, re.M)
    if len(images) != 1:
        raise ReleaseError("Expected one pinned n8n default")
    sources = {"scripts/n8n-orchestrator-tool-policy.js", "scripts/n8n-toolCalculator.patched.js",
               "scripts/n8n-createAgentSequence.patched.js", "scripts/n8n-processEventStream.patched.js"}
    mounts = re.findall(r"^      - \./(scripts/[^:\s]+):(/[^:\s]+):ro[ \t]*$", block, re.M)
    mounts = [(source, target) for source, target in mounts if source in sources]
    if len(mounts) != 4 or {source for source, _ in mounts} != sources or len({target for _, target in mounts}) != 4:
        raise ReleaseError("Expected all three n8n overlays and /opt/govchat policy mount")
    if not all(target.startswith("/usr/local/lib/node_modules/n8n/") if "patched" in source
               else target == "/opt/govchat/n8n-orchestrator-tool-policy.js" for source, target in mounts):
        raise ReleaseError("Unexpected n8n overlay destination")
    return f"docker.n8n.io/n8nio/n8n:{images[0]}", mounts


def node_tests(source, patterns):
    files = sorted({str(path.relative_to(source)) for pattern in patterns for path in source.glob(pattern)})
    if not files:
        raise ReleaseError("No tests matched")
    return ["node", "--test", "--test-concurrency=2", *files]


def container_args(source, image, command, mounts=()):
    args = ["docker", "run", "--rm", "--pull", "never", "--network", "none",
            "--security-opt", "no-new-privileges:true", "--cap-drop", "ALL",
            "--env", "CI=true", "--env", "NODE_PATH=/app/node_modules",
            "--mount", f"type=bind,source={source},target=/repo,readonly", "--workdir", "/repo"]
    for name, target in mounts:
        args += ["--mount", f"type=bind,source={source / name},target={target},readonly"]
    return [*args, "--entrypoint", "node", image, *command[1:]]


def execute_suite(source, offline=False):
    text = (source / "docker-compose.yml").read_text()
    image, tag = read_pins(text)
    if offline:
        run(node_tests(source, ["tests/librechat-release-pin.test.js"]), source)
        run(["node", "tests/translations/run-tests.js"], source)
        run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py", "-v"], source)
        print("OFFLINE ONLY: tooling, translation fixtures and Python tests; public image suite, admin, n8n and proxy integration not validated.")
        return
    n8n_image, mounts = n8n_spec(text)
    nginx_image = "nginx:1.28-alpine"  # same isolated proxy-test default
    admin_image = "govchat-regression-admin:" + uuid.uuid4().hex
    for pinned in (image, n8n_image, nginx_image):
        run(["docker", "pull", pinned], source)
    try:
        run(["docker", "build", "--tag", admin_image, "services/admin-overlay/admin"], source)
        # Fail rather than let upstream contract tests silently skip in a wrong image.
        preflight = ("const fs=require('node:fs'); const assert=require('node:assert/strict');"
                     f"assert.equal(JSON.parse(fs.readFileSync('/app/package.json')).version,{tag!r});"
                     "for(const p of ['/app/api/package.json','/app/client/src/components/Chat/Footer.tsx'])"
                     "assert.ok(fs.existsSync(p),p);")
        run(container_args(source, image, ["node", "-e", preflight]), source)
        run(container_args(source, image, node_tests(source, SOURCE_TEST_PATTERNS)), source)
        for script in ("tests/translations/run-tests.js", "tests/translations/run-image-loader-test.js"):
            run(container_args(source, image, ["node", script]), source)
        run(container_args(source, admin_image, node_tests(source, ["tests/orchestrator/name*.test.js", "tests/orchestrator/prompt*.test.js", "tests/orchestrator/utility*.test.js"])), source)
        run(container_args(source, n8n_image, ["node", "--test", "tests/orchestrator/n8n-utility-integration.test.js",
                                             "tests/orchestrator/n8n-image-integration.test.js"], mounts), source)
        run(container_args(source, n8n_image, ["node", "tests/orchestrator/run-document-smoke.js"]), source)
        env = {**clean_env(), "GOVCHAT_DOCKER_TESTS": "1",
               "DOCKER_CONFIG": str(source / ".regression-docker-config")}
        run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py", "-v"], source, env)
    finally:
        # Remove only the unique regression image, never any deployment image/container.
        subprocess.run(["docker", "image", "rm", admin_image], cwd=source,
                       env={**clean_env(), "DOCKER_CONFIG": str(source / ".regression-docker-config")}, check=False)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true", help="No container run/build/pull; image/admin/n8n/proxy tests excluded")
    args = parser.parse_args(argv)
    try:
        with tempfile.TemporaryDirectory(prefix="govchat-regression-") as directory:
            source = Path(directory)
            snapshot(source)
            execute_suite(source, args.offline)
    except (ReleaseError, subprocess.CalledProcessError, OSError) as exc:
        parser.exit(1, f"Regression failed: {exc}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
