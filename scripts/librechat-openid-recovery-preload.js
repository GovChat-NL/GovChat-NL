"use strict";

// v0.8.8 startup adapter, not a Node preload or a parallel authentication engine.
// Patches native recovery/request/SSE hooks; no provider calls or token storage.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");

const BACKEND_HASHES = Object.freeze({
  'api/server/controllers/AuthController.js': 'bc0ce0e8b3c88fcee6513549c26104675c5d9b84c526a496ea03d5457c0d16f9',
  'api/server/socialLogins.js': '5ae619a31f417cc93873bd456524b640a43a502067da38c4e417ba4ed122542f',
  'packages/api/dist/index.cjs': '52857b776039c7ceedcc3e139a7e3a2ddb602737ea0f4d5fd3acb77a015f8407',
});

function replaceOnce(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) {
    throw new Error('OpenID backend adapter: incompatible raw original anchor');
  }
  return source.replace(anchor, replacement);
}

// Embedded in AuthController; trusted session decode, NOT a signature verifier.
function hasCurrentOpenIDAccessToken(openidTokens) {
  const token = openidTokens?.accessToken;
  if (typeof token !== 'string' || token.trim().length === 0) return false;
  let decoded;
  try {
    decoded = jwt.decode(token);
  } catch {
    return false;
  }
  // A JWT cannot borrow an advertised lifetime to override a missing/bad/expired
  // exp. Only opaque tokens use the provider's persisted access-token lifetime.
  const isJwt = decoded != null || token.split('.').length === 3;
  const expiresAt = isJwt
    ? decoded && typeof decoded === 'object' &&
      Object.prototype.hasOwnProperty.call(decoded, 'exp') ? decoded.exp : undefined
    : openidTokens?.accessTokenExpiresAt;
  return typeof expiresAt === 'number' && Number.isFinite(expiresAt) &&
    expiresAt > Math.floor(Date.now() / 1000) + OPENID_EXPIRY_BUFFER_SECONDS;
}

// Conservative classification only, no provider calls/retries/bridge changes.
// Terminal evidence wins over network/503 evidence anywhere in the cause chain.
function isTransientOpenIDProviderError(error) {
  const seen = new Set();
  let transient = false;
  for (let current = error; current && typeof current === 'object'; current = current.cause) {
    if (seen.has(current) || seen.size >= 8) return false;
    seen.add(current);
    if (isOpenIDRefreshOwnershipError(current) || isOpenIDSessionMissingError(current)) return false;
    const statuses = [current.status, current.statusCode, current.response?.status,
      current.response?.statusCode];
    if (statuses.some((status) => [400, 401, 403].includes(Number(status)))) return false;
    const values = [current.message, current.error, current.code,
      current.response?.data?.error, current.response?.data?.error_description,
      current.body?.error, current.body?.error_description];
    if (values.some((value) => typeof value === 'string' &&
      /invalid[_\s-]*(grant|token|client)|unauthorized[_\s-]*client|access[_\s-]*denied|revok|\bmfa\b|mfa[_\s-]*required|multi[_\s-]*factor|interaction[_\s-]*required|login[_\s-]*required|consent[_\s-]*required|account[_\s-]*(disabled|locked)/i.test(value))) return false;
    if (statuses.some((status) => Number(status) === 503)) transient = true;
    if (['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND',
      'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'].includes(current.code) ||
      current.name === 'TimeoutError') transient = true;
  }
  return transient;
}

function patchBackend(relativeFilename, source) {
  if (typeof source !== 'string') throw new TypeError('OpenID backend adapter: source must be text');
  if (relativeFilename === 'packages/api/dist/index.cjs') {
    return replaceOnce(source,
      '\t\tlet expiresAt = expiresAtOverride;\n\t\tif (expiresAt == null) expiresAt =',
      '\t\tlet expiresAt = expiresAtOverride;\n\t\tif (arguments.length < 3 && expiresAt == null) expiresAt =');
  }
  if (relativeFilename === 'api/server/socialLogins.js') {
    return replaceOnce(source, '    store: getLogStores(CacheKeys.OPENID_SESSION),\n    cookie: {',
      '    store: getLogStores(CacheKeys.OPENID_SESSION),\n' +
      '    rolling: isEnabled(process.env.OPENID_REUSE_TOKENS),\n    cookie: {');
  }
  if (relativeFilename === 'api/server/controllers/AuthController.js') {
    source = replaceOnce(source,
      'const getReusableOpenIDSessionToken = (openidTokens) => {\n  if (!isRecentOpenIDSessionRefresh(openidTokens)) {',
      hasCurrentOpenIDAccessToken.toString() + '\n\n' +
      isTransientOpenIDProviderError.toString() + '\n\n' +
      'const getReusableOpenIDSessionToken = (openidTokens) => {\n' +
      '  if (!hasCurrentOpenIDAccessToken(openidTokens)) return null;\n' +
      '  if (!isRecentOpenIDSessionRefresh(openidTokens)) {');
    return replaceOnce(source,
      "      logger.error('[refreshController] OpenID token refresh error', error);\n\n      /**",
      "      logger.error('[refreshController] OpenID token refresh failed');\n\n" +
      '      if (isTransientOpenIDProviderError(error)) {\n' +
      "        res.set('Cache-Control', 'no-store');\n" +
      "        return res.status(503).send({ code: 'OPENID_PROVIDER_UNAVAILABLE', retryable: true });\n" +
      '      }\n\n      /**');
  }
  // A combined adapter may offer frontend/other paths; they remain untouched.
  return source;
}

const CLIENT_HASHES = Object.freeze({
  'client/dist/assets/hooks.B1NLB7i6.js': '08dc29bd5c9ef0a3df224e367cd21920a2c588b97247fa28811689d293b59e6e',
  'client/dist/assets/vendor.DMhDOqx5.js': '3fe9bc3b52c7beaa1d6953401145cb4fdd914b8e90698489f0da898f4527c54c',
});
const INTERVAL_MS = 5 * 60 * 1000;

// This function is inserted INSIDE the real native request module. The names
// below are pinned native functions, not globals or replacement transports.
function nativeCoordinatorExtension() {
  const govchatNativeAuthState = { epoch: 0, last: 0, timer: null, failures: 0, blocked: false,
    publishing: false, signedIn: false, account: null, stopped: false,
    pendingAccount: null, pendingLogin: false, cancelContext: null, initialRetry: null };
  // Only session invalidation is broadcast; refresh singleflight remains native
  // in each tab and native server coordination handles concurrent tab grants.
  const gcChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('librechat.auth.invalidation') : null;
  const gcPublic = () => /^\/(?:login|register|share|reset-password|forgot-password|verify)(?:\/|$)/.test(Gm(window.location.pathname));
  const gcChat = url => /^\/api\/(?:ask|agents\/(?:chat|.*queued)|assistants)/.test(Gm(qm(url)));
  const gcError = (message, status = 503) => Object.assign(new Error(message),
    { response: { status, data: { message } }, govchatReadiness: true });
  const gcStatus = message => {
    window.dispatchEvent(new CustomEvent('authRecoveryStatus', { detail: { message } }));
    let node = document.getElementById('govchat-auth-status');
    if (!message) { node?.remove(); return; }
    if (!node) {
      node = document.createElement('div'); node.id = 'govchat-auth-status';
      node.setAttribute('role', 'status'); node.setAttribute('aria-live', 'polite');
      node.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:10000;padding:12px;background:#fff3cd;color:#292100;text-align:center';
      document.body?.appendChild(node);
    }
    node.textContent = message;
  };
  const gcTemporary = 'Aanmelden tijdelijk niet beschikbaar. U blijft aangemeld; chat wacht op herstel. Probeer later opnieuw.';
  const gcInstruction = 'Uw sessie moet worden hersteld. Meld u opnieuw aan voordat u een chatbericht verstuurt.';
  const gcTransient = error => !error?.govchatTerminal && (!error?.response ||
    [429, 500, 502, 503, 504].includes(error.response.status));
  const gcUsable = token => {
    if (typeof token !== 'string' || !token.trim() || token.trim() !== token) return false;
    const expiry = ch(token);
    return Number.isFinite(expiry) && expiry > Date.now() + 30000;
  };
  const gcValidResponse = response => gcUsable(response?.token) &&
    typeof response?.user?.id === 'string' && !!response.user.id.trim() &&
    (!(govchatNativeAuthState.pendingAccount || govchatNativeAuthState.account) ||
      response.user.id === (govchatNativeAuthState.pendingAccount || govchatNativeAuthState.account));
  const gcInvalidate = stopped => {
    govchatNativeAuthState.cancelContext?.(); govchatNativeAuthState.initialRetry = null;
    govchatNativeAuthState.pendingAccount = null; govchatNativeAuthState.pendingLogin = false;
    govchatNativeAuthState.epoch++; govchatNativeAuthState.last = 0; govchatNativeAuthState.failures = 0; govchatNativeAuthState.blocked = false; govchatNativeAuthState.stopped = stopped;
    clearTimeout(govchatNativeAuthState.timer); govchatNativeAuthState.timer = null; Zm().refreshPromise = null;
  };
  const gcLogout = () => {
    gcChannel?.postMessage({ type: 'logout' });
    gcInvalidate(true); govchatNativeAuthState.signedIn = false; wm(undefined);
    gcStatus(''); return govchatNativeAuthState.epoch;
  };
  const gcBeginLogin = () => {
    gcInvalidate(false); govchatNativeAuthState.pendingLogin = true;
    return govchatNativeAuthState.epoch;
  };
  const gcAcceptLogin = response => {
    if (!gcUsable(response?.token) || typeof response?.user?.id !== 'string' || !response.user.id.trim()) return false;
    govchatNativeAuthState.pendingAccount = response.user.id;
    govchatNativeAuthState.pendingLogin = false; return true;
  };
  const gcContextPublisher = debounced => {
    const publish = context => {
      const current = { ...context, govchatEpoch: govchatNativeAuthState.epoch };
      if (!gcContextCurrent(current)) return;
      if (current.isAuthenticated) govchatNativeAuthState.pendingAccount = current.user.id;
      debounced(current);
    };
    publish.cancel = () => debounced.cancel();
    govchatNativeAuthState.cancelContext = publish.cancel;
    return publish;
  };
  const gcContextCurrent = context => context.govchatEpoch === govchatNativeAuthState.epoch &&
    (!context.isAuthenticated || (!govchatNativeAuthState.stopped && !govchatNativeAuthState.pendingLogin && gcValidResponse(context)));
  const gcTokenContext = (event, user) => {
    const detail = event.detail;
    const response = typeof detail === 'string' ? { token: detail, user } : detail;
    if (govchatNativeAuthState.pendingLogin || govchatNativeAuthState.stopped ||
      (typeof detail !== 'string' && detail?.govchatEpoch !== govchatNativeAuthState.epoch) ||
      response?.token !== sh() || !gcValidResponse(response)) return null;
    return { token: response.token, user: response.user, isAuthenticated: true };
  };
  const gcContextHeader = token => {
    govchatNativeAuthState.publishing = true;
    try { wm(token); } finally { govchatNativeAuthState.publishing = false; }
  };
  const gcInitialFailure = (error, retry) => {
    if (!gcTransient(error)) return false;
    govchatNativeAuthState.blocked = true; govchatNativeAuthState.failures++;
    govchatNativeAuthState.last = Date.now(); govchatNativeAuthState.initialRetry = retry;
    gcStatus(gcTemporary); gcArm(); return true;
  };
  const gcHeaderChanged = token => {
    if (govchatNativeAuthState.publishing || token === sh()) return;
    gcInvalidate(!token); gcArm();
  };
  const gcSetAccount = (signedIn, account) => {
    if (govchatNativeAuthState.signedIn && govchatNativeAuthState.account && govchatNativeAuthState.account !== account) gcChannel?.postMessage({ type: 'session-change' });
    if (govchatNativeAuthState.signedIn !== signedIn || (signedIn && govchatNativeAuthState.account !== account)) gcInvalidate(!signedIn);
    govchatNativeAuthState.account = account; govchatNativeAuthState.signedIn = signedIn; gcArm();
  };
  const gcDelay = () => govchatNativeAuthState.blocked ? Math.min(300000, 15000 * 2 ** Math.min(govchatNativeAuthState.failures - 1, 5)) : 300000;
  const gcArm = () => {
    clearTimeout(govchatNativeAuthState.timer); govchatNativeAuthState.timer = null;
    if (govchatNativeAuthState.initialRetry && !govchatNativeAuthState.stopped && !gcPublic() &&
      document.visibilityState === 'visible' && window.navigator.onLine !== false) {
      govchatNativeAuthState.timer = setTimeout(gcWake, Math.max(0, govchatNativeAuthState.last + gcDelay() - Date.now())); return;
    }
    if (!govchatNativeAuthState.signedIn || govchatNativeAuthState.stopped || !sh() || gcPublic() || th() ||
      document.visibilityState !== 'visible' || window.navigator.onLine === false) return;
    const delay = govchatNativeAuthState.last ? Math.max(0, govchatNativeAuthState.last + gcDelay() - Date.now()) : 0;
    govchatNativeAuthState.timer = setTimeout(() => { govchatNativeAuthState.timer = null; gcWake(); }, delay);
  };
  const gcWake = () => {
    if (govchatNativeAuthState.initialRetry && !govchatNativeAuthState.stopped && !gcPublic() &&
      document.visibilityState === 'visible' && window.navigator.onLine !== false) {
      if (Date.now() - govchatNativeAuthState.last >= gcDelay()) {
        const retry = govchatNativeAuthState.initialRetry; govchatNativeAuthState.initialRetry = null; retry();
      } else gcArm();
      return;
    }
    if (!govchatNativeAuthState.signedIn || govchatNativeAuthState.stopped || !sh() || gcPublic() || th() || document.visibilityState !== 'visible') {
      clearTimeout(govchatNativeAuthState.timer); govchatNativeAuthState.timer = null; return;
    }
    if (window.navigator.onLine === false) { govchatNativeAuthState.blocked = true; gcStatus(gcTemporary); return; }
    if (!govchatNativeAuthState.last || Date.now() - govchatNativeAuthState.last >= gcDelay() || lh()) ah(false).catch(() => {});
    else gcArm();
  };
  const gcRecover = retry => {
    const state = Zm();
    if (state.refreshPromise) return state.refreshPromise;
    const epoch = govchatNativeAuthState.epoch;
    if (govchatNativeAuthState.stopped || govchatNativeAuthState.pendingLogin) return Promise.reject(gcError(gcInstruction, 401));
    clearTimeout(govchatNativeAuthState.timer); govchatNativeAuthState.timer = null; nh('started');
    const promise = Bm(retry).then(response => {
      if (epoch !== govchatNativeAuthState.epoch || govchatNativeAuthState.stopped) throw gcError('Sessie gewijzigd; bericht niet verzonden.', 409);
      const token = response?.token;
      if (!gcValidResponse(response)) {
        throw Object.assign(gcError(gcInstruction, 401), { govchatTerminal: true });
      }
      govchatNativeAuthState.blocked = false; govchatNativeAuthState.failures = 0; govchatNativeAuthState.last = Date.now();
      govchatNativeAuthState.publishing = true;
      try { Xm(token, { token, user: response.user, govchatEpoch: epoch }); } finally { govchatNativeAuthState.publishing = false; }
      gcStatus(''); return token;
    }).catch(error => {
      if (epoch !== govchatNativeAuthState.epoch || govchatNativeAuthState.stopped) throw error;
      govchatNativeAuthState.last = Date.now();
      if (gcTransient(error)) { govchatNativeAuthState.blocked = true; govchatNativeAuthState.failures++; gcStatus(gcTemporary); }
      else { govchatNativeAuthState.stopped = true; gcStatus(gcInstruction); oh(); }
      throw error;
    }).finally(() => {
      if (epoch === govchatNativeAuthState.epoch && state.refreshPromise === promise) {
        state.refreshPromise = null; nh('finished'); gcArm();
      }
    });
    state.refreshPromise = promise; return promise;
  };
  const gcBefore = async url => {
    if (ih(url)) return null;
    if (gcPublic()) {
      if (gcChat(url)) throw gcError(gcInstruction, 401);
      return null;
    }
    if (govchatNativeAuthState.stopped || govchatNativeAuthState.pendingLogin || th()) throw gcError(gcInstruction, 401);
    if (!sh()) { if (gcChat(url)) throw gcError(gcInstruction, 401); return null; }
    const epoch = govchatNativeAuthState.epoch;
    if (window.navigator.onLine === false) { govchatNativeAuthState.blocked = true; gcStatus(gcTemporary); throw gcError(gcTemporary); }
    const state = Zm();
    if (state.refreshPromise) await state.refreshPromise;
    else if (!govchatNativeAuthState.last || govchatNativeAuthState.blocked || Date.now() - govchatNativeAuthState.last >= 300000 || lh(url)) {
      if (govchatNativeAuthState.blocked && Date.now() - govchatNativeAuthState.last < gcDelay()) throw gcError(gcTemporary);
      await ah(false);
    }
    if (epoch !== govchatNativeAuthState.epoch || govchatNativeAuthState.stopped || !gcUsable(sh())) throw gcError('Sessie gewijzigd; bericht niet verzonden.', 409);
    return sh();
  };
  const gcFinalToken = (token, epoch, url) => {
    if (ih(url) || gcPublic()) return token;
    if (!token && !gcChat(url)) return token;
    if (epoch !== govchatNativeAuthState.epoch || govchatNativeAuthState.stopped || govchatNativeAuthState.pendingLogin || token !== sh() || !gcUsable(token)) {
      throw gcError('Sessie gewijzigd; bericht niet verzonden.', 409);
    }
    return token;
  };
  const gcOperationCurrent = epoch => epoch === govchatNativeAuthState.epoch &&
    !govchatNativeAuthState.stopped && !govchatNativeAuthState.pendingLogin;
  const gcAxiosFinal = (config, token, epoch) => {
    if (!token) return;
    config.govchatOriginalAdapter ??= Ar.getAdapter(config.adapter ?? Ar.defaults.adapter);
    config.adapter = cfg => {
      gcFinalToken(token, epoch, cfg.url);
      return config.govchatOriginalAdapter(cfg);
    };
  };
  const gcStreamReady = async url => {
    const epoch = govchatNativeAuthState.epoch;
    await uh(url); const token = sh();
    const isCurrent = () => gcOperationCurrent(epoch) && token === sh() && gcUsable(token);
    if (!isCurrent()) throw gcError(gcInstruction, 401);
    return { token, isCurrent };
  };
  if (gcChannel) gcChannel.onmessage = event => {
    if (!['logout', 'session-change'].includes(event.data?.type)) return;
    gcInvalidate(true); govchatNativeAuthState.signedIn = false; wm(undefined); gcStatus(gcInstruction);
    if (!gcPublic()) oh();
  };
  window.addEventListener('focus', gcWake);
  window.addEventListener('online', gcWake);
  document.addEventListener('visibilitychange', gcWake);
  if (new URLSearchParams(window.location.search).get('govchat_reauth') === '1') {
    if (document.body) gcStatus(gcInstruction);
    else window.addEventListener('DOMContentLoaded', () => gcStatus(gcInstruction), { once: true });
  }
}

function patchClient(relativeFilename, source) {
  if (relativeFilename.endsWith('/hooks.B1NLB7i6.js')) {
    const extension = nativeCoordinatorExtension.toString().replace(/^function nativeCoordinatorExtension\(\) \{/, '').replace(/\}\s*$/, '');
    source = replaceOnce(source, 'var Fm=`authRecovery`', extension + '\nvar Fm=`authRecovery`');
    source = replaceOnce(source, 'function wm(e){e===void 0?', 'function wm(e){gcHeaderChanged(e);e===void 0?');
    source = replaceOnce(source, 'Xm=e=>{wm(e),eh(),window.dispatchEvent(new CustomEvent(`tokenUpdated`,{detail:e}))}',
      'Xm=(e,t)=>{wm(e),eh(),window.dispatchEvent(new CustomEvent(`tokenUpdated`,{detail:t??e}))}');
    source = replaceOnce(source,
      'ah=e=>{let t=Zm();return t.refreshPromise?t.refreshPromise:(nh(`started`),t.refreshPromise=Bm(e).then(e=>{let t=e?.token??``;return t?(Xm(t),t):null}).finally(()=>{t.refreshPromise=null,nh(`finished`)}),t.refreshPromise)}',
      'ah=e=>gcRecover(e)');
    source = replaceOnce(source,
      'uh=async e=>{let t=Zm();return t.refreshPromise&&!ih(e)?t.refreshPromise.catch(()=>null):lh(e)?ah(!1).catch(()=>null):null}',
      'uh=async e=>gcBefore(e)');
    source = replaceOnce(source, 'return r>0&&r<=zm', 'return r<=zm');
    source = replaceOnce(source, 'let e=Ll()+Bu();$m()',
      'let e=Ll()+Bu();e+=(e.includes(`?`)?`&`:`?`)+`govchat_reauth=1&redirect=false`;$m()');
    source = replaceOnce(source, 'let i;try{i=await ah(!1)}catch{return oh(),r}',
      'if(![`GET`,`HEAD`].includes((t?.method??`GET`).toUpperCase())){ah(!1).catch(()=>{});return r}let i;try{i=await ah(!1)}catch{return r}');
    source = replaceOnce(source, 'catch{return oh(),Promise.reject(e)}', 'catch{return Promise.reject(e)}');
    source = replaceOnce(source, 'if(e.response.status===401&&!t._retry)',
      'if(e.response.status===401&&!t._retry&&!gcChat(t.url)&&gcOperationCurrent(t.govchatEpoch))');
    source = replaceOnce(source, 'let r=await ah(n);return r?(rh(t,r),await Ar(t))',
      'let r=await ah(n);if(!gcOperationCurrent(t.govchatEpoch))return Promise.reject(e);return r?(rh(t,r),await Ar(t))');
    source = replaceOnce(source, 'let n=await uh(e)??sh(),r=await fetch(e,dh(t,n));',
      'const govchatFetchEpoch=govchatNativeAuthState.epoch;let n=await uh(e)??sh(),r=await fetch(e,dh(t,gcFinalToken(n,govchatFetchEpoch,e)));');
    source = replaceOnce(source, 'fetch(e,dh(t,i))', 'fetch(e,dh(t,gcFinalToken(i,govchatFetchEpoch,e)))');
    source = replaceOnce(source, 'if(r.status!==401||ih(e)||th()||!sh())return r;',
      'if(r.status!==401||ih(e)||th()||!sh()||!gcOperationCurrent(govchatFetchEpoch))return r;');
    source = replaceOnce(source, 'return i?(await r.body?.cancel()',
      'if(!gcOperationCurrent(govchatFetchEpoch))return r;return i?(await r.body?.cancel()');
    source = replaceOnce(source, 'Ar.interceptors.request.use(async e=>{let t=await uh(e.url);return t&&rh(e,t),e})',
      'Ar.interceptors.request.use(async e=>{const epoch=e.govchatEpoch??=govchatNativeAuthState.epoch;if(epoch!==govchatNativeAuthState.epoch)throw gcError(`Sessie gewijzigd; bericht niet verzonden.`,409);let t=await uh(e.url);return t&&(gcFinalToken(t,epoch,e.url),rh(e,t),gcAxiosFinal(e,t,epoch)),e})');
    source = replaceOnce(source, 'onMutate:a=>{i(!1),r(),n(),t.removeQueries(),e?.onMutate?.(a)}',
      'onMutate:a=>{i(!1),r(),n(),t.removeQueries();return e?.onMutate?.(a)}');
    source = replaceOnce(source, 'onSuccess:(...a)=>{i(!1),r(),n(),t.removeQueries(),e?.onSuccess?.(...a)}',
      'onSuccess:(...a)=>{if(a[2]?.govchatEpoch!=null&&a[2].govchatEpoch!==govchatNativeAuthState.epoch)return;i(!1),r(),n(),t.removeQueries(),e?.onSuccess?.(...a)}');
    source = replaceOnce(source, 'onError:(...t)=>{i(!0),e?.onError?.(...t)}',
      'onError:(...t)=>{if(t[2]?.govchatEpoch!=null&&t[2].govchatEpoch!==govchatNativeAuthState.epoch)return;i(!0),e?.onError?.(...t)}');
    source = replaceOnce(source, 'E=(0,q.useCallback)(e=>{e&&(a.current=e),w.mutate(void 0)}',
      'E=(0,q.useCallback)(e=>{const epoch=gcLogout();x.cancel();e&&(a.current=e),w.mutate({govchatEpoch:epoch})}');
    source = replaceOnce(source, 'x=(0,q.useMemo)(()=>(0,r8.debounce)(e=>{let{token:t,isAuthenticated:n,user:r,redirect:o}=e;',
      'x=(0,q.useMemo)(()=>gcContextPublisher((0,r8.debounce)(e=>{if(!gcContextCurrent(e))return;let{token:t,isAuthenticated:n,user:r,redirect:o}=e;');
    source = replaceOnce(source, 'i(r),s(t),wm(t),d(n)', 'i(r),s(t),gcContextHeader(t),d(n)');
    source = replaceOnce(source, 'b(u,{replace:!0})},50),[b,i,m])', 'b(u,{replace:!0})},50)),[b,i,m])');
    source = replaceOnce(source, 'C=PV({onSuccess:e=>{let{user:t',
      'C=PV({onMutate:()=>({govchatEpoch:gcBeginLogin()}),onSuccess:(e,variables,context)=>{if(context?.govchatEpoch!==govchatNativeAuthState.epoch)return;let{user:t');
    source = replaceOnce(source, 'l(void 0),x({token:n,isAuthenticated:!0,user:t,redirect:`/c/new`})',
      'if(!gcAcceptLogin(e)){gcStatus(gcInstruction);return}l(void 0),x({token:n,isAuthenticated:!0,user:t,redirect:`/c/new`})');
    source = replaceOnce(source, 'onError:e=>{let t=e,n=t.response?.data?.code;',
      'onError:(e,variables,context)=>{if(context?.govchatEpoch!==govchatNativeAuthState.epoch)return;let t=e,n=t.response?.data?.code;');
    source = replaceOnce(source, 'w=NV({onSuccess:e=>{if(e.redirect)',
      'w=NV({onMutate:variables=>variables,onSuccess:(e,variables,context)=>{if(context?.govchatEpoch!==govchatNativeAuthState.epoch)return;if(e.redirect)');
    source = replaceOnce(source, 'onError:e=>{a8(),S(e.message),x({token:void 0',
      'onError:(e,variables,context)=>{if(context?.govchatEpoch!==govchatNativeAuthState.epoch)return;a8(),S(e.message),x({token:void 0');
    source = replaceOnce(source, 'e?.test!==!0&&(n.current||T.mutate(void 0,{onSuccess:t=>{if(n.current)return;',
      'const govchatInitialEpoch=govchatNativeAuthState.epoch;e?.test!==!0&&(n.current||T.mutate(void 0,{onSuccess:t=>{if(n.current||govchatInitialEpoch!==govchatNativeAuthState.epoch||govchatNativeAuthState.stopped)return;');
    source = replaceOnce(source, 'onError:t=>{n.current||(console.log(`refreshToken mutation error:`',
      'onError:t=>{if(n.current||govchatInitialEpoch!==govchatNativeAuthState.epoch||govchatNativeAuthState.stopped||gcInitialFailure(t,k))return;console.log(`refreshToken mutation error:`');
    source = replaceOnce(source, 'e?.optional!==!0&&b(Bu()))}}))},[])', 'e?.optional!==!0&&b(Bu())}}))},[])');
    source = replaceOnce(source, 'let{user:r,token:i=``}=t??{};if(i){',
      'let{user:r,token:i=``}=t??{};if(i&&!gcValidResponse(t)){gcStatus(gcInstruction);oh();return}govchatNativeAuthState.initialRetry=null;govchatNativeAuthState.blocked=false;gcStatus(``);if(i){');
    source = replaceOnce(source, 'D.data?i(D.data):D.isError&&(a8()',
      'D.data?(D.data.id===(govchatNativeAuthState.pendingAccount||govchatNativeAuthState.account)&&i(D.data)):D.isError&&!gcTransient(D.error)&&(a8()');
    source = replaceOnce(source, 'console.log(`tokenUpdated event received event`),x({token:e.detail,isAuthenticated:!0,user:r})',
      'const context=gcTokenContext(e,r);if(context)x(context)');
    source = replaceOnce(source, 'let A=(0,q.useMemo)(()=>({user:r,token:o,error:c,login:O',
      '(0,q.useEffect)(()=>{gcSetAccount(u,r?.id);return()=>{gcInvalidate(true)}},[u,r?.id]);let A=(0,q.useMemo)(()=>({user:r,token:o,error:c,login:O');
    source = replaceOnce(source, 'new Jn(n.server,{payload:',
      'new Jn(n.server,{govchatAuthReady:()=>gcStreamReady(n.server),payload:');
    source = replaceOnce(source, 'new Jn(rt,{headers:',
      'new Jn(rt,{govchatAuthReady:()=>gcStreamReady(rt),headers:');
  } else if (relativeFilename.endsWith('/vendor.DMhDOqx5.js')) {
    source = replaceOnce(source, 'this.url=e,t||={},this.headers=t.headers||{}',
      'this.url=e,t||={},this.govchatAuthReady=t.govchatAuthReady,this.govchatSendEpoch=0,this.govchatPending=false,this.headers=t.headers||{}');
    source = replaceOnce(source, 'this.stream=function(){if(!this.xhr){',
      'this.stream=async function(){if(this.govchatPending||this.xhr)return;const epoch=this.govchatSendEpoch;let ready;this.govchatPending=true;try{if(this.govchatAuthReady){ready=await this.govchatAuthReady();if(epoch!==this.govchatSendEpoch||!ready.isCurrent())return;this.headers.Authorization=`Bearer ${ready.token}`}}catch(error){this.autoReconnect=false;this._onStreamFailure({currentTarget:{status:error.response?.status??503,response:JSON.stringify({message:error.message})}});return}finally{this.govchatPending=false}if(epoch!==this.govchatSendEpoch)return;if(!this.xhr){');
    source = replaceOnce(source, 'this._setReadyState(SSE.CONNECTING),this.xhr=new XMLHttpRequest',
      'this._setReadyState(SSE.CONNECTING);if(epoch!==this.govchatSendEpoch||ready&&!ready.isCurrent())return;this.xhr=new XMLHttpRequest');
    source = replaceOnce(source, 'this.xhr.send(this.payload)',
      'epoch===this.govchatSendEpoch&&(!ready||ready.isCurrent())&&this.xhr?.send(this.payload)');
    source = replaceOnce(source, 'this.close=function(){this.reconnectTimer',
      'this.close=function(){this.govchatSendEpoch++;this.reconnectTimer');
  }
  return source;
}

const digest = content => crypto.createHash('sha256').update(content).digest('hex');
const HASHES = Object.freeze({ ...BACKEND_HASHES, ...CLIENT_HASHES });

function apply(root = '/app') {
  if (JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version !== 'v0.8.8') {
    throw new Error('OpenID adapter: unsupported LibreChat version');
  }
  // Validate EVERY file before writing ANY. Retain pristine copies in the image
  // writable layer; repeated startup derives exactly the same result from them.
  const changes = [];
  for (const [name, hash] of Object.entries(HASHES)) {
    const file = path.join(root, name), backup = file + '.govchat-openid-original';
    const current = fs.readFileSync(file, 'utf8');
    const original = fs.existsSync(backup) ? fs.readFileSync(backup, 'utf8') : current;
    if (digest(original) !== hash) throw new Error('OpenID adapter: incompatible source ' + name);
    const patched = patchClient(name, patchBackend(name, original));
    const unversioned = current.replace(/\?govchat_openid=[a-f0-9]+/g, '');
    if (digest(current) !== hash && unversioned !== patched) throw new Error('OpenID adapter: unexpected patched source ' + name);
    changes.push({ file, backup, original, patched });
  }
  // Prepare the complete asset graph BEFORE writing source/backups/compression.
  const dist = path.join(root, 'client/dist');
  const revision = digest(changes.map(change => change.patched).join('\n')).slice(0, 16);
  const assets = Object.keys(CLIENT_HASHES).map(name => path.basename(name));
  const files = [path.join(dist, 'index.html'), path.join(dist, 'sw.js'),
    ...fs.readdirSync(path.join(dist, 'assets')).filter(name => name.endsWith('.js')).map(name => path.join(dist, 'assets', name))];
  const outputs = new Map(changes.map(change => [change.file, change.patched]));
  for (const file of files) {
    if (!fs.existsSync(file)) {
      if (path.basename(file) === 'sw.js') continue;
      throw new Error('OpenID adapter: missing required asset ' + file);
    }
    let text = outputs.get(file) ?? fs.readFileSync(file, 'utf8');
    for (const name of assets) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(escaped + '(?:\\?govchat_openid=[a-f0-9]+)?', 'g'), name + '?govchat_openid=' + revision);
    }
    outputs.set(file, text);
  }
  const swPath = path.join(dist, 'sw.js');
  if (outputs.has(swPath)) {
    const sw = outputs.get(swPath).replace(/(\{url:["']([^"']+)["'],revision:)(["'][^"']*["']|null)/g,
      (match, prefix, url) => {
        const file = path.resolve(dist, url.replace(/^\//, '').split('?')[0]);
        // Rewritten importers also need revisions: null/hash-named native cache
        // entries otherwise retain old import bodies across an adapter upgrade.
        const content = outputs.get(file);
        return content == null ? match : prefix + JSON.stringify(digest(content));
      });
    outputs.set(swPath, sw);
  }
  const prepared = [];
  for (const [file, content] of outputs) {
    prepared.push([file, content]);
    for (const [suffix, compress] of [['.gz', zlib.gzipSync], ['.br', zlib.brotliCompressSync]]) {
      if (fs.existsSync(file + suffix)) prepared.push([file + suffix, compress(content)]);
    }
  }
  // Validation/read/transform/compression failures cannot leave a partial patch.
  // Disk-write failure still aborts startup; this is not a filesystem transaction.
  for (const { backup, original } of changes) {
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, original, { mode: 0o600 });
  }
  for (const [file, content] of prepared) fs.writeFileSync(file, content);
  console.info('[GovChat OpenID adapter] native coordinator installed; touched-source fingerprints=5');
}

module.exports = { HASHES, BACKEND_HASHES, CLIENT_HASHES, INTERVAL_MS, patchBackend, patchClient, apply };
if (require.main === module) {
  try { apply(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
