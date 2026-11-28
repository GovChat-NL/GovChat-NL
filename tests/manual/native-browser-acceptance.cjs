"use strict";
// Actual complete Vite client, not injected marker fixtures. All API identity is synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const expect = require('playwright/test').expect.configure({ timeout: 15000 });
const { startFixture, model } = require('./browser-fixture.cjs');
const results = [];
const metrics = {};
async function main() {
  const nativeDist = process.env.GOVCHAT_NATIVE_DIST;
  if (!nativeDist || !fs.existsSync(path.join(nativeDist, 'index.html'))) throw Error('GOVCHAT_NATIVE_DIST must point to the independently compiled pinned client');
  const fixture = await startFixture({ nativeDist });
  const browser = await chromium.launch({ headless: true });
  const evidence = path.join(__dirname, 'evidence');
  async function scenario(name, viewport, run) {
    const ctx = await browser.newContext({ viewport, serviceWorkers: 'block' });
    ctx.setDefaultTimeout(15000);
    const errors = [], unexpected = [];
    await ctx.route('**/*', route => new URL(route.request().url()).origin === fixture.base ? route.continue() : route.abort('blockedbyclient'));
    const p = await ctx.newPage(); p.on('pageerror', e => errors.push(e.message));
    p.on('response', response => { if (response.status() >= 400) unexpected.push({ status: response.status(), path: new URL(response.url()).pathname }); });
    try {
      await p.goto(fixture.base + '/c/new');
      await expect(p.locator('[data-govchat-manual-slot="desktop"]')).toHaveCount(1);
      await expect(p.locator('[data-govchat-manual-owned="desktop"]')).toHaveCount(1);
      await run(p);
      assert.deepEqual(errors, []);
      assert.deepEqual(unexpected.filter(item => !(name.includes('auth page') && item.status === 401 && item.path === '/api/auth/refresh')), []);
      results.push({ name, status: 'passed', pageErrors: errors, syntheticApiErrors: unexpected });
      console.log('PASS', name);
    } catch (error) {
      results.push({ name, status: 'failed', error: error.stack, pageErrors: errors, syntheticApiErrors: unexpected });
      console.error('FAIL', name, error, errors, unexpected);
      await p.screenshot({ path: path.join(nativeDist, 'diagnostic.png'), fullPage: true });
    } finally { await ctx.unrouteAll({ behavior: 'ignoreErrors' }); await ctx.close(); }
  }
  try {
    await scenario('complete native desktop footer + real overlay + preserved composer/citation/focus', { width: 1440, height: 1000 }, async p => {
      await expect(p.locator('[data-govchat-manual-footer]')).toContainText('Controleer synthetische bronnen');
      await expect(p.locator('[data-govchat-manual-footer] a[href="https://example.invalid/privacy"]')).toHaveCount(1);
      const composer = p.locator('textarea').first(); await composer.fill('Unsent synthetic native message');
      const url = p.url(); const opener = p.locator('[data-govchat-manual-owned="desktop"]');
      await opener.click(); await expect(p.locator('[data-manual-passage="welkom"]')).toBeVisible();
      await p.locator('.gc-manual-article a').first().click(); await expect(p.locator('[data-manual-passage="documenten"]')).toBeVisible();
      assert.equal(p.url(), url); await expect(composer).toHaveValue('Unsent synthetic native message');
      for (let i = 0; i < 15; i++) { await p.keyboard.press('Tab'); assert.equal(await p.evaluate(() => document.getElementById('gc-manual-modal').contains(document.activeElement)), true); }
      await p.screenshot({ path: path.join(evidence, 'manual-native-desktop.png'), animations: 'disabled' });
      await p.keyboard.press('Escape'); await expect(opener).toBeFocused();
      await p.waitForTimeout(2200); await expect(opener).toHaveCount(1);
      await expect(p.locator('#gc-help-btn')).toHaveCount(0);
    });
    await scenario('complete native mobile help remains visible and opens shared reader', { width: 390, height: 844 }, async p => {
      const opener = p.locator('[data-govchat-manual-owned="mobile"]'); await expect(opener).toBeVisible();
      const box = await opener.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 391 && box.y + box.height <= 845);
      assert.ok(box.height >= 44);
      metrics.mobileTarget = box;
      await p.screenshot({ path: path.join(evidence, 'manual-native-mobile-shell.png'), animations: 'disabled' });
      await opener.click(); await expect(p.locator('[data-manual-passage="welkom"]')).toBeVisible();
      await expect(p.locator('.gc-manual-preferences')).toBeHidden();
      await p.screenshot({ path: path.join(evidence, 'manual-native-mobile.png'), animations: 'disabled' });
      await p.getByRole('button', { name: 'Handleiding sluiten' }).click(); await expect(opener).toBeFocused();
      await p.goto(fixture.base + '/c/11111111-1111-4111-8111-111111111111');
      await expect(opener).toBeVisible(); await opener.click(); await expect(p.locator('[data-manual-passage="welkom"]')).toBeVisible();
      await p.getByRole('button', { name: 'Handleiding sluiten' }).click(); await expect(opener).toBeFocused();
    });
    await scenario('real native failed-turn component exposes exact context; ordinary prose is not scanned', { width: 1440, height: 1000 }, async p => {
      await p.goto(fixture.base + '/c/11111111-1111-4111-8111-111111111111');
      await expect(p.locator('[data-govchat-manual-error="message"]')).toHaveCount(1);
      await expect(p.locator('[data-govchat-manual-error="message"]')).toHaveAttribute('data-govchat-error-code', 'bad_document');
      await expect(p.locator('[data-govchat-manual-owned="error"]')).toHaveCount(1);
      await p.locator('[data-govchat-manual-owned="error"]').click(); await expect(p.locator('[data-manual-passage="bad-document"]')).toBeVisible();
      await p.screenshot({ path: path.join(evidence, 'manual-native-error.png'), animations: 'disabled' });
      await p.getByRole('button', { name: 'Handleiding sluiten' }).click();
      await expect(p.locator('[data-govchat-manual-owned="error"]')).toBeFocused();
      await expect(p.locator('[data-govchat-manual-error="message"]')).toContainText('Exacte vaste testmelding');
    });
    await scenario('native Help & FAQ menu uses manual; live disable restores external fallback', { width: 1440, height: 1000 }, async p => {
      await p.getByTestId('nav-user').click();
      await p.getByRole('menuitem', { name: 'Help', exact: true }).click();
      const menu = p.locator('[data-govchat-manual-menu="help-faq"]'); await expect(menu).toBeVisible(); await menu.click();
      await expect(p.locator('[data-manual-passage="welkom"]')).toBeVisible();
      fixture.store.disable(fixture.store.adminState());
      await p.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(p.locator('[data-manual-passage]')).toHaveCount(0);
      await p.getByRole('button', { name: 'Handleiding sluiten' }).click();
      await expect(p.locator('[data-govchat-manual-owned]')).toHaveCount(0);
      await p.getByTestId('nav-user').click();
      await p.getByRole('menuitem', { name: 'Help', exact: true }).click();
      const popup = p.waitForEvent('popup'); await menu.click(); const external = await popup;
      await external.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {}); await external.close();
      fixture.store.publish(fixture.store.save(model(), fixture.store.adminState()));
    });
    await scenario('complete native auth page never opens manual automatically or exposes content', { width: 1440, height: 1000 }, async p => {
      fixture.store.publish(fixture.store.save(model('every-session'), fixture.store.adminState()));
      await p.context().addCookies([{ name: 'fixtureUser', value: 'anonymous', url: fixture.base }]);
      await p.goto(fixture.base + '/login'); await p.waitForTimeout(1200);
      await expect(p.locator('[data-govchat-manual-owned]')).toHaveCount(0);
      await expect(p.locator('#gc-manual-modal')).toHaveCount(0);
      await expect(p.locator('input[type="password"]')).toBeVisible();
      fixture.store.publish(fixture.store.save(model(), fixture.store.adminState()));
    });
  } finally {
    const indexSha256 = createHash('sha256').update(fs.readFileSync(path.join(nativeDist, 'index.html'))).digest('hex');
    const report = { generatedAt: new Date().toISOString(), browser: browser.version(), isolation: 'complete independently compiled pinned native Vite artifacts + production overlay route loop; loopback synthetic API/auth; no production services', nativeDistInput: 'GOVCHAT_NATIVE_DIST', indexSha256, metrics, passed: results.filter(r => r.status === 'passed').length, failed: results.filter(r => r.status === 'failed').length, results, apiPaths: [...new Set(fixture.calls.map(call => call.path))] };
    fs.writeFileSync(path.join(evidence, 'native-browser-results.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ passed: report.passed, failed: report.failed }));
    await browser.close(); await fixture.close(); if (report.failed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
