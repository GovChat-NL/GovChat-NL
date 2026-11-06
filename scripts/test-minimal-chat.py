"""Read-only browser smoke test of the minimal LibreChat deployment.

Requires Playwright/Chromium and local Docker access. Uses an existing admin's
five-minute access token in memory; no account, session or conversation is created.
Only the browser's refresh response is stubbed, not the server's SSO configuration.
"""

import json
import os
import subprocess

from playwright.sync_api import sync_playwright


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print("PASS", message)


def test_auth():
    source = """
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const u = await mongoose.connection.db.collection('users').findOne({role:'ADMIN'});
  if (!u) throw Error('An existing admin is required');
  const user = Object.fromEntries(['_id','name','username','email','provider','role',
    'avatar','personalization','createdAt'].filter(k => u[k] !== undefined).map(k => [k,u[k]]));
  const token = jwt.sign({id:u._id,username:u.username,provider:u.provider,email:u.email},
    process.env.JWT_SECRET,{expiresIn:300});
  process.stdout.write(JSON.stringify({user,token}));
  await mongoose.disconnect();
})().catch(() => process.exit(1));
"""
    result = subprocess.run(
        ["docker", "exec", "librechat", "node", "-e", source],
        check=True, capture_output=True, text=True,
    )
    return json.loads(result.stdout)


def run():
    base = os.environ["LIBRECHAT_TEST_URL"].rstrip("/")
    auth = test_auth()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            for width in (1440, 390):
                context = browser.new_context(viewport={"width": width, "height": 900})
                context.route("**/api/auth/refresh", lambda route: route.fulfill(json=auth))
                page = context.new_page()
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(base + "/c/new", wait_until="domcontentloaded")
                text = page.get_by_test_id("text-input")
                text.wait_for(state="visible", timeout=60000)
                page.wait_for_timeout(2000)
                headers = {"Authorization": "Bearer " + auth["token"]}
                config = page.request.get(base + "/api/config", headers=headers).json()
                interface = config["interface"]
                check(interface["prompts"] is True, "prompt library enabled")
                for feature in ("modelSelect", "parameters", "presets", "multiConvo",
                                "bookmarks", "memories", "agents", "temporaryChat",
                                "runCode", "webSearch", "fileSearch", "skills", "sharedLinks"):
                    check(interface[feature] is False, feature + " disabled")
                endpoints = page.request.get(base + "/api/endpoints", headers=headers).json()
                check(list(endpoints) == ["govchat-orchestrator"], "one fixed chat endpoint")
                for role in ("USER", "ADMIN"):
                    permissions = page.request.get(
                        base + "/api/roles/" + role, headers=headers,
                    ).json()["permissions"]
                    check(permissions["PROMPTS"]["USE"], role + " can use prompts")
                    check(not permissions["AGENTS"]["USE"], role + " agents disabled")
                check(page.locator('script[src*="govchat-overlay/loader.js"]').count() == 0,
                      "no help modal or app launcher script")
                check(page.locator("#gc-help-btn, #gc-launcher-btn").count() == 0,
                      "no extra overlay buttons")
                check(not page.get_by_test_id("parameters-button").is_visible(),
                      "parameters button absent")
                artifact_controls = page.locator(
                    'button[aria-label="Artefacten"], button[aria-label="Artifacts"], '
                    'button[aria-label="Tools Options"]',
                )
                check(all(not control.is_visible() for control in artifact_controls.all()),
                      "artifact controls and tools menu hidden")
                check(page.locator('button[aria-label="Attach File Options"]').is_visible(),
                      "upload button available")
                opener = page.get_by_test_id("open-sidebar-button")
                if opener.is_visible():
                    opener.click()
                prompts = page.get_by_test_id("nav-panel-prompts")
                prompts.wait_for(state="visible", timeout=10000)
                files = page.get_by_test_id("nav-panel-files")
                check(files.is_visible(), "file management button available")
                files.click()
                page.wait_for_timeout(500)
                prompts.click()
                page.wait_for_timeout(800)
                check(not errors, "no browser JavaScript errors")
                check(True, "chat and prompt library available at width " + str(width))
                context.close()
        finally:
            browser.close()


if __name__ == "__main__":
    run()
