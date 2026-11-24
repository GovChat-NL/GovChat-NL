'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { applyMetadata } = require('../../scripts/apply-branding-metadata');

const original = `<!doctype html><html><head>
  <meta charset="utf-8" />
  <meta
    name="description"
    content="LibreChat - An open source chat application with support for multiple AI models"
  />
  <title>LibreChat</title>
  <base href="/" /><meta name="viewport" content="width=device-width" />
</head><body><div id="root"></div></body></html>`;

function fixture(t, html = original) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'govchat-link-preview-'));
  t.after(() => fs.rmSync(dist, { recursive: true, force: true }));
  const assets = path.join(dist, 'assets');
  fs.mkdirSync(assets);
  fs.writeFileSync(path.join(dist, 'index.html'), html);
  fs.writeFileSync(path.join(dist, 'manifest.webmanifest'), JSON.stringify({
    name: 'LibreChat', description: 'Original', start_url: './', scope: '/',
    icons: [{ src: 'assets/icon-192x192.png' }],
  }));
  fs.writeFileSync(path.join(dist, 'sw.js'), 'const entries=[{url:"index.html",revision:"old"},{url:"manifest.webmanifest",revision:"old"},{url:"assets/vendor.js",revision:null}];');
  const read = file => fs.readFileSync(path.join(dist, file), 'utf8');
  const apply = env => applyMetadata({ BRANDING_ASSETS_DIR: assets, ...env });
  return { dist, assets, read, apply };
}

function metaValues(html, key) {
  const tags = html.match(/<meta\b[^>]*>/g) || [];
  return tags.flatMap(tag => {
    const attributes = Object.fromEntries(Array.from(tag.matchAll(/\s+([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g),
      match => [match[1].toLowerCase(), match[2] ?? match[3] ?? match[4]]));
    return attributes.name === key || attributes.property === key ? [attributes.content] : [];
  });
}

function expectMeta(html, key, value) {
  assert.deepEqual(metaValues(html, key), [value], `exactly one ${key}`);
}

test('realistic multiline LibreChat description is replaced with generic deployment metadata', t => {
  const f = fixture(t);
  f.apply({});
  const html = f.read('index.html');
  assert.doesNotMatch(html, /LibreChat|open source chat application/);
  expectMeta(html, 'description', 'GovChat-NL — AI-chatassistent');
  expectMeta(html, 'og:title', 'GovChat-NL');
  expectMeta(html, 'og:site_name', 'GovChat-NL');
  expectMeta(html, 'og:type', 'website');
  expectMeta(html, 'og:description', 'GovChat-NL — AI-chatassistent');
  expectMeta(html, 'twitter:description', 'GovChat-NL — AI-chatassistent');
  expectMeta(html, 'twitter:card', 'summary');
  assert.deepEqual(metaValues(html, 'og:url'), []);
  assert.deepEqual(metaValues(html, 'og:image'), []);
  assert.deepEqual(metaValues(html, 'twitter:image'), []);
  assert.match(html, /<meta charset="utf-8" \/>/);
  assert.match(html, /<base href="\/" \/>/);
  assert.match(html, /<body><div id="root"><\/div><\/body>/);
  assert.equal(JSON.parse(f.read('manifest.webmanifest')).description, 'GovChat-NL — AI-chatassistent');
});

test('charset stays before long metadata and inside the first 1024 document bytes', t => {
  const f = fixture(t);
  f.apply({ APP_TITLE: 'Mijn GovChat', APP_DESCRIPTION: 'é'.repeat(1000), APP_IMAGE_URL: 'https://cdn.example.org/preview.png' });
  const html = f.read('index.html');
  assert.ok(Buffer.byteLength(html.slice(0, html.indexOf('<meta charset="utf-8" />') + 25), 'utf8') < 1024);
  assert.ok(html.indexOf('charset="utf-8"') < html.indexOf('<title>'));
  f.apply({ APP_TITLE: 'Mijn GovChat', APP_DESCRIPTION: 'é'.repeat(1000), APP_IMAGE_URL: 'https://cdn.example.org/preview.png' });
  assert.equal(f.read('index.html'), html);
});

for (const description of [undefined, '', '  \n\t']) {
  test(`empty description falls back to the configured title: ${JSON.stringify(description)}`, t => {
    const f = fixture(t);
    f.apply({ APP_TITLE: 'Mijn assistent', APP_DESCRIPTION: description });
    expectMeta(f.read('index.html'), 'description', 'Mijn assistent — AI-chatassistent');
  });
}

test('configured values, Unicode and HTML metacharacters are escaped without replacement-string expansion', t => {
  const f = fixture(t);
  f.apply({
    APP_TITLE: `A<&"'$&`, APP_DESCRIPTION: `  Café — <script>alert("x")</script> & '$&  `,
    PUBLIC_BASE_URL: 'https://chat.example.org/govchat',
    APP_IMAGE_URL: 'https://cdn.example.org/preview.png?v=2&format=png',
  });
  const html = f.read('index.html');
  const title = 'A&lt;&amp;&quot;&#39;$&amp;';
  const description = 'Café — &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;$&amp;';
  assert.match(html, /<title>A&lt;&amp;&quot;&#39;\$&amp;<\/title>/);
  for (const key of ['og:title', 'twitter:title', 'og:site_name', 'og:image:alt', 'twitter:image:alt']) expectMeta(html, key, title);
  for (const key of ['description', 'og:description', 'twitter:description']) expectMeta(html, key, description);
  expectMeta(html, 'og:url', 'https://chat.example.org/govchat');
  expectMeta(html, 'og:image', 'https://cdn.example.org/preview.png?v=2&amp;format=png');
  expectMeta(html, 'twitter:image', 'https://cdn.example.org/preview.png?v=2&amp;format=png');
  expectMeta(html, 'twitter:card', 'summary_large_image');
  assert.doesNotMatch(html, /<script>alert/);
  assert.equal(JSON.parse(f.read('manifest.webmanifest')).description, `Café — <script>alert("x")</script> & '$&`);
});

test('all stale social tags and duplicates are replaced regardless of quotes, order, whitespace or case', t => {
  const f = fixture(t, `<html><HEAD>
    <TITLE data-test="old">LibreChat</TITLE><title>duplicate</title>
    <META content='LibreChat' NAME = 'DESCRIPTION'>
    <meta content="duplicate" name=description>
    <meta content='LibreChat' PROPERTY='OG:TITLE'>
    <meta name="og:description" content="LibreChat">
    <meta content="https://librechat.example/logo.png" property="og:image">
    <meta property="og:image:secure_url" content="stale">
    <meta name="twitter:image:src" content="stale">
    <meta property="twitter:card" content="stale">
    <meta data-note='name="description"' name="viewport" content="unchanged">
  </HEAD><body>unchanged</body></html>`);
  f.apply({ APP_TITLE: 'GovChat', APP_DESCRIPTION: 'Publieke assistent' });
  const html = f.read('index.html');
  assert.doesNotMatch(html, /LibreChat|duplicate|stale|librechat\.example/);
  assert.equal((html.match(/<title>/g) || []).length, 1);
  expectMeta(html, 'description', 'Publieke assistent');
  expectMeta(html, 'og:title', 'GovChat');
  assert.match(html, /data-note='name="description"' name="viewport" content="unchanged"/);
});

test('missing metadata is inserted while comments and script/style contents are preserved', t => {
  const untouched = `<!-- <meta name="description" content="comment"> -->
<script>const template = '<title>template</title><meta name="description" content="template">';</script>
<style>/* <meta name="description" content="style"> */</style>`;
  const f = fixture(t, `<head>${untouched}</head><body>body</body>`);
  f.apply({ APP_TITLE: 'GovChat' });
  const first = f.read('index.html');
  assert.ok(first.includes(untouched));
  f.apply({ APP_TITLE: 'GovChat' });
  assert.equal(f.read('index.html'), first);
});

test('changed configuration updates metadata, removes old images and remains byte-idempotent', t => {
  const f = fixture(t);
  f.apply({ APP_TITLE: 'Old', APP_IMAGE_URL: 'https://images.example.org/old.png' });
  const env = { APP_TITLE: 'New', APP_DESCRIPTION: 'Nieuwe beschrijving', APP_IMAGE_URL: '', PUBLIC_BASE_URL: 'https://chat.example.org/' };
  f.apply(env);
  const files = ['index.html', 'manifest.webmanifest', 'sw.js', 'assets/govchat-branding.js'];
  const before = files.map(f.read);
  assert.doesNotMatch(before[0], /Old|old\.png|og:image|twitter:image/);
  f.apply(env);
  assert.deepEqual(files.map(f.read), before);
});

for (const variable of ['PUBLIC_BASE_URL', 'APP_IMAGE_URL']) {
  for (const value of ['not-a-url', '/relative.png', '//example.org/image.png', 'javascript:alert(1)', 'data:image/png;base64,a', 'ftp://example.org/image', 'https://user:secret@example.org/', 'https://example.org/#fragment', 'https://example.org/a\nb', 'https://example.org/a b', 'https:\\example.org\\image']) {
    test(`${variable} rejects invalid or unsafe URL ${JSON.stringify(value)} before writes`, t => {
      const f = fixture(t);
      const before = ['index.html', 'manifest.webmanifest', 'sw.js'].map(f.read);
      assert.throws(() => f.apply({ [variable]: value }), new RegExp(variable));
      assert.deepEqual(['index.html', 'manifest.webmanifest', 'sw.js'].map(f.read), before);
      assert.equal(fs.existsSync(path.join(f.assets, 'govchat-branding.js')), false);
    });
  }
}

test('public URL rejects queries and supports upstream DOMAIN_CLIENT fallback', t => {
  const f = fixture(t);
  assert.throws(() => f.apply({ PUBLIC_BASE_URL: 'https://chat.example.org/?token=secret' }), /PUBLIC_BASE_URL/);
  f.apply({ DOMAIN_CLIENT: 'http://localhost:3080', PUBLIC_BASE_URL: '' });
  expectMeta(f.read('index.html'), 'og:url', 'http://localhost:3080/');
  f.apply({ DOMAIN_CLIENT: 'https://fallback.example.org/', PUBLIC_BASE_URL: 'https://preferred.example.org/' });
  expectMeta(f.read('index.html'), 'og:url', 'https://preferred.example.org/');
});

test('no complete head fails clearly instead of silently keeping upstream metadata', t => {
  const f = fixture(t, '<html><title>LibreChat</title><body>broken</body></html>');
  assert.throws(() => f.apply({}), /no complete head/);
  assert.match(f.read('index.html'), /LibreChat/);
});

test('custom manifest metadata is preserved unless an explicit env description wins', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dist, 'site.webmanifest'), JSON.stringify({
    name: 'Custom name', description: 'Custom PWA description', theme_color: '#123456',
    scope: '/wrong/', start_url: '/wrong/', icons: [{ src: '/wrong.png' }],
  }));
  const env = { BRANDING_MODE: 'custom', BRANDING_CUSTOM_DIR: f.dist };
  f.apply(env);
  assert.equal(JSON.parse(f.read('manifest.webmanifest')).description, 'Custom PWA description');
  expectMeta(f.read('index.html'), 'description', 'GovChat-NL — AI-chatassistent');
  f.apply({ ...env, APP_DESCRIPTION: 'Env description' });
  const manifest = JSON.parse(f.read('manifest.webmanifest'));
  assert.equal(manifest.description, 'Env description');
  assert.equal(manifest.theme_color, '#123456');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.icons[0].src, 'assets/icon-192x192.png');
});

test('HTML, manifest and branding script compressed variants and Workbox revisions stay current', t => {
  const f = fixture(t);
  const files = ['index.html', 'manifest.webmanifest', 'sw.js', 'assets/govchat-branding.js'];
  for (const file of files) {
    fs.writeFileSync(path.join(f.dist, `${file}.gz`), zlib.gzipSync('LibreChat'));
    fs.writeFileSync(path.join(f.dist, `${file}.br`), zlib.brotliCompressSync('LibreChat'));
  }
  const env = { APP_DESCRIPTION: 'Beschrijving één', APP_IMAGE_URL: 'https://images.example.org/preview.png' };
  f.apply(env);
  const oldSW = f.read('sw.js');
  f.apply({ ...env, APP_DESCRIPTION: 'Beschrijving twee' });
  assert.notEqual(f.read('sw.js'), oldSW);
  for (const file of files) {
    const expected = fs.readFileSync(path.join(f.dist, file));
    assert.deepEqual(zlib.gunzipSync(fs.readFileSync(path.join(f.dist, `${file}.gz`))), expected);
    assert.deepEqual(zlib.brotliDecompressSync(fs.readFileSync(path.join(f.dist, `${file}.br`))), expected);
  }
  for (const file of ['index.html', 'manifest.webmanifest']) {
    assert.ok(f.read('sw.js').includes(crypto.createHash('sha256').update(f.read(file)).digest('hex')));
  }
  assert.match(f.read('sw.js'), /vendor\.js",revision:null/);
});
