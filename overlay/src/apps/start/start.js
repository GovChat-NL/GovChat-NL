// Start script of the start page (/start/): a choice between the apps
// listed in apps.json under "landing", each a link to a page of its own.
// The overlay sends users here after they log in.

import { escapeHTML, escapeAttr } from "../../shared/html.js";
import { getLibreChatAuthToken } from "../../shared/librechat-api.js";
import { fetchHelpContent, openHelpModal } from "../../shared/help.js";
import { applyLibreChatTheme } from "../../shared/theme.js";

const APPS_URL = "/govchat-overlay/apps.json";
const HELP_CONTENT_URL = "/govchat-overlay/help-content.json";
const CHAT_URL = "/c/new";
// After a login LibreChat can only redirect to its own routes, so the way
// back to this page goes through the chat, which the overlay forwards here.
const LOGIN_URL = "/login?redirect_to=" + encodeURIComponent("/c/new?app=start");
// Same keys as the overlay: "don't show again" for the manual, and the app
// the overlay opens after a login (see rememberRequestedScreen there).
const HELP_STORAGE_KEY = "govchat_help_dont_show";
const REQUESTED_SCREEN_KEY = "gc_requested_screen";

applyLibreChatTheme();
start();

async function start() {
  const [loggedIn, apps, helpData, librechatConfig] = await Promise.all([
    getLibreChatAuthToken(true).then(
      () => true,
      () => false,
    ),
    fetchJson(APPS_URL),
    fetchHelpContent(HELP_CONTENT_URL),
    fetchJson("/api/config"),
  ]);
  if (!loggedIn) {
    window.location.replace(LOGIN_URL);
    return;
  }
  const cfg = (apps && apps.landing) || {};
  const all = Array.isArray(apps?.apps) ? apps.apps : [];
  const ids = Array.isArray(cfg.apps) ? cfg.apps : [];
  // The apps on the start page, in the order of "landing".apps. Only links
  // to pages; the small apps that open as a window belong in the launcher.
  const tiles = ids
    .map((id) => all.find((a) => a && a.id === id))
    .filter((a) => a && a.target === "navigate" && a.url);
  const appName = String(librechatConfig?.appTitle || document.title);

  // After a login the overlay passes along the conversation the user was in
  // (?chat=/c/<id>), so the chat tile takes them back into it.
  const chat = new URLSearchParams(window.location.search).get("chat");
  const chatUrl = isChatUrl(chat) ? chat : CHAT_URL;

  // When the start page is switched off, anyone who opens /start/ (from a
  // bookmark or by typing it) is redirected to the chat and does not see
  // the start page.
  if (!apps?.landing || cfg.enabled === false || ids.length === 0 || tiles.length === 0) {
    window.location.replace(chatUrl);
    return;
  }

  render(cfg, tiles, chatUrl, helpData, appName);
}

function isChatUrl(url) {
  try {
    const parsed = new URL(url || "", window.location.origin);
    return parsed.origin === window.location.origin && /^\/c(\/|$)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function render(cfg, tiles, chatUrl, helpData, appName) {
  const cards = tiles
    .map((app) => {
      const href = isChatUrl(app.url) ? chatUrl : app.url;
      return `
      <a class="gc-landing-card" data-id="${escapeAttr(app.id)}" href="${escapeAttr(href)}">
        <span class="gc-landing-icon" aria-hidden="true">${escapeHTML(app.icon || "📦")}</span>
        <span class="gc-landing-name">${escapeHTML(app.name || "App")}</span>
        <span class="gc-landing-desc">${escapeHTML(app.description || "")}</span>
        <span class="gc-landing-open" aria-hidden="true">Openen →</span>
      </a>`;
    })
    .join("");

  document.body.innerHTML = `
    <main id="gc-landing">
      <div class="gc-landing-inner">
        <h1 id="gc-landing-title">${escapeHTML(cfg.title || "Welkom")}</h1>
        ${cfg.subtitle ? `<p class="gc-landing-subtitle">${escapeHTML(cfg.subtitle)}</p>` : ""}
        <div class="gc-landing-grid">${cards}</div>
        ${helpData ? `<p class="gc-landing-help">Twijfel je wat je nodig hebt? <button type="button" id="gc-landing-help-btn">Bekijk de handleiding</button></p>` : ""}
      </div>
    </main>`;

  // The chat tile may lead to the login page first. LibreChat then lands on
  // the chat and the overlay would send the user back here; remembering the
  // choice makes the overlay leave them in the chat instead.
  document.querySelectorAll(".gc-landing-card").forEach((card) => {
    if (!isChatUrl(card.getAttribute("href"))) return;
    card.addEventListener("click", () => {
      try {
        sessionStorage.setItem(REQUESTED_SCREEN_KEY, card.getAttribute("data-id"));
      } catch {
        // Without storage the user simply sees the start page once more.
      }
    });
  });

  document.getElementById("gc-landing-help-btn")?.addEventListener("click", () => {
    openHelpModal(helpData, { appName, storageKey: HELP_STORAGE_KEY });
  });

  const first = document.querySelector(".gc-landing-card");
  if (first) first.focus();
}

async function fetchJson(url) {
  try {
    const resp = await fetch(url, { cache: "no-store" });
    return resp.ok ? await resp.json() : null;
  } catch {
    return null;
  }
}
