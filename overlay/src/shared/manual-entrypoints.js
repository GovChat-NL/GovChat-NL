/** Native markers only. Called by the parent's existing route loop; no observer/timer loop.
 * getDocument must return the authenticated /document response (never an admin preview).
 * Replace its identity after auth/config/revision changes, or call cleanup first.
 * open owns current-context /get validation, modal navigation and user-facing failures.
 */
const STATE_EVENT = 'govchat:manual-state';
const OPEN_EVENT = 'govchat:manual-open';
const STATE_ATTRIBUTE = 'data-govchat-manual-enabled';
const ERROR_SELECTOR = '[data-govchat-manual-error]';
const owned = new Map();
let options = null;
let generation = 0;
let documentSource = null;
let permittedDocument = null;
let attempted = false;
let pending = null;
let cancelLoad = null;
let listening = false;

function report(error) {
  try { options?.onError?.(error); } catch { /* Host reporting must not break chat. */ }
}

function invoke(target = {}) {
  if (!options?.enabled || typeof options.open !== 'function') return;
  try { Promise.resolve(options.open(target)).catch(report); } catch (error) { report(error); }
}

function onNativeOpen(event) {
  if (!options?.enabled) return;
  event.preventDefault();
  invoke();
}

function setNativeState(enabled) {
  const root = document.documentElement;
  const next = enabled ? 'true' : 'false';
  if (root.getAttribute(STATE_ATTRIBUTE) === next) return;
  root.setAttribute(STATE_ATTRIBUTE, next);
  window.dispatchEvent(new CustomEvent(STATE_EVENT));
}

function removeOwned(predicate = () => true) {
  for (const [host, entry] of owned) {
    if (!predicate(entry, host)) continue;
    entry.button.removeEventListener('click', entry.click);
    entry.button.remove();
    owned.delete(host);
  }
}

function attach(host, kind, target = {}) {
  const key = JSON.stringify(target);
  const previous = owned.get(host);
  if (previous?.key === key && previous.button.parentNode === host) return;
  if (previous) removeOwned((_entry, node) => node === host);
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('data-govchat-manual-owned', kind);
  button.textContent = kind === 'error' ? 'Hulp bij deze fout' : 'Handleiding';
  button.setAttribute('aria-label', kind === 'error' ? 'Open handleiding: hulp bij deze fout' : 'Open handleiding');
  // Native slots provide layout/breakpoints. Never restyle or replace native text/links.
  button.className = 'rounded px-2 py-1 text-xs text-text-muted underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';
  const click = () => invoke(target);
  button.addEventListener('click', click);
  host.appendChild(button);
  owned.set(host, { button, click, key, kind });
}

function exactValues(component) {
  const values = new Set();
  for (const attribute of ['data-govchat-error-code', 'data-govchat-error-message']) {
    const value = component.getAttribute(attribute);
    if (value && value.length <= 24000) values.add(value);
  }
  // Exact visible leaf text only inside a pinned error component. No chat-wide scans,
  // substring matching, provider JSON parsing, regex diagnosis or fuzzy matching.
  const collect = node => {
    if (node.nodeType === 1 && (node.hasAttribute('data-govchat-manual-owned') ||
        node.hasAttribute('data-govchat-manual-error-actions'))) return;
    if (node.nodeType === 3) {
      const text = node.textContent.trim();
      if (text && text.length <= 24000) values.add(text);
    }
    for (const child of node.childNodes || []) collect(child);
  };
  collect(component);
  return values;
}

function targetFor(component, doc) {
  const values = exactValues(component);
  const matches = doc.passages.filter(passage =>
    ['codes', 'messages', 'aliases'].some(field => Array.isArray(passage[field]) &&
      passage[field].some(value => typeof value === 'string' && values.has(value))));
  // Ambiguous aliases/messages must not silently choose a diagnosis.
  const passage = matches.length === 1 ? matches[0] :
    doc.passages.find(item => item.id === 'probleem-algemeen');
  return passage ? { id: passage.id, revision: doc.revision } : null;
}

function syncErrors() {
  if (!options?.enabled || !permittedDocument) return;
  for (const component of document.querySelectorAll(ERROR_SELECTOR)) {
    const host = component.querySelector('[data-govchat-manual-error-actions]');
    if (!host) continue;
    const target = targetFor(component, permittedDocument);
    if (target) attach(host, 'error', target);
    else removeOwned((_entry, node) => node === host);
  }
}

function loadDocument() {
  if (attempted || typeof documentSource !== 'function' ||
      !document.querySelector(ERROR_SELECTOR)) return;
  attempted = true;
  const current = generation;
  const source = documentSource;
  // One in-flight read and one attempt per supplied auth/config context. A bounded
  // deadline releases references even when an optional host callback never settles.
  const controller = new AbortController();
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error('Handleidingdocument niet beschikbaar'));
    }, 8000);
    cancelLoad = () => {
      controller.abort();
      reject(new Error('Handleidingdocument geannuleerd'));
    };
  });
  pending = Promise.race([Promise.resolve().then(() => source({ signal: controller.signal })), deadline])
    .then(doc => {
      if (current !== generation || !options?.enabled) return;
      if (!doc || doc.ok !== true || doc.enabled !== true || doc.preview === true ||
          typeof doc.revision !== 'string' || !doc.revision ||
          !Array.isArray(doc.passages) || doc.passages.length > 1200 ||
          doc.passages.some(p => !p || typeof p.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(p.id))) {
        throw new Error('Ongeldig toegestaan handleidingdocument');
      }
      permittedDocument = doc;
      syncErrors();
    })
    .catch(error => { if (current === generation && options?.enabled) report(error); })
    .finally(() => {
      clearTimeout(timeout);
      if (current === generation) { pending = null; cancelLoad = null; }
    });
}

/** Repeat-safe route-loop entrypoint. Optional getDocument is deliberately injected. */
export function syncManualEntrypoints({ enabled, open, onError, getDocument } = {}) {
  if (enabled !== true || typeof open !== 'function') {
    cleanupManualEntrypoints();
    return;
  }
  if (documentSource !== getDocument) {
    generation++;
    cancelLoad?.();
    cancelLoad = null;
    pending = null;
    documentSource = getDocument;
    permittedDocument = null;
    attempted = false;
    removeOwned(entry => entry.kind === 'error');
  }
  options = { enabled: true, open, onError };
  if (!listening) {
    window.addEventListener(OPEN_EVENT, onNativeOpen);
    listening = true;
  }
  setNativeState(true);
  removeOwned((_entry, host) => !host.isConnected);
  for (const host of document.querySelectorAll('[data-govchat-manual-slot]')) {
    const kind = host.getAttribute('data-govchat-manual-slot');
    if (kind === 'desktop' || kind === 'mobile') attach(host, kind);
  }
  syncErrors();
  loadDocument();
}

/** Call on disable, logout or owner teardown; safe to call repeatedly. */
export function cleanupManualEntrypoints() {
  generation++;
  options = null;
  cancelLoad?.();
  cancelLoad = null;
  pending = null;
  documentSource = null;
  permittedDocument = null;
  attempted = false;
  removeOwned();
  if (listening) window.removeEventListener(OPEN_EVENT, onNativeOpen);
  listening = false;
  setNativeState(false);
}
