"""Optional code-server ingress smoke test; credentials arrive only via stdin."""

import json
import os
import re
import sys
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print("PASS", message)


def https_url(value):
    parts = urlsplit(value)
    if (parts.scheme != "https" or not parts.hostname or parts.username
            or parts.password or parts.query or parts.fragment):
        raise ValueError("Management URL must be explicit HTTPS without credentials/query/fragment")
    return value.rstrip("/")


def prefix(name, default):
    value = os.environ.get(name, default)
    if not re.fullmatch(r"/([A-Za-z0-9_-]+/)*", value):
        raise ValueError("Management prefixes must be absolute plain paths with a trailing slash")
    return value


def port(name, default):
    value = os.environ.get(name, str(default))
    if not value.isascii() or not value.isdigit() or not 1 <= int(value) <= 65535:
        raise ValueError("Invalid management port")
    return value


def run():
    base = https_url(os.environ.get("MANAGEMENT_CODE_URL", ""))
    n8n_path = prefix("N8N_MANAGEMENT_PATH", "/proxy/" + port("N8N_MANAGEMENT_PORT", 5678) + "/")
    qdrant_path = prefix("QDRANT_MANAGEMENT_PATH", "/proxy/" + port("QDRANT_MANAGEMENT_PORT", 6333) + "/")
    admin_path = prefix("ADMIN_PANEL_BASE_PATH", "/absproxy/" + port("ADMIN_PANEL_PORT", 3100) + "/")
    meili_path = "/proxy/" + port("MEILI_MANAGEMENT_PORT", 7700) + "/"
    bridge_path = "/proxy/" + port("BRIDGE_MANAGEMENT_PORT", 3333) + "/"
    legacy = os.environ.get("MANAGEMENT_LEGACY_ADMIN_URL", "")
    if legacy:
        legacy = https_url(legacy)
    password = json.load(sys.stdin).get("password")
    check(isinstance(password, str) and bool(password), "password supplied locally")

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        context = browser.new_context()
        try:
            for path in (n8n_path + "rest/settings", qdrant_path + "collections",
                         meili_path + "health", bridge_path + "v1/models",
                         admin_path + "assets/missing.js"):
                response = context.request.get(base + path, max_redirects=0)
                check(response.status == 401, "unauthenticated management route blocked")
            if legacy:
                response = context.request.get(legacy + "/", max_redirects=0)
                check(response.status == 404, "legacy public panel route closed")

            page = context.new_page()
            page.goto(base + "/login", wait_until="domcontentloaded")
            page.locator('input[name="password"]').fill(password)
            page.locator('button[type="submit"], input[type="submit"]').first.click()
            page.wait_for_url(lambda url: "/login" not in urlsplit(url).path, timeout=30000)
            check(True, "authenticated ingress login succeeded")
            page.close()

            for name, path, expected in (
                ("n8n", n8n_path, "Sign in|Set up owner account"),
                ("Qdrant", qdrant_path + "dashboard", "Collections"),
                ("admin panel", admin_path, "Sign in"),
            ):
                page = context.new_page()
                errors, bad_assets = [], []
                page.on("pageerror", lambda _error: errors.append(True))

                def inspect_response(response):
                    if (response.status >= 400 and
                            response.request.resource_type in ("script", "stylesheet")):
                        bad_assets.append(True)

                page.on("response", inspect_response)
                response = page.goto(base + path, wait_until="domcontentloaded")
                check(response.status == 200, name + " HTML available")
                page.get_by_text(re.compile(expected, re.I)).first.wait_for(timeout=45000)
                page.wait_for_timeout(2500)
                check(not bad_assets, name + " scripts/styles load")
                check(not errors, name + " no JavaScript errors")
                check("/login" not in urlsplit(page.url).path, name + " stays behind ingress")
                page.close()

            for path in (n8n_path + "healthz", qdrant_path + "collections", meili_path + "health"):
                response = context.request.get(base + path)
                check(response.status == 200, "authenticated backend reachable")
        finally:
            context.close()
            browser.close()


if __name__ == "__main__":
    try:
        run()
    except Exception:
        # Browser exceptions may contain private URLs, query values or cookies.
        print("FAIL management smoke test; inspect the ingress locally", file=sys.stderr)
        sys.exit(1)
