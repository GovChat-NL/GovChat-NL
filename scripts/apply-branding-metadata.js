'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

function write(file, content) {
  fs.writeFileSync(file, content);
  // Do not leave image-provided precompressed responses with stale branding.
  for (const [suffix, compress] of [['.gz', zlib.gzipSync], ['.br', zlib.brotliCompressSync]]) {
    if (fs.existsSync(file + suffix)) fs.writeFileSync(file + suffix, compress(content));
  }
}

function applyMetadata(env = process.env) {
  const assets = env.BRANDING_ASSETS_DIR || '/app/client/dist/assets';
  const dist = path.dirname(assets);
  const appName = env.APP_TITLE || 'GovChat-NL';
  const escapeHTML = value => value.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
  const indexPath = path.join(dist, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');
  html = html.replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHTML(appName)}</title>`);
  html = html.replace(/(<meta name="description" content=")[^"]*("\s*\/?>)/,
    (match, prefix, suffix) => `${prefix}${escapeHTML(appName)} — AI-chatassistent${suffix}`);
  const brandingTag = '<script src="/assets/govchat-branding.js"></script>';
  if (!html.includes(brandingTag)) html = html.replace('</head>', `${brandingTag}</head>`);
  write(indexPath, html);
  write(path.join(assets, 'govchat-branding.js'),
    `window.GOVCHAT_BRANDING=${JSON.stringify({ appName })};\n`);

  const manifestPath = path.join(dist, 'manifest.webmanifest');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const customManifestPath = path.join(env.BRANDING_CUSTOM_DIR || '/opt/branding/custom', 'site.webmanifest');
  if (env.BRANDING_MODE === 'custom' && fs.existsSync(customManifestPath)) {
    const custom = JSON.parse(fs.readFileSync(customManifestPath, 'utf8'));
    // Preserve LibreChat's scope, start URL and canonical icon paths: favicon
    // generators reference root-level files which LibreChat does not serve.
    for (const key of ['theme_color', 'background_color', 'display', 'description', 'lang']) {
      if (typeof custom[key] === 'string') manifest[key] = custom[key];
    }
    if (!custom.description && typeof custom.name === 'string') manifest.description = custom.name;
  }
  manifest.name = appName;
  manifest.short_name = appName;
  write(manifestPath, JSON.stringify(manifest));

  // Workbox otherwise keeps the original icons even after the serviceworker updates.
  const swPath = path.join(dist, 'sw.js');
  if (fs.existsSync(swPath)) {
    let sw = fs.readFileSync(swPath, 'utf8');
    sw = sw.replace(/(\{url:["']([^"']+)["'],revision:)(["'][^"']*["']|null)/g,
      (match, prefix, url) => {
        if (!/^(?:\.\/)?(?:assets\/(?:logo\.svg|favicon-\d+x\d+\.png|apple-touch-icon-180x180\.png|icon-192x192\.png|maskable-icon\.png)|manifest\.webmanifest|index\.html)$/.test(url)) return match;
        const file = path.join(dist, url);
        if (!fs.existsSync(file)) return match;
        const revision = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        return prefix + JSON.stringify(revision);
      });
    write(swPath, sw);
  }
  console.log(`Branding: applicatietitel en webmanifest ingesteld op ${appName}`);
}

module.exports = { applyMetadata };
if (require.main === module) {
  try { applyMetadata(); } catch (error) {
    console.error('Branding metadata: ' + error.message);
    process.exitCode = 1;
  }
}
