'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { patchManualNative, patches, helperPath, helper } = require('../../scripts/patch-manual-native.js');
const root = path.resolve(__dirname, '../..');
const nativeRoot = process.env.GOVCHAT_TEST_LIBRECHAT_ROOT || path.join(root, '.manual-tools/LibreChat-0.8.8');
const available = patches.every(patch => fs.existsSync(path.join(nativeRoot, patch.file)));
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'govchat-manual-markers-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  for (const patch of patches) {
    const target = path.join(temp, patch.file); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(nativeRoot, patch.file), target);
  }
  return temp;
}
test('pinned marker patch is byte-idempotent and confined to exact native components', { skip: !available }, t => {
  const temp = fixture(t); const files = patchManualNative(temp);
  const first = files.map(file => fs.readFileSync(path.join(temp, file), 'utf8'));
  patchManualNative(temp);
  assert.deepEqual(files.map(file => fs.readFileSync(path.join(temp, file), 'utf8')), first);
  assert.equal(files.length, 7);
  assert.equal(fs.readFileSync(path.join(temp, helperPath), 'utf8'), helper);
  assert.doesNotMatch(first.join(''), /MutationObserver|setInterval|setTimeout/);
  const footer = first[0];
  assert.match(footer, /configuredFooter \?\? genericFooter/);
  assert.match(footer, /privacyPolicyRender, termsOfServiceRender/);
  assert.equal((footer.match(/data-govchat-manual-slot="desktop"/g) || []).length, 1);
  assert.equal((footer.match(/data-govchat-manual-slot="mobile"/g) || []).length, 1);
  assert.match(footer, /hidden items-center.*sm:flex/);
  assert.match(footer, /sm:hidden.*data-govchat-manual-slot="mobile"/);
  assert.match(footer, /manualEnabled \|\| \(isSuccess/);
  const menu = first[1];
  assert.match(menu, /manualEnabled \|\| hasHelpFaq/);
  assert.match(menu, /manualEnabled \? openManualEntrypoint\(\) : openInNewTab\(helpAndFaqURL\)/);
  assert.match(menu, /openInNewTab\(termsOfServiceURL\)/);
  assert.match(menu, /openInNewTab\(privacyPolicyURL\)/);
  assert.match(first[2], /<NativeError \{\.\.\.props\} \/>/);
  assert.match(first[3], /<Alert/);
  assert.match(first[4], /onClick=\{onRetry\}/);
  assert.match(first[5], /useManualEntrypoints/);
  const clearance = first[5].match(/if \(manualEnabled\) bottomClearance = `mb-14 \$\{bottomClearance\}`;/)[0];
  for (const enabled of [false, true]) {
    const context = { manualEnabled: enabled, bottomClearance: 'sm:mb-10' };
    vm.runInNewContext(clearance, context);
    assert.equal(context.bottomClearance, enabled ? 'mb-14 sm:mb-10' : 'sm:mb-10');
  }
});

test('source drift or partially modified patch fails before any writes', { skip: !available }, t => {
  const temp = fixture(t);
  const last = path.join(temp, patches.at(-1).file); fs.appendFileSync(last, '\n// unexpected source drift\n');
  const first = path.join(temp, patches[0].file); const original = fs.readFileSync(first, 'utf8');
  assert.throws(() => patchManualNative(temp), /changed/);
  assert.equal(fs.readFileSync(first, 'utf8'), original);
  fs.copyFileSync(path.join(nativeRoot, patches.at(-1).file), last); patchManualNative(temp);
  fs.appendFileSync(last, '\n// drift after patch\n');
  assert.throws(() => patchManualNative(temp), /changed/);
});

test('native Help & FAQ keeps external fallback only while manual disabled', { skip: !available }, t => {
  const temp = fixture(t); patchManualNative(temp);
  const menu = fs.readFileSync(path.join(temp, patches[1].file), 'utf8');
  const branch = menu.match(/onClick=\{\(\) => (manualEnabled \? openManualEntrypoint\(\) : openInNewTab\(helpAndFaqURL\))\}/)[1];
  for (const enabled of [false, true]) {
    const calls = [];
    vm.runInNewContext(branch, { manualEnabled: enabled, helpAndFaqURL: 'https://faq.example/',
      openManualEntrypoint: () => calls.push('manual'), openInNewTab: url => calls.push(url) });
    assert.deepEqual(calls, [enabled ? 'manual' : 'https://faq.example/']);
  }
});

async function renderFooter(temp, config, enabled) {
  const React = require('react'); const ts = require('typescript');
  const Markdown = (await import(pathToFileURL(require.resolve('react-markdown')).href)).default;
  const filename = path.join(temp, patches[0].file); const source = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  const dependencies = {
    react: React, 'react-markdown': Markdown, 'react-gtm-module': { initialize() {} },
    'librechat-data-provider': { Constants: { VERSION: 'test-version' }, hasConfiguredFooter: () => false },
    '~/data-provider': { useGetStartupConfig: () => ({ data: config, isSuccess: true }) },
    '~/hooks': { useLocalize: () => key => key }, './useManualEntrypoints': { useManualEntrypoints: () => enabled },
  };
  vm.runInNewContext(compiled, { module, exports: module.exports, require: name => {
    assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name];
  } });
  return require('react-dom/server').renderToStaticMarkup(React.createElement(module.exports.default, { configuredOnly: true }));
}
test('patched native footer preserves warning, empty override, Markdown and legal links with enabled slots', { skip: !available }, async t => {
  const temp = fixture(t); patchManualNative(temp);
  for (const enabled of [false, true]) {
    const warning = await renderFooter(temp, { customFooter: '**Controleer bronnen**' }, enabled);
    assert.equal((warning.match(/Controleer bronnen/g) || []).length, 1); assert.match(warning, /<strong>Controleer bronnen<\/strong>/);
    const empty = await renderFooter(temp, { customFooter: '' }, enabled);
    assert.doesNotMatch(empty, /librechat\.ai|test-version|com_ui_latest_footer/);
    assert.equal(empty.includes('data-govchat-manual-slot="desktop"'), enabled);
    if (!enabled) assert.equal(empty, '');
    const legal = await renderFooter(temp, { customFooter: '', interface: {
      privacyPolicy: { externalUrl: 'https://example.org/privacy' }, termsOfService: { externalUrl: 'https://example.org/terms' },
    } }, enabled);
    assert.match(legal, /https:\/\/example\.org\/privacy/); assert.match(legal, /https:\/\/example\.org\/terms/);
  }
});

test('every patched native source transpiles against the existing TypeScript toolchain', { skip: !available }, t => {
  const temp = fixture(t); const files = patchManualNative(temp); const ts = require('typescript');
  for (const file of files) {
    const result = ts.transpileModule(fs.readFileSync(path.join(temp, file), 'utf8'), {
      fileName: file, reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    });
    assert.deepEqual(result.diagnostics || [], [], file);
  }
});

test('actual failed-turn wrapper exposes exact structured/nested/native LangChain codes and retains native rendering', { skip: !available }, t => {
  const temp = fixture(t); patchManualNative(temp); const React = require('react'); const ts = require('typescript');
  const filename = path.join(temp, patches[2].file);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const readString = (object, key) => typeof object?.[key] === 'string' ? object[key] : undefined;
  const readObject = (object, key) => object?.[key] && typeof object[key] === 'object' ? object[key] : undefined;
  const deps = {
    'react/jsx-runtime': require('react/jsx-runtime'),
    'librechat-data-provider': { parseLangChainErrorCode: text => text === 'native-langchain-failure' ? 'MODEL_RATE_LIMIT' : undefined },
    './registry': { errorCopy: {}, errorRenderers: {} },
    './ProviderError': { UnclassifiedError: () => React.createElement('p', null, 'Native provider failure') },
    '~/utils/json': { extractJson: text => text, isJson: text => { try { JSON.parse(text); return true; } catch { return false; } } },
    './parts': { readString, readObject }, './source': { useErrorSource: () => undefined },
    '~/hooks': { useLocalize: () => key => key },
  };
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, require: name => { assert.ok(Object.hasOwn(deps, name), name); return deps[name]; } });
  const render = text => require('react-dom/server').renderToStaticMarkup(React.createElement(module.exports.default, { text }));
  const flat = render(JSON.stringify({ code: 'BadRequest', message: 'Exact failure' }));
  assert.match(flat, /data-govchat-error-code="BadRequest"/); assert.match(flat, /data-govchat-error-message="Exact failure"/);
  assert.match(flat, /Native provider failure/);
  assert.match(render(JSON.stringify({ error: { code: 'NETWORK_ERROR', message: 'Network Error' } })), /data-govchat-error-code="NETWORK_ERROR"/);
  assert.match(render('native-langchain-failure'), /data-govchat-error-code="MODEL_RATE_LIMIT"/);
  const unknown = render('<not a known code>');
  assert.doesNotMatch(unknown, /data-govchat-error-code=/); assert.match(unknown, /&lt;not a known code&gt;/);
});

test('opt-in build applies markers before client build using pinned upstream locked dependencies', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'scripts/manual-native.Dockerfile'), 'utf8');
  assert.match(dockerfile, /FROM registry\.librechat\.ai\/librechat-ai\/librechat:v0\.8\.8/);
  assert.ok(dockerfile.indexOf('node /tmp/patch-manual-native.cjs /app') < dockerfile.indexOf('npm run build:client'));
  assert.match(dockerfile, /npm ci --include=dev/); assert.doesNotMatch(dockerfile, /npm install|latest/);
  const compose = fs.readFileSync(path.join(root, 'docker-compose.manual-native-build.yml'), 'utf8');
  assert.match(compose, /dockerfile: scripts\/manual-native\.Dockerfile/);
  const ignore = fs.readFileSync(path.join(root, 'scripts/manual-native.Dockerfile.dockerignore'), 'utf8');
  assert.match(ignore, /^\*\*$/m); assert.match(ignore, /^!scripts\/patch-manual-native\.js$/m);
});
