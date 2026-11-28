// The Beleidskompas page (/beleidskompas/): checks the login, picks up
// LibreChat's theme and the published configuration, and builds the screen
// from the store and the panels.

import { getLibreChatAuthToken } from "../../shared/librechat-api.js";
import { initializeManual, openHelpModal, scheduleManualAuto } from "../../shared/help.js";
import { applyLibreChatTheme } from "../../shared/theme.js";
import { requireElement } from "../../shared/dom.js";
import { buildConfig } from "./config.js";
import { createStore } from "./store.js";
import { setupCases } from "./panels/cases.js";
import { setupChat } from "./panels/chat.js";
import { setupStepper } from "./panels/stepper.js";
import { setupStepCard } from "./panels/step-card.js";
import { setupOverview } from "./panels/overview.js";

const APPS_URL = "/govchat-overlay/apps.json";
const FLOW_CONFIG_URL = "/govchat-overlay/beleidskompas-config.json";
const CHAT_URL = "/c/new";
// LibreChat only knows its own routes after login, so the way back here goes
// through the chat, where the overlay sees ?app=beleidskompas and forwards.
const LOGIN_URL = "/login?redirect_to=" + encodeURIComponent("/c/new?app=beleidskompas");

applyLibreChatTheme();
start();

async function start() {
  try {
    await getLibreChatAuthToken(true);
  } catch {
    window.location.replace(LOGIN_URL);
    return;
  }

  const [apps, flowConfig] = await Promise.all([
    fetchJson(APPS_URL),
    fetchJson(FLOW_CONFIG_URL),
  ]);
  const app = (apps?.apps || []).find((a) => a && a.id === "beleidskompas") || { id: "beleidskompas" };

  const helpData = await initializeManual({ auto: false });
  openBeleidskompas(buildConfig(app, flowConfig), { data: helpData.enabled ? helpData : null });
  scheduleManualAuto();
}

// Metadata gates the entry; the shared modal fetches permitted content itself.
function openBeleidskompas(config, help) {
  const store = createStore(config.steps);

  const container = requireElement("gc-bk");
  const titleEl = requireElement("gc-bk-title");
  const disclaimerEl = requireElement("gc-bk-disclaimer");
  if (config.title) titleEl.textContent = config.title;
  if (config.disclaimer) disclaimerEl.textContent = config.disclaimer;

  requireElement("gc-bk-back").addEventListener("click", () => {
    window.location.href = CHAT_URL;
  });
  // The manual (with the Beleidskompas chapter) can be opened from this page
  // too; the overlay's floating help button is not shown here.
  const helpButton = requireElement("gc-bk-help");
  helpButton.setAttribute("data-gc-manual-entry", "");
  helpButton.hidden = !help.data;
  helpButton.addEventListener("click", () => openHelpModal());

  const { resumeConversation } = setupCases(store);
  setupChat(store, { sources: config.sources });
  setupStepper(store);
  setupStepCard(store, { specialistTeam: config.specialistTeam });
  const { setView } = setupOverview(store);

  store.changed("chat", "steps", "conversation");
  // A new session starts on the overview; a resumed case opens straight in
  // the workspace, so you continue where you left off.
  setView(store.state.conversationId ? "workspace" : "overview");
  container.hidden = false;

  if (store.state.conversationId) {
    resumeConversation(store.state.conversationId).catch((err) => {
      // The stored case is gone or inaccessible (deleted, session expired):
      // forget it, so the next message does not fail on it again.
      store.setConversationId(null);
      store.addMessage("assistant", `Kon vorige casus niet laden (${String(err?.message || err)}). Start een nieuwe chat.`);
    });
  }
}

async function fetchJson(url) {
  try {
    const resp = await fetch(url, { cache: "no-store" });
    return resp.ok ? await resp.json() : null;
  } catch {
    return null;
  }
}
