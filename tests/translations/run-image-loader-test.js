'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const i18nextPath = require.resolve('i18next', { paths: [process.env.LIBRECHAT_ROOT || '/app'] });
const { createInstance } = require(i18nextPath);
const {
  normalizeTranslations,
  patchDutchBundle,
  patchServiceWorker,
} = require('../../scripts/apply-dutch-translations');

async function main() {
  const assetsDir = process.env.LIBRECHAT_ASSETS_DIR || '/app/client/dist/assets';
  const candidates = fs.readdirSync(assetsDir)
    .filter((name) => /^locale-nl\..+\.js$/.test(name));
  assert.equal(candidates.length, 1, `Verwacht één Nederlandse bundel, gevonden: ${candidates.length}`);

  const translationsPath = path.join(__dirname, '../../overlay/locales/nl/translation.json');
  const translations = normalizeTranslations(JSON.parse(fs.readFileSync(translationsPath, 'utf8')));
  const original = fs.readFileSync(path.join(assetsDir, candidates[0]), 'utf8');
  const patched = original.includes('const __govchatDutchDefault=')
    ? original
    : patchDutchBundle(original, translations);
  const serviceWorkerPath = path.join(path.dirname(assetsDir), 'sw.js');
  const serviceWorker = fs.readFileSync(serviceWorkerPath, 'utf8');
  const cachePatchedServiceWorker = patchServiceWorker(serviceWorker, '0123456789abcdef');
  assert.ok(cachePatchedServiceWorker.includes('locale-chunks-govchat-0123456789abcdef'));
  // Keep the temporary module beside the real bundle so its relative
  // rolldown-runtime import resolves exactly as it does in the browser.
  const modulePath = path.join(assetsDir, `.govchat-locale-loader-test-${process.pid}.mjs`);
  fs.writeFileSync(modulePath, patched);
  let localeModule;
  try {
    ({ t: localeModule } = await import(pathToFileURL(modulePath).href));
  } finally {
    fs.rmSync(modulePath, { force: true });
  }
  assert.ok(localeModule.default, 'LibreChat/i18next verwacht de t.default namespace');

  const i18n = createInstance();
  await i18n.init({
    lng: 'nl',
    fallbackLng: 'en',
    resources: {
      nl: { translation: localeModule.default },
      en: { translation: {} },
    },
    interpolation: { escapeValue: false },
  });
  const greeting = `${i18n.t('com_ui_good_evening')}, Jeannot`;
  assert.equal(greeting, 'Goedenavond, Jeannot');
  console.log(`PASS: ${candidates[0]} + sw.js -> t.default/i18next -> ${greeting}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
