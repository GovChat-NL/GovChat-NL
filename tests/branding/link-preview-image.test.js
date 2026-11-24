'use strict';

// Runs automatically in the public regression suite's pinned LibreChat image.
// Exercises the startup wrapper and the image's own HTML response handler over
// loopback HTTP. No database, deployment, credentials or client-side JS needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const zlib = require('node:zlib');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');

const imageServer = '/app/api/server/index.js';
const inImage = fs.existsSync(imageServer) && fs.existsSync('/app/client/dist/index.html');

for (const mode of ['govchat', 'custom', 'librechat']) {
  test(`pinned image startup and crawler HTTP responses: ${mode}`, { skip: !inImage }, async t => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'govchat-preview-image-'));
    t.after(() => fs.rmSync(dist, { recursive: true, force: true }));
    const assets = path.join(dist, 'assets');
    fs.mkdirSync(assets);
    for (const file of ['index.html', 'manifest.webmanifest', 'sw.js']) {
      const source = path.join('/app/client/dist', file);
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(dist, file));
    }
    const upstreamHTML = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
    assert.match(upstreamHTML, /name="description"\s+content="LibreChat/);
    const scripts = path.resolve(__dirname, '../../scripts');
    const env = {
      PATH: process.env.PATH,
      BRANDING_MODE: mode, BRANDING_ASSETS_DIR: assets,
      BRANDING_GOVCHAT_DIR: path.resolve(__dirname, '../../branding'),
      BRANDING_CUSTOM_DIR: dist,
      BRANDING_METADATA_SCRIPT: path.join(scripts, 'apply-branding-metadata.js'),
      LIBRECHAT_NL_TRANSLATIONS_SCRIPT: path.join(scripts, 'apply-dutch-translations.js'),
      LIBRECHAT_NL_TRANSLATIONS_ENABLED: 'false',
      GOVCHAT_MINIMAL_UI_SCRIPT: path.join(scripts, 'apply-minimal-ui.js'),
      GOVCHAT_MINIMAL_UI: 'false',
      APP_TITLE: 'Mijn GovChat', APP_DESCRIPTION: 'AI-assistent voor onze organisatie',
      PUBLIC_BASE_URL: 'https://chat.example.org/',
      APP_IMAGE_URL: 'https://cdn.example.org/govchat-preview.png',
    };
    const startup = spawnSync('sh', [path.join(scripts, 'apply-branding.sh'), 'true'], { env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(startup.status, 0, startup.stderr || startup.error?.message);
    const indexHTML = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
    assert.doesNotMatch(indexHTML, /LibreChat - An open source/);

    // Use the response-handler source from the pinned image, rather than a
    // second hand-written handler. Stub unrelated CSP/devtools features only;
    // assert the image still uses this handler for index and SPA fallback.
    const source = fs.readFileSync(imageServer, 'utf8');
    const handler = source.match(/const sendIndexHtml = \(req, res\) => \{[\s\S]*?\n  \};/);
    assert.ok(handler, 'Pinned image HTML handler contract changed');
    assert.match(source, /app\.get\('\/index\.html', sendIndexHtml\)/);
    assert.match(source, /app\.use\(createSpaFallback\(sendIndexHtml\)\)/);
    const sendIndexHtml = vm.runInNewContext(`${handler[0]}\nsendIndexHtml;`, {
      indexHTML, shellCache: {}, QUERY_DEVTOOLS_HEADER: 'X-Query-Devtools', cspPolicy: null,
      escapeHtmlAttribute: value => value.replace(/[&<>"']/g, ''),
      maybeInjectQueryDevtoolsBootstrap: value => value,
    });
    const imageRequire = createRequire(imageServer);
    const app = imageRequire('express')();
    app.use(imageRequire('compression')());
    app.use((req, res, next) => { req.cookies = {}; next(); });
    app.get('/index.html', sendIndexHtml);
    app.use(sendIndexHtml);
    const server = app.listen(0, '127.0.0.1');
    t.after(() => new Promise(resolve => server.close(resolve)));
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });

    for (const route of ['/', '/index.html', '/share/preview-regression', '/c/new']) {
      for (const gzip of [false, true]) {
        const response = await new Promise((resolve, reject) => {
          const request = http.get({ hostname: '127.0.0.1', port: server.address().port, path: route,
            headers: { 'User-Agent': 'WhatsApp/2.0 crawler', 'Accept-Language': 'nl-NL',
              'Accept-Encoding': gzip ? 'gzip' : 'identity' } }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
            res.on('error', reject);
          });
          request.setTimeout(5000, () => request.destroy(new Error('Crawler request timed out')));
          request.on('error', reject);
        });
        assert.equal(response.status, 200);
        assert.match(response.headers['content-type'], /text\/html/);
        if (gzip) assert.equal(response.headers['content-encoding'], 'gzip');
        const html = (gzip ? zlib.gunzipSync(response.body) : response.body).toString('utf8');
        assert.match(html, /<title>Mijn GovChat<\/title>/);
        for (const key of ['description', 'og:description', 'twitter:description']) {
          assert.ok(html.includes(`="${key}" content="AI-assistent voor onze organisatie"`));
        }
        assert.ok(html.includes('property="og:url" content="https://chat.example.org/"'));
        assert.ok(html.includes('property="og:image" content="https://cdn.example.org/govchat-preview.png"'));
        assert.doesNotMatch(html, /LibreChat - An open source|preview-regression/);
      }
    }
  });
}
