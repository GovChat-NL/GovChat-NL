"use strict";
// Run with the isolated NODE_PATH/PLAYWRIGHT_BROWSERS_PATH documented in README.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const expect = require("playwright/test").expect.configure({ timeout: 6000 });
const { startFixture, model } = require("./browser-fixture.cjs");
const evidence = path.join(__dirname, "evidence");
const adminHeaders = { cookie: "authfixture=manual-browser-admin", "content-type": "application/json" };
const results = [];
const metrics = {};
let fixture, browser;

async function api(route, method = "GET", body) {
  const response = await fetch(fixture.base + "/api/admin/manual" + route, { method, headers: adminHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data;
}
function revisions(state) { return { baseRevision: state.baseRevision, draftRevision: state.draftRevision }; }
async function publish(value = model()) { const state = await api(""); const draft = await api("/draft", "PUT", { ...revisions(state), model: value }); return api("/publish", "POST", revisions(draft)); }
async function context(options = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...options });
  ctx.setDefaultTimeout(6000);
  await ctx.addCookies([{ name: "authfixture", value: "manual-browser-admin", url: fixture.base }]);
  await ctx.route("**/*", route => new URL(route.request().url()).origin === fixture.base ? route.continue() : route.abort("blockedbyclient"));
  return ctx;
}
async function chat(ctx, url = "/c/fixture-conversation") {
  const page = await ctx.newPage(); page.errors = []; page.on("pageerror", e => page.errors.push(e.message));
  await page.goto(fixture.base + url); await page.waitForFunction(() => window.fixtureReady === true); return page;
}
async function opened(page, id = "welkom") { await expect(page.locator("#gc-manual-modal")).toBeVisible(); await expect(page.locator(`[data-manual-passage="${id}"]`)).toBeVisible(); }
async function close(page) { await page.getByRole("button", { name: "Handleiding sluiten" }).click(); await expect(page.locator("#gc-manual-modal")).toHaveCount(0); }
async function screenshot(page, name) { await page.screenshot({ path: path.join(evidence, name + ".png"), fullPage: name === "manual-editor" || name === "manual-print", animations: "disabled" }); }
async function test(name, fn) {
  const start = Date.now(); const contexts = [];
  const makeContext = async opts => { const c = await context(opts); contexts.push(c); return c; };
  try { fixture.setRestrictedShares(false); await publish(); await fn(makeContext); results.push({ name, status: "passed", durationMs: Date.now() - start }); console.log("PASS", name); }
  catch (error) { results.push({ name, status: "failed", error: error.message, durationMs: Date.now() - start }); console.error("FAIL", name, error.message); }
  finally { for (const c of contexts) { await c.unrouteAll({ behavior: 'ignoreErrors' }); await c.close(); } }
}

async function main() {
  fs.mkdirSync(evidence, { recursive: true }); fixture = await startFixture(); browser = await chromium.launch({ headless: true });
  try {
    await test("desktop modal, focus trap, dynamic inert and exact restore", async make => {
      const p = await chat(await make()); await p.evaluate(() => { document.body.style.overflow = "scroll"; document.body.style.minHeight = '2000px'; document.getElementById('fixture-chat').style.marginTop = '300px'; window.scrollTo(0, 200); });
      const scrollBefore = await p.evaluate(() => window.scrollY);
      await p.locator("#manual-open").click(); await opened(p);
      await expect(p.locator("#fixture-chat")).toHaveJSProperty("inert", true);
      await p.evaluate(() => { const div = document.createElement("div"); div.id = "late-route"; document.body.append(div); });
      await expect(p.locator("#late-route")).toHaveJSProperty("inert", true);
      for (let i = 0; i < 20; i++) { await p.keyboard.press("Tab"); assert.equal(await p.evaluate(() => document.getElementById("gc-manual-modal").contains(document.activeElement)), true); }
      await p.getByRole("button", { name: "Volledig scherm", exact: true }).click(); await expect(p.locator("#gc-manual-modal")).toHaveClass(/gc-manual-full/);
      await p.getByRole("button", { name: "Vensterweergave", exact: true }).click();
      await screenshot(p, "manual-desktop"); await p.keyboard.press("Escape");
      await expect(p.locator("#manual-open")).toBeFocused(); await expect(p.locator("#fixture-chat")).toHaveJSProperty("inert", false);
      await expect(p.locator("#late-route")).toHaveJSProperty("inert", false); await expect(p.locator("#already-inert")).toHaveJSProperty("inert", true);
      assert.equal(await p.evaluate(() => document.body.style.overflow), "scroll"); assert.deepEqual(p.errors, []);
      assert.equal(await p.evaluate(() => window.scrollY), scrollBefore);
    });
    await test("passage history and explicit TOC fallback never modify chat history", async make => {
      const p = await chat(await make()); const url = p.url();
      await p.locator('#manual-open').click(); await opened(p);
      await p.locator('#gc-manual-nav [data-manual-id="documenten"]').click(); await opened(p, 'documenten');
      await p.getByRole('button', { name: 'Vorige handleidingpassage' }).click(); await opened(p, 'welkom');
      await p.getByRole('button', { name: 'Volgende handleidingpassage' }).click(); await opened(p, 'documenten');
      await p.evaluate(() => window.fixtureManual.openManual({ toc: true }));
      await expect(p.locator('[data-manual-passage]')).toHaveCount(0);
      await expect(p.locator('.gc-manual-status')).toContainText('Actuele inhoudsopgave'); assert.equal(p.url(), url);
    });
    await test("200 and 400 percent equivalent viewport reflow keeps text and controls reachable", async make => {
      for (const viewport of [{ width: 720, height: 500 }, { width: 360, height: 250 }]) {
        const p = await chat(await make({ viewport, reducedMotion: 'reduce' })); await p.locator('#manual-open').click(); await opened(p);
        const bounds = await p.locator('#gc-manual-modal').evaluate(el => ({ width: el.getBoundingClientRect().width, scrollWidth: el.scrollWidth, height: el.getBoundingClientRect().height, scrollHeight: el.scrollHeight }));
        assert.ok(bounds.width <= viewport.width); assert.ok(bounds.scrollWidth <= viewport.width + 1);
        await p.getByRole('button', { name: 'Inhoud', exact: true }).click();
        await p.locator('#gc-manual-nav [data-manual-id="documenten"]').click(); await opened(p, 'documenten');
        await p.getByRole('button', { name: 'Print / PDF' }).scrollIntoViewIfNeeded();
        await close(p);
      }
    });
    await test("automatic preflight rejects unavailable authenticated content despite public enabled metadata", async make => {
      await publish({ ...model(), autoOpen: 'every-session' });
      const ctx = await make();
      await ctx.route('**/govchat-api/manual/toc', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'MANUAL_UNAVAILABLE' } }) }));
      const p = await chat(ctx); await p.waitForTimeout(700); await expect(p.locator('#gc-manual-modal')).toHaveCount(0);
      await p.locator('#manual-open').click(); await expect(p.locator('#gc-manual-modal')).toBeVisible();
      await expect(p.locator('.gc-manual-status')).toContainText('tijdelijk niet beschikbaar');
    });
    await test("suspended login bootstrap cannot re-enable private entrypoints from a late response", async make => {
      const ctx = await make();
      await ctx.route('**/api/user', async route => { await new Promise(resolve => setTimeout(resolve, 250)); await route.continue(); });
      const p = await ctx.newPage(); await p.goto(fixture.base + '/c/fixture-conversation');
      await p.waitForFunction(() => !!window.fixtureManual);
      await p.evaluate(() => window.fixtureManual.suspendManual());
      await p.waitForFunction(() => window.fixtureReady === true);
      assert.equal(await p.evaluate(() => window.fixtureManual.isManualEnabled()), false);
      await expect(p.locator('[data-govchat-manual-owned]')).toHaveCount(0);
    });
    await test("complete repository catalog is searchable and editable without public defaults", async make => {
      const defaults = require('../../overlay/defaults/manual.json'); await publish({ ...defaults, enabled: true });
      const catalog = (await api('')).model.errorCategories;
      assert.equal(catalog.reduce((count, category) => count + category.articles.length, 0), 692);
      const appendix = catalog.find(category => category.id === 'appendix-errors');
      assert.equal(appendix.articles.length, 226);
      assert.equal(catalog.filter(category => category.id !== 'appendix-errors').reduce((count, category) => count + category.articles.length, 0), 466);
      const p = await chat(await make()); await p.locator('#manual-open').click(); await expect(p.locator('#gc-manual-modal')).toBeVisible();
      const articles = await p.evaluate(async () => (await window.fixtureRequest('document')).passages.filter(p => p.kind === 'articles').map(p => ({ id: p.id, title: p.title, codes: p.codes })));
      assert.equal(articles.length, 450); // 466 ordinary articles minus 16 filtered by trusted fixture context.
      const defaultDocument = await p.evaluate(async () => window.fixtureRequest('document'));
      assert.ok(!defaultDocument.errorCategories.some(category => category.id === 'appendix-errors'));
      for (const article of appendix.articles) assert.ok(!articles.some(passage => passage.id === article.id), article.id);
      metrics.catalog = { total: 692, ordinary: 466, defaultHiddenAppendix: 226, trustedFixtureVisible: articles.length, defaultExcludesAppendix: true };
      const target = articles.find(article => article.codes.length && article.codes[0].length <= 200);
      await p.locator('#gc-manual-search').fill(target.codes[0]);
      await expect(p.locator(`#gc-manual-nav [data-manual-id="${target.id}"]`)).toBeVisible();
      await p.locator(`#gc-manual-nav [data-manual-id="${target.id}"]`).click(); await opened(p, target.id);
      await screenshot(p, 'manual-catalog-search');
      const editor = await (await make()).newPage(); await editor.goto(fixture.base + '/help-editor');
      await expect(editor.locator('#workspace')).toHaveAttribute('aria-busy', 'false');
      await editor.locator('[data-tab="errors"]').click();
      await editor.getByLabel('Zoeken in titel, ID, code, melding en inhoud').fill(target.codes[0]);
      await editor.locator('.catalog button').filter({ hasText: target.id }).first().click();
      await expect(editor.locator('#node-heading')).toContainText(target.title);
      await screenshot(editor, 'manual-editor-search');
      assert.deepEqual(p.errors, []);
    });
    await test("hierarchy and trusted rights filter TOC/search/get/document/print/context", async make => {
      const p = await chat(await make());
      const hidden = ["verborgen", "ouderkind", "verborgenonderwerp", "verborgenartikel", "categoriekind", "hoofdstukfout", "rechten"];
      const payload = await p.evaluate(async ids => {
        const toc = await window.fixtureRequest("toc"), doc = await window.fixtureRequest("document"), search = await window.fixtureRequest("search", { query: "SENTINEL" });
        const denied = [];
        for (const id of ids) { try { await window.fixtureRequest("get", { id, revision: doc.revision }); denied.push("LEAK"); } catch (e) { denied.push(e.code); } }
        return { toc, doc, search, denied };
      }, hidden);
      for (const id of hidden) assert.equal(payload.doc.passages.some(p => p.id === id), false, id);
      assert.equal(payload.search.total, 0); assert.deepEqual(payload.denied, hidden.map(() => "PASSAGE_NOT_FOUND"));
      assert.doesNotMatch(JSON.stringify(payload.toc), /Verborgen|Promptrechten/);
      await p.locator("#manual-open").click(); await opened(p); await expect(p.locator("#gc-manual-nav")).not.toContainText("Verborgen");
      await p.locator("#gc-manual-search").fill("bad_document"); await expect(p.locator(".gc-manual-result")).toHaveCount(1);
      await screenshot(p, "manual-search"); await p.locator(".gc-manual-result").click(); await opened(p, "bad-document");
      // Keep the real print DOM for inspection, but suppress the OS print dialog.
      await p.evaluate(() => { window.print = () => { window.fixturePrintCalled = true; }; });
      await p.getByRole("button", { name: "Print / PDF" }).click(); await p.waitForFunction(() => window.fixturePrintCalled);
      const print = await p.locator("#gc-manual-print").textContent(); assert.doesNotMatch(print, /SENTINEL|Verborgen/);
      for (const id of hidden) await expect(p.locator(`#gc-manual-print [data-manual-passage="${id}"]`)).toHaveCount(0);
      await expect(p.locator('#gc-manual-print a[href*="manual=rechten"]')).toHaveCount(0); assert.match(print, /Document kan niet worden gelezen/);
      await p.emulateMedia({ media: "print" }); await screenshot(p, "manual-print"); await p.emulateMedia({ media: "screen" });
      await p.evaluate(() => window.dispatchEvent(new Event("afterprint"))); await expect(p.locator("#gc-manual-print")).toHaveCount(0);
      const privileged = await make(); await privileged.addCookies([{ name: "fixtureUser", value: "privileged", url: fixture.base }]);
      const q = await chat(privileged); const doc = await q.evaluate(() => window.fixtureRequest("document")); assert.ok(doc.passages.some(p => p.id === "rechten"));
      const internal = await p.request.post(fixture.base + "/api/internal/manual", { headers: { Authorization: "Bearer fixture-internal-only" }, data: { action: "search", query: "SENTINEL" } }); assert.equal((await internal.json()).total, 0);
    });
    await test("canonical citations validate current passage and preserve conversation; stale/hidden/unknown fallback", async make => {
      const p = await chat(await make()); const url = p.url(); const text = await p.locator("#composer").inputValue();
      await p.getByRole("link", { name: "Canoniek documentcitaat", exact: true }).click(); await opened(p, "documenten"); assert.equal(p.url(), url); assert.equal(await p.locator("#composer").inputValue(), text);
      await screenshot(p, "manual-citation"); await close(p);
      for (const name of ["Verouderd citaat", "Verborgen citaat", "Onbekend citaat"]) {
        await p.getByRole("link", { name, exact: true }).click(); await expect(p.locator(".gc-manual-pane")).toContainText("Passage niet beschikbaar");
        await expect(p.locator("[data-manual-passage]")).toHaveCount(0); assert.equal(p.url(), url);
        if (name === "Verouderd citaat") {
          await screenshot(p, "manual-stale-citation");
          await p.getByRole("button", { name: "Actuele inhoudsopgave laden" }).click();
          await expect(p.locator(".gc-manual-status")).toContainText("Het oude citaat is niet opnieuw geopend");
          await expect(p.locator("[data-manual-passage]")).toHaveCount(0);
        }
        await close(p);
      }
      // Observe actual trusted pointer events after the manual's capture handler.
      await p.evaluate(() => document.addEventListener("click", e => { const a = e.target.closest("a"); if (a) { window.fixtureClickPrevented = e.defaultPrevented; e.preventDefault(); } }));
      for (const name of ["Gewone bron", "Niet-canonieke bron", "Externe bron"]) { await p.getByRole("link", { name, exact: true }).click(); assert.equal(await p.evaluate(() => window.fixtureClickPrevented), false, name); await expect(p.locator("#gc-manual-modal")).toHaveCount(0); }
    });
    await test("mobile layout/navigation and dark theme screenshots", async make => {
      const p = await chat(await make({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }));
      await p.locator("#manual-open").click(); await opened(p); await expect(p.locator("#gc-manual-nav")).toBeHidden();
      await screenshot(p, "manual-mobile"); await p.getByRole("button", { name: "Inhoud", exact: true }).click(); await expect(p.locator("#gc-manual-nav")).toBeVisible();
      await p.locator('[data-manual-id="documenten"]').click(); await opened(p, "documenten"); await expect(p.locator("#gc-manual-nav")).toBeHidden();
      const box = await p.locator("#gc-manual-modal").boundingBox(); assert.ok(box.x >= 0 && box.width <= 391 && box.height <= 845);
      await p.locator('#gc-manual-search').fill('bad_document'); await expect(p.locator('#gc-manual-nav')).toBeVisible();
      await p.locator('#gc-manual-nav [data-manual-id="bad-document"]').click(); await opened(p, 'bad-document');
      const q = await chat(await make({ colorScheme: "dark" })); await q.locator("#manual-open").click(); await opened(q);
      await expect(q.locator("html")).toHaveClass(/dark/); assert.equal(await q.locator("#gc-manual-modal").evaluate(e => getComputedStyle(e).backgroundColor), "rgb(24, 33, 41)"); await screenshot(q, "manual-dark");
    });
    await test("native marker adapter is idempotent and fixed errors do not scan chat prose", async make => {
      const p = await chat(await make()); await expect(p.locator('[data-govchat-manual-owned="desktop"]')).toHaveCount(1); await expect(p.locator('[data-govchat-manual-owned="mobile"]')).toHaveCount(1);
      for (let i = 0; i < 12; i++) await p.evaluate(i => window.fixtureRoute(`/c/fixture-${i}`), i);
      await expect(p.locator('[data-govchat-manual-owned="desktop"]')).toHaveCount(1); await expect(p.locator('[data-govchat-manual-owned="mobile"]')).toHaveCount(1);
      await expect(p.locator("#ordinary-text button")).toHaveCount(0);
      await p.locator("#exact-error button").click(); await opened(p, "bad-document"); await close(p);
      await p.locator("#unknown-error button").click(); await opened(p, "probleem-algemeen"); await close(p);
      await p.evaluate(() => { document.querySelector("#exact-error").setAttribute("data-govchat-error-code", "prefix_bad_document_suffix"); document.querySelector("#exact-error span").textContent = "prefix Exacte vaste testmelding suffix"; window.fixtureManual.manualRouteCheck(); });
      await p.locator("#exact-error button").click(); await opened(p, "probleem-algemeen"); await close(p);
      await p.evaluate(() => window.dispatchEvent(new CustomEvent("govchat:manual-open", { cancelable: true }))); await opened(p);
    });
    await test("revision/focus and disable invalidate old content, remove entries and restore inert on close", async make => {
      const p = await chat(await make()); await p.locator("#manual-open").click(); await opened(p);
      const newer = model(); newer.sections[0].content = "<p>Nieuwe openbare fixtureversie.</p>"; await publish(newer);
      await p.evaluate(() => window.dispatchEvent(new Event("focus"))); await expect(p.locator("[data-manual-passage]")).toHaveCount(0); await expect(p.locator(".gc-manual-status")).toContainText("gewijzigd");
      await p.locator('[data-manual-id="welkom"]').click(); await opened(p); await expect(p.locator(".gc-manual-pane")).toContainText("Nieuwe openbare fixtureversie");
      await api("/disable", "POST", await api("")); await p.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(p.locator("[data-manual-passage]")).toHaveCount(0); await expect(p.locator(".gc-manual-status")).toContainText("uitgeschakeld"); await expect(p.locator("[data-govchat-manual-owned]")).toHaveCount(0);
      await close(p); await expect(p.locator("#fixture-chat")).toHaveJSProperty("inert", false); await expect(p.locator("#already-inert")).toHaveJSProperty("inert", true);
    });
    await test("focus revalidates changed rights without a new content revision", async make => {
      fixture.setRestrictedShares(true);
      const p = await chat(await make()); await p.locator('#manual-open').click();
      await p.locator('#gc-manual-nav [data-manual-id="rechten"]').click(); await opened(p, 'rechten');
      const revision = fixture.store.metadata().revision; fixture.setRestrictedShares(false);
      await p.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(p.locator('#gc-manual-nav [data-manual-id="rechten"]')).toHaveCount(0);
      await expect(p.locator('[data-manual-passage="rechten"]')).toHaveCount(0);
      await expect(p.locator('.gc-manual-status')).toContainText('niet meer zichtbaar');
      assert.equal(fixture.store.metadata().revision, revision);
    });
    await test("initial canonical deep link and route/popstate opens validate without replacing route", async make => {
      const rev = (await api("")).effective.revision;
      const p = await chat(await make(), `/c/new?manual=documenten&manualRevision=${rev}`); await opened(p, "documenten");
      assert.ok(p.url().endsWith(`manualRevision=${rev}`)); await close(p);
      await p.evaluate(rev => { window.fixtureRoute("/c/route-transition"); window.fixtureRoute(`/c/new?manual=documenten&manualRevision=${rev}`); }, rev); await opened(p, "documenten"); await close(p);
      await p.evaluate(() => { history.pushState({}, "", "/c/new?manual=toc"); window.dispatchEvent(new PopStateEvent("popstate")); });
      await expect(p.locator(".gc-manual-status")).toContainText("Actuele inhoudsopgave"); await expect(p.locator("[data-manual-passage]")).toHaveCount(0);
    });
    await test("global error-reference visibility removes articles from all read routes, print and contextual buttons", async make => {
      const value = model(); value.visibility.errors = false; await publish(value); const p = await chat(await make());
      const data = await p.evaluate(async () => ({ doc: await window.fixtureRequest("document"), toc: await window.fixtureRequest("toc"), search: await window.fixtureRequest("search", { query: "bad_document" }) }));
      assert.equal(data.doc.passages.some(p => p.kind === "articles"), false); assert.deepEqual(data.toc.errorCategories, []); assert.equal(data.search.total, 0);
      const get = await p.evaluate(async () => { try { await window.fixtureRequest("get", { id: "bad-document" }); return "LEAK"; } catch (e) { return e.code; } }); assert.equal(get, "PASSAGE_NOT_FOUND");
      await expect(p.locator('[data-govchat-manual-owned="error"]')).toHaveCount(0);
      await p.locator("#manual-open").click(); await opened(p); await p.evaluate(() => { window.print = () => { window.fixturePrintCalled = true; }; });
      await p.getByRole("button", { name: "Print / PDF" }).click(); await p.waitForFunction(() => window.fixturePrintCalled); await expect(p.locator('#gc-manual-print [data-manual-passage="bad-document"]')).toHaveCount(0);
      const internal = await p.request.post(fixture.base + "/api/internal/manual", { headers: { Authorization: "Bearer fixture-internal-only" }, data: { action: "get", id: "bad-document" } }); assert.equal(internal.status(), 404);
    });
    for (const policy of ["never", "first-use", "new-revision", "every-session"]) await test(`automatic ${policy}: full-route same-session suppression and next-session policy`, async make => {
      await publish(model(policy)); const ctx = await make(); let p = await chat(ctx);
      if (policy === "never") { await p.waitForTimeout(550); await expect(p.locator("#gc-manual-modal")).toHaveCount(0); }
      else { await opened(p); await close(p); }
      await p.goto(fixture.base + "/start/"); await expect(p.locator("#gc-landing-help-btn")).toBeVisible(); await p.waitForTimeout(550); await expect(p.locator("#gc-manual-modal")).toHaveCount(0);
      await p.goto(fixture.base + "/beleidskompas/"); await expect(p.locator("#gc-bk-help")).toBeVisible(); await p.waitForTimeout(550); await expect(p.locator("#gc-manual-modal")).toHaveCount(0);
      const state = await ctx.storageState(); const next = await make({ storageState: state }); p = await chat(next);
      if (policy === "every-session") { await opened(p); await close(p); } else { await p.waitForTimeout(550); await expect(p.locator("#gc-manual-modal")).toHaveCount(0); }
      if (policy === "new-revision") {
        await publish(model(policy)); const revised = await make({ storageState: state }); const q = await chat(revised); await opened(q);
        await q.getByRole("checkbox").check(); await close(q); const optState = await revised.storageState(); await publish(model(policy));
        const opted = await chat(await make({ storageState: optState })); await opted.waitForTimeout(550); await expect(opted.locator("#gc-manual-modal")).toHaveCount(0);
        await opted.locator("#manual-open").click(); await opened(opted); await opted.getByRole("button", { name: "Opnieuw toestaan" }).click(); await expect(opted.getByRole("checkbox")).not.toBeChecked();
      }
    });
    await test("storage denied prevents automatic popups across full chat/start/app routes, manual remains usable", async make => {
      await publish(model("every-session")); const ctx = await make();
      await ctx.addInitScript(() => { Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Fixture denied", "SecurityError"); } }); Object.defineProperty(window, "sessionStorage", { get() { throw new DOMException("Fixture denied", "SecurityError"); } }); });
      const p = await chat(ctx);
      for (const [route, button] of [["/c/fixture-conversation", "#manual-open"], ["/start/", "#gc-landing-help-btn"], ["/beleidskompas/", "#gc-bk-help"]]) {
        await p.goto(fixture.base + route); await expect(p.locator(button)).toBeVisible(); await p.waitForTimeout(550); await expect(p.locator("#gc-manual-modal")).toHaveCount(0);
        await p.locator(button).click(); await opened(p); await expect(p.getByRole("checkbox")).toBeDisabled(); await expect(p.locator(".gc-manual-preferences")).toContainText("Browseropslag niet beschikbaar"); await close(p);
      }
    });
    await test("verified account-scoped storage contains only opaque preferences and does not suppress another user", async make => {
      await publish(model("first-use")); const ctx = await make(); const p = await chat(ctx); await opened(p); await close(p);
      const preferences = await p.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith("gc_manual_v1_")));
      assert.equal(preferences.length, 1); assert.match(preferences[0][0], /^gc_manual_v1_[a-f0-9]{64}$/);
      assert.deepEqual(Object.keys(JSON.parse(preferences[0][1])).sort(), ["optOut", "revision", "seen"]);
      assert.doesNotMatch(JSON.stringify(preferences), /fixture-restricted|Bearer|testbericht|conversation/);
      await ctx.addCookies([{ name: "fixtureUser", value: "privileged", url: fixture.base }]);
      await p.goto(fixture.base + "/c/other-account"); await opened(p); await close(p);
      assert.equal(await p.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith("gc_manual_v1_")).length), 2);
    });
    await test("automatic opening never competes with another dialog or an explicit manual click", async make => {
      await publish(model("every-session")); const ctx = await make();
      await ctx.addInitScript(() => document.addEventListener("DOMContentLoaded", () => { const other = document.createElement("section"); other.id = "fixture-other-dialog"; other.setAttribute("role", "dialog"); other.textContent = "Andere synthetische dialoog"; document.body.append(other); }));
      const p = await chat(ctx); await p.waitForTimeout(550); await expect(p.locator("#gc-manual-modal")).toHaveCount(0);
      await p.locator("#fixture-other-dialog").evaluate(e => e.remove()); await p.waitForTimeout(550); await expect(p.locator("#gc-manual-modal")).toHaveCount(0);
      await p.locator("#manual-open").click(); await opened(p); await close(p);
      const q = await chat(await make()); await q.locator("#manual-open").click(); await opened(q); await close(q); await q.waitForTimeout(550); await expect(q.locator("#gc-manual-modal")).toHaveCount(0);
    });
    await test("compact conditional preferences reclaim mobile reader space", async make => {
      const p = await chat(await make({ viewport: { width: 390, height: 844 } }));
      await p.locator('#manual-open').click(); await opened(p);
      await expect(p.locator('.gc-manual-preferences')).toBeHidden();
      metrics.mobilePreferencesNeverPx = await p.locator('.gc-manual-preferences').evaluate(el => el.getBoundingClientRect().height);
      assert.equal(metrics.mobilePreferencesNeverPx, 0);
      assert.equal(await p.locator('#gc-manual-modal').innerText().then(text => text.includes('beleidsacceptatie')), false);
      await close(p); await publish(model('every-session'));
      await p.locator('#manual-open').click(); await opened(p);
      await expect(p.getByRole('checkbox')).toBeVisible();
      await expect(p.getByRole('button', { name: 'Opnieuw toestaan' })).toBeHidden();
      metrics.mobilePreferencesEnabledPx = await p.locator('.gc-manual-preferences').evaluate(el => el.getBoundingClientRect().height);
      assert.ok(metrics.mobilePreferencesEnabledPx <= 60);
      await p.getByRole('checkbox').check(); await expect(p.getByRole('button', { name: 'Opnieuw toestaan' })).toBeVisible();
      metrics.mobilePreferencesOptOutPx = await p.locator('.gc-manual-preferences').evaluate(el => el.getBoundingClientRect().height);
      assert.ok(metrics.mobilePreferencesOptOutPx <= 100);
      await screenshot(p, 'manual-mobile-preferences');
    });
    await test("translated error text is ignored and explicit exact message attributes still match", async make => {
      const p = await chat(await make());
      await p.evaluate(() => { const error = document.getElementById('exact-error'); error.removeAttribute('data-govchat-error-code'); window.fixtureManual.manualRouteCheck(); });
      await p.locator('#exact-error button').click(); await opened(p, 'probleem-algemeen'); await close(p);
      await p.evaluate(() => { document.getElementById('exact-error').setAttribute('data-govchat-error-message', 'Exacte vaste testmelding'); window.fixtureManual.manualRouteCheck(); });
      await p.locator('#exact-error button').click(); await opened(p, 'bad-document');
    });
    await test("alertdialog and auth route suppress automatic opening without polling", async make => {
      await publish(model('every-session')); const ctx = await make();
      await ctx.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const other = document.createElement('section'); other.setAttribute('role', 'alertdialog'); document.body.append(other); }));
      const p = await chat(ctx); await p.waitForTimeout(600); await expect(p.locator('#gc-manual-modal')).toHaveCount(0);
      await p.evaluate(() => { document.querySelector('[role="alertdialog"]').remove(); history.pushState({}, '', '/login/2fa'); window.fixtureManual.scheduleManualAuto(); });
      await p.waitForTimeout(600); await expect(p.locator('#gc-manual-modal')).toHaveCount(0);
    });
    await test("late TOC and print reads cannot populate a replacement dialog", async make => {
      const ctx = await make(); const p = await chat(ctx);
      let release, captured;
      await ctx.route('**/govchat-api/manual/toc', async route => { const response = await route.fetch(); captured = true; await new Promise(resolve => { release = resolve; }); await route.fulfill({ response, json: { ...await response.json(), title: 'LATE_TOC_SENTINEL' } }); });
      await p.locator('#manual-open').click(); await expect(p.locator('#gc-manual-modal')).toBeVisible();
      await expect.poll(() => captured).toBe(true); await close(p); await ctx.unroute('**/govchat-api/manual/toc');
      await p.locator('#manual-open').click(); await opened(p); release(); await p.waitForTimeout(300);
      await expect(p.locator('#gc-manual-title')).not.toContainText('LATE_TOC_SENTINEL');
      captured = false;
      await ctx.route('**/govchat-api/manual/document', async route => { const response = await route.fetch(); captured = true; await new Promise(resolve => { release = resolve; }); await route.fulfill({ response }); });
      await p.evaluate(() => { window.print = () => { window.latePrintCalled = true; }; });
      await p.getByRole('button', { name: 'Print / PDF' }).click(); await expect.poll(() => captured).toBe(true);
      await close(p); await ctx.unroute('**/govchat-api/manual/document'); await p.locator('#manual-open').click(); await opened(p);
      release(); await p.waitForTimeout(300); await expect(p.locator('#gc-manual-print')).toHaveCount(0);
      assert.notEqual(await p.evaluate(() => window.latePrintCalled), true);
    });
    await test("print trust rejects preview and hiddenReasons and clears on same-revision focus", async make => {
      const ctx = await make(); const p = await chat(ctx); await p.locator('#manual-open').click(); await opened(p);
      await p.evaluate(() => { window.print = () => {}; });
      await ctx.route('**/govchat-api/manual/document', async route => { const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), preview: true } }); });
      await p.getByRole('button', { name: 'Print / PDF' }).click(); await expect(p.locator('.gc-manual-status')).toContainText('tijdelijk niet beschikbaar'); await expect(p.locator('#gc-manual-print')).toHaveCount(0);
      await ctx.unroute('**/govchat-api/manual/document');
      await ctx.route('**/govchat-api/manual/document', async route => { const response = await route.fetch(); const data = await response.json(); data.passages[0].hiddenReasons = ['fixture-denied']; data.passages[0].html = '<p>PRINT_HIDDEN_SENTINEL</p>'; await route.fulfill({ response, json: data }); });
      await p.getByRole('button', { name: 'Print / PDF' }).click(); await expect(p.locator('#gc-manual-print')).toHaveCount(1);
      await expect(p.locator('#gc-manual-print')).not.toContainText('PRINT_HIDDEN_SENTINEL');
      await p.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(p.locator('#gc-manual-print')).toHaveCount(0);
    });
    await test("start and Beleidskompas use the same real manual and preserve app state", async make => {
      const ctx = await make(); const p = await ctx.newPage();
      await p.goto(fixture.base + "/start/?chat=/c/fixture-conversation"); await p.locator("#gc-landing-help-btn").click(); await opened(p); await screenshot(p, "manual-start"); await close(p);
      await p.goto(fixture.base + "/beleidskompas/"); await expect(p.locator("#gc-bk-help")).toBeVisible(); const url = p.url();
      await p.locator("#gc-bk-help").click(); await opened(p); assert.equal(p.url(), url); await expect(p.locator("#gc-bk")).toHaveJSProperty("inert", true); await screenshot(p, "manual-beleidskompas"); await close(p); await expect(p.locator("#gc-bk")).toHaveJSProperty("inert", false);
    });
    await test("Beleidskompas caught error components offer validated context without scanning answer prose", async make => {
      const ctx = await make(); await ctx.route('**/api/agents/chat/govchat-beleidskompas', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'bad_document' }) }));
      const p = await ctx.newPage(); await p.goto(fixture.base + '/beleidskompas/');
      await expect(p.locator('#gc-bk')).toBeVisible(); await p.locator('[data-overview-step="0"]').click();
      await p.locator('#gc-bk-chat-input').fill('Openbare synthetische testvraag'); await p.locator('#gc-bk-send').click();
      await expect(p.locator('#gc-bk-chat-log [data-govchat-manual-error]')).toHaveCount(1);
      await p.locator('#gc-bk-chat-log [data-govchat-manual-owned="error"]').click(); await opened(p, 'bad-document');
      assert.equal(new URL(p.url()).pathname, '/beleidskompas/');
    });
    await test("real admin editor saves draft, previews hidden reasons, publishes and preserves conflicting local changes", async make => {
      const ctx = await make(); const p = await ctx.newPage(); p.on("dialog", d => d.accept());
      await p.goto(fixture.base + "/help-editor"); await expect(p.locator("#workspace")).toHaveAttribute("aria-busy", "false");
      await p.getByLabel("Titel", { exact: true }).fill("Gewijzigde openbare testhandleiding"); await p.locator("#save").click(); await expect(p.locator("#status")).toContainText(/bewaard|opgeslagen/i);
      assert.equal((await api("")).model.title, "Gewijzigde openbare testhandleiding"); assert.notEqual(fixture.store.document({ capabilities: ["chat"], rights: [] }).title, "Gewijzigde openbare testhandleiding");
      await p.locator("#preview").click(); await expect(p.locator("#preview-panel")).toBeVisible(); await expect(p.locator("#preview-list")).toContainText("chapters-hidden"); await screenshot(p, "manual-editor");
      await p.locator("#publish").click(); await expect(p.locator("#status")).toContainText(/gepubliceerd/i); assert.equal(fixture.store.document({ capabilities: ["chat"], rights: [] }).title, "Gewijzigde openbare testhandleiding");
      await p.getByLabel("Titel", { exact: true }).fill("Lokale bewerking behouden"); await api("/draft", "PUT", { ...await api(""), model: { title: "Andere beheerder" } }); await p.locator("#save").click();
      await expect(p.locator("#conflict")).toBeVisible(); await expect(p.getByLabel("Titel", { exact: true })).toHaveValue("Lokale bewerking behouden"); await expect(p.locator("#publish")).toBeDisabled();
      const anonymous = await browser.newContext(); try { assert.equal((await anonymous.request.get(fixture.base + "/api/admin/manual")).status(), 401); } finally { await anonymous.close(); }
    });
  } finally {
    const report = { generatedAt: new Date().toISOString(), browser: browser.version(), isolation: "loopback-only; synthetic trusted auth/config; actual model/store/routes/editor and ES modules; native markers not full client build", passed: results.filter(r => r.status === "passed").length, failed: results.filter(r => r.status === "failed").length, metrics, results };
    fs.writeFileSync(path.join(evidence, "browser-results.json"), JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify({ passed: report.passed, failed: report.failed }));
    await browser.close(); await fixture.close(); if (report.failed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
