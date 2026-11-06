"""Configuration regressions; Docker integration is explicitly opt-in."""

import ast
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import unittest
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
IMAGE = os.environ.get("GOVCHAT_TEST_NGINX_IMAGE", "nginx:1.28-alpine")


def command(*args, check=True, env=None):
    result = subprocess.run(args, capture_output=True, text=True, timeout=60, env=env)
    if check and result.returncode:
        raise AssertionError(result.stderr or result.stdout)
    return result


@unittest.skipUnless(shutil.which("docker"), "Docker Compose CLI required")
class ComposeConfigurationTests(unittest.TestCase):
    def config(self, *files, **settings):
        # Do not import the production environment or interpolate real secrets.
        env = {"PATH": os.environ.get("PATH", ""), **settings}
        args = ["docker", "compose", "--env-file", str(ROOT / ".env.example"),
                "-f", str(ROOT / "docker-compose.yml")]
        for name in files:
            args.extend(["-f", str(ROOT / name)])
        return json.loads(command(*args, "config", "--format", "json", env=env).stdout)

    def test_base_defaults_and_no_optional_management(self):
        config = self.config("docker-compose.override.yml")
        services = config["services"]
        self.assertNotIn("management-proxy", services)
        self.assertEqual(services["mongodb"]["image"], "mongo:8.0.20")
        self.assertEqual(services["librechat"]["environment"]["OPENID_REUSE_TOKENS"], "true")
        self.assertEqual(services["librechat"]["environment"]["OPENID_ADMIN_ROLE"], "")
        self.assertEqual(services["librechat-proxy"]["environment"]["GOVCHAT_BLOCK_PASSWORD_AUTH"], "false")
        self.assertEqual(services["admin-panel"]["environment"]["API_SERVER_URL"], "http://librechat-proxy:3080")
        self.assertFalse(config["networks"]["librechat-net"].get("external", False))

    def test_portable_paths_network_image_and_context(self):
        config = self.config(GOVCHAT_DATA_ROOT="/srv/govchat-test", GOVCHAT_NETWORK_EXTERNAL="true",
                             GOVCHAT_NETWORK_NAME="review-network", MONGO_IMAGE="mongo:8.2",
                             N8N_OPENAI_BRIDGE_BUILD_CONTEXT="../bridge-test", LC_BIND_IP="127.0.0.1",
                             LC_PORT="4080", NGINX_TRUSTED_PROXIES_CONF_PATH="./nginx/ingress.local.conf",
                             NGINX_TRUSTED_PROXIES_GEO_PATH="./nginx/ingress.local.geo")
        network = config["networks"]["librechat-net"]
        self.assertEqual(network["name"], "review-network")
        self.assertTrue(network["external"])
        self.assertNotIn("driver", network)
        services = config["services"]
        self.assertEqual(services["mongodb"]["image"], "mongo:8.2")
        self.assertTrue(services["n8n-openai-bridge"]["build"]["context"].endswith("/bridge-test"))
        port = services["librechat-proxy"]["ports"][0]
        self.assertEqual((port["host_ip"], port["published"], port["target"]), ("127.0.0.1", "4080", 3080))
        for service in services.values():
            for volume in service.get("volumes", []):
                if volume["type"] == "bind":
                    self.assertFalse(volume["source"].startswith("/opt/librechat/"))
        trust = [v for v in services["librechat-proxy"]["volumes"] if v["target"].startswith("/etc/nginx/trusted")]
        self.assertTrue(all("ingress.local." in v["source"] and v["read_only"] for v in trust))

    def test_minimal_ui_is_opt_in_and_passed_to_app_and_proxy(self):
        for enabled in ("false", "true"):
            services = self.config("docker-compose.override.yml", GOVCHAT_MINIMAL_UI=enabled,
                                   ENDPOINTS="custom,agents")["services"]
            for name in ("librechat", "librechat-proxy"):
                self.assertEqual(services[name]["environment"]["GOVCHAT_MINIMAL_UI"], enabled)
            # Endpoint restriction belongs to runtime startup, not an unconditional override.
            self.assertEqual(services["librechat"]["environment"]["ENDPOINTS"], "custom,agents")
            mounts = {v["target"]: v for v in services["librechat-proxy"]["volumes"]}
            self.assertTrue(mounts["/opt/govchat/minimal.css"]["read_only"])
        defaults = self.config("docker-compose.override.yml")["services"]
        self.assertEqual(defaults["librechat"]["environment"]["GOVCHAT_MINIMAL_UI"], "false")

    def test_native_footer_default_override_empty_and_minimal_ui(self):
        warning = "GovChat-NL kan fouten maken. Controleer belangrijke informatie."
        for minimal in ("false", "true"):
            defaults = self.config("docker-compose.override.yml", GOVCHAT_MINIMAL_UI=minimal)
            self.assertEqual(defaults["services"]["librechat"]["environment"]["CUSTOM_FOOTER"], warning)
        cases = [
            ({"APP_TITLE": "Voorbeeld Chat"}, "Voorbeeld Chat kan fouten maken. Controleer belangrijke informatie."),
            ({"CUSTOM_FOOTER": "Eigen waarschuwing | Controleer bronnen"}, "Eigen waarschuwing | Controleer bronnen"),
            ({"CUSTOM_FOOTER": ""}, ""),
            ({"CUSTOM_FOOTER": "<b>letterlijk</b>\nTweede regel"}, "<b>letterlijk</b>\nTweede regel"),
        ]
        for settings, expected in cases:
            with self.subTest(settings=settings):
                config = self.config(**settings)
                self.assertEqual(config["services"]["librechat"]["environment"]["CUSTOM_FOOTER"], expected)

    def test_sso_policy_is_coherent_even_with_dev_seeder_enabled(self):
        config = self.config("docker-compose.override.yml", "docker-compose.sso-only.yml",
                             DEV_SEED_ADMIN_ENABLED="true", ALLOW_EMAIL_LOGIN="true",
                             GOVCHAT_BLOCK_PASSWORD_AUTH="false", ADMIN_SSO_ONLY="false")
        services = config["services"]
        env = services["librechat"]["environment"]
        for flag in ("ALLOW_EMAIL_LOGIN", "ALLOW_REGISTRATION", "ALLOW_PASSWORD_RESET"):
            self.assertEqual(env[flag], "false")
        self.assertEqual(env["OPENID_SCOPE"], "openid profile email")
        self.assertEqual(env["OPENID_GRAPH_SCOPES"], "")
        self.assertEqual(env["OPENID_REUSE_TOKENS"], "false")
        self.assertEqual(env["USE_ENTRA_ID_FOR_PEOPLE_SEARCH"], "false")
        self.assertEqual(env["OPENID_ON_BEHALF_FLOW_FOR_USERINFO_REQUIRED"], "false")
        self.assertEqual(services["librechat-proxy"]["environment"]["GOVCHAT_BLOCK_PASSWORD_AUTH"], "true")
        self.assertEqual(services["librechat-seed-admin"]["environment"]["DEV_SEED_ADMIN_ENABLED"], "false")
        self.assertEqual(services["admin-panel"]["environment"]["ADMIN_SSO_ONLY"], "true")

    def test_explicit_role_graph_and_login_configuration(self):
        config = self.config(OPENID_ADMIN_ROLE="Example.Admin", OPENID_ADMIN_ROLE_TOKEN_KIND="access",
                             OPENID_ADMIN_ROLE_PARAMETER_PATH="custom.roles", OPENID_GRAPH_SCOPES="",
                             OPENID_SCOPE="openid email", ALLOW_EMAIL_LOGIN="true",
                             OPENID_REUSE_TOKENS="false")
        env = config["services"]["librechat"]["environment"]
        self.assertEqual(env["OPENID_ADMIN_ROLE"], "Example.Admin")
        self.assertEqual(env["OPENID_ADMIN_ROLE_TOKEN_KIND"], "access")
        self.assertEqual(env["OPENID_ADMIN_ROLE_PARAMETER_PATH"], "custom.roles")
        self.assertEqual(env["OPENID_GRAPH_SCOPES"], "")
        self.assertEqual(env["ALLOW_EMAIL_LOGIN"], "true")

    def test_management_loopback_and_native_panel_build_path(self):
        config = self.config("docker-compose.sso-only.yml", "docker-compose.management.yml",
                             "docker-compose.admin-panel-build.yml", ADMIN_PANEL_BASE_PATH="/admin/",
                             N8N_PATH="/editor/", N8N_MANAGEMENT_PATH="/editor/",
                             QDRANT_MANAGEMENT_PATH="/vectors/", N8N_PROXY_HOPS="2",
                             N8N_EDITOR_BASE_URL="https://management.example.org/editor/",
                             N8N_WEBHOOK_URL="https://chat.example.org/n8n/")
        services = config["services"]
        self.assertTrue(all(p["host_ip"] == "127.0.0.1" for p in services["management-proxy"]["ports"]))
        panel = services["admin-panel"]
        self.assertEqual(panel["build"]["args"]["VITE_BASE_PATH"], "/admin/")
        self.assertEqual(panel["environment"]["VITE_BASE_PATH"], "/admin/")
        self.assertEqual(services["n8n"]["environment"]["N8N_PROXY_HOPS"], "2")
        self.assertEqual(services["n8n"]["environment"]["WEBHOOK_URL"], "https://chat.example.org/n8n/")
        self.assertNotIn("ports", services["n8n"])
        self.assertTrue(services["management-proxy"]["read_only"])


class PublicationSafetyTests(unittest.TestCase):
    def test_local_files_are_ignored_but_example_is_not(self):
        paths = [".env", "docker-compose.local.yml", "nginx/ingress.local.conf", "nginx/ingress.local.geo"]
        result = command("git", "-C", str(ROOT), "check-ignore", "--no-index", *paths)
        self.assertEqual(set(result.stdout.splitlines()), set(paths))
        self.assertNotEqual(command("git", "-C", str(ROOT), "check-ignore", ".env.example", check=False).returncode, 0)

    def test_renderer_executable_and_shell_syntax(self):
        script = ROOT / "scripts/render-proxy-config.sh"
        self.assertTrue(os.access(script, os.X_OK))
        command("sh", "-n", str(script))

    def test_browser_smoke_test_has_no_installation_default_or_saved_state(self):
        text = (ROOT / "scripts/test-management-access.py").read_text()
        ast.parse(text)
        self.assertIn('os.environ.get("MANAGEMENT_CODE_URL", "")', text)
        for term in ("storage_state", "screenshot", "record_video", "ignore_https_errors", "--no-sandbox"):
            self.assertNotIn(term, text)


@unittest.skipUnless(os.environ.get("GOVCHAT_DOCKER_TESTS") == "1", "Opt in with GOVCHAT_DOCKER_TESTS=1")
class ProxyIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.network = "govchat-review-" + uuid.uuid4().hex[:12]
        cls.containers = []
        cls.temp = tempfile.TemporaryDirectory(prefix="govchat-proxy-tests-")
        cls.addClassCleanup(cls.temp.cleanup)
        cls.addClassCleanup(cls.cleanup)
        command("docker", "image", "inspect", IMAGE)
        command("docker", "network", "create", "--internal", cls.network)
        cls.start_upstream("v1")

    @classmethod
    def cleanup(cls):
        for name in cls.containers:
            command("docker", "rm", "-f", name, check=False)
        command("docker", "network", "rm", cls.network, check=False)

    @classmethod
    def start_upstream(cls, version):
        path = Path(cls.temp.name) / (version + ".conf")
        servers = []
        for port in (3080, 5678, 6333, 7700, 3333):
            extra = ""
            if port == 5678:
                extra = ('add_header Set-Cookie "session=test; Path=/; HttpOnly" always; '
                         "location = /socket { return 200 '$http_upgrade|$http_connection'; } ")
            if port == 6333:
                extra = ("location = /assets.js { default_type application/javascript; "
                         "return 200 'const x=\"/dashboard/app.js\";'; } ")
            servers.append("server { listen " + str(port) + "; server_name _; " + extra +
                           "location / { default_type text/plain; return 200 '" + version +
                           "|$http_x_forwarded_proto|$http_x_forwarded_for'; } }")
        path.write_text("\n".join(servers))
        name = cls.network + "-" + version
        cls.containers.append(name)
        args = ["docker", "run", "-d", "--pull", "never", "--name", name, "--network", cls.network]
        for alias in ("librechat", "n8n", "qdrant", "meilisearch", "n8n-openai-bridge"):
            args.extend(["--network-alias", alias])
        command(*args, "-v", str(path) + ":/etc/nginx/conf.d/default.conf:ro", IMAGE)
        cls.upstream = name

    def proxy(self, mode="librechat", network=None, trust_directory=None, **settings):
        name = self.network + "-proxy-" + uuid.uuid4().hex[:8]
        self.containers.append(name)
        args = ["docker", "run", "-d", "--pull", "never", "--name", name, "--network", network or self.network,
                "--read-only", "--security-opt", "no-new-privileges:true", "--cap-drop", "ALL"]
        for cap in ("CHOWN", "SETUID", "SETGID"):
            args.extend(["--cap-add", cap])
        for directory in ("/var/cache/nginx", "/var/run", "/etc/nginx/conf.d"):
            args.extend(["--tmpfs", directory])
        for source, target in (
            ("scripts/render-proxy-config.sh", "/docker-entrypoint.d/40-govchat-config.sh"),
            ("nginx/librechat-overlay.conf", "/opt/govchat/nginx/librechat-overlay.conf"),
            ("nginx/management-proxy.conf", "/opt/govchat/nginx/management-proxy.conf"),
            ("nginx/trusted-proxies.conf", "/etc/nginx/trusted-proxies.conf"),
            ("nginx/trusted-proxies.geo", "/etc/nginx/trusted-proxies.geo"),
            ("overlay/minimal.css", "/opt/govchat/minimal.css"),
        ):
            source_path = ROOT / source
            if trust_directory and source.startswith("nginx/trusted-proxies."):
                source_path = Path(trust_directory) / Path(source).name
            args.extend(["-v", str(source_path) + ":" + target + ":ro"])
        for key, value in {"GOVCHAT_PROXY_CONFIG": mode, **settings}.items():
            args.extend(["-e", key + "=" + value])
        command(*args, IMAGE)
        time.sleep(1)
        return name

    def request(self, proxy, path="/", host="localhost", port=3080, headers=()):
        response = self.request_raw(proxy, path, host, port, headers)
        statuses = re.findall(r"HTTP/\d\.\d (\d{3})", response.stderr)
        return (int(statuses[-1]) if statuses else None), response.stdout

    def request_raw(self, proxy, path="/", host="localhost", port=3080, headers=()):
        args = ["docker", "exec", proxy, "wget", "-S", "-O", "-", "--header", "Host: " + host]
        for header in headers:
            args.extend(["--header", header])
        return command(*args, "http://127.0.0.1:" + str(port) + path, check=False)

    def test_rendering_without_optional_admin_and_password_login_compatibility(self):
        proxy = self.proxy(PUBLIC_BASE_URL="https://chat.example.org")
        config = command("docker", "exec", proxy, "cat", "/etc/nginx/conf.d/default.conf").stdout
        self.assertIn("chat.example.org localhost librechat-proxy", config)
        self.assertIn("$http_upgrade", config)
        self.assertIn("$govchat_admin_upstream", config)
        self.assertNotIn("${GOVCHAT_SERVER_NAMES}", config)
        self.assertIn('/govchat-overlay/loader.js', config)
        self.assertNotIn('${GOVCHAT_UI_HEAD}', config)
        self.assertEqual(self.request(proxy, "/api/auth/login")[0], 200)
        self.assertEqual(self.request(proxy, host="chat.example.org")[0], 200)
        self.assertIsNone(self.request(proxy, host="unknown.example.org")[0])

    def test_sso_blocks_normal_case_variants_and_trailing_slashes(self):
        proxy = self.proxy(GOVCHAT_BLOCK_PASSWORD_AUTH="true")
        for path in ("/api/auth/login", "/api/auth/register", "/api/auth/requestPasswordReset",
                     "/api/auth/resetPassword", "/API/AUTH/LOGIN/", "/api/auth/%6cogin",
                     "/api/admin/login/local", "/API/ADMIN/LOGIN/LOCAL/"):
            self.assertEqual(self.request(proxy, path)[0], 403, path)
        for path in ("/oauth/openid", "/oauth/openid/callback", "/api/auth/refresh",
                     "/api/admin/oauth/openid/callback"):
            self.assertEqual(self.request(proxy, path)[0], 200, path)

    def test_untrusted_forwarding_metadata_is_not_honored(self):
        proxy = self.proxy()
        status, body = self.request(proxy, headers=("X-Forwarded-Proto: https", "X-Forwarded-For: 192.0.2.100"))
        self.assertEqual(status, 200)
        self.assertIn("v1|http|", body)
        self.assertNotIn("192.0.2.100", body)

    def test_explicit_trust_files_enable_forwarding_only_for_trusted_peer(self):
        trust = Path(self.temp.name) / "trust"
        trust.mkdir()
        # Test-only loopback trust, never written to repository defaults.
        (trust / "trusted-proxies.conf").write_text("set_real_ip_from 127.0.0.1/32;\n")
        (trust / "trusted-proxies.geo").write_text("127.0.0.1/32 1;\n")
        proxy = self.proxy(trust_directory=trust)
        status, body = self.request(proxy, headers=("X-Forwarded-Proto: https", "X-Forwarded-For: 192.0.2.100"))
        self.assertEqual(status, 200)
        self.assertIn("v1|https|192.0.2.100", body)

    def test_branding_revalidates_cache_and_preserves_security_and_forwarding(self):
        proxy = self.proxy()
        for path in ("/assets/govchat-branding.js", "/assets/logo.svg",
                     "/assets/favicon-16x16.png", "/assets/apple-touch-icon-180x180.png",
                     "/assets/icon-192x192.png", "/assets/maskable-icon.png",
                     "/manifest.webmanifest"):
            with self.subTest(path=path):
                response = self.request_raw(proxy, path, headers=(
                    "X-Forwarded-Proto: https", "X-Forwarded-For: 192.0.2.100"))
                self.assertEqual(response.returncode, 0, response.stderr)
                for header in (
                    "Cache-Control: no-cache, must-revalidate, max-age=0",
                    "X-Content-Type-Options: nosniff", "X-Frame-Options: SAMEORIGIN",
                    "Referrer-Policy: strict-origin-when-cross-origin",
                    "Permissions-Policy: camera=(), geolocation=(), payment=(), usb=(), microphone=(self)",
                ):
                    self.assertIn(header, response.stderr)
                self.assertIn("v1|http|", response.stdout)
                self.assertNotIn("192.0.2.100", response.stdout)

    def test_management_starts_and_renders_custom_paths(self):
        proxy = self.proxy("management", N8N_MANAGEMENT_PATH="/editor/", QDRANT_MANAGEMENT_PATH="/vectors/")
        config = command("docker", "exec", proxy, "cat", "/etc/nginx/conf.d/default.conf").stdout
        self.assertIn("proxy_cookie_path / /editor/;", config)
        self.assertIn('"/vectors/dashboard', config)
        self.assertIn("$n8n_upstream$request_uri", config)
        self.assertEqual(self.request(proxy, "/healthz", port=8080)[0], 200)
        self.assertEqual(self.request(proxy, "/", port=8080)[0], 404)
        for port in (5678, 6333, 7700, 3333):
            self.assertEqual(self.request(proxy, "/", port=port)[0], 200)
        cookies = self.request_raw(proxy, port=5678).stderr
        self.assertIn("Path=/editor/", cookies)
        self.assertIn('"/vectors/dashboard/app.js"', self.request(proxy, "/assets.js", port=6333)[1])
        status, body = self.request(proxy, "/socket", port=5678,
                                    headers=("Upgrade: websocket", "Connection: Upgrade"))
        self.assertEqual(status, 200)
        self.assertEqual(body, "websocket|upgrade")

    def test_minimal_ui_replaces_launcher_and_serves_styles(self):
        proxy = self.proxy(GOVCHAT_MINIMAL_UI="true")
        config = command("docker", "exec", proxy, "cat", "/etc/nginx/conf.d/default.conf").stdout
        self.assertIn('minimal.css?v=1', config)
        self.assertNotIn('/govchat-overlay/loader.js', config)
        self.assertNotIn('${GOVCHAT_UI_HEAD}', config)
        status, css = self.request(proxy, '/govchat-overlay/minimal.css')
        self.assertEqual(status, 200)
        self.assertIn('#tools-dropdown-button', css)
        command("docker", "exec", proxy, "nginx", "-t")

    def test_invalid_values_fail_closed_without_config_injection(self):
        for mode, settings in (
            ("librechat", {"GOVCHAT_SERVER_NAMES": "example.org; return 200;"}),
            ("librechat", {"GOVCHAT_SERVER_NAMES": "*"}),
            ("librechat", {"GOVCHAT_BLOCK_PASSWORD_AUTH": "yes"}),
            ("librechat", {"GOVCHAT_MINIMAL_UI": "yes"}),
            ("librechat", {"GOVCHAT_MINIMAL_UI": "true; return 200;"}),
            ("librechat", {"PUBLIC_BASE_URL": "https://user:password@example.org"}),
            ("management", {"N8N_MANAGEMENT_PATH": "/bad;path/"}),
            ("management", {"MANAGEMENT_FORWARDED_PROTO": "https;"}),
        ):
            proxy = self.proxy(mode, **settings)
            state = json.loads(command("docker", "inspect", proxy).stdout)[0]["State"]
            self.assertFalse(state["Running"])
            self.assertNotEqual(state["ExitCode"], 0)

    def test_management_starts_without_any_upstream_services(self):
        network = self.network + "-empty"
        command("docker", "network", "create", "--internal", network)
        proxy = None
        try:
            proxy = self.proxy("management", network=network)
            self.assertEqual(self.request(proxy, "/healthz", port=8080)[0], 200)
            command("docker", "exec", proxy, "nginx", "-t")
        finally:
            if proxy:
                command("docker", "rm", "-f", proxy, check=False)
            command("docker", "network", "rm", network, check=False)

    def test_z_recreated_upstream_resolves_without_proxy_restart(self):
        proxy = self.proxy()
        self.assertIn("v1|", self.request(proxy)[1])
        old = self.upstream
        # Create the replacement before removing the old container, forcing a new IP.
        self.start_upstream("v2")
        command("docker", "rm", "-f", old)
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            if "v2|" in self.request(proxy)[1]:
                break
            time.sleep(2)
        else:
            self.fail("proxy did not re-resolve the replaced upstream")


if __name__ == "__main__":
    unittest.main()
