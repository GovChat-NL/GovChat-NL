'use strict';
const { test } = require('node:test');
const adapter = require('../scripts/librechat-openid-recovery-preload');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

async function runBackendContributionTests({
  backendAdapter,
  nativeRoot = '/app',
} = {}) {
  const names = [];
  const check = async (name, fn) => { await fn(); names.push(name); };
  const raw = {};
  const patched = {};
  const keys = ['api/server/controllers/AuthController.js', 'api/server/socialLogins.js',
    'packages/api/dist/index.cjs'];
  await check('exactly three original touched-source fingerprints; syntax and raw-anchor rejection', () => {
    assert.deepEqual(Object.keys(backendAdapter.HASHES).sort(), keys.slice().sort());
    for (const key of keys) {
      raw[key] = fs.readFileSync(path.join(nativeRoot, key), 'utf8');
      assert.equal(crypto.createHash('sha256').update(raw[key]).digest('hex'), backendAdapter.HASHES[key]);
      patched[key] = backendAdapter.patchBackend(key, raw[key]);
      assert.notEqual(patched[key], raw[key]);
      new vm.Script(patched[key], { filename: key }); // Parse the entire real compiled package; do not run it.
      assert.throws(() => backendAdapter.patchBackend(key, patched[key]), /anchor/);
      assert.throws(() => backendAdapter.patchBackend(key, ''), /anchor/);
      assert.throws(() => backendAdapter.patchBackend(key, raw[key] + raw[key]), /anchor/);
    }
    assert.equal(backendAdapter.patchBackend('unrelated-source.js', 'untouched'), 'untouched');
  });

  const now = 1800000000000;
  const nowSeconds = now / 1000;
  class FixedDate extends Date { static now() { return now; } }
  // Synthetic JWT decode fixture, not authentication/signature verification.
  // VM exercises actual image controller/helpers; this substitutes only the JWT dependency.
  const jwt = {
    decode(token) {
      if (token === 'decode-throws') throw new Error('synthetic decode error');
      if (typeof token !== 'string' || token.split('.').length !== 3) return null;
      try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
      catch { return null; }
    },
    verify() { return { id: 'fixture-user' }; },
  };
  const token = (payload) => 'eyJhbGciOiJub25lIn0.' +
    Buffer.from(JSON.stringify(payload)).toString('base64url') + '.fixture';
  const bufferMatch = raw[keys[2]].match(/const OPENID_EXPIRY_BUFFER_SECONDS = (\d+);/g);
  assert.equal(bufferMatch.length, 1);
  const buffer = Number(bufferMatch[0].match(/= (\d+)/)[1]);
  assert.equal(buffer, 30); // Evidence from this official image, never assume a 60-second policy.
  const liveAccess = token({ exp: nowSeconds + buffer + 300 });
  const liveId = token({ exp: nowSeconds + buffer + 500 });
  const logger = { info() {}, debug() {}, warn() {}, error() {} };
  const between = (source, first, last) => {
    assert.equal(source.split(first).length, 2);
    assert.equal(source.split(last).length, 2);
    const begin = source.indexOf(first);
    const end = source.indexOf(last, begin + first.length);
    assert.ok(end > begin);
    return source.slice(begin, end);
  };
  const controllerSource = patched[keys[0]];
  const api = {
    math: (_value, fallback) => fallback,
    isEnabled: (value) => value === 'true',
    createAuthIdentityContext: ({ user }) => ({ appUserId: user._id }),
    isOpenIDSessionIdentityMatch: () => true,
    isOpenIDRefreshOwnershipError: (error) => error?.code === 'FIXTURE_OWNERSHIP',
    isOpenIDSessionMissingError: (error) => error?.code === 'FIXTURE_SESSION_MISSING',
    OPENID_EXPIRY_BUFFER_SECONDS: buffer,
  };
  function loadController({ grantError, grantResult, identityMatches = true } = {}) {
    const calls = { grant: 0, publication: 0, cleared: 0, bridge: 0,
      generation: 0, claim: 0, authorized: 0, release: 0, cloudfront: 0 };
    const user = { _id: 'fixture-user', provider: 'openid', openidId: 'fixture-sub',
      password: 'fixture-redacted', totpSecret: 'fixture-redacted', federatedTokens: {} };
    const dependencies = {
      cookie: { parse: () => ({ token_provider: 'openid', refreshToken: 'fixture-refresh',
        openid_user_id: 'fixture-signed-cookie' }) },
      jsonwebtoken: jwt,
      'node:crypto': crypto,
      '@librechat/data-schemas': { logger, runAsSystem: (fn) => fn(),
        tenantStorage: { run: (_tenant, fn) => fn() } },
      '@librechat/api': { ...api, isOpenIDSessionIdentityMatch: () => identityMatches },
      '~/server/services/AuthService': {
        clearOpenIDAuthTokens: () => { calls.cleared++; },
        setCloudFrontAuthCookies: () => { calls.cloudfront++; return false; },
      },
      '~/models': { getUserById: async () => user, updateUser: async () => {} },
      '~/server/services/GraphTokenService': {},
      '~/server/services/RefreshTokenBridge': {
        getRefreshTokenBridge: async () => { calls.bridge++; return null; },
      },
      '~/server/services/OpenIDRefreshRecovery': {
        refreshOpenIDUser: async () => {
          calls.grant++;
          if (grantError) throw grantError;
          return grantResult || { tokenset: {}, claims: { sub: 'fixture-sub' }, user };
        },
        sendOpenIDAuthResponse: async () => { calls.publication++; return 'fixture-fresh-auth'; },
      },
      '~/server/services/OpenIDRefreshFlight': {
        assertOpenIDRefreshSessionGenerationAvailable: async () => { calls.generation++; },
        claimOpenIDRefreshFlightDelivery: async () => { calls.claim++; return { deliveryId: 'fixture-delivery' }; },
        assertOpenIDRefreshFlightDeliveryAvailable: async () => { calls.authorized++; },
        releaseOpenIDRefreshFlightDelivery: async () => { calls.release++; },
      },
    };
    const context = { module: { exports: {} }, Date: FixedDate,
      process: { env: { OPENID_REUSE_TOKENS: 'true', JWT_REFRESH_SECRET: 'fixture-not-used-for-signing' } },
      require(name) {
        assert.ok(Object.hasOwn(dependencies, name), 'Disallowed controller dependency: ' + name);
        return dependencies[name];
      },
      setTimeout() { throw new Error('Unexpected timer: isolated source tests must not start services'); },
    };
    vm.runInNewContext(controllerSource + '\nmodule.exports.__backendTest = {' +
      ' getReusableOpenIDSessionToken, hasCurrentOpenIDAccessToken, isTransientOpenIDProviderError };',
      context, { filename: keys[0], timeout: 1000 });
    return { exports: context.module.exports, calls };
  }
  const helpers = loadController().exports.__backendTest;
  const recent = { lastRefreshedAt: now, accessToken: liveAccess, idToken: liveId,
    refreshToken: 'fixture-refresh', appUserId: 'fixture-user' };
  await check('access-token freshness uses its own finite JWT exp and image buffer; ID-only fails', () => {
    const reuse = helpers.getReusableOpenIDSessionToken;
    assert.equal(reuse(recent).token, liveId); // Keep native bearer preference.
    for (const exp of [nowSeconds - 1, nowSeconds + buffer, undefined, null,
      String(nowSeconds + 500), 'Infinity']) {
      assert.equal(reuse({ ...recent, accessToken: token({ exp }),
        accessTokenExpiresAt: nowSeconds + 900 }), null);
    }
    assert.equal(reuse({ ...recent, accessToken: token({ exp: nowSeconds + buffer + 1 }) }).token, liveId);
    assert.equal(reuse({ ...recent, accessToken: undefined, accessTokenExpiresAt: nowSeconds + 900 }), null);
    assert.equal(reuse({ ...recent, accessToken: '' }), null);
    assert.equal(reuse({ ...recent, accessToken: 'bad.jwt.shape', accessTokenExpiresAt: nowSeconds + 900 }), null);
    assert.equal(reuse({ ...recent, accessToken: 'decode-throws', accessTokenExpiresAt: nowSeconds + 900 }), null);
    assert.equal(reuse({ ...recent, lastRefreshedAt: now - 15 * 60 * 1000 - 1 }), null);
    assert.equal(reuse({ ...recent, lastRefreshedAt: now + 1 }), null);
    assert.equal(reuse({ ...recent, idToken: undefined }).type, 'access_token');
    assert.equal(reuse({ ...recent, idToken: token({ exp: nowSeconds - 1 }) }).type, 'access_token');
  });
  await check('opaque access requires advertised finite future access expiry; opaque-only bearer stays native', () => {
    const reuse = helpers.getReusableOpenIDSessionToken;
    const opaque = { ...recent, accessToken: 'fixture-opaque', accessTokenExpiresAt: nowSeconds + 900 };
    assert.equal(reuse(opaque).token, liveId);
    for (const exp of [undefined, null, NaN, Infinity, -Infinity, '1900000000', nowSeconds + buffer]) {
      assert.equal(reuse({ ...opaque, accessTokenExpiresAt: exp }), null);
    }
    // This adapter deliberately does not change native JWT bearer selection.
    assert.equal(reuse({ ...opaque, idToken: undefined }), null);
  });
  function response() {
    return { headers: {}, statusCode: null, body: null, redirects: 0,
      set(key, value) { this.headers[key] = value; return this; },
      status(status) { this.statusCode = status; return this; },
      send(body) { this.body = body; return this; },
      redirect(url) { this.body = url; this.redirects++; return this; },
      cookie() { throw new Error('Cached/generic error branch must not rewrite auth cookies'); },
      clearCookie() { throw new Error('Unexpected direct cookie clearing'); },
    };
  }
  const request = (tokens) => ({ headers: { cookie: 'fixture-cookie' },
    session: { openidTokens: { ...tokens } } });
  await check('actual controller cached response stays native; generation/delivery checks retained; no grant/publication', async () => {
    const { exports, calls } = loadController();
    const req = request({ ...recent, publicationFlightKey: 'fixture-flight',
      publicationFlightOwnerId: 'fixture-owner', publicationFlightCreatedAt: now });
    const snapshot = JSON.stringify(req.session);
    const res = response();
    await exports.refreshController(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.token, liveId);
    assert.equal(res.body.user.password, undefined);
    assert.equal(res.body.user.totpSecret, undefined);
    assert.equal(calls.grant, 0);
    assert.equal(calls.publication, 0);
    assert.equal(calls.cleared, 0);
    assert.equal(calls.cloudfront, 1); // Native CloudFront call remains; auth cookies are untouched.
    assert.equal(calls.claim, 1);
    assert.equal(calls.authorized, 1);
    assert.equal(calls.release, 1);
    assert.equal(calls.generation, 1);
    assert.equal(JSON.stringify(req.session), snapshot);
    const first = '      const reusableSessionToken = cookieDiffersFromSession';
    const last = '      const refreshUserId =';
    assert.equal(between(controllerSource, first, last), between(raw[keys[0]], first, last));
  });
  await check('expired access/fresh ID and identity mismatch fall through to native refresh/publication', async () => {
    for (const options of [
      { tokens: { ...recent, accessToken: token({ exp: nowSeconds - 1 }) } },
      { tokens: recent, identityMatches: false },
    ]) {
      const { exports, calls } = loadController(options);
      const res = response();
      await exports.refreshController(request(options.tokens), res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.token, 'fixture-fresh-auth');
      assert.equal(calls.grant, 1);
      assert.equal(calls.publication, 1);
    }
  });
  const stale = { ...recent, lastRefreshedAt: now - 15 * 60 * 1000 - 1 };
  await check('actual generic catch: structured network/timeout/provider503 => sanitized503, no clearing or retries', async () => {
    assert.ok(controllerSource.includes("logger.error('[refreshController] OpenID token refresh failed');"));
    assert.ok(!controllerSource.includes("logger.error('[refreshController] OpenID token refresh error', error)"));
    for (const grantError of [
      { code: 'ECONNRESET' }, { name: 'TimeoutError' },
      { response: { statusCode: 503 } }, { response: { status: 503 } },
      { message: 'fetch failed', cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } },
    ]) {
      const { exports, calls } = loadController({ grantError });
      const req = request(stale);
      const snapshot = JSON.stringify(req.session);
      const res = response();
      await exports.refreshController(req, res);
      assert.equal(res.statusCode, 503);
      assert.equal(res.body.code, 'OPENID_PROVIDER_UNAVAILABLE');
      assert.equal(res.body.retryable, true);
      assert.equal(Object.keys(res.body).length, 2);
      assert.equal(res.headers['Cache-Control'], 'no-store');
      assert.equal(calls.cleared, 0);
      assert.equal(calls.bridge, 0);
      assert.equal(calls.grant, 1);
      assert.equal(calls.publication, 0);
      assert.equal(JSON.stringify(req.session), snapshot);
    }
  });
  await check('terminal invalid_grant/revocation/MFA/auth errors dominate transient evidence and retain native response', async () => {
    for (const grantError of [
      { error: 'invalid_grant', response: { status: 503 } },
      { message: 'refresh token revoked', code: 'ETIMEDOUT' },
      { body: { error: 'mfa_required' }, cause: { code: 'ECONNRESET' } },
      { response: { data: { error: 'interaction_required' }, status: 503 } },
      { response: { status: 401 }, code: 'ETIMEDOUT' },
      { response: { status: 403 }, code: 'ETIMEDOUT' },
      { message: 'application bug' }, { message: 'network timeout' },
      { name: 'AbortError' }, { response: { status: 500 } },
    ]) {
      assert.equal(helpers.isTransientOpenIDProviderError(grantError), false);
      const { exports, calls } = loadController({ grantError });
      const res = response();
      await exports.refreshController(request(stale), res);
      assert.equal(res.statusCode, 403);
      assert.equal(res.body, 'Invalid OpenID refresh token');
      assert.equal(calls.cleared, 0); // Preserve exact native generic-terminal policy.
    }
    const cycle = { code: 'ECONNRESET' }; cycle.cause = cycle;
    assert.equal(helpers.isTransientOpenIDProviderError(cycle), false);
    const { exports } = loadController({ grantResult: { error: 'mfa_required', user: null } });
    const res = response();
    await exports.refreshController(request(stale), res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body, '/login');
  });
  await check('native ownership and missing-session terminal clearing remains native, not transient', async () => {
    for (const [code, expected] of [['FIXTURE_OWNERSHIP', 403], ['FIXTURE_SESSION_MISSING', 401]]) {
      const { exports, calls } = loadController({ grantError: { code, response: { status: 503 } } });
      const res = response();
      await exports.refreshController(request(stale), res);
      assert.equal(res.statusCode, expected);
      assert.equal(calls.cleared, 1);
    }
    const first = '      /**\n       * Detect and recover from stale refresh-token cookie after SSE-triggered rotation.';
    const last = '  /** For non-OpenID users, read refresh token from cookies */';
    assert.equal(between(controllerSource, first, last), between(raw[keys[0]], first, last));
  });
  await check('actual compiled helper: omitted override falls back; explicit undefined/null never borrows ID/access expiry', () => {
    const source = patched[keys[2]];
    // Execute only real extracted compiled helper declarations, NOT package initialization.
    const declarations = between(source, '\tfunction decodeJwtExp(token) {', '\tfunction canWriteRefreshTokenCookie(res) {') +
      between(source, '\tfunction buildOIDCTokensFromSession(sessionTokens, tokenPreference, expiresAtOverride) {',
        '\tfunction resolveRefreshIdentityClaims(tokenset, fallbackIdToken) {');
    const build = vm.runInNewContext(declarations + '\nbuildOIDCTokensFromSession;', { jwt, logger }, { timeout: 1000 });
    const tokens = { accessToken: 'fixture-opaque', accessTokenExpiresAt: nowSeconds + 200,
      idToken: liveId, refreshToken: 'fixture-refresh' };
    assert.equal(build(tokens, 'id_token').expires_at, nowSeconds + buffer + 500);
    assert.equal(build(tokens, 'access_token').expires_at, nowSeconds + 200);
    for (const preference of ['id_token', 'access_token']) {
      assert.equal(build(tokens, preference, undefined).expires_at, undefined);
      assert.equal(build(tokens, preference, null).expires_at, undefined);
      assert.equal(build(tokens, preference, nowSeconds + 50).expires_at, nowSeconds + 50);
    }
    assert.throws(() => build(tokens, 'invalid'), /tokenPreference/);
    assert.ok(source.includes('buildOIDCTokensFromSession(updatedSessionTokens, tokenPreference, nextAccessTokenExp ?? void 0)'));
  });
  await check('actual social source: rolling iff reuse; existing native maxAge, secure, store, resave retained', async () => {
    for (const reuse of ['true', 'false']) {
      let options;
      const dependencies = {
        passport: { session: () => () => {} },
        'express-session': (value) => { options = value; return () => {}; },
        'librechat-data-provider': { CacheKeys: { OPENID_SESSION: 'fixture-store' } },
        '@librechat/api': { ...api, math: (value, fallback) => value == null ? fallback : Number(value),
          shouldUseSecureCookie: () => true, registerOpenIdWithRetry: async () => {} },
        '@librechat/data-schemas': { logger, DEFAULT_SESSION_EXPIRY: 5000 },
        '~/strategies': {}, '~/cache': { getLogStores: (key) => key },
      };
      const context = { module: { exports: {} },
        process: { env: { OPENID_REUSE_TOKENS: reuse, OPENID_REUSE_MAX_SESSION_AGE_MS: '900000' } },
        require(name) { assert.ok(Object.hasOwn(dependencies, name)); return dependencies[name]; } };
      vm.runInNewContext(patched[keys[1]] + '\nmodule.exports = configureOpenId;', context, { timeout: 1000 });
      await context.module.exports({ use() {} }, {});
      assert.equal(options.rolling, reuse === 'true');
      assert.equal(options.cookie.maxAge, reuse === 'true' ? 900000 : 5000);
      assert.equal(options.cookie.secure, true);
      assert.equal(options.store, 'fixture-store');
      assert.equal(options.resave, false);
      assert.equal(options.saveUninitialized, false);
    }
    assert.equal(patched[keys[1]], raw[keys[1]].replace(
      '    store: getLogStores(CacheKeys.OPENID_SESSION),\n    cookie: {',
      '    store: getLogStores(CacheKeys.OPENID_SESSION),\n    rolling: isEnabled(process.env.OPENID_REUSE_TOKENS),\n    cookie: {'));
  });
  return { passed: names.length, names, bufferSeconds: buffer,
    caveats: ['VM dependency fixtures; no live IdP/browser/Express-session integration',
      'Parent must verify pristine hashes and own patched-hash/backup/marker idempotence',
      'No maintenance, deploy, restart, commit, app initialization, or network performed'] };
}


test('native backend contracts (10 groups)', async () => {
 const result=await runBackendContributionTests({backendAdapter:{HASHES:adapter.BACKEND_HASHES,patchBackend:adapter.patchBackend}});
 assert.equal(result.passed,10);
});

const hooksPath = 'client/dist/assets/hooks.B1NLB7i6.js';
const vendorPath = 'client/dist/assets/vendor.DMhDOqx5.js';
const readNative = name => fs.readFileSync('/app/' + name, 'utf8');
const patchedHooks = () => adapter.patchClient(hooksPath, readNative(hooksPath));
const jwtToken = (seconds = 3600, subject = 'subject') => 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({
  exp: 1800000000 + seconds, sub: subject,
})).toString('base64url') + '.signature';
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };

// Execute the ACTUAL transformed native request + SSE logic, extracted using
// pinned boundary anchors, in a controlled browser/clock VM. No fabricated
// minified snippets or globally exposed runtime token getters.
function browser(realAxios = false) {
  let now = 1800000000000, counter = 0, refreshCalls = 0, fetchCalls = 0, sends = 0;
  const timers = new Map(), events = [], nodes = new Map(), channels = [], windowHandlers = {}, documentHandlers = {};
  const handlers = { request: [], response: [] };
  const responses = [], fetchResponses = [], operations = [], operationResponses = [];
  const axiosStub = Object.assign(async config => config, {
    defaults: { headers: { common: {} } },
    interceptors: {
      request: { use: fn => handlers.request.push(fn) },
      response: { use: (ok, fail) => handlers.response.push(fail) },
    },
    post: async (url) => {
      assert.match(url, /auth\/refresh/); refreshCalls++;
      const response = responses.length ? responses.shift() : {token:jwtToken(),user:{id:'account'}};
      return { data: await (response instanceof Error ? Promise.reject(response) : response) };
    },
    getAdapter: () => async config => config,
  });
  const axios = realAxios ? require('axios').create({adapter:async config=>{
    if(config.url.includes('/api/auth/refresh'))return axiosStub.post(config.url);
    operations.push(config);
    const response = await (operationResponses.shift() ?? {status:200,data:{}});
    if(response.status===401)throw Object.assign(new Error('old operation unauthorized'),{config,response:{...response,config}});
    return {...response,config};
  }}) : axiosStub;
  if(realAxios) {
    axios.getAdapter=require('axios').getAdapter;
    for(const type of ['request','response']) {
      const use=axios.interceptors[type].use.bind(axios.interceptors[type]);
      axios.interceptors[type].use=(ok,fail)=>{handlers[type].push(type==='request'?ok:fail);return use(ok,fail)};
    }
  }
  class Clock extends Date { static now() { return now; } }
  class Event { constructor(type, options = {}) { this.type=type; Object.assign(this,options); } }
  class XHR {
    static HEADERS_RECEIVED = 2;
    constructor() { this.listeners={}; this.status=200; this.headers={}; }
    addEventListener(type, fn) { this.listeners[type]=fn; }
    open(method,url) { this.method=method; this.url=url; }
    setRequestHeader(name,value) { this.headers[name]=value; }
    send() { sends++; }
    abort() { this.listeners.abort?.(); }
  }
  class Channel { constructor(name){this.name=name;this.messages=[];channels.push(this)} postMessage(message){this.messages.push(message)} }
  const window = {
    location: {pathname:'/c/new',search:'',origin:'https://chat.example',href:'/c/new'},
    navigator: {onLine:true}, atob: value => Buffer.from(value,'base64').toString('utf8'),
    localStorage: { getItem:()=>null,setItem(){},removeItem(){} },
    dispatchEvent: event => { events.push(event); for (const fn of windowHandlers[event.type]??[]) fn(event); },
    addEventListener: (type,fn) => { (windowHandlers[type]??=[]).push(fn); },
    removeEventListener: (type,fn) => { windowHandlers[type]=(windowHandlers[type]??[]).filter(item=>item!==fn); },
  };
  const document = {
    visibilityState:'visible',
    body: {appendChild:node=>nodes.set(node.id,node)},
    getElementById:id=>nodes.get(id),
    createElement:()=>({style:{},setAttribute(){},remove(){nodes.delete(this.id)}}),
    addEventListener:(type,fn)=>{(documentHandlers[type]??=[]).push(fn)},
  };
  const context = vm.createContext({window, document, Date:Clock, CustomEvent:Event,
    URL, URLSearchParams, Headers, console:{warn(){},log(){}}, Ar:axios,
    Ll:()=>'', Bu:()=>'/login?redirect_to=%2Fc%2Fnew', Mte:()=>'/api/auth/refresh',
    setTimeout: (fn,delay)=>{const id=++counter;timers.set(id,{fn,at:now+delay});return id},
    clearTimeout:id=>timers.delete(id),
    fetch: async ()=>{fetchCalls++;return await (fetchResponses.shift()??new Response('',{status:401}))},
    XMLHttpRequest:XHR, BroadcastChannel:Channel,
  });
  const hooks = patchedHooks();
  const start = hooks.indexOf('function wm(e)'), end = hooks.indexOf(',ph=`text/event-stream`',start);
  assert.ok(start>0 && end>start);
  vm.runInContext(hooks.slice(start,end) + ';globalThis.testNative={request:W,recover:ah,before:uh,set:wm,account:gcSetAccount,logout:gcLogout,state:govchatNativeAuthState,streamReady:gcStreamReady};',context);
  const vendor = adapter.patchClient(vendorPath,readNative(vendorPath));
  const sseStart = vendor.indexOf('SSE=function(e,t)'), sseEnd = vendor.indexOf(';function _possibleConstructorReturn',sseStart);
  assert.ok(sseStart>0 && sseEnd>sseStart);
  vm.runInContext('var '+vendor.slice(sseStart,sseEnd)+';',context);
  return {
    native:context.testNative, context, window, document, responses, fetchResponses, operations, operationResponses, events, timers, handlers, nodes, channels,
    counts:()=>({refreshCalls,fetchCalls,sends}),
    login(token=jwtToken()) { context.testNative.set(token); context.testNative.account(true,'account'); },
    async advance(ms) { now+=ms; const due=[...timers].filter(([,timer])=>timer.at<=now);for(const [id,timer] of due){if(timers.delete(id))timer.fn()}await tick(); },
    async wake(type='focus') { for(const fn of windowHandlers[type]??[])fn();if(type==='visibilitychange')for(const fn of documentHandlers[type]??[])fn();await tick(); },
    stream() { return new context.SSE('/api/agents/chat', {govchatAuthReady:()=>context.testNative.streamReady('/api/agents/chat'),payload:'{}',start:false,headers:{}}); },
  };
}

// Actual AuthContext debounce, login callback and tokenUpdated effect, including
// its stale React user closure. Local IDs deliberately differ from JWT subjects.
function authContext(b, user = {id:'account'}) {
  const hooks=patchedHooks();let queued;const publications=[];
  const debounce=fn=>Object.assign(value=>{queued=()=>fn(value)},{cancel:()=>{queued=null}});
  Object.assign(b.context,{q:{useMemo:fn=>fn(),useCallback:fn=>fn,useEffect:fn=>fn()},r8:{debounce},
    i:user=>publications.push(user),s(){},d(){},p(){},m(){},b(){},l(){},a:{current:undefined},
    pk(){},a8(){},KP:()=>null,WP:()=>true,Hde:()=>()=>{},PV:options=>options,NV:options=>options,r:user});
  const start=hooks.indexOf('x=(0,q.useMemo)(()=>gcContextPublisher('),end=hooks.indexOf(',T=FV()',start);
  vm.runInContext('var '+hooks.slice(start,end)+';',b.context);
  const listenerStart=hooks.indexOf('(0,q.useEffect)(()=>{let e=e=>{const context=gcTokenContext'),
    listenerEnd=hooks.indexOf('},[x,r])',listenerStart)+'},[x,r])'.length;
  assert.ok(listenerStart>0&&listenerEnd>listenerStart);
  vm.runInContext(hooks.slice(listenerStart,listenerEnd)+';',b.context);
  return {publications,queued:()=>queued,flush(){const fn=queued;queued=null;fn?.()},
    begin:()=>b.context.C.onMutate(),
    success:(response,operation)=>b.context.C.onSuccess(response,undefined,operation)};
}

test('real Axios delayed old-account 401 cannot recover/replay or overwrite queued new login; fetch is fenced too', async () => {
  for(const transport of ['axios','fetch']) {
    const b=browser(true),tokenA=jwtToken(3600,'provider-A');
    b.responses.push({token:tokenA,user:{id:'account'}});b.login(tokenA);await b.advance(0);
    const auth=authContext(b),old=deferred();
    b.context.x({token:tokenA,user:{id:'account'},isAuthenticated:true});const staleContext=auth.queued();
    if(transport==='axios')b.operationResponses.push(old.promise);else b.fetchResponses.push(old.promise);
    const operation=transport==='axios'?b.context.Ar.get('/api/convos'):b.native.request.authenticatedFetch('/api/convos');
    const result=operation.then(value=>({value}),error=>({error}));await tick();
    assert.equal(transport==='axios'?b.operations.length:b.counts().fetchCalls,1);
    const login=auth.begin(),tokenB=jwtToken(3600,'provider-B');assert.equal(auth.queued(),null);
    auth.success({token:tokenB,user:{id:'local-B'}},login);
    staleContext();assert.equal(auth.publications.length,0);
    assert.equal(b.native.state.account,'account');assert.equal(b.native.state.pendingAccount,'local-B');
    const before=b.counts().refreshCalls;
    old.resolve(transport==='axios'?{status:401,data:{}}:new Response('',{status:401}));
    const outcome=await result;await tick();
    if(transport==='axios')assert.equal(outcome.error.response.status,401);else assert.equal(outcome.value.status,401);
    assert.equal(b.counts().refreshCalls,before);
    assert.equal(transport==='axios'?b.operations.length:b.counts().fetchCalls,1);
    auth.flush();assert.equal(auth.publications.at(-1).id,'local-B');
    assert.equal(b.context.Ar.defaults.headers.common.Authorization,'Bearer '+tokenB);
  }
});

test('actual tokenUpdated listener uses refresh response user, rejects wrong account and safely supports legacy strings', async () => {
  const b=browser(true);b.login(jwtToken(3600,'provider-A'));await b.advance(0);
  const auth=authContext(b),login=auth.begin(),tokenB=jwtToken(3600,'provider-B');
  auth.success({token:tokenB,user:{id:'local-B'}},login);
  // Recovery can complete before React commits B. It must not restore closure A.
  b.responses.push({token:tokenB,user:{id:'local-B',name:'fresh B'}});
  await b.native.recover(false);
  const event=b.events.filter(event=>event.type==='tokenUpdated').at(-1);
  assert.equal(event.detail.user.id,'local-B');assert.equal(event.detail.token,tokenB);
  const valid=auth.queued();
  for(const detail of [tokenB,{token:tokenB,user:{id:'account'},govchatEpoch:b.native.state.epoch},
    {token:tokenB,user:{id:'local-B'},govchatEpoch:b.native.state.epoch-1}]) {
    b.window.dispatchEvent({type:'tokenUpdated',detail});assert.equal(auth.queued(),valid);
  }
  auth.flush();assert.equal(auth.publications.at(-1).id,'local-B');assert.equal(auth.publications.at(-1).name,'fresh B');
  b.native.account(true,'local-B');
  const current=authContext(b,{id:'local-B'});
  b.window.dispatchEvent({type:'tokenUpdated',detail:tokenB});current.flush();
  assert.equal(current.publications.at(-1).id,'local-B');
  const stale=jwtToken(3500,'provider-A');b.window.dispatchEvent({type:'tokenUpdated',detail:stale});assert.equal(current.queued(),null);
});

test('login without logout broadcasts token-free account-switch invalidation only after accepted publication', async () => {
  const b=browser(true);b.login();await b.advance(0);const auth=authContext(b),login=auth.begin();
  assert.equal(b.channels[0].messages.length,0);
  const response={token:jwtToken(3600,'provider-B'),user:{id:'local-B'}};
  auth.success(response,login);assert.equal(b.channels[0].messages.length,0);
  auth.flush();b.native.account(true,'local-B');
  assert.equal(JSON.stringify(b.channels[0].messages),'[{"type":"session-change"}]');
  const other=browser();other.login();await other.advance(0);
  other.channels[0].onmessage({data:b.channels[0].messages[0]});
  assert.equal(other.native.state.stopped,true);assert.equal(other.context.Ar.defaults.headers.common.Authorization,undefined);
});

test('compiled SSE connecting listeners may close/logout reentrantly with zero transmissions', async () => {
  for(const change of ['close','logout']) {
    const b=browser(),stream=b.stream();b.login();await b.advance(0);
    let connecting=0;
    stream.addEventListener('readystatechange',event=>{if(event.readyState===b.context.SSE.CONNECTING){connecting++;if(change==='close')stream.close();else b.native.logout()}});
    await stream.stream();assert.equal(connecting,1);assert.equal(b.counts().sends,0);
  }
  const b=browser();b.login();await b.advance(0);
  const header=b.context.XMLHttpRequest.prototype.setRequestHeader;
  b.context.XMLHttpRequest.prototype.setRequestHeader=function(...args){header.apply(this,args);b.native.logout()};
  await b.stream().stream();assert.equal(b.counts().sends,0);
});

test('real Axios native login remains sendable during login lifecycle; current-account GET 401 recovers exactly once', async () => {
  const b=browser(true);b.login();await b.advance(0);const auth=authContext(b);
  b.window.location.pathname='/login';const login=auth.begin();
  const token=jwtToken(3600,'provider-B'),user={id:'local-B'};
  b.operationResponses.push({status:200,data:{token,user}});
  const response=await b.context.Ar.post('/api/auth/login',{});
  assert.equal(b.operations.length,1);assert.equal(b.counts().refreshCalls,1);
  auth.success(response.data,login);auth.flush();b.native.account(true,user.id);
  b.window.location.pathname='/c/new';b.responses.push({token,user});await b.wake();
  const before=b.counts().refreshCalls;
  b.operationResponses.push({status:401,data:{}},{status:200,data:{accepted:true}});
  b.responses.push({token,user});
  const get=await b.context.Ar.get('/api/convos');
  assert.equal(get.data.accepted,true);assert.equal(b.counts().refreshCalls,before+1);
  assert.equal(b.operations.length,3);
  assert.equal(b.operations[1].govchatEpoch,b.operations[2].govchatEpoch);
  assert.equal(b.operations[2].headers.Authorization,'Bearer '+token);
});

test('full actual assets parse; pinned anchors reject drift and repeated raw patch', () => {
  const { spawnSync } = require('node:child_process');
  for (const name of Object.keys(adapter.CLIENT_HASHES)) {
    const raw = readNative(name);
    assert.equal(crypto.createHash('sha256').update(raw).digest('hex'),adapter.CLIENT_HASHES[name]);
    const patched = adapter.patchClient(name,raw);
    const result = spawnSync(process.execPath,['--check','--input-type=module'],{input:patched,maxBuffer:8e6});
    assert.equal(result.status,0,result.stderr.toString());
    assert.throws(()=>adapter.patchClient(name,raw+raw),/anchor/);
    assert.throws(()=>adapter.patchClient(name,patched),/anchor/);
  }
});

test('visible timer restores native auth and rearms on completion with the same ID string', async () => {
  const b=browser();b.login();await b.advance(0);
  assert.equal(b.counts().refreshCalls,1); assert.equal(b.events.filter(e=>e.type==='tokenUpdated').length,1);
  await b.advance(300000); assert.equal(b.counts().refreshCalls,2);
  await b.advance(300000); assert.equal(b.counts().refreshCalls,3);
  assert.equal(b.timers.size,1);
});

test('hidden tabs stop polling, suspended wake checks promptly, offline wake blocks and reconnect restores', async () => {
  const b=browser();b.login();await b.advance(0);
  b.document.visibilityState='hidden';await b.wake('visibilitychange');assert.equal(b.timers.size,0);
  await b.advance(3600000);assert.equal(b.counts().refreshCalls,1);
  b.document.visibilityState='visible';b.window.navigator.onLine=false;await b.wake('visibilitychange');
  await assert.rejects(b.native.before('/api/agents/chat'),/tijdelijk/);
  assert.equal(b.counts().refreshCalls,1);
  b.window.navigator.onLine=true;await b.wake('online');assert.equal(b.counts().refreshCalls,2);
});

test('terminal loss navigates proactively once through native login, not Microsoft endsession', async () => {
  for(const response of [undefined,Object.assign(new Error('invalid grant'),{response:{status:403}})]) {
    const b=browser();b.responses.push(response);b.login();await b.advance(0);
    assert.match(b.window.location.href,/login.*govchat_reauth=1&redirect=false/);
    assert.doesNotMatch(b.window.location.href,/logout|endsession/);
    assert.equal(b.events.filter(e=>e.type==='authRedirectStarted').length,1);
    await b.wake();assert.equal(b.counts().refreshCalls,1);assert.equal(b.timers.size,0);
  }
});

test('503 and network errors retain sign-in without dispatch/logout, block fetch/Axios/SSE, bounded retry restores', async () => {
  for(const error of [new Error('network'),Object.assign(new Error('provider unavailable'),{response:{status:503}})]) {
    const b=browser();b.responses.push(error);b.login();await b.advance(0);
    assert.equal(b.window.location.href,'/c/new');assert.equal(b.events.filter(e=>e.type==='tokenUpdated').length,0);
    assert.ok(b.native.state.signedIn);assert.equal(b.timers.size,1);
    await assert.rejects(b.native.request.authenticatedFetch('/api/agents/chat',{method:'POST'}));
    await assert.rejects(b.handlers.request[0]({url:'/api/agents/chat'}));
    await b.stream().stream();assert.equal(b.counts().sends,0);assert.equal(b.counts().fetchCalls,0);
    await b.advance(14999);assert.equal(b.counts().refreshCalls,1);
    await b.advance(1);assert.equal(b.counts().refreshCalls,2);assert.equal(b.native.state.blocked,false);
  }
});

test('native singleflight, completion timing and exactly-once SSE send after readiness', async () => {
  const b=browser(),pending=deferred();b.responses.push(pending.promise);b.login();await b.advance(0);
  const p=b.native.before('/api/agents/chat'), q=b.native.before('/api/agents/chat'),s=b.stream();
  const one=s.stream(),two=s.stream();await tick();assert.equal(b.counts().refreshCalls,1);assert.equal(b.counts().sends,0);
  await b.advance(120000);pending.resolve({token:jwtToken(),user:{id:'account'}});
  await Promise.all([p,q,one,two]);assert.equal(b.counts().sends,1);
  assert.match(s.xhr.headers.Authorization,/^Bearer /);assert.equal(b.timers.size,1);
  await b.advance(299999);assert.equal(b.counts().refreshCalls,1);
  await b.advance(1);assert.equal(b.counts().refreshCalls,2);
});

test('logout/account epochs and canceled pending stream cannot repopulate or transmit', async () => {
  for(const change of ['logout','account','close']) {
    const b=browser(),pending=deferred();b.responses.push(pending.promise);b.login();await b.advance(0);
    const s=b.stream(),send=s.stream();await tick();
    if(change==='logout')b.native.logout();
    if(change==='account')b.native.account(true,'other-account');
    if(change==='close')s.close();
    pending.resolve({token:jwtToken(),user:{id:'account'}});await send;await tick();
    assert.equal(b.counts().sends,0);
    if(change!=='close')assert.equal(b.events.filter(e=>e.type==='tokenUpdated').length,0);
    if(change==='logout')assert.equal(b.context.Ar.defaults.headers.common.Authorization,undefined);
  }
});

test('expired JWT preflight and all request methods retained; chat POST 401 is never replayed', async () => {
  const b=browser();b.login(jwtToken(-10));await b.native.before('/api/agents/chat');
  assert.equal(b.counts().refreshCalls,1);
  const response=await b.native.request.authenticatedFetch('/api/agents/chat',{method:'POST',body:'{}'});
  assert.equal(response.status,401);assert.equal(b.counts().fetchCalls,1);
  for(const method of ['get','getResponse','post','postMultiPart','postTTS','put','delete','deleteWithOptions','patch','authenticatedFetch','refreshToken','dispatchTokenUpdatedEvent'])assert.equal(typeof b.native.request[method],'function');
});

test('login/public routes never poll; authenticated account mismatch cannot publish', async () => {
  const b=browser();b.window.location.pathname='/login';b.login();await b.advance(0);assert.equal(b.counts().refreshCalls,0);
  await b.native.before('/api/config');assert.equal(b.counts().refreshCalls,0);
  b.window.location.pathname='/c/new';b.responses.push({token:jwtToken(),user:{id:'wrong-account'}});await b.wake();
  assert.equal(b.events.filter(e=>e.type==='tokenUpdated').length,0);assert.match(b.window.location.href,/login/);
});

test('malformed, expired and identity-less successful refreshes never publish or send', async () => {
  for(const response of [{token:'   ',user:{id:'account'}},{token:{bad:true},user:{id:'account'}},
    {token:jwtToken(-1),user:{id:'account'}},{token:jwtToken()}, {token:'opaque',user:{id:'account'}}]) {
    const b=browser();b.responses.push(response);b.login();await b.advance(0);await b.stream().stream();
    assert.equal(b.counts().sends,0);assert.equal(b.events.filter(e=>e.type==='tokenUpdated').length,0);
    assert.match(b.window.location.href,/login/);
  }
});

test('actual debounced auth publication and initial refresh callbacks are fenced after remote invalidation', async () => {
  const b=browser(),hooks=patchedHooks();let queued,publications=0,callbacks;
  const debounce=fn=>Object.assign(value=>{queued=()=>fn(value)},{cancel:()=>{queued=null}});
  Object.assign(b.context,{q:{useMemo:fn=>fn(),useCallback:fn=>fn},r8:{debounce},
    i(){publications++},s(){},d(){},p(){},m(){},b(){},a:{current:undefined},
    pk(){},a8(){},KP:()=>null,WP:()=>true,VP:()=>null,HP(){},
    e:{},n:{current:false},T:{mutate:(_,options)=>{callbacks=options}}});
  const start=hooks.indexOf('x=(0,q.useMemo)(()=>gcContextPublisher('),end=hooks.indexOf(',S=Hde',start);
  assert.ok(start>0&&end>start);vm.runInContext('var '+hooks.slice(start,end)+';',b.context);
  b.context.x({token:jwtToken(),isAuthenticated:true,user:{id:'account'}});
  const old=queued;b.channels[0].onmessage({data:{type:'logout'}});assert.equal(queued,null);old();
  assert.equal(publications,0);assert.equal(b.context.Ar.defaults.headers.common.Authorization,undefined);
  b.native.state.stopped=false;
  const initStart=hooks.indexOf('k=(0,q.useCallback)(()=>{const govchatInitialEpoch='),initEnd=hooks.indexOf(';(0,q.useEffect)',initStart);
  assert.ok(initStart>0&&initEnd>initStart);vm.runInContext('var '+hooks.slice(initStart,initEnd)+';',b.context);
  b.context.k();b.native.logout();callbacks.onSuccess({token:jwtToken(),user:{id:'account'}});
  assert.equal(queued,null);assert.equal(publications,0);
});

test('actual initial refresh outages remain unresolved without login and retry with backoff', async () => {
  for(const error of [new Error('network'),Object.assign(new Error('503'),{response:{status:503}})]) {
    const b=browser(),hooks=patchedHooks();let callbacks,navigations=0,calls=0;
    Object.assign(b.context,{q:{useCallback:fn=>fn},e:{},n:{current:false},T:{mutate:(_,options)=>{calls++;callbacks=options}},
      a8(){throw Error('outage must not clear session')},p(){},b(){navigations++},x(){},VP:()=>null,HP(){},WP:()=>true});
    const start=hooks.indexOf('k=(0,q.useCallback)(()=>{const govchatInitialEpoch='),end=hooks.indexOf(';(0,q.useEffect)',start);
    vm.runInContext('var '+hooks.slice(start,end)+';',b.context);b.context.k();callbacks.onError(error);
    assert.equal(navigations,0);assert.equal(b.native.state.signedIn,false);assert.equal(b.timers.size,1);
    await b.advance(15000);assert.equal(calls,2);assert.equal(navigations,0);
  }
});

test('initial mount does not invalidate refresh; actual old login/logout callbacks cannot publish', () => {
  const b=browser();const epoch=b.native.state.epoch;b.native.account(false,undefined);
  assert.equal(b.native.state.epoch,epoch);assert.equal(b.native.state.stopped,false);
  const hooks=patchedHooks();let publication=0;
  Object.assign(b.context,{PV:options=>options,NV:options=>options,x:()=>publication++,q:{useCallback:fn=>fn}});
  const start=hooks.indexOf('C=PV({onMutate:'),end=hooks.indexOf(',T=FV()',start);
  assert.ok(start>0&&end>start);vm.runInContext('var '+hooks.slice(start,end)+';',b.context);
  const loginA=b.context.C.onMutate();b.native.logout();const loginB=b.context.C.onMutate();
  assert.notEqual(loginA.govchatEpoch,loginB.govchatEpoch);
  b.context.C.onSuccess({token:jwtToken(),user:{id:'account'}},undefined,loginA);assert.equal(publication,0);
  const logout=b.context.w.onMutate({govchatEpoch:b.native.logout()});b.context.C.onMutate();
  b.context.w.onSuccess({},undefined,logout);assert.equal(publication,0);
});

test('logout after readiness is rejected at actual fetch/Axios dispatch and SSE final checks', async () => {
  const b=browser();b.login();await b.advance(0);
  // Patch the lexical binding in the SAME VM, not a fabricated transport.
  b.context.queueMicrotask=queueMicrotask;
  vm.runInContext('var govchatTestBefore=uh;uh=async url=>{const token=await govchatTestBefore(url);queueMicrotask(()=>gcLogout());return token};',b.context);
  await assert.rejects(b.native.request.authenticatedFetch('/api/agents/chat',{method:'POST'}),/Sessie gewijzigd/);
  assert.equal(b.counts().fetchCalls,0);
  const c=browser();c.login();await c.advance(0);
  const config=await c.handlers.request[0]({url:'/api/agents/chat'});c.native.logout();
  assert.throws(()=>config.adapter(config),/Sessie gewijzigd/);
  assert.equal(typeof require('axios').getAdapter,'function');
});

test('actual native mutation wrapper returns operation context and fences its own stale cleanup', () => {
  const b=browser(),hooks=patchedHooks();let cleanup=0;
  Object.assign(b.context,{F:()=>({removeQueries:()=>cleanup++}),MV:()=>()=>cleanup++,
    Ie:()=>()=>cleanup++,we:()=>()=>cleanup++,Q:{defaultPreset:1,queriesEnabled:2},
    I:(_key,options)=>options,Cm:{loginUser:1,logoutUser:2},G:{login(){},logout(){}}});
  const start=hooks.indexOf('NV=e=>{'),end=hooks.indexOf(',FV=e=>',start);
  assert.ok(start>0&&end>start);vm.runInContext('var '+hooks.slice(start,end)+';',b.context);
  const login=b.context.PV({onMutate:()=>({govchatEpoch:b.native.state.epoch})});
  assert.equal(login.onMutate({}).govchatEpoch,b.native.state.epoch);
  const epoch=b.native.state.epoch;b.native.logout();const before=cleanup;
  b.context.NV({}).onSuccess({},undefined,{govchatEpoch:epoch});assert.equal(cleanup,before);
});

test('native final placeholder boundary rejects missing/stale access without substituting ID credentials', () => {
  const source=readNative('packages/api/dist/index.cjs');
  const getFunction=name=>{const start=source.indexOf('function '+name+'(');assert.ok(start>0);return source.slice(start,source.indexOf('\n}',start)+2)};
  const context={Date:class extends Date{static now(){return 1800000000000}},
    _librechat_data_schemas:{logger:{warn(){}}},librechat_data_provider:{extractEnvVariable:value=>value},
    processUserPlaceholders:value=>value,extractOpenIDTokenInfo:user=>user,
    processOpenIDPlaceholders:(value,info)=>value.replace('{{LIBRECHAT_OPENID_ACCESS_TOKEN}}',info.accessToken),
    OPENID_ACCESS_CREDENTIAL_PLACEHOLDER_PATTERN:/\{\{LIBRECHAT_OPENID_(?:ACCESS_TOKEN|TOKEN)\}\}/,
    OpenIDReauthRequiredError:class extends Error{constructor(message){super(message);this.statusCode=401}}};
  vm.runInNewContext(getFunction('isOpenIDTokenValid')+';'+getFunction('processSingleValue')+';globalThis.resolve=processSingleValue;',context);
  for(const user of [{idToken:jwtToken()},{accessToken:'stale',expiresAt:1799999999},{accessToken:'near',expiresAt:1800000010}]) {
    assert.throws(()=>context.resolve({originalValue:'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}',user}),error=>error.statusCode===401);
  }
  assert.equal(context.resolve({originalValue:'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}',user:{accessToken:'access',expiresAt:1800003600,idToken:'id'}}),'Bearer access');
  assert.ok(adapter.patchBackend('packages/api/dist/index.cjs',source).includes(getFunction('processSingleValue')));
});

test('startup idempotence, all-before-write validation and .gz/.br/cache revisions', () => {
  const os=require('node:os'),zlib=require('node:zlib');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-openid-adapter-'));
  try {
    fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version:'v0.8.8'}));
    for(const name of Object.keys(adapter.HASHES)){const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,readNative(name));}
    const dist=path.join(root,'client/dist');
    const refs='<script src="/assets/hooks.B1NLB7i6.js"></script><link href="/assets/vendor.DMhDOqx5.js">';
    fs.writeFileSync(path.join(dist,'index.html'),refs);
    const importer='index.CSEwt3Fy.js';
    fs.writeFileSync(path.join(dist,'assets',importer),fs.readFileSync('/app/client/dist/assets/'+importer));
    fs.writeFileSync(path.join(dist,'sw.js'),'const entries=[{url:"assets/hooks.B1NLB7i6.js",revision:null},{url:"assets/'+importer+'",revision:null},{url:"index.html",revision:"old"}];');
    for(const name of ['index.html','sw.js','assets/hooks.B1NLB7i6.js'])for(const suffix of ['.gz','.br'])fs.writeFileSync(path.join(dist,name+suffix),'stale');
    adapter.apply(root);const html=fs.readFileSync(path.join(dist,'index.html'),'utf8');assert.match(html,/govchat_openid=/);
    const sw=fs.readFileSync(path.join(dist,'sw.js'),'utf8');assert.doesNotMatch(sw,/revision:null|revision:"old"/);
    assert.ok(sw.includes(crypto.createHash('sha256').update(fs.readFileSync(path.join(dist,'assets',importer))).digest('hex')));
    assert.ok(sw.includes(crypto.createHash('sha256').update(html).digest('hex')));
    const hook=fs.readFileSync(path.join(root,hooksPath),'utf8');adapter.apply(root);
    assert.equal(fs.readFileSync(path.join(root,hooksPath),'utf8'),hook);assert.equal(fs.readFileSync(path.join(dist,'index.html'),'utf8'),html);
    for(const name of ['index.html','sw.js','assets/hooks.B1NLB7i6.js']){
      assert.deepEqual(zlib.gunzipSync(fs.readFileSync(path.join(dist,name+'.gz'))),fs.readFileSync(path.join(dist,name)));
      assert.deepEqual(zlib.brotliDecompressSync(fs.readFileSync(path.join(dist,name+'.br'))),fs.readFileSync(path.join(dist,name)));
    }
    fs.appendFileSync(path.join(root,vendorPath),'/* drift */');assert.throws(()=>adapter.apply(root),/unexpected patched/);
    assert.equal(fs.readFileSync(path.join(root,hooksPath),'utf8'),hook);
    fs.writeFileSync(path.join(root,vendorPath),adapter.patchClient(vendorPath,readNative(vendorPath)));
    fs.unlinkSync(path.join(dist,'index.html'));assert.throws(()=>adapter.apply(root),/missing required/);
    assert.equal(fs.readFileSync(path.join(root,hooksPath),'utf8'),hook);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
