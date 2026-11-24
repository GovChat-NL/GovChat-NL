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

function escapeHTML(value) {
  return value.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function httpURL(value, variable, { allowQuery = false } = {}) {
  if (!value) return '';
  let url;
  try { url = new URL(value); } catch {
    throw new Error(`${variable} must be an absolute HTTP(S) URL`);
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash ||
      (!allowQuery && url.search) || /[\s\u0000-\u001f\u007f]/.test(value) ||
      !/^https?:\/\//i.test(value) || value.includes('\\')) {
    throw new Error(`${variable} must be an absolute HTTP(S) URL without credentials, fragments${allowQuery ? '' : ' or query parameters'}`);
  }
  return url.href;
}

function attribute(tag, name) {
  // Parse complete attributes, not attribute-like text inside another value.
  const attributes = /\s+([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of tag.matchAll(attributes)) {
    if (match[1].toLowerCase() === name) return (match[2] ?? match[3] ?? match[4] ?? '').toLowerCase();
  }
  return '';
}

function renderMetadata(html, { appName, description, publicURL, imageURL }) {
  const head = /(<head\b[^>]*>)([\s\S]*?)(<\/head\s*>)/i;
  if (!head.test(html)) throw new Error('Branding metadata: index.html has no complete head element');
  const meta = (kind, key, value) => `<meta ${kind}="${key}" content="${escapeHTML(value)}" />`;
  const tags = [
    `<title>${escapeHTML(appName)}</title>`,
    meta('name', 'description', description),
    meta('property', 'og:type', 'website'),
    meta('property', 'og:site_name', appName),
    meta('property', 'og:title', appName),
    meta('property', 'og:description', description),
    meta('name', 'twitter:card', imageURL ? 'summary_large_image' : 'summary'),
    meta('name', 'twitter:title', appName),
    meta('name', 'twitter:description', description),
  ];
  if (publicURL) tags.push(meta('property', 'og:url', publicURL));
  if (imageURL) tags.push(
    meta('property', 'og:image', imageURL), meta('property', 'og:image:alt', appName),
    meta('name', 'twitter:image', imageURL), meta('name', 'twitter:image:alt', appName),
  );
  const brandingTag = '<script src="/assets/govchat-branding.js"></script>';
  return html.replace(head, (match, open, content, close) => {
    let charset = '';
    // Only transform actual head tags. Leave comments, inline scripts/styles,
    // body markup and unrelated metadata intact. Remove stale social metadata
    // (including image subproperties) so crawlers cannot select upstream values.
    const tokens = /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<title\b[^>]*>[\s\S]*?<\/title\s*>|<meta\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
    content = content.replace(tokens, tag => {
      if (/^<title\b/i.test(tag)) return '';
      if (!/^<meta\b/i.test(tag)) return tag;
      // Keep the encoding declaration before potentially long preview text.
      // HTML requires it within the first 1024 bytes of the document.
      if (attribute(tag, 'charset')) {
        if (!charset) charset = tag;
        return '';
      }
      const keys = [attribute(tag, 'name'), attribute(tag, 'property')];
      return keys.some(key => key === 'description' || /^(og:|twitter:)/.test(key)) ? '' : tag;
    });
    // Keep the canonical generated block at the start for idempotent restarts.
    content = content.replace(/^\s+/, '');
    if (!content.includes(brandingTag)) content += brandingTag;
    return `${open}\n${charset ? `${charset}\n` : ''}${tags.join('\n')}\n${content}${close}`;
  });
}

function applyMetadata(env = process.env) {
  const assets = env.BRANDING_ASSETS_DIR || '/app/client/dist/assets';
  const dist = path.dirname(assets);
  const appName = env.APP_TITLE || 'GovChat-NL';
  const configuredDescription = (env.APP_DESCRIPTION || '').trim();
  const description = configuredDescription || `${appName} — AI-chatassistent`;
  // Resolve and validate before modifying any files. Never fetch configured URLs.
  const publicURL = httpURL(env.PUBLIC_BASE_URL || env.DOMAIN_CLIENT || '', 'PUBLIC_BASE_URL');
  const imageURL = httpURL((env.APP_IMAGE_URL || '').trim(), 'APP_IMAGE_URL', { allowQuery: true });
  const indexPath = path.join(dist, 'index.html');
  const html = renderMetadata(fs.readFileSync(indexPath, 'utf8'), { appName, description, publicURL, imageURL });
  write(indexPath, html);
  write(path.join(assets, 'govchat-branding.js'),
    `window.GOVCHAT_BRANDING=${JSON.stringify({ appName })};\n`);

  const manifestPath = path.join(dist, 'manifest.webmanifest');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.description = description;
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
  // A supplied env description wins; otherwise preserve the custom manifest.
  if (configuredDescription) manifest.description = configuredDescription;
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
  console.log(`Branding: applicatietitel en webmanifest ingesteld op ${appName}; linkpreview-metadata bijgewerkt`);
}

module.exports = { applyMetadata };
if (require.main === module) {
  try { applyMetadata(); } catch (error) {
    console.error('Branding metadata: ' + error.message);
    process.exitCode = 1;
  }
}
