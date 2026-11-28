import { librechatFetch, getLibreChatAuthToken } from './librechat-api.js';

const BASE = '/govchat-api/manual';
export class ManualFailure extends Error {
  constructor(code, message, status = 0) { super(message); this.code = code; this.status = status; }
}

export async function manualAuthBootstrap() {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([(async () => {
      // A newly activated app/login must not reuse another login's cached token.
      await getLibreChatAuthToken(true);
      const responses = await Promise.all(['/api/user', '/api/config'].map(path => librechatFetch(path, { cache: 'no-store', signal: controller.signal })));
      if (responses.some(response => !response.ok)) throw new ManualFailure('UNAUTHORIZED');
      const [user, appConfig] = await Promise.all(responses.map(response => response.json()));
      if (!appConfig || typeof appConfig !== 'object') throw new ManualFailure('MANUAL_UNAVAILABLE');
      const id = user?.id || user?._id;
      if (typeof id !== 'string' || !id) throw new ManualFailure('UNAUTHORIZED');
      return id;
    })(), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new ManualFailure('MANUAL_UNAVAILABLE')); }, 10000);
    })]);
  } catch (error) {
    if (error instanceof ManualFailure) throw error;
    throw new ManualFailure('UNAUTHORIZED', 'Meld je opnieuw aan om de handleiding te lezen.');
  } finally { clearTimeout(timer); }
}

// A deadline also bounds the existing refresh bootstrap (which owns token handling).
export async function manualRequest(action, params = {}, { signal } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let timer;
  try {
    const work = async () => {
      const url = `${BASE}/${action}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''}`;
      const options = { cache: 'no-store', signal: controller.signal, credentials: 'same-origin' };
      const response = action === 'config' ? await fetch(url, options) : await librechatFetch(url, options);
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) throw new ManualFailure(data?.error?.code || 'MANUAL_UNAVAILABLE', data?.error?.message || 'De handleiding is tijdelijk niet beschikbaar.', response.status);
      if (data.preview || (action !== 'config' && !data.revision)) throw new ManualFailure('INVALID_RESPONSE', 'De handleiding kon niet veilig worden geladen.');
      return data;
    };
    return await Promise.race([work(), new Promise((_, reject) => {
      timer = setTimeout(() => { abort(); reject(new ManualFailure('MANUAL_UNAVAILABLE', 'Het laden duurt te lang. Probeer later opnieuw.')); }, 10000);
    })]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

// Strict raw canonical compiler href only; no model prose, alternate paths, extra
// parameters, fragments, encoded path tricks or external source interception.
export function parseManualHref(href) {
  if (typeof href !== 'string') return null;
  if (href === '/c/new?manual=toc') return { toc: true };
  const match = /^\/c\/new\?manual=([A-Za-z0-9][A-Za-z0-9_-]{0,79})&manualRevision=([A-Za-z0-9_-]{1,100})$/.exec(href);
  return match ? { id: match[1], revision: match[2] } : null;
}

export function failureText(error) {
  switch (error?.code) {
    case 'REVISION_CHANGED': return 'Deze bron verwijst naar een eerdere handleidingversie. De aangehaalde passage is niet getoond. Open de actuele inhoudsopgave en zoek opnieuw.';
    case 'PASSAGE_NOT_FOUND': return 'Deze passage bestaat niet meer of is voor jou niet zichtbaar. De aangehaalde tekst is niet getoond.';
    case 'MANUAL_DISABLED': return 'De handleiding is uitgeschakeld. Je gesprek blijft ongewijzigd.';
    case 'UNAUTHORIZED': return 'Je sessie is verlopen. Meld je opnieuw aan om de handleiding te lezen.';
    default: return 'De handleiding is tijdelijk niet beschikbaar. Je kunt gewoon verder werken. Probeer later opnieuw.';
  }
}
