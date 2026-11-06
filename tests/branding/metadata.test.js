'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { applyMetadata } = require('../../scripts/apply-branding-metadata');

for (const title of [undefined, 'LAICA', 'A<&"$&']) {
  test(`deployment metadata: ${title || 'GovChat-NL default'}`, () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'branding-metadata-'));
    const assets = path.join(dist, 'assets');
    fs.mkdirSync(assets);
    fs.writeFileSync(path.join(dist, 'index.html'), '<head><title>LibreChat</title><meta name="description" content="Original" /></head>');
    fs.writeFileSync(path.join(dist, 'manifest.webmanifest'), JSON.stringify({ name: 'LibreChat', short_name: 'LibreChat', start_url: './', icons: [{ src: 'assets/icon-192x192.png' }] }));
    fs.writeFileSync(path.join(assets, 'icon-192x192.png'), 'custom-icon');
    fs.writeFileSync(path.join(dist, 'sw.js'), 'const entries=[{url:"assets/icon-192x192.png",revision:"old"},{url:"manifest.webmanifest",revision:"old"},{url:"assets/vendor.js",revision:null}];');
    const compressedFiles = ['index.html', 'manifest.webmanifest', 'sw.js', 'assets/govchat-branding.js'];
    for (const file of compressedFiles) {
      fs.writeFileSync(path.join(dist, file + '.gz'), zlib.gzipSync('stale branding'));
      fs.writeFileSync(path.join(dist, file + '.br'), zlib.brotliCompressSync('stale branding'));
    }
    try {
      const env = { BRANDING_ASSETS_DIR: assets, APP_TITLE: title };
      applyMetadata(env);
      const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
      const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.webmanifest'), 'utf8'));
      assert.equal(manifest.name, title || 'GovChat-NL');
      assert.equal(manifest.short_name, manifest.name);
      assert.equal(manifest.start_url, './');
      assert.equal(manifest.icons[0].src, 'assets/icon-192x192.png');
      assert.match(html, /govchat-branding\.js/);
      if (title?.includes('<')) assert.match(html, /A&lt;&amp;&quot;\$&amp;/);
      const context = { window: {} };
      vm.runInNewContext(fs.readFileSync(path.join(assets, 'govchat-branding.js'), 'utf8'), context);
      assert.equal(context.window.GOVCHAT_BRANDING.appName, manifest.name);
      const sw = fs.readFileSync(path.join(dist, 'sw.js'), 'utf8');
      assert.ok(sw.includes(crypto.createHash('sha256').update('custom-icon').digest('hex')));
      assert.match(sw, /vendor\.js",revision:null/);
      applyMetadata(env);
      assert.equal(fs.readFileSync(path.join(dist, 'index.html'), 'utf8'), html);
      assert.equal(fs.readFileSync(path.join(dist, 'sw.js'), 'utf8'), sw);
      fs.writeFileSync(path.join(dist, 'site.webmanifest'), JSON.stringify({
        name: 'Limburgse AI Chat Assistent', short_name: 'LAICA',
        background_color: '#ffffff', theme_color: '#ffffff', display: 'standalone',
        icons: [{ src: '/web-app-manifest-192x192.png' }],
      }));
      applyMetadata({ ...env, BRANDING_MODE: 'custom', BRANDING_CUSTOM_DIR: dist });
      const customManifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.webmanifest'), 'utf8'));
      assert.equal(customManifest.name, title || 'GovChat-NL');
      assert.equal(customManifest.description, 'Limburgse AI Chat Assistent');
      assert.equal(customManifest.theme_color, '#ffffff');
      assert.equal(customManifest.background_color, '#ffffff');
      assert.equal(customManifest.icons[0].src, 'assets/icon-192x192.png');
      for (const file of compressedFiles) {
        const expected = fs.readFileSync(path.join(dist, file));
        assert.deepEqual(zlib.gunzipSync(fs.readFileSync(path.join(dist, file + '.gz'))), expected);
        assert.deepEqual(zlib.brotliDecompressSync(fs.readFileSync(path.join(dist, file + '.br'))), expected);
      }
    } finally {
      fs.rmSync(dist, { recursive: true, force: true });
    }
  });
}
