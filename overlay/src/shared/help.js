// The help modal ("Handleiding"): the text comes from help-content.json,
// which administrators edit in GovChat Admin.

import { escapeHTML } from "./html.js";

// Loads the help text; when that fails, a short message takes its place so
// the modal still opens.
export async function fetchHelpContent(url) {
  try {
    const resp = await fetch(url, { cache: "no-store" });
    return resp.ok ? await resp.json() : getFallbackHelp();
  } catch {
    return getFallbackHelp();
  }
}

function getFallbackHelp() {
  return {
    title: "Handleiding",
    subtitle: "Welkom",
    sections: [
      {
        id: "intro",
        emoji: "📘",
        title: "Welkom",
        content: "<p>Help-content kon niet geladen worden.</p>",
      },
    ],
  };
}

// Fills in the {{APP_NAME}} placeholder that the help text may contain.
function fillAppName(text, appName) {
  return (text || "").replace(/\{\{APP_NAME\}\}/g, appName);
}

export function openHelpModal(helpData, { appName, storageKey }) {
  if (!helpData || document.getElementById("gc-help-backdrop")) return;

  const backdrop = document.createElement("div");
  backdrop.id = "gc-help-backdrop";
  backdrop.innerHTML = `
    <div id="gc-help-modal">
      <div class="gc-modal-head">
        <h2>${escapeHTML(fillAppName(helpData.title || "Handleiding", appName))}</h2>
        <button id="gc-help-close">✕</button>
      </div>
      <div class="gc-modal-sub">${escapeHTML(fillAppName(helpData.subtitle || "", appName))}</div>
      <div class="gc-help-content">
        ${(helpData.sections || [])
          .map(
            (s) =>
              `<section><h3>${escapeHTML(s.emoji || "")} ${escapeHTML(fillAppName(s.title || "", appName))}</h3>${fillAppName(s.content || "", appName)}</section>`
          )
          .join("")}
      </div>
      <label class="gc-dont-show"><input id="gc-help-dont-show" type="checkbox"/> Niet meer automatisch tonen</label>
    </div>`;

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeHelpModal();
  });
  document.body.appendChild(backdrop);
  document.body.style.overflow = "hidden";

  const closeBtn = document.getElementById("gc-help-close");
  if (closeBtn) closeBtn.addEventListener("click", closeHelpModal);

  const checkbox = document.getElementById("gc-help-dont-show");
  if (checkbox) {
    checkbox.checked = localStorage.getItem(storageKey) === "1";
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) localStorage.setItem(storageKey, "1");
      else localStorage.removeItem(storageKey);
    });
  }
}

export function closeHelpModal() {
  const el = document.getElementById("gc-help-backdrop");
  if (el) el.remove();
  document.body.style.overflow = "";
}
