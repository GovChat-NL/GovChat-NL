"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const read = filename => fs.readFileSync(path.join(root, filename), "utf8");
const librechatRoot = process.env.GOVCHAT_TEST_LIBRECHAT_ROOT || "/app";
const footerPath = path.join(librechatRoot, "client/src/components/Chat/Footer.tsx");
const nativeAvailable = fs.existsSync(footerPath);

test("native footer configuration preserves explicit empty values", () => {
  assert.match(read("docker-compose.yml"), /CUSTOM_FOOTER: "\$\{CUSTOM_FOOTER-\$\{APP_TITLE:-GovChat-NL\} kan fouten maken\. Controleer belangrijke informatie\.\}"/);
  assert.match(read(".env.example"), /^# CUSTOM_FOOTER=$/m);
  assert.doesNotMatch(read(".env.example"), /^CUSTOM_FOOTER=/m);
});

test("removed disclaimer assets and admin policy are no longer loaded", () => {
  for (const filename of ["overlay/defaults/chat-disclaimer.js", "overlay/defaults/chat-disclaimer.css",
    "overlay/defaults/ui-config.json", "services/admin-overlay/admin/defaults/ui-config.json"]) {
    assert.equal(fs.existsSync(path.join(root, filename)), false, filename);
  }
  const renderer = read("scripts/render-proxy-config.sh");
  assert.doesNotMatch(renderer, /chat-disclaimer\.(?:js|css)/);
  const server = read("services/admin-overlay/admin/server.js");
  assert.doesNotMatch(server, /showChatDisclaimer|chatDisclaimerChecked|readUIConfig|chat-disclaimer\.(?:js|css)/);
  assert.match(server, /registerNameRoutes\(app/);
  assert.match(server, /registerPromptRoutes\(app/);
  assert.doesNotMatch(read("services/admin-overlay/admin/views/dashboard.html"), /show-chat-disclaimer/);
});

test("help overlay cannot overwrite the native footer and minimal CSS does not hide it", () => {
  assert.doesNotMatch(read("overlay/src/overlay.js"), /applyFooterBranding|footerBrandText|footerBrandUrl/);
  for (const filename of ["overlay/src/custom.css", "overlay/minimal.css"]) {
    assert.doesNotMatch(read(filename), /contentinfo[^}]*display\s*:\s*none/);
  }
});

async function loadNativeFooter(config) {
  const React = require("react");
  const ts = require("typescript");
  const ReactMarkdown = (await import(pathToFileURL(require.resolve("react-markdown")).href)).default;
  const source = fs.readFileSync(footerPath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
    fileName: footerPath,
  }).outputText;
  const module = { exports: {} };
  const dependencies = {
    react: React,
    "react-markdown": ReactMarkdown,
    "react-gtm-module": { initialize() {} },
    "librechat-data-provider": { Constants: { VERSION: "test-version" } },
    "~/data-provider": { useGetStartupConfig: () => ({ data: config }) },
    "~/hooks": { useLocalize: () => key => key },
  };
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), "Unexpected upstream dependency: " + name);
      return dependencies[name];
    },
  }, { filename: footerPath });
  return props => require("react-dom/server").renderToStaticMarkup(
    React.createElement(module.exports.default, props || {}));
}

test("pinned native footer renders configured warning instead of upstream branding", { skip: !nativeAvailable }, async () => {
  const warning = "GovChat-NL kan fouten maken. Controleer belangrijke informatie.";
  const render = await loadNativeFooter({ customFooter: warning });
  const html = render();
  assert.ok(html.includes(warning));
  assert.equal(html.split(warning).length - 1, 1);
  assert.doesNotMatch(html, /test-version|librechat\.ai/);
  // v0.8.8 uses an absolutely positioned band, without the old contentinfo role.
  const cssClasses = html.match(/class="([^"]*items-center[^"]*)"/)[1];
  assert.match(cssClasses, /hidden/);
  assert.match(cssClasses, /sm:flex/);
});

test("pinned conversation footer retains configured text but omits generic branding", { skip: !nativeAvailable }, async () => {
  const render = await loadNativeFooter({ customFooter: "Controleer belangrijke informatie." });
  assert.match(render({ configuredOnly: true }), /Controleer belangrijke informatie\./);
  assert.doesNotMatch(render({ configuredOnly: true }), /test-version|librechat\.ai/);
  const unconfigured = await loadNativeFooter({});
  assert.equal(unconfigured({ configuredOnly: true }), "");
});

test("pinned footer accepts resolved startup configuration without replacing it", { skip: !nativeAvailable }, async () => {
  const render = await loadNativeFooter({ customFooter: "Fetched fallback" });
  const html = render({ startupConfig: { customFooter: "Resolved warning" }, configuredOnly: true });
  assert.match(html, /Resolved warning/);
  assert.doesNotMatch(html, /Fetched fallback/);
});

test("pinned native footer preserves empty override while retaining legal links", { skip: !nativeAvailable }, async () => {
  const render = await loadNativeFooter({ customFooter: "", interface: {
    privacyPolicy: { externalUrl: "https://example.org/privacy" },
    termsOfService: { externalUrl: "https://example.org/terms" },
  } });
  const html = render();
  assert.doesNotMatch(html, /test-version|librechat\.ai|kan fouten maken/);
  assert.match(html, /https:\/\/example\.org\/privacy/);
  assert.match(html, /https:\/\/example\.org\/terms/);
});

test("pinned native footer handles Markdown without executing raw HTML", { skip: !nativeAvailable }, async () => {
  const render = await loadNativeFooter({ customFooter: "**Controleer bronnen** | <img src=x onerror=alert(1)>" });
  const html = render();
  assert.match(html, /<strong>Controleer bronnen<\/strong>/);
  assert.doesNotMatch(html, /<img|<script/);
});

test("pinned native config routes forward an explicitly empty footer", { skip: !nativeAvailable }, () => {
  const routes = ["api/server/routes/config.js", "packages/api/src/shared-links/config.ts"];
  for (const filename of routes) {
    const source = fs.readFileSync(path.join(librechatRoot, filename), "utf8");
    const expression = source.match(/if \(typeof (?:process\.)?env\.CUSTOM_FOOTER === ['"]string['"]\) \{\s*payload\.customFooter = (?:process\.)?env\.CUSTOM_FOOTER;\s*\}/);
    assert.ok(expression, "Native footer contract changed in " + filename);
    for (const value of ["", "Voorbeeldwaarschuwing"]) {
      const payload = {};
      vm.runInNewContext(expression[0], { env: { CUSTOM_FOOTER: value }, process: { env: { CUSTOM_FOOTER: value } }, payload });
      assert.equal(payload.customFooter, value);
    }
  }
});
