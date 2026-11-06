/** Chat accuracy disclaimer, independent of the optional help/app overlay. */
(function () {
  "use strict";

  const CONFIG = {
    uiConfigUrl: "/govchat-overlay/ui-config.json",
    appName: window.GOVCHAT_BRANDING?.appName || document.title || "GovChat-NL",
  };
  let showChatDisclaimer = true;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  function init() {
    for (const name of ["pushState", "replaceState"]) {
      const original = history[name];
      history[name] = function () {
        original.apply(this, arguments);
        applyFooterBranding();
      };
    }
    window.addEventListener("popstate", applyFooterBranding);
    window.addEventListener("hashchange", applyFooterBranding);
    setInterval(applyFooterBranding, 1000);
    setInterval(() => {
      if (isMainAppRoute(window.location.pathname)) loadUIConfig();
    }, 30000);
    applyFooterBranding();
    loadUIConfig();
  }

  function isMainAppRoute(pathname) {
    const path = (pathname || "").toLowerCase();
    return path === "/c" || path.startsWith("/c/");
  }

  async function loadUIConfig() {
    try {
      const response = await fetch(CONFIG.uiConfigUrl, { cache: "no-store" });
      if (!response.ok) return;
      const config = await response.json();
      showChatDisclaimer = config?.showChatDisclaimer !== false;
      applyFooterBranding();
    } catch {
      // Keep the default (enabled), or the last successfully loaded setting.
    }
  }

  function applyFooterBranding() {
    if (!isMainAppRoute(window.location.pathname)) return;
    // Re-find the upstream footer after React remounts, or our marked span
    // after replacement. Never modify other contentinfo regions.
    const span = document.querySelector('div[role="contentinfo"] span[data-govchat-disclaimer]') ||
      document.querySelector('div[role="contentinfo"] span > a[href*="librechat.ai"]')?.closest("span") ||
      document.querySelector('div[role="contentinfo"] span > a[data-govchat-brand="1"]')?.closest("span");
    if (!span) return;
    if (!span.hasAttribute("data-govchat-disclaimer")) {
      span.setAttribute("data-govchat-disclaimer", "1");
    }
    const appName = window.GOVCHAT_BRANDING?.appName || CONFIG.appName;
    const text = `${appName} kan fouten maken. Controleer belangrijke informatie.`;
    if (span.textContent !== text) span.textContent = text;
    if (span.hidden !== !showChatDisclaimer) span.hidden = !showChatDisclaimer;
  }
})();
