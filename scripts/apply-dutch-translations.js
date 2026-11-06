#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const DEFAULT_ASSETS_DIR = '/app/client/dist/assets';
const DEFAULT_TRANSLATIONS_FILE = '/app/govchat-overlay/translation.json';
const DEFAULT_BACKUP_DIR = '/tmp/govchat-locale-original';
const EXPORT_PATTERN = /export\{([A-Za-z_$][\w$]*) as t\};\s*$/;
const LOCALE_CACHE_PATTERN = /cacheName\s*:\s*(["'])locale-chunks\1/g;

function translationsEnabled(value = process.env.LIBRECHAT_NL_TRANSLATIONS_ENABLED) {
  if (value == null) return true;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') {
    throw new Error('LIBRECHAT_NL_TRANSLATIONS_ENABLED moet true of false zijn.');
  }
  if (value.trim() === '') return true;
  if (/^(true|1|yes|on)$/i.test(value.trim())) return true;
  if (/^(false|0|no|off)$/i.test(value.trim())) return false;
  throw new Error(
    `Ongeldige LIBRECHAT_NL_TRANSLATIONS_ENABLED '${value}'; gebruik true of false.`,
  );
}

function normalizeTranslations(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('Het Nederlandse vertaalbestand moet een JSON-object bevatten.');
  }

  const translations = {};
  for (const [key, text] of Object.entries(value)) {
    if (typeof text !== 'string') {
      throw new Error(`Vertaling '${key}' moet een tekstwaarde zijn.`);
    }
    // An empty or whitespace-only value means "not translated" and must not
    // erase LibreChat's existing Dutch wording (or its normal English fallback).
    if (text.trim() !== '') translations[key] = text;
  }
  return translations;
}

function patchDutchBundle(source, translations) {
  const match = source.match(EXPORT_PATTERN);
  if (!match) {
    throw new Error(
      'De Nederlandse LibreChat-taalbundel heeft een onbekende exportstructuur; '
        + 'pas LibreChat niet automatisch aan.',
    );
  }

  const variableName = match[1];
  const serializedTranslations = JSON.stringify(translations);
  const replacement = `const __govchatDutchDefault={...(${variableName}.default||{}),...${serializedTranslations}};const __govchatDutchTranslations={...${variableName},...${serializedTranslations},default:__govchatDutchDefault};export{__govchatDutchTranslations as t};`;
  return source.replace(EXPORT_PATTERN, replacement);
}

function patchServiceWorker(source, version) {
  const cacheNames = [...source.matchAll(LOCALE_CACHE_PATTERN)];
  if (
    cacheNames.length !== 1
    || !source.includes('StaleWhileRevalidate')
    || !source.includes('locale-[^/]+')
  ) {
    throw new Error(
      'De LibreChat-serviceworker heeft een onbekende locale-cacheconfiguratie; '
        + 'pas de serviceworker niet automatisch aan.',
    );
  }

  const cacheName = `locale-chunks-govchat-${version}`;
  const patched = source.replace(LOCALE_CACHE_PATTERN, `cacheName:"${cacheName}"`);
  const cleanup = `self.addEventListener("activate",e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(n=>(n==="locale-chunks"||n.startsWith("locale-chunks-govchat-"))&&n!=="${cacheName}").map(n=>caches.delete(n))))));`;
  return `${patched}\n${cleanup}\n`;
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function applyTranslations({
  enabled = process.env.LIBRECHAT_NL_TRANSLATIONS_ENABLED,
  assetsDir = process.env.LIBRECHAT_ASSETS_DIR || DEFAULT_ASSETS_DIR,
  translationsFile = process.env.LIBRECHAT_NL_TRANSLATIONS_FILE || DEFAULT_TRANSLATIONS_FILE,
  backupDir = process.env.LIBRECHAT_NL_TRANSLATIONS_BACKUP_DIR || DEFAULT_BACKUP_DIR,
} = {}) {
  if (!translationsEnabled(enabled)) {
    let restored = false;
    if (fs.existsSync(backupDir)) {
      const backups = fs.readdirSync(backupDir)
        .filter((name) => /^locale-nl\..+\.js(?:\.gz|\.br)?$/.test(name) || name === 'sw.js');
      for (const filename of backups) {
        const destinationDir = filename === 'sw.js' ? path.dirname(assetsDir) : assetsDir;
        fs.copyFileSync(path.join(backupDir, filename), path.join(destinationDir, filename));
        restored = true;
      }
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
    console.log(restored
      ? 'Nederlandse vertalingen: override uitgeschakeld; oorspronkelijke LibreChat-bundel hersteld.'
      : 'Nederlandse vertalingen: override uitgeschakeld; LibreChat-vertalingen blijven actief.');
    return { applied: false, restored, count: 0 };
  }

  const candidates = fs.readdirSync(assetsDir)
    .filter((name) => /^locale-nl\..+\.js$/.test(name));
  if (candidates.length !== 1) {
    throw new Error(
      `Verwacht precies één locale-nl.*.js in ${assetsDir}, gevonden: ${candidates.length}. `
        + 'Controleer de LibreChat-image vóór een upgrade.',
    );
  }

  const bundlePath = path.join(assetsDir, candidates[0]);
  const serviceWorkerPath = path.join(path.dirname(assetsDir), 'sw.js');
  const backupPaths = [bundlePath, `${bundlePath}.gz`, `${bundlePath}.br`, serviceWorkerPath];
  const backups = backupPaths.map((filePath) => path.join(backupDir, path.basename(filePath)));

  let rawTranslations;
  try {
    rawTranslations = JSON.parse(fs.readFileSync(translationsFile, 'utf8'));
  } catch (error) {
    throw new Error(`Kan Nederlands vertaalbestand niet lezen: ${translationsFile}: ${error.message}`);
  }
  const translations = normalizeTranslations(rawTranslations);

  try {
    fs.mkdirSync(backupDir, { recursive: true });
    backupPaths.forEach((filePath, index) => {
      if (!fs.existsSync(backups[index])) fs.copyFileSync(filePath, backups[index]);
    });
  } catch (error) {
    throw new Error(`Kan de oorspronkelijke Nederlandse taalbundel niet veiligstellen: ${error.message}`);
  }

  let original;
  let originalServiceWorker;
  try {
    original = fs.readFileSync(backups[0], 'utf8');
    originalServiceWorker = fs.readFileSync(backups[3], 'utf8');
  } catch (error) {
    throw new Error(`Kan de originele taalbundel of serviceworker niet lezen: ${error.message}`);
  }

  const patched = patchDutchBundle(original, translations);
  if (patched === original) throw new Error('Geen wijziging in Nederlandse LibreChat-taalbundel aangebracht.');
  const cacheVersion = hash(`${JSON.stringify(translations)}\n${candidates[0]}\n${hash(original)}\n${hash(originalServiceWorker)}`).slice(0, 16);
  const patchedServiceWorker = patchServiceWorker(originalServiceWorker, cacheVersion);

  try {
    fs.writeFileSync(bundlePath, patched);
    fs.writeFileSync(`${bundlePath}.gz`, zlib.gzipSync(patched));
    fs.writeFileSync(`${bundlePath}.br`, zlib.brotliCompressSync(patched));
    fs.writeFileSync(serviceWorkerPath, patchedServiceWorker);
  } catch (error) {
    throw new Error(`Kan de Nederlandse taalbundel of serviceworker niet bijwerken: ${error.message}`);
  }

  console.log(`Nederlandse vertalingen: ${Object.keys(translations).length} eigen vertalingen toegepast; serviceworker-cacheversie ${cacheVersion}.`);
  return { applied: true, count: Object.keys(translations).length, bundlePath, cacheVersion };
}

if (require.main === module) {
  try {
    applyTranslations();
  } catch (error) {
    console.error(`Nederlandse vertalingen: ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  applyTranslations,
  normalizeTranslations,
  patchDutchBundle,
  patchServiceWorker,
  translationsEnabled,
};
