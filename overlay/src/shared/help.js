// One authenticated manual and dialog shared by chat, start and GovChat apps.
// Legacy signatures are intentional: passed raw helpData/URLs are NEVER rendered.
import { manualRequest, manualAuthBootstrap, ManualFailure, parseManualHref, failureText } from './manual-client.js';
import { preferenceScope, createManualPreferences } from './manual-preferences.js';
import { node, articleNode, loadManualStyles } from './manual-render.js';
import { syncManualEntrypoints, cleanupManualEntrypoints } from './manual-entrypoints.js';

let config = { enabled: false, autoOpen: 'never', revision: '' };
let authenticated = false, prefs = null, booting = null;
let dialog = null, toc = null, active = null, operation = 0, searchOperation = 0;
let route = '', lastCheck = 0, autoTimer = null, manualWins = false;
let lifecycle = 0, checking = null, autoBusy = false;
let bootstrapFailure = null;
let getDocument = options => manualRequest('document', {}, options);
let pendingDeepLink = typeof window !== 'undefined' ? parseManualHref(window.location.pathname + window.location.search) : null;
let hooks = false;
let printCleanup = null;
const competingDialog = () => document.querySelector('[role="dialog"],[role="alertdialog"],dialog[open],#gc-app-backdrop,#gc-iframe,#gc-vs,#gc-img,#gc-tr');
const authRoute = () => /^\/(login|register|forgot-password|reset-password|verify|oauth)(\/|$)/.test(window.location.pathname);
function clearPrint() { printCleanup?.(); printCleanup = null; document.getElementById('gc-manual-print')?.remove(); }

export function isManualEnabled() { return authenticated && config.enabled === true; }
export async function fetchHelpContent() { // compatibility: metadata only, never legacy assets
  try { const value = await manualRequest('config'); return value.enabled ? value : null; } catch { return null; }
}

function updateEntrypoints() {
  syncManualEntrypoints({ enabled: isManualEnabled(), open: target => openManual(target), getDocument, onError: () => {} });
  for (const entry of document.querySelectorAll('[data-gc-manual-entry]')) entry.hidden = !isManualEnabled();
  window.dispatchEvent(new CustomEvent('govchat:manual-config', { detail: { enabled: isManualEnabled() } }));
}

export async function initializeManual({ auto = true } = {}) {
  loadManualStyles();
  if (!hooks) {
    hooks = true;
    document.addEventListener('click', citationClick, true);
    window.addEventListener('focus', () => { if (authenticated) recheckManual(true, true); });
    window.addEventListener('popstate', () => manualRouteCheck());
  }
  if (!booting) {
    const generation = lifecycle;
    booting = (async () => {
    try {
      // Verify both identity and config after the standard shared refresh flow.
      const id = await manualAuthBootstrap();
      const scope = await preferenceScope(id, window.location.origin);
      if (generation !== lifecycle) return config;
      let local, session;
      try { local = window.localStorage; session = window.sessionStorage; } catch { /* disabled storage */ }
      prefs = createManualPreferences(scope, local, session);
      bootstrapFailure = null;
      authenticated = true;
      await recheckManual(true);
      if (generation !== lifecycle) return config;
      route = window.location.pathname + window.location.search;
      if (pendingDeepLink) {
        const target = pendingDeepLink; pendingDeepLink = null;
        await openManual(target);
      } else if (auto) scheduleManualAuto();
    } catch (error) { if (generation === lifecycle) { bootstrapFailure = error; authenticated = false; config = { enabled: false }; updateEntrypoints(); } }
    return config;
    })().finally(() => { if (generation === lifecycle) booting = null; });
  }
  return booting;
}

export function suspendManual() {
  lifecycle++; checking = null; booting = null; prefs = null; manualWins = false; pendingDeepLink = null;
  bootstrapFailure = null;
  authenticated = false; config = { enabled: false }; clearTimeout(autoTimer);
  toc = null; active = null;
  operation++; closeHelpModal(); cleanupManualEntrypoints(); updateEntrypoints();
}

export async function recheckManual(force = false, refreshContent = false) {
  if (!authenticated) return config;
  if (checking) return checking;
  if (!force && Date.now() - lastCheck < 1500) return config;
  lastCheck = Date.now();
  const generation = lifecycle;
  checking = (async () => {
  try {
    const next = await manualRequest('config');
    if (generation !== lifecycle) return config;
    const changed = next.revision !== config.revision || next.enabled !== config.enabled;
    config = next;
    if (refreshContent) clearPrint();
    updatePreferences();
    // Contextual error indexes are scoped to the latest read lifecycle, never a
    // cross-route cache of formerly permitted articles.
    getDocument = options => manualRequest('document', {}, options);
    // Adapter identity replacement drops only contextual indexes. Keep the
    // native trigger connected so async opening can restore keyboard focus.
    if (changed) {
      clearPrint();
      toc = null; active = null; operation++; searchOperation++;
      if (dialog) { dialog.history = []; dialog.historyIndex = -1; updateHistory(); }
      if (dialog) {
        dialog.nav.replaceChildren(); dialog.article.replaceChildren();
        if (!next.enabled) { dialog.title.textContent = 'Handleiding'; dialog.subtitle.textContent = ''; }
        status(next.enabled ? 'De handleiding is gewijzigd. Kies de actuele inhoudsopgave; de vorige passage is niet meer getoond.' : failureText({ code: 'MANUAL_DISABLED' }));
        if (next.enabled) await loadToc();
      }
    } else if (refreshContent && dialog && next.enabled) {
      const previous = active;
      operation++; searchOperation++; active = null;
      dialog.article.replaceChildren(); dialog.nav.replaceChildren(); status('Actuele toegang controleren…');
      await loadToc();
      if (dialog && generation === lifecycle) {
        const ids = new Set(toc.sections.flatMap(section => [section, ...section.items]).concat(toc.errorCategories.flatMap(category => category.articles)).map(passage => passage.id));
        dialog.history = dialog.history.filter(item => ids.has(item.id));
        dialog.historyIndex = Math.min(dialog.historyIndex, dialog.history.length - 1); updateHistory();
        if (previous && ids.has(previous)) await navigate(previous, next.revision, false);
        else status(previous ? 'Dit onderwerp is voor jouw account niet meer zichtbaar. Kies een actueel onderwerp.' : 'Actuele inhoudsopgave geladen.');
      }
    }
  } catch (error) {
    if (error?.code === 'CANCELLED') return config;
    if (generation !== lifecycle) return config;
    clearPrint();
    config = { enabled: false }; toc = null; active = null; operation++; searchOperation++;
    cleanupManualEntrypoints();
    if (dialog) { dialog.title.textContent = 'Handleiding'; dialog.subtitle.textContent = ''; dialog.nav.replaceChildren(); dialog.article.replaceChildren(); status(failureText()); }
  }
  updateEntrypoints();
  return config;
  })();
  const pending = checking;
  try { return await pending; } finally { if (checking === pending) checking = null; }
}

// Called from the existing overlay route loop: DOM sync is idempotent, network
// rechecks only on actual route transitions, focus and explicit opening.
export function manualRouteCheck() {
  if (!authenticated) return;
  const next = window.location.pathname + window.location.search;
  if (next !== route) {
    route = next;
    const target = parseManualHref(next);
    if (target) openManual(target);
    else recheckManual(false, true);
  }
  syncManualEntrypoints({ enabled: isManualEnabled(), open: target => openManual(target), getDocument, onError: () => {} });
}

export function scheduleManualAuto() {
  clearTimeout(autoTimer);
  if (authRoute() || !isManualEnabled() || manualWins || !prefs?.shouldOpen(config.autoOpen, config.revision)) return;
  autoTimer = setTimeout(() => {
    // Do not wait/poll above someone else's dialog or app. A later manual click
    // remains available; storage denial disables auto across full page routes.
    if (authRoute() || manualWins || dialog || competingDialog()) return;
    if (!autoBusy) openManual({}, { automatic: true });
  }, 350);
}

function citationClick(event) {
  const link = event.target.closest?.('a[href]');
  if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const target = parseManualHref(link.getAttribute('href'));
  if (!target) return;
  event.preventDefault(); event.stopPropagation();
  // Intercepting only compiler-canonical links is not claiming the citation is
  // valid. /get under CURRENT context/revision is the authority before render.
  openManual(target);
}

export function openHelpModal(_legacyData, _legacyOptions) { return openManual(); }

export async function openManual(target = {}, { automatic = false } = {}) {
  const trigger = document.activeElement;
  const focusKind = trigger?.getAttribute?.('data-govchat-manual-owned');
  const focusHost = focusKind ? trigger.parentElement : null;
  const focusReturn = trigger?.hasAttribute?.('data-govchat-manual-menu') ? document.querySelector('[data-testid="nav-user"]') || trigger : trigger;
  if (!automatic) { manualWins = true; prefs?.cancelAuto(); clearTimeout(autoTimer); }
  if (!authenticated) await initializeManual({ auto: false });
  const generation = lifecycle;
  const current = await recheckManual(true);
  if (generation !== lifecycle) return;
  if (automatic && (authRoute() || !current.enabled || !prefs?.shouldOpen(current.autoOpen, current.revision))) return;
  if (automatic) {
    // A public enabled flag alone does not authorize a popup. Preflight the
    // authenticated, filtered TOC before interrupting the user's screen.
    autoBusy = true;
    try {
      const permitted = await manualRequest('toc');
      if (generation !== lifecycle || manualWins || dialog || !isManualEnabled() || !prefs?.shouldOpen(config.autoOpen, config.revision) || permitted.revision !== config.revision ||
           authRoute() || competingDialog()) return;
    } catch { prefs?.cancelAuto(); return; } finally { autoBusy = false; }
  }
  ensureDialog({ focusReturn, focusHost, focusKind });
  const serial = ++operation;
  if (!current.enabled) { dialog.nav.replaceChildren(); dialog.article.replaceChildren(); status(failureText(bootstrapFailure || { code: 'MANUAL_DISABLED' })); return; }
  prefs?.opened(current.revision);
  updatePreferences();
  status('Handleiding laden…');
  try {
    await loadToc();
    if (!dialog || serial !== operation) return;
    if (target.id) await navigate(target.id, target.revision || current.revision);
    else if (target.toc) { dialog.article.replaceChildren(node('h2', 'Kies een onderwerp')); active = null; status('Actuele inhoudsopgave. Kies een onderwerp.'); }
    else if (!active) {
      if (toc.sections[0]) await navigate(toc.sections[0].id, toc.revision);
      else status('Er zijn geen onderwerpen zichtbaar voor jouw account.');
    } else status('');
  } catch (error) { if (dialog && serial === operation) showFailure(error); }
}

function ensureDialog({ focusReturn = document.activeElement, focusHost = null, focusKind = null } = {}) {
  if (dialog) return;
  const overflow = document.body.style.overflow;
  const backdrop = node('div', null, { id: 'gc-manual-backdrop' });
  const modal = node('section', null, { id: 'gc-manual-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'gc-manual-title', tabindex: '-1' });
  const header = node('header', null, { class: 'gc-manual-header' });
  const title = node('h1', 'Handleiding', { id: 'gc-manual-title' });
  const actions = node('div', null, { class: 'gc-manual-actions' });
  const navToggle = node('button', 'Inhoud', { type: 'button', 'aria-controls': 'gc-manual-nav', 'aria-expanded': 'false', class: 'gc-manual-nav-toggle' });
  const full = node('button', 'Volledig scherm', { type: 'button', 'aria-pressed': 'false', class: 'gc-manual-full-toggle' });
  const print = node('button', 'Print / PDF', { type: 'button' });
  const close = node('button', 'Sluiten', { type: 'button', 'aria-label': 'Handleiding sluiten' });
  actions.append(navToggle, full, print, close); header.append(title, actions);
  const subtitle = node('p', '', { class: 'gc-manual-subtitle' });
  const searchLabel = node('label', 'Zoek in alle zichtbare onderwerpen en fouten', { for: 'gc-manual-search', class: 'gc-manual-search-label' });
  const search = node('input', null, { id: 'gc-manual-search', type: 'search', maxlength: '200', placeholder: 'Zoek een onderwerp, foutcode of melding…', autocomplete: 'off' });
  const message = node('p', '', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', class: 'gc-manual-status' });
  const body = node('div', null, { class: 'gc-manual-body' });
  const nav = node('nav', null, { id: 'gc-manual-nav', 'aria-label': 'Inhoudsopgave handleiding' });
  const article = node('div', null, { class: 'gc-manual-pane', tabindex: '0', 'aria-label': 'Handleidingtekst' });
  const reader = node('div', null, { class: 'gc-manual-reader' });
  const historyBar = node('div', null, { class: 'gc-manual-history', 'aria-label': 'Passagenavigatie' });
  const previous = node('button', '← Vorige', { type: 'button', 'aria-label': 'Vorige handleidingpassage' });
  const next = node('button', 'Volgende →', { type: 'button', 'aria-label': 'Volgende handleidingpassage' });
  historyBar.append(previous, next); reader.append(historyBar, article); body.append(nav, reader);
  const footer = node('footer', null, { class: 'gc-manual-preferences' });
  const optLabel = node('label'); const opt = node('input', null, { type: 'checkbox' });
  optLabel.append(opt, document.createTextNode(' Niet meer automatisch openen'));
  const restore = node('button', 'Opnieuw toestaan', { type: 'button' });
  const prefNote = node('span');
  footer.append(optLabel, restore, prefNote);
  modal.append(header, subtitle, searchLabel, search, message, body, footer); backdrop.append(modal);
  const inert = new Map();
  const makeInert = () => { for (const child of document.body.children) if (child !== backdrop && !inert.has(child)) { inert.set(child, child.inert); child.inert = true; } };
  document.body.append(backdrop); makeInert(); document.body.style.overflow = 'hidden';
  // Narrow observer exists only while modal is open, to inert newly mounted
  // native menus/routes. It does not fetch, scan content or poll activation.
  const observer = new MutationObserver(makeInert); observer.observe(document.body, { childList: true });
  dialog = { backdrop, modal, title, subtitle, nav, article, search, message, footer, opt, optLabel, restore, prefNote, observer, inert, focusReturn, focusHost, focusKind, overflow, previous, next, history: [], historyIndex: -1 };
  previous.addEventListener('click', () => historyNavigate(-1)); next.addEventListener('click', () => historyNavigate(1)); updateHistory();
  const keydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeHelpModal(); }
    if (event.key === 'Tab') {
      const focusable = [...modal.querySelectorAll('button,input,select,textarea,summary,a[href],[tabindex="0"]')].filter(el => !el.disabled && !el.hidden && el.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (!first) { event.preventDefault(); modal.focus(); }
      else if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
  };
  dialog.keydown = keydown; document.addEventListener('keydown', keydown, true);
  dialog.focusin = () => { if (dialog && !modal.contains(document.activeElement)) modal.focus(); };
  document.addEventListener('focusin', dialog.focusin);
  close.addEventListener('click', closeHelpModal);
  backdrop.addEventListener('click', event => { if (event.target === backdrop) closeHelpModal(); });
  full.addEventListener('click', () => { const on = modal.classList.toggle('gc-manual-full'); full.setAttribute('aria-pressed', String(on)); full.textContent = on ? 'Vensterweergave' : 'Volledig scherm'; });
  navToggle.addEventListener('click', () => { const on = modal.classList.toggle('gc-manual-show-nav'); navToggle.setAttribute('aria-expanded', String(on)); });
  print.addEventListener('click', printManual);
  opt.addEventListener('change', () => { prefs?.suppress(opt.checked); updatePreferences(); });
  restore.addEventListener('click', () => { prefs?.restore(); updatePreferences(); status('Voorkeur hersteld. Automatische opening wordt vanaf een volgende sessie opnieuw beoordeeld.'); });
  let timer;
  search.addEventListener('input', () => { clearTimeout(timer); ++searchOperation; timer = setTimeout(() => searchManual(), 250); });
  updatePreferences(); search.focus();
}

function updatePreferences() {
  if (!dialog) return;
  dialog.footer.hidden = !isManualEnabled() || config.autoOpen === 'never';
  dialog.opt.checked = prefs?.optOut === true;
  dialog.optLabel.hidden = dialog.opt.checked;
  dialog.opt.disabled = !prefs?.available;
  dialog.restore.disabled = !prefs?.available;
  dialog.restore.hidden = !prefs?.optOut;
  dialog.prefNote.textContent = !prefs?.available ? 'Browseropslag niet beschikbaar: automatisch openen staat uit.' : dialog.opt.checked ? 'Automatisch openen staat uit.' : '';
  dialog.prefNote.hidden = !!prefs?.available && !dialog.opt.checked;
}

export function closeHelpModal() {
  clearPrint();
  if (!dialog) return;
  const previous = dialog; dialog = null; active = null; ++operation; ++searchOperation;
  previous.observer.disconnect();
  document.removeEventListener('keydown', previous.keydown, true); document.removeEventListener('focusin', previous.focusin);
  previous.backdrop.remove();
  for (const [element, value] of previous.inert) element.inert = value;
  document.body.style.overflow = previous.overflow;
  const restoredTrigger = previous.focusReturn?.isConnected ? previous.focusReturn : previous.focusHost?.isConnected && previous.focusKind ? previous.focusHost.querySelector('[data-govchat-manual-owned]') : null;
  restoredTrigger?.focus({ preventScroll: true });
}

function status(text) { if (dialog) dialog.message.textContent = text; }

async function loadToc() {
  const owner = dialog, serial = operation, generation = lifecycle;
  const current = await manualRequest('toc');
  if (!dialog || dialog !== owner || serial !== operation || generation !== lifecycle) throw new ManualFailure('CANCELLED');
  if (current.revision !== config.revision) throw new ManualFailure('REVISION_CHANGED');
  toc = current;
  dialog.title.textContent = current.title; dialog.subtitle.textContent = [current.subtitle, current.reviewedAt ? `Gecontroleerd: ${current.reviewedAt}` : ''].filter(Boolean).join(' · ');
  renderNav();
}

function passageButton(passage, revision, className = '') {
  const button = node('button', passage.title, { type: 'button', class: className, 'data-manual-id': passage.id });
  button.addEventListener('click', () => navigate(passage.id, revision));
  return button;
}

function renderNav() {
  if (!dialog || !toc) return;
  dialog.nav.replaceChildren();
  const home = node('button', 'Inhoudsopgave', { type: 'button' });
  home.addEventListener('click', () => { dialog.search.value = ''; renderNav(); dialog.article.replaceChildren(node('h2', 'Kies een onderwerp')); active = null; status('Actuele inhoudsopgave.'); });
  dialog.nav.append(home);
  for (const section of toc.sections) {
    const group = node('div', null, { class: 'gc-manual-nav-group' });
    group.append(passageButton(section, toc.revision, 'gc-manual-chapter'));
    for (const item of section.items) group.append(passageButton(item, toc.revision, 'gc-manual-topic'));
    dialog.nav.append(group);
  }
  if (toc.errorCategories.length) dialog.nav.append(node('h2', 'Problemen en foutmeldingen'));
  for (const category of toc.errorCategories) {
    const details = node('details'); details.append(node('summary', `${category.title} (${category.articles.length})`));
    for (const article of category.articles) details.append(passageButton(article, toc.revision, 'gc-manual-topic'));
    dialog.nav.append(details);
  }
}

function updateHistory() {
  if (!dialog) return;
  dialog.previous.disabled = dialog.historyIndex <= 0;
  dialog.next.disabled = dialog.historyIndex >= dialog.history.length - 1;
}

function historyNavigate(delta) {
  const index = dialog.historyIndex + delta;
  const target = dialog.history[index];
  if (!target) return;
  dialog.historyIndex = index; updateHistory();
  navigate(target.id, target.revision, false);
}

async function navigate(id, revision, remember = true) {
  if (!dialog) return;
  const serial = ++operation;
  dialog.article.replaceChildren(); active = null; status('Passage laden…');
  try {
    const result = await manualRequest('get', { id, revision });
    if (!dialog || serial !== operation) return;
    if (result.revision !== revision || !result.passage || result.passage.hiddenReasons) throw new ManualFailure('REVISION_CHANGED');
    active = result.passage.id;
    if (remember && dialog.history[dialog.historyIndex]?.id !== active) {
      dialog.history = dialog.history.slice(0, dialog.historyIndex + 1);
      dialog.history.push({ id: active, revision });
      if (dialog.history.length > 80) dialog.history.shift();
      dialog.historyIndex = dialog.history.length - 1;
    }
    updateHistory();
    const article = articleNode(result.passage);
    article.classList.add('gc-manual-highlight');
    setTimeout(() => article.classList.remove('gc-manual-highlight'), 1600);
    const related = node('div', null, { class: 'gc-manual-related' });
    for (const ref of result.passage.related || []) {
      const target = toc?.sections.flatMap(s => [s, ...s.items]).concat(toc.errorCategories.flatMap(c => c.articles)).find(p => p.id === ref.id);
      if (target) related.append(passageButton(target, revision));
    }
    dialog.article.replaceChildren(article, related); dialog.article.scrollTop = 0;
    for (const button of dialog.nav.querySelectorAll('[data-manual-id]')) { if (button.getAttribute('data-manual-id') === active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); }
    dialog.modal.classList.remove('gc-manual-show-nav');
    dialog.modal.querySelector('.gc-manual-nav-toggle').setAttribute('aria-expanded', 'false');
    dialog.article.focus(); status(`Geopend: ${result.passage.title}`);
  } catch (error) { if (serial === operation) showFailure(error); }
}

function showFailure(error) {
  if (!dialog || error?.code === 'CANCELLED') return;
  if (['UNAUTHORIZED', 'MANUAL_DISABLED', 'MANUAL_UNAVAILABLE'].includes(error?.code)) {
    toc = null; dialog.nav.replaceChildren(); dialog.title.textContent = 'Handleiding'; dialog.subtitle.textContent = '';
    dialog.history = []; dialog.historyIndex = -1; updateHistory();
    clearPrint(); cleanupManualEntrypoints();
    if (error.code === 'UNAUTHORIZED') { authenticated = false; config = { enabled: false }; prefs = null; updateEntrypoints(); }
    else if (error.code === 'MANUAL_DISABLED') { config = { enabled: false }; updateEntrypoints(); }
  }
  active = null; dialog.article.replaceChildren(node('h2', 'Passage niet beschikbaar'), node('p', failureText(error)));
  status(failureText(error));
  const retry = node('button', 'Actuele inhoudsopgave laden', { type: 'button' });
  retry.addEventListener('click', async () => { await recheckManual(true); if (isManualEnabled()) { try { await loadToc(); dialog?.article.replaceChildren(node('h2', 'Kies een actueel onderwerp')); status('Actuele inhoudsopgave geladen. Het oude citaat is niet opnieuw geopend.'); } catch (err) { status(failureText(err)); } } });
  dialog.article.append(retry);
}

async function searchManual() {
  if (!dialog) return;
  const query = dialog.search.value.trim(); const serial = ++searchOperation;
  if (!query) { renderNav(); status('Inhoudsopgave geladen.'); return; }
  status('Zoeken…');
  try {
    const result = await manualRequest('search', { query, limit: 50, revision: toc?.revision || config.revision });
    if (!dialog || serial !== searchOperation) return;
    if (result.revision !== config.revision) throw new ManualFailure('REVISION_CHANGED');
    dialog.nav.replaceChildren(node('h2', 'Zoekresultaten'));
    dialog.modal.classList.add('gc-manual-show-nav');
    dialog.modal.querySelector('.gc-manual-nav-toggle').setAttribute('aria-expanded', 'true');
    for (const item of result.results) {
      const button = passageButton(item, result.revision, 'gc-manual-result');
      button.append(node('span', item.snippet, { class: 'gc-manual-snippet' })); dialog.nav.append(button);
    }
    if (!result.results.length) dialog.nav.append(node('p', 'Geen resultaten. Probeer een andere term of een exacte foutcode.'));
    status(`${result.total} resultaten${result.total > 50 ? '; de eerste 50 worden getoond. Verfijn je zoekterm.' : '.'}`);
  } catch (error) { if (serial === searchOperation) showFailure(error); }
}

async function printManual() {
  const owner = dialog, generation = lifecycle;
  clearPrint();
  status('Alle toegestane inhoud voor print laden…');
  try {
    await recheckManual(true);
    if (!isManualEnabled()) throw new ManualFailure('MANUAL_DISABLED');
    const serial = operation;
    const result = await manualRequest('document');
    if (dialog !== owner || generation !== lifecycle || serial !== operation) return;
    if (!dialog || result.revision !== config.revision || !result.enabled) throw new ManualFailure('REVISION_CHANGED');
    clearPrint();
    const print = node('section', null, { id: 'gc-manual-print' });
    print.append(node('h1', result.title), node('p', result.subtitle), node('p', `Handleidingrevisie: ${result.revision}`));
    // Group by the authenticated compiled document, never private defaults.
    const passages = new Map(result.passages.filter(passage => !passage.hiddenReasons).map(passage => [passage.id, passage]));
    for (const section of result.sections) for (const item of [section, ...section.items]) {
      if (passages.has(item.id)) print.append(articleNode(passages.get(item.id), item.id === section.id ? 'h2' : 'h3'));
    }
    if (result.errorCategories.length) print.append(node('h2', 'Problemen en foutmeldingen'));
    for (const category of result.errorCategories) {
      print.append(node('h3', category.title));
      for (const article of category.articles) if (passages.has(article.id)) print.append(articleNode(passages.get(article.id), 'h4'));
    }
    document.body.append(print); print.inert = false;
    const cleanup = () => { print.remove(); window.removeEventListener('afterprint', cleanup); if (printCleanup === cleanup) printCleanup = null; };
    printCleanup = cleanup;
    window.addEventListener('afterprint', cleanup);
    window.print(); status('Printweergave bevat alle zichtbare hoofdstukken, onderwerpen en foutartikelen.');
  } catch (error) { if (dialog === owner && generation === lifecycle) showFailure(error); }
}
