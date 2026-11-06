"""Isolated Chromium verification; never connects to a deployed chat service."""

import json
from pathlib import Path
import unittest

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
LOADER = (ROOT / "overlay/defaults/loader.js").read_text()
CSS = (ROOT / "overlay/defaults/custom.css").read_text()
DASHBOARD = (ROOT / "services/admin-overlay/admin/views/dashboard.html").read_text()


class ChatDisclaimerBrowserTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.page = self.browser.new_page()
        self.setting = True
        self.config_status = 200
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.route("**/*", self.route)

    def tearDown(self):
        self.page.close()
        self.assertEqual(self.errors, [])

    def route(self, route):
        if route.request.url.endswith("/api/config/ui"):
            if self.config_status == 200:
                self.setting = route.request.post_data_json["showChatDisclaimer"]
            route.fulfill(status=self.config_status, content_type="application/json",
                          body=json.dumps({"ok": self.config_status == 200}))
        elif route.request.url.endswith("/dashboard"):
            route.fulfill(content_type="text/html", body=DASHBOARD.replace(
                "{{chatDisclaimerChecked}}", "checked" if self.setting else ""))
        elif route.request.url.endswith("/govchat-overlay/ui-config.json"):
            route.fulfill(status=self.config_status, content_type="application/json",
                          body=json.dumps({"showChatDisclaimer": self.setting}))
        else:
            route.fulfill(content_type="text/html", body="""<!doctype html>
                <title>LAICA</title><textarea aria-label="Chatinvoer"></textarea>
                <div role="contentinfo" id="footer"><span>
                <a href="https://librechat.ai">LibreChat</a> v0.8.7 - Elke AI voor iedereen.
                </span></div><aside role="contentinfo">Andere informatie</aside>""")

    def boot(self, route="/c/new"):
        self.page.goto("https://chat.test" + route)
        self.page.evaluate("""() => {
            window.GOVCHAT_BRANDING = {appName: 'LAICA'};
            window.testTimers = {};
            window.setInterval = (callback, ms) => { window.testTimers[ms] = callback; return ms; };
        }""")
        self.page.add_style_tag(content=CSS)
        self.page.add_script_tag(content=LOADER)
        self.page.wait_for_timeout(100)

    def refresh_config(self):
        with self.page.expect_response("**/govchat-overlay/ui-config.json"):
            self.page.evaluate("window.testTimers[30000]()")
        self.page.wait_for_timeout(50)

    def test_visible_by_default_and_toggle_without_reload(self):
        self.boot()
        footer = self.page.locator("#footer span")
        self.assertEqual(footer.inner_text(), "LAICA kan fouten maken. Controleer belangrijke informatie.")
        self.assertTrue(footer.is_visible())
        self.assertEqual(self.page.locator("#footer a").count(), 0)
        self.assertTrue(self.page.get_by_label("Chatinvoer").is_visible())
        self.assertEqual(self.page.locator("aside").inner_text(), "Andere informatie")
        self.setting = False
        self.refresh_config()
        self.assertFalse(footer.is_visible())
        self.setting = True
        self.refresh_config()
        self.assertTrue(footer.is_visible())

    def test_disabled_setting_survives_remount_and_route_navigation(self):
        self.setting = False
        self.boot()
        self.assertFalse(self.page.locator("#footer span").is_visible())
        self.page.evaluate("""() => {
            document.querySelector('#footer').innerHTML =
              '<span><a href="https://librechat.ai">LibreChat</a> v0.8.7 - Elke AI voor iedereen.</span>';
            history.pushState({}, '', '/c/another-conversation');
        }""")
        self.assertFalse(self.page.locator("#footer span").is_visible())
        self.assertEqual(self.page.locator("#footer span").text_content(),
                         "LAICA kan fouten maken. Controleer belangrijke informatie.")

    def test_missing_configuration_and_untrusted_app_name(self):
        self.config_status = 404
        self.boot()
        self.assertTrue(self.page.locator("#footer span").is_visible())
        self.page.evaluate("""() => {
            window.GOVCHAT_BRANDING.appName = '<img src=x onerror=alert(1)>';
            window.testTimers[1000]();
        }""")
        self.assertEqual(self.page.locator("#footer img").count(), 0)
        self.assertIn("<img src=x onerror=alert(1)> kan fouten maken.",
                      self.page.locator("#footer span").inner_text())

    def test_login_footer_is_not_modified(self):
        self.boot("/login")
        self.assertIn("LibreChat", self.page.locator("#footer span").inner_text())
        self.assertEqual(self.page.locator("[data-govchat-disclaimer]").count(), 0)

    def test_dashboard_checkbox_saves_and_reports_errors(self):
        self.page.goto("https://chat.test/dashboard")
        checkbox = self.page.get_by_label("Waarschuwing onder chatinvoer tonen")
        self.assertTrue(checkbox.is_checked())
        checkbox.uncheck()
        self.page.get_by_role("button", name="Opslaan").click()
        self.page.get_by_role("status").filter(has_text="Opgeslagen.").wait_for()
        self.assertFalse(self.setting)
        self.page.reload()
        self.assertFalse(checkbox.is_checked())
        checkbox.check()
        self.config_status = 403
        self.page.get_by_role("button", name="Opslaan").click()
        self.page.get_by_role("status").filter(has_text="Opslaan mislukt.").wait_for()
        self.assertFalse(self.setting)
        self.assertTrue(self.page.get_by_role("button", name="Opslaan").is_enabled())


if __name__ == "__main__":
    unittest.main(verbosity=2)
