// Start script of the Beleidskompas page (/beleidskompas/): checks the
// login, picks up LibreChat's theme and the published configuration, and
// opens the Beleidskompas screen in the empty page.

import { getLibreChatAuthToken } from "../../shared/librechat-api.js";
import { fetchHelpContent } from "../../shared/help.js";
import { applyLibreChatTheme } from "../../shared/theme.js";
import { openBeleidskompas } from "./beleidskompas.js";

const APPS_URL = "/govchat-overlay/apps.json";
const FLOW_CONFIG_URL = "/govchat-overlay/beleidskompas-config.json";
const HELP_CONTENT_URL = "/govchat-overlay/help-content.json";
const CHAT_URL = "/c/new";
// LibreChat only knows its own routes after login, so the way back here goes
// through the chat, where the overlay sees ?app=beleidskompas and forwards.
const LOGIN_URL = "/login?redirect_to=" + encodeURIComponent("/c/new?app=beleidskompas");
// Same key as the overlay, so "don't show again" means the same everywhere.
const HELP_STORAGE_KEY = "govchat_help_dont_show";

applyLibreChatTheme();
start();

async function start() {
  try {
    await getLibreChatAuthToken(true);
  } catch {
    window.location.replace(LOGIN_URL);
    return;
  }

  const [apps, flowConfig, helpData, librechatConfig] = await Promise.all([
    fetchJson(APPS_URL),
    fetchJson(FLOW_CONFIG_URL),
    fetchHelpContent(HELP_CONTENT_URL),
    fetchJson("/api/config"),
  ]);
  const app = (apps?.apps || []).find((a) => a && a.id === "beleidskompas") || { id: "beleidskompas" };
  const appName = String(librechatConfig?.appTitle || document.title);

  openBeleidskompas(app, {
    flowConfig,
    backUrl: CHAT_URL,
    help: { data: helpData, appName, storageKey: HELP_STORAGE_KEY },
  });
}

async function fetchJson(url) {
  try {
    const resp = await fetch(url, { cache: "no-store" });
    return resp.ok ? await resp.json() : null;
  } catch {
    return null;
  }
}
