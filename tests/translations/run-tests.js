'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const {
  applyTranslations,
  normalizeTranslations,
  patchDutchBundle,
  patchServiceWorker,
  translationsEnabled,
} = require('../../scripts/apply-dutch-translations');

let assertions = 0;
function test(name, fn) {
  fn();
  assertions += 1;
  console.log(`PASS: ${name}`);
}
function expectThrow(fn, pattern) {
  assert.throws(fn, pattern);
}

test('schakelaar staat standaard aan en accepteert expliciet true/false', () => {
  assert.equal(translationsEnabled(undefined), true);
  assert.equal(translationsEnabled('true'), true);
  assert.equal(translationsEnabled('false'), false);
  assert.equal(translationsEnabled('0'), false);
  assertions += 4;
  expectThrow(() => translationsEnabled('enabled'), /gebruik true of false/);
});

test('ontbrekende en lege vertalingen worden overgeslagen, niet als lege waarde toegepast', () => {
  assert.deepEqual(normalizeTranslations({ own: 'Eigen tekst', blank: '  ', empty: '' }), {
    own: 'Eigen tekst',
  });
  assertions += 1;
});

test('eigen vertaling overschrijft alleen een aanwezige Nederlandse waarde', () => {
  const source = 'const te={default:{}};export{te as t};';
  const patched = patchDutchBundle(source, { existing: 'Eigen tekst', customOnly: 'Nieuwe sleutel' });
  assert.match(patched, /\.\.\.\(te\.default\|\|\{\}\),\.\.\.\{"existing":"Eigen tekst","customOnly":"Nieuwe sleutel"\}/);
  assert.match(patched, /default:__govchatDutchDefault/);
  assert.match(patched, /export\{__govchatDutchTranslations as t\};$/);
  assertions += 3;
});

test('fallbackbron blijft intact voor Nederlandse ontbrekende waarden en Engelse fallback', () => {
  const source = 'const te={existing:"Nederlands",default:{existing:"Nederlands"}};export{te as t};';
  const patched = patchDutchBundle(source, { existing: 'Eigen tekst', customOnly: 'Eigen sleutel' });
  const executable = patched.replace(
    /export\{__govchatDutchTranslations as t\};$/,
    'globalThis.resources=__govchatDutchTranslations;',
  );
  const context = { globalThis: {} };
  vm.runInNewContext(executable, context);
  const english = { missing: 'English fallback' };
  // LibreChat v0.8.7's locale loader passes the namespace's `.default` member
  // to i18next, not the namespace object itself.
  const translate = (key) => context.globalThis.resources.default[key] ?? english[key] ?? key;
  assert.equal(translate('existing'), 'Eigen tekst');
  assert.equal(translate('customOnly'), 'Eigen sleutel');
  assert.equal(translate('missing'), 'English fallback');
  assertions += 3;
});

test('waarden en placeholders worden ongewijzigd bewaard', () => {
  const value = 'Hallo {{name}} — <strong>{{count}}</strong>\nRegel 2';
  const patched = patchDutchBundle('const te={default:{}};export{te as t};', { greeting: value });
  assert.ok(patched.includes(JSON.stringify({ greeting: value })));
  assertions += 1;
});

test('serviceworker-cache is gebonden aan de overrideversie en verwijdert oude locale-caches', () => {
  const source = 'self.skipWaiting();urlPattern:/assets/locale-[^/]+.js;new p.StaleWhileRevalidate({cacheName:"locale-chunks"});';
  const patched = patchServiceWorker(source, '0123456789abcdef');
  assert.match(patched, /cacheName:"locale-chunks-govchat-0123456789abcdef"/);
  assert.match(patched, /n==="locale-chunks"/);
  assert.match(patched, /caches\.delete\(n\)/);
  expectThrow(() => patchServiceWorker('self.skipWaiting();', 'version'), /onbekende locale-cacheconfiguratie/);

  // Controlled upgrade fixture: another minifier layout and quote style while
  // retaining the same explicitly supported Workbox runtime-cache contract.
  const upgraded = patchServiceWorker(
    "self.skipWaiting();urlPattern:/assets/locale-[^/]+.js;new p.StaleWhileRevalidate({ cacheName : 'locale-chunks' });",
    'fedcba9876543210',
  );
  assert.match(upgraded, /cacheName:"locale-chunks-govchat-fedcba9876543210"/);
  assert.match(upgraded, /n!=="locale-chunks-govchat-fedcba9876543210"/);
  assertions += 5;
});

test('andere talenbundels worden niet geselecteerd of aangepast', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'govchat-locale-test-'));
  const translationsFile = path.join(directory, 'translation.json');
  const assetsDir = path.join(directory, 'assets');
  fs.mkdirSync(assetsDir);
  fs.writeFileSync(translationsFile, JSON.stringify({ own: 'Eigen tekst' }));
  fs.writeFileSync(path.join(assetsDir, 'locale-fr.test.js'), 'const tf={};export{tf as t};');
  expectThrow(() => applyTranslations({ enabled: true, translationsFile, assetsDir }), /locale-nl/);
  assert.equal(fs.readFileSync(path.join(assetsDir, 'locale-fr.test.js'), 'utf8'), 'const tf={};export{tf as t};');
  fs.rmSync(directory, { recursive: true, force: true });
  assertions += 1;
});

test('uitgeschakelde override leest niet en wijzigt geen taalbundels', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'govchat-locale-test-'));
  const assetsDir = path.join(directory, 'assets');
  fs.mkdirSync(assetsDir);
  fs.writeFileSync(path.join(assetsDir, 'locale-nl.test.js'), 'const te={};export{te as t};');
  const result = applyTranslations({
    enabled: false,
    translationsFile: 'ontbreekt.json',
    assetsDir,
    backupDir: path.join(directory, 'backup'),
  });
  assert.deepEqual(result, { applied: false, restored: false, count: 0 });
  fs.rmSync(directory, { recursive: true, force: true });
  assertions += 1;
});

test('echte bundel, gzip- en brotli-varianten krijgen dezelfde override', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'govchat-locale-test-'));
  const translationsFile = path.join(directory, 'translation.json');
  const assetsDir = path.join(directory, 'assets');
  const backupDir = path.join(directory, 'backup');
  fs.mkdirSync(assetsDir);
  fs.writeFileSync(path.join(directory, 'sw.js'), 'urlPattern:/assets/locale-[^/]+.js;new p.StaleWhileRevalidate({cacheName:"locale-chunks"});');
  fs.writeFileSync(translationsFile, JSON.stringify({ own: 'Eigen {{name}}', blank: ' ' }));
  const bundlePath = path.join(assetsDir, 'locale-nl.test.js');
  const originalSource = 'const te={stock:"Nederlands"};export{te as t};';
  fs.writeFileSync(bundlePath, originalSource);
  fs.writeFileSync(`${bundlePath}.gz`, zlib.gzipSync(originalSource));
  fs.writeFileSync(`${bundlePath}.br`, zlib.brotliCompressSync(originalSource));

  const result = applyTranslations({ enabled: true, translationsFile, assetsDir, backupDir });
  const patched = fs.readFileSync(bundlePath, 'utf8');
  assert.equal(result.count, 1);
  assert.ok(patched.includes('stock:"Nederlands"'));
  assert.ok(patched.includes(JSON.stringify({ own: 'Eigen {{name}}' })));
  assert.equal(zlib.gunzipSync(fs.readFileSync(`${bundlePath}.gz`)).toString(), patched);
  assert.equal(zlib.brotliDecompressSync(fs.readFileSync(`${bundlePath}.br`)).toString(), patched);
  const patchedServiceWorker = fs.readFileSync(path.join(directory, 'sw.js'), 'utf8');
  assert.match(patchedServiceWorker, new RegExp(`locale-chunks-govchat-${result.cacheVersion}`));
  assertions += 5;

  // Repeated startup uses the clean backup as its base, never layering overrides.
  applyTranslations({ enabled: true, translationsFile, assetsDir, backupDir });
  assert.equal(fs.readFileSync(bundlePath, 'utf8'), patched);
  assertions += 1;

  const disabled = applyTranslations({ enabled: false, translationsFile, assetsDir, backupDir });
  assert.equal(disabled.restored, true);
  assert.equal(fs.readFileSync(bundlePath, 'utf8'), originalSource);
  assert.equal(fs.readFileSync(path.join(directory, 'sw.js'), 'utf8'), 'urlPattern:/assets/locale-[^/]+.js;new p.StaleWhileRevalidate({cacheName:"locale-chunks"});');
  assertions += 3;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('ongeldige JSON-structuur en niet-tekstuele vertalingen falen duidelijk', () => {
  expectThrow(() => normalizeTranslations([]), /JSON-object/);
  expectThrow(() => normalizeTranslations({ invalid: 42 }), /moet een tekstwaarde/);
  expectThrow(() => patchDutchBundle('export{unknown};', {}), /onbekende exportstructuur/);
  assertions += 2;
});

test('aangeleverde JSON is valide, tekstueel en bevat geen dubbele sleutels', () => {
  const localePath = path.join(__dirname, '../../overlay/locales/nl/translation.json');
  const source = fs.readFileSync(localePath, 'utf8');
  const parsed = JSON.parse(source);
  const keys = [...source.matchAll(/^\s+"([^\"]+)"\s*:/gm)].map((match) => match[1]);
  assert.equal(keys.length, Object.keys(parsed).length);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(Object.values(parsed).every((value) => typeof value === 'string'));
  assert.equal(parsed.com_ui_good_evening, 'Goedenavond');
  assert.equal(parsed.com_ui_good_afternoon, 'Goedemiddag');
  assert.equal(parsed.com_ui_good_morning, 'Goedemorgen');
  assert.equal(parsed.com_ui_weekend_morning, 'Goedemorgen');
  assert.equal(parsed.com_ui_late_night, 'Nog laat wakker?');
  assertions += 8;
});

console.log(`PASS: ${assertions} Nederlandse vertaaloverridecontroles`);
