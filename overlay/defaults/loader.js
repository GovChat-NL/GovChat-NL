/**
 * GovChat overlay loader for LibreChat (no fork)
 * Served via /govchat-overlay/loader.js by nginx reverse proxy.
 */
(function () {
  "use strict";

  const CONFIG = {
    helpContentUrl: "/govchat-overlay/help-content.json",
    appsUrl: "/govchat-overlay/apps.json",
    beleidskompasConfigUrl: "/govchat-overlay/beleidskompas-config.json",
    appName: window.GOVCHAT_BRANDING?.appName || document.title || "GovChat-NL",
    storageKey: "govchat_help_dont_show",
    footerBrandText: window.GOVCHAT_BRANDING?.appName || "GovChat-NL v0.0.1",
    footerBrandUrl: "https://govchat-nl.github.io/",
    helpFaqUrl: "https://govchat-nl.github.io/",
  };

  let helpData = null;
  let appsData = null;
  let beleidskompasFlowConfig = null;
  let overlayActive = false;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  function init() {
    observeRouteChanges();

    refreshOverlayState();
  }

  function isAuthRoute(pathname) {
    const p = (pathname || "").toLowerCase();
    return (
      p.includes("/login") ||
      p.includes("/register") ||
      p.includes("/forgot") ||
      p.includes("/reset") ||
      p.includes("/verify")
    );
  }

  function isMainAppRoute(pathname) {
    const p = (pathname || "").toLowerCase();
    // LibreChat hoofdscherm (gesprekken) draait standaard onder /c/*
    return p === "/c" || p.startsWith("/c/");
  }

  function shouldActivateOverlay() {
    const path = window.location.pathname;
    if (isAuthRoute(path)) return false;
    if (!isMainAppRoute(path)) return false;
    if (isLoginScreenVisible()) return false;
    if (!hasLoggedInUIMarkers()) return false;
    return true;
  }

  function refreshOverlayState() {
    applyFooterBranding();
    rewriteHelpFaqMenuLink();

    const shouldBeActive = shouldActivateOverlay();
    if (shouldBeActive && !overlayActive) {
      overlayActive = true;
      createButtons();
      Promise.all([loadHelpContent(), loadAppsConfig()]).catch(() => {
        // no-op
      });
      return;
    }
    if (!shouldBeActive && overlayActive) {
      overlayActive = false;
      removeButtonsAndModals();
    }
  }

  function rewriteHelpFaqMenuLink() {
    const targetUrl = CONFIG.helpFaqUrl;

    const normalize = (s) =>
      (s || "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();

    // Strictly target only the "Help & FAQ" item.
    document.querySelectorAll("a, button, [role='menuitem']").forEach((el) => {
      const label = normalize(el.textContent);
      if (label !== "help & faq") return;

      if (el.tagName === "A") {
        el.setAttribute("href", targetUrl);
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      }

      if (el.getAttribute("data-govchat-helpfaq") === "1") return;
      el.setAttribute("data-govchat-helpfaq", "1");
      el.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.open(targetUrl, "_blank", "noopener,noreferrer");
      });
    });
  }

  function applyFooterBranding() {
    if (!isMainAppRoute(window.location.pathname)) return;

    // Exact target as shared by user:
    // <div role="contentinfo"><span><a href="https://librechat.ai">LibreChat</a> ...</span></div>
    const libreChatLink = document.querySelector('div[role="contentinfo"] span > a[href*="librechat.ai"]');
    if (!libreChatLink) return;

    const span = libreChatLink.closest("span");
    if (!span) return;

    if (span.querySelector("a[data-govchat-brand='1']")) return;

    span.innerHTML = `<a data-govchat-brand="1" class="gc-footer-brand" href="${escapeAttr(
      CONFIG.footerBrandUrl
    )}" target="_blank" rel="noopener noreferrer">${escapeHTML(CONFIG.footerBrandText)}</a>`;
  }

  function isLoginScreenVisible() {
    // Hard gate: zolang een zichtbaar wachtwoordveld aanwezig is, nooit overlay tonen.
    const passwordInput = document.querySelector('input[type="password"]');
    if (passwordInput && isVisible(passwordInput)) return true;

    const emailInput = document.querySelector('input[type="email"]');
    if (emailInput && isVisible(emailInput)) {
      const submitBtn = document.querySelector('button[type="submit"], input[type="submit"]');
      if (submitBtn && isVisible(submitBtn)) return true;
    }

    return false;
  }

  function hasLoggedInUIMarkers() {
    return Boolean(
      // Betrouwbaarste marker: user menu rechtsboven na succesvolle login.
      document.querySelector('button[aria-label="User Menu"]') ||
        document.querySelector('button[aria-haspopup="menu"] img')?.closest("button")
    );
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function observeRouteChanges() {
    const _pushState = history.pushState;
    const _replaceState = history.replaceState;

    history.pushState = function () {
      _pushState.apply(this, arguments);
      refreshOverlayState();
    };
    history.replaceState = function () {
      _replaceState.apply(this, arguments);
      refreshOverlayState();
    };

    window.addEventListener("popstate", refreshOverlayState);
    window.addEventListener("hashchange", refreshOverlayState);

    setInterval(refreshOverlayState, 1000);
  }

  function removeButtonsAndModals() {
    [
      "gc-help-btn",
      "gc-launcher-btn",
      "gc-help-backdrop",
      "gc-app-backdrop",
      "gc-iframe",
      "gc-bk",
      "gc-vs",
    ].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });
    document.body.style.overflow = "";
  }

  function createButtons() {
    if (!document.getElementById("gc-help-btn")) {
      const helpBtn = document.createElement("button");
      helpBtn.id = "gc-help-btn";
      helpBtn.title = "Help";
      helpBtn.textContent = "?";
      helpBtn.addEventListener("click", openHelpModal);
      document.body.appendChild(helpBtn);
    }

    if (!document.getElementById("gc-launcher-btn")) {
      const launcherBtn = document.createElement("button");
      launcherBtn.id = "gc-launcher-btn";
      launcherBtn.title = "App Launcher";
      launcherBtn.innerHTML = `
        <svg class="gc-launcher-grid-icon" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <rect x="3" y="3" width="4" height="4" rx="0.8"></rect>
          <rect x="10" y="3" width="4" height="4" rx="0.8"></rect>
          <rect x="17" y="3" width="4" height="4" rx="0.8"></rect>
          <rect x="3" y="10" width="4" height="4" rx="0.8"></rect>
          <rect x="10" y="10" width="4" height="4" rx="0.8"></rect>
          <rect x="17" y="10" width="4" height="4" rx="0.8"></rect>
          <rect x="3" y="17" width="4" height="4" rx="0.8"></rect>
          <rect x="10" y="17" width="4" height="4" rx="0.8"></rect>
          <rect x="17" y="17" width="4" height="4" rx="0.8"></rect>
        </svg>`;
      launcherBtn.addEventListener("click", openAppLauncher);
      document.body.appendChild(launcherBtn);
    }
  }

  async function loadHelpContent() {
    try {
      const resp = await fetch(CONFIG.helpContentUrl, { cache: "no-store" });
      helpData = resp.ok ? await resp.json() : getFallbackHelp();
    } catch {
      helpData = getFallbackHelp();
    }

    const dontShow = localStorage.getItem(CONFIG.storageKey) === "1";
    if (!dontShow) {
      setTimeout(() => {
        if (overlayActive) {
          openHelpModal();
        }
      }, 250);
    }
  }

  async function loadAppsConfig() {
    try {
      const resp = await fetch(CONFIG.appsUrl, { cache: "no-store" });
      appsData = resp.ok ? await resp.json() : { title: "App Launcher", enabled: false, apps: [] };
    } catch {
      appsData = { title: "App Launcher", enabled: false, apps: [] };
    }

    if (appsData.enabled === false) {
      const btn = document.getElementById("gc-launcher-btn");
      if (btn) btn.style.display = "none";
    }

    try {
      const resp = await fetch(CONFIG.beleidskompasConfigUrl, { cache: "no-store" });
      if (resp.ok) {
        const raw = await resp.json();
        beleidskompasFlowConfig = raw && typeof raw === "object" ? raw : null;
      } else {
        beleidskompasFlowConfig = null;
      }
    } catch {
      beleidskompasFlowConfig = null;
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

  function r(text) {
    return (text || "").replace(/\{\{APP_NAME\}\}/g, CONFIG.appName);
  }

  function openHelpModal() {
    if (!helpData || document.getElementById("gc-help-backdrop")) return;

    const backdrop = document.createElement("div");
    backdrop.id = "gc-help-backdrop";
    backdrop.innerHTML = `
      <div id="gc-help-modal">
        <div class="gc-modal-head">
          <h2>${escapeHTML(r(helpData.title || "Handleiding"))}</h2>
          <button id="gc-help-close">✕</button>
        </div>
        <div class="gc-modal-sub">${escapeHTML(r(helpData.subtitle || ""))}</div>
        <div class="gc-help-content">
          ${(helpData.sections || [])
            .map(
              (s) =>
                `<section><h3>${escapeHTML(s.emoji || "")} ${escapeHTML(r(s.title || ""))}</h3>${r(s.content || "")}</section>`
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
      checkbox.checked = localStorage.getItem(CONFIG.storageKey) === "1";
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) localStorage.setItem(CONFIG.storageKey, "1");
        else localStorage.removeItem(CONFIG.storageKey);
      });
    }
  }

  function closeHelpModal() {
    const el = document.getElementById("gc-help-backdrop");
    if (el) el.remove();
    document.body.style.overflow = "";
  }

  function openAppLauncher() {
    if (!appsData || !appsData.apps || document.getElementById("gc-app-backdrop")) return;

    const cards = appsData.apps
      .map(
        (app) => `
      <button class="gc-app-card" data-id="${escapeAttr(app.id)}" data-url="${escapeAttr(app.url)}" data-target="${escapeAttr(app.target || "blank")}">
        <span class="gc-app-icon">${escapeHTML(app.icon || "📦")}</span>
        <span class="gc-app-meta">
          <span class="gc-app-name">${escapeHTML(app.name || "App")}</span>
          <span class="gc-app-desc">${escapeHTML(app.description || "")}</span>
        </span>
      </button>`
      )
      .join("");

    const backdrop = document.createElement("div");
    backdrop.id = "gc-app-backdrop";
    backdrop.innerHTML = `
      <div id="gc-app-modal">
        <div class="gc-modal-head">
          <h2>${escapeHTML(appsData.title || "App Launcher")}</h2>
          <button id="gc-app-close">✕</button>
        </div>
        <div class="gc-app-grid">${cards}</div>
      </div>`;

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeAppLauncher();
    });
    document.body.appendChild(backdrop);
    document.body.style.overflow = "hidden";

    const closeBtn = document.getElementById("gc-app-close");
    if (closeBtn) closeBtn.addEventListener("click", closeAppLauncher);

    backdrop.querySelectorAll(".gc-app-card").forEach((card) => {
      card.addEventListener("click", () => {
        const id = card.getAttribute("data-id");
        const url = card.getAttribute("data-url");
        const target = card.getAttribute("data-target");
        const app = (appsData.apps || []).find((a) => a.id === id) || { url, target };
        closeAppLauncher();

        if (target === "versimpelaar") {
          openVersimpelaar(app);
        } else if (target === "beleidskompas") {
          openBeleidskompas(app);
        } else if (target === "imagegen") {
          openImageGenerator(app);
        } else if (target === "transcriptie") {
          openTranscription(app);
        } else if (target === "navigate") {
          window.location.href = url;
        } else if (target === "iframe") {
          openIframe(url, app.name || "App");
        } else {
          window.open(url, "_blank", "noopener,noreferrer");
        }
      });
    });
  }

  function closeAppLauncher() {
    const el = document.getElementById("gc-app-backdrop");
    if (el) el.remove();
    document.body.style.overflow = "";
  }

  function openAppOverviewFromMiniApp(container) {
    if (container) container.remove();
    setTimeout(() => {
      if (overlayActive) openAppLauncher();
    }, 40);
  }

  function openIframe(url, title) {
    if (document.getElementById("gc-iframe")) return;
    const container = document.createElement("div");
    container.id = "gc-iframe";
    container.innerHTML = `
      <div class="gc-iframe-head">
        <div class="gc-mini-head-left">
          <button id="gc-iframe-back" class="gc-mini-nav-btn" type="button">← Overzicht</button>
          <strong>${escapeHTML(title)}</strong>
        </div>
        <button id="gc-iframe-close">✕</button>
      </div>
      <iframe src="${escapeAttr(url)}" title="${escapeAttr(title)}"></iframe>`;
    document.body.appendChild(container);
    document.getElementById("gc-iframe-back")?.addEventListener("click", () => openAppOverviewFromMiniApp(container));
    document.getElementById("gc-iframe-close")?.addEventListener("click", () => container.remove());
  }

  function openBeleidskompas(app) {
    if (document.getElementById("gc-bk")) return;

    const cfg = {
      ...(app?.config && typeof app.config === "object" ? app.config : {}),
      ...(beleidskompasFlowConfig && typeof beleidskompasFlowConfig === "object" ? beleidskompasFlowConfig : {}),
    };
    const orchestratorWebhookPath = String(cfg.orchestrator_webhook_path || "beleidskompas-hoofdagent").trim() || "beleidskompas-hoofdagent";
    const orchestratorWebhookUrl = `${window.location.origin}/n8n/webhook/${orchestratorWebhookPath}`;
    const webhookToken = String(cfg.webhook_token || "").trim();
    const specialistTeam = String(
      cfg.specialist_team ||
        "Schakel bij complexe juridische, financiële of politiek-bestuurlijke casussen een specialistenteam in."
    ).trim();
    const defaultSources = Array.isArray(cfg.sources) && cfg.sources.length
      ? cfg.sources
      : [
          "SiS 4.0 Strategisch kader",
          "SiS 4.0 Uitvoeringskader",
          "Provinciale Instrumentenkoffer",
          "Coalitieakkoord en beleidskaders",
          "Overzicht wettelijke taken Provincie",
        ];

    const fallbackSteps = [
      {
        id: "stap1",
        nr: 1,
        title: "Publiek en provinciaal belang",
        short: "Bepaal probleem, publiek belang en provinciale legitimiteit.",
        info:
          "Toets of het vraagstuk publiek relevant is, binnen provinciale wettelijke taken valt en expliciet past binnen coalitieakkoord en beleidskaders.",
        help: [
          "Welk concreet maatschappelijk probleem wil je oplossen?",
          "Wie ondervindt nadeel als de provincie niet handelt?",
          "Welke wettelijke of bestuurlijke grondslag legitimeert provinciaal handelen?",
        ],
        deep: [
          "Welke groepen hebben conflicterende belangen en waarom?",
          "Welke juridische, financiële en organisatorische randvoorwaarden begrenzen het handelen?",
        ],
      },
      {
        id: "stap2",
        nr: 2,
        title: "Rolbepaling provincie",
        short: "Kies passende rol(len): regulerend, regisserend, stimulerend, faciliterend.",
        info:
          "Onderbouw waarom een rol passend is bij doel, bevoegdheid, bestuurlijke context en uitvoerbaarheid. Combineer rollen alleen als dit uitlegbaar en bestuurbaar is.",
        help: [
          "Welke rol heeft de hoogste effectiviteit gegeven urgentie en mandaat?",
          "Welke rol biedt de beste balans tussen impact, kosten en bestuurlijke haalbaarheid?",
          "Is een rolcombinatie nodig of ontstaat dan juist complexiteit?",
        ],
        deep: [
          "Welke governance-risico’s ontstaan bij deze rolkeuze?",
          "Welke afhankelijkheden met ketenpartners zijn kritiek?",
        ],
      },
      {
        id: "stap3",
        nr: 3,
        title: "Instrumentkeuze",
        short: "Weeg en vergelijk instrumenten met score en argumentatie.",
        info:
          "Gebruik de Provinciale Instrumentenkoffer en beoordeel instrumenten op effectiviteit, uitvoerbaarheid, juridische robuustheid, betaalbaarheid en maatschappelijke impact.",
        help: [
          "Welke instrumenten zijn realistisch beschikbaar binnen planning en capaciteit?",
          "Wat is het voorkeursinstrument en waarom?",
          "Welke twee alternatieven zijn serieus en bestuurlijk verdedigbaar?",
        ],
        deep: [
          "Welke risico’s, neveneffecten en mitigerende maatregelen horen per optie?",
          "Welke bron onderbouwt elke score of aanname?",
        ],
      },
      {
        id: "stap4",
        nr: 4,
        title: "Governance-inrichting",
        short: "Adviseer sturing, toezicht, beheersing en verantwoording.",
        info:
          "Sluit aan op hoofdstuk 10 van SiS 4.0 en het uitvoeringskader: wie stuurt, wie houdt toezicht, welke KPI’s gelden en hoe wordt verantwoord.",
        help: [
          "Welke governance-structuur past bij het gekozen instrument?",
          "Hoe richt je besluitvorming, escalatie en verantwoordingslijnen in?",
          "Welke monitoring/KPI’s zijn nodig voor bestuurlijke bijsturing?",
        ],
        deep: [
          "Welke governance-implicaties gelden voor alternatieve instrumenten?",
          "Welke kwaliteitspoorten en validatiestappen voorkómen ongecontroleerde AI-output?",
        ],
      },
    ];

    const steps = Array.isArray(cfg.steps) && cfg.steps.length
      ? cfg.steps.map((step, idx) => {
          const fb = fallbackSteps[Math.min(idx, fallbackSteps.length - 1)] || fallbackSteps[0];
          const substeps = Array.isArray(step?.substeps) ? step.substeps : [];
          return {
            id: String(step?.id || `stap${idx + 1}`).trim() || `stap${idx + 1}`,
            nr: idx + 1,
            title: String(step?.title || fb.title || `Stap ${idx + 1}`).trim(),
            short: String(step?.description || fb.short || "").trim() || fb.short,
            info: String(step?.prompt || step?.description || fb.info || "").trim() || fb.info,
            help: substeps.length
              ? substeps.map((s) => String(s?.title || "").trim()).filter(Boolean)
              : fb.help,
            deep: substeps.length
              ? substeps
                  .map((s) => String(s?.description || "").trim())
                  .filter(Boolean)
                  .slice(0, 4)
              : fb.deep,
          };
        })
      : fallbackSteps;

    const initialStepState = () => ({
      report_text: "",
      citations: [],
      retrieval_trace: null,
      updated_at: "",
    });

    const state = {
      activeStep: 0,
      messages: [
        {
          role: "assistant",
          text: "Hallo! Ik ben je beleidsassistent. Beschrijf je casus en ik help je stap voor stap.",
          ts: new Date().toISOString(),
          citations: [],
          retrieval_trace: null,
        },
      ],
      steps: {},
    };

    steps.forEach((s) => {
      state.steps[s.id] = initialStepState();
    });

    const groupedSteps = [
      { title: "Stap 1", items: steps.slice(0, 2) },
      { title: "Stap 2", items: steps.slice(2, 4) },
      { title: "Stap 3", items: steps.slice(4) },
    ].filter((g) => g.items.length > 0);

    const container = document.createElement("div");
    container.id = "gc-bk";
    container.innerHTML = `
      <div class="gc-bk-shell">
        <aside class="gc-bk-sidebar">
          <div class="gc-bk-brand">
            <div class="gc-bk-brand-logo">🧭</div>
            <div>
              <div class="gc-bk-brand-title">${escapeHTML(String(cfg.title || "Beleidskompas assistant"))}</div>
              <div class="gc-bk-brand-sub">Provincie assistent</div>
            </div>
          </div>
          <button id="gc-bk-new-chat" class="gc-bk-new-chat" type="button">✎ Nieuwe chat</button>
          <div id="gc-bk-step-groups" class="gc-bk-step-groups"></div>
        </aside>

        <section class="gc-bk-chat">
          <div class="gc-bk-chat-head">
            <div class="gc-mini-head-left">
              <button id="gc-bk-back" class="gc-mini-nav-btn" type="button">← Overzicht</button>
              <strong>Beleidskompas</strong>
            </div>
            <button id="gc-bk-close" class="gc-bk-close" type="button">✕</button>
          </div>
          <div class="gc-bk-chat-note">${escapeHTML(String(cfg.disclaimer || "Ondersteunend hulpmiddel, geen automatische besluitvorming."))}</div>
          <div id="gc-bk-chat-log" class="gc-bk-chat-log"></div>
          <div class="gc-bk-chat-compose">
            <input id="gc-bk-chat-input" type="text" placeholder="Stel een vraag..." />
            <button id="gc-bk-send" type="button">➤</button>
          </div>
        </section>

        <section class="gc-bk-form">
          <div class="gc-bk-form-head">
            <div>
              <h3 id="gc-bk-form-title"></h3>
              <div id="gc-bk-form-short" class="gc-bk-form-short"></div>
            </div>
            <div class="gc-bk-step-nav">
              <button id="gc-bk-prev" type="button">‹</button>
              <button id="gc-bk-next" type="button">›</button>
            </div>
          </div>

          <div id="gc-bk-report-status" class="gc-bk-chat-note"></div>
          <pre id="gc-bk-report-body" class="gc-bk-doc-body">Nog geen tussentijds rapport voor deze stap. Stel links in de chat je vraag om de analyse voor deze stap op te bouwen.</pre>
          <div id="gc-bk-report-meta" class="gc-bk-form-short"></div>
          <div id="gc-bk-report-sources" class="gc-bk-citations"></div>

          <div class="gc-bk-form-actions">
            <button id="gc-bk-save-step" type="button">Markeer stap gereed</button>
            <button id="gc-bk-next-step" type="button">Volgende stap</button>
          </div>
        </section>
      </div>`;

    document.body.appendChild(container);

    const closeBtn = document.getElementById("gc-bk-close");
    const backBtn = document.getElementById("gc-bk-back");
    const newChatBtn = document.getElementById("gc-bk-new-chat");
    const stepGroupsEl = document.getElementById("gc-bk-step-groups");
    const chatLogEl = document.getElementById("gc-bk-chat-log");
    const chatInputEl = document.getElementById("gc-bk-chat-input");
    const sendBtn = document.getElementById("gc-bk-send");
    const formTitleEl = document.getElementById("gc-bk-form-title");
    const formShortEl = document.getElementById("gc-bk-form-short");
    const prevBtn = document.getElementById("gc-bk-prev");
    const nextBtn = document.getElementById("gc-bk-next");
    const saveStepBtn = document.getElementById("gc-bk-save-step");
    const nextStepBtn = document.getElementById("gc-bk-next-step");
    const reportStatusEl = document.getElementById("gc-bk-report-status");
    const reportBodyEl = document.getElementById("gc-bk-report-body");
    const reportMetaEl = document.getElementById("gc-bk-report-meta");
    const reportSourcesEl = document.getElementById("gc-bk-report-sources");

    function normalizeCitations(input) {
      if (!Array.isArray(input)) return [];
      return input
        .map((c, idx) => ({
          rank: Number(c?.rank || idx + 1),
          id: String(c?.id || "").trim(),
          filename: String(c?.filename || `Document ${idx + 1}`).trim() || `Document ${idx + 1}`,
          score: Number(c?.score || 0),
          tags: Array.isArray(c?.tags) ? c.tags.map((t) => String(t || "").trim()).filter(Boolean) : [],
          preview: String(c?.preview || "").trim(),
        }))
        .filter((c) => c.id || c.filename);
    }

    function addMessage(role, text, meta = {}) {
      state.messages.push({
        role,
        text: String(text || "").trim(),
        ts: new Date().toISOString(),
        citations: normalizeCitations(meta?.citations),
        retrieval_trace: meta?.retrieval_trace || null,
      });
      renderChat();
    }

    function formatTime(ts) {
      const d = new Date(ts);
      return d.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
    }

    function citationLabel(citation) {
      const nr = Number(citation?.rank || 0) || 1;
      const score = Number(citation?.score || 0);
      return Number.isFinite(score) && score > 0 ? `#${nr} · score ${score.toFixed(3)}` : `#${nr}`;
    }

    function renderChat() {
      if (!chatLogEl) return;
      chatLogEl.innerHTML = state.messages
        .map(
          (m) => `
            <div class="gc-bk-msg gc-bk-msg-${escapeAttr(m.role)}">
              <div class="gc-bk-msg-text">${escapeHTML(m.text)}</div>
              ${Array.isArray(m.citations) && m.citations.length
                ? `<div class="gc-bk-citations">${m.citations
                    .map(
                      (c) =>
                        `<button type="button" class="gc-bk-citation-btn" data-doc-id="${escapeAttr(c.id)}" data-doc-filename="${escapeAttr(c.filename)}" data-doc-score="${escapeAttr(String(c.score || 0))}" data-doc-tags="${escapeAttr((c.tags || []).join(", "))}" data-doc-preview="${escapeAttr(c.preview || "")}"><span class="gc-bk-citation-file">${escapeHTML(c.filename)}</span><span class="gc-bk-citation-meta">${escapeHTML(citationLabel(c))}</span></button>`
                    )
                    .join("")}</div>`
                : ""}
              <div class="gc-bk-msg-time">${escapeHTML(formatTime(m.ts))}</div>
            </div>`
        )
        .join("");
      chatLogEl.scrollTop = chatLogEl.scrollHeight;
    }

    function openCitationPreview(meta) {
      const docId = String(meta?.id || "").trim();
      const filename = String(meta?.filename || "Document").trim() || "Document";
      const scoreVal = Number(meta?.score || 0);
      const score = Number.isFinite(scoreVal) ? scoreVal.toFixed(4) : "-";
      const tags = Array.isArray(meta?.tags) ? meta.tags.filter(Boolean) : [];
      const preview = String(meta?.preview || "").trim() || "Geen preview beschikbaar voor deze bron.";
      const tagsLabel = tags.length ? tags.join(", ") : "geen tags";

      const existing = document.getElementById("gc-bk-doc-preview");
      if (existing) existing.remove();

      const modal = document.createElement("div");
      modal.id = "gc-bk-doc-preview";
      modal.className = "gc-bk-doc-modal";
      modal.innerHTML = `
        <div class="gc-bk-doc-dialog" role="dialog" aria-modal="true" aria-label="Bronpreview">
          <div class="gc-bk-doc-head">
            <div>
              <div class="gc-bk-doc-title">${escapeHTML(filename)}</div>
              <div class="gc-bk-doc-meta">ID: ${escapeHTML(docId || "-")} · score: ${escapeHTML(score)} · tags: ${escapeHTML(tagsLabel)}</div>
            </div>
            <button type="button" class="gc-bk-doc-close" aria-label="Sluiten">✕</button>
          </div>
          <pre class="gc-bk-doc-body">${escapeHTML(preview)}</pre>
        </div>`;
      document.body.appendChild(modal);

      const close = () => modal.remove();
      modal.querySelector(".gc-bk-doc-close")?.addEventListener("click", close);
      modal.addEventListener("click", (e) => {
        if (e.target === modal) close();
      });
    }

    function renderStepGroups() {
      if (!stepGroupsEl) return;
      stepGroupsEl.innerHTML = groupedSteps
        .map(
          (group) => `
            <section class="gc-bk-step-group">
              <h4>${escapeHTML(group.title)}</h4>
              ${group.items
                .map((s) => {
                  const idx = steps.findIndex((x) => x.id === s.id);
                  const activeClass = idx === state.activeStep ? "is-active" : "";
                  return `
                    <button type="button" class="gc-bk-step-link ${activeClass}" data-step-index="${idx}">
                      <span class="gc-bk-step-link-nr">${s.nr}</span>
                      <span class="gc-bk-step-link-title">${escapeHTML(s.title)}</span>
                    </button>`;
                })
                .join("")}
            </section>`
        )
        .join("");

      stepGroupsEl.querySelectorAll("[data-step-index]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const idx = Number(btn.getAttribute("data-step-index"));
          if (!Number.isFinite(idx)) return;
          state.activeStep = Math.max(0, Math.min(steps.length - 1, idx));
          renderStepGroups();
          renderStepForm();
        });
      });
    }

    function activeStep() {
      return steps[state.activeStep] || steps[0];
    }

    function renderStepForm() {
      const step = activeStep();
      const data = state.steps[step.id] || initialStepState();
      if (formTitleEl) formTitleEl.textContent = `Stap ${step.nr} · ${step.title}`;
      if (formShortEl) formShortEl.textContent = step.short || "";
      if (reportStatusEl) {
        reportStatusEl.textContent = data.report_text
          ? `Tussentijds rapport beschikbaar voor stap ${step.nr}.`
          : `Nog geen tussentijds rapport voor stap ${step.nr}. Stel links in de chat je vraag om de analyse op te bouwen.`;
      }
      if (reportBodyEl) {
        reportBodyEl.textContent =
          data.report_text ||
          "Nog geen tussentijds rapport voor deze stap. Stel links in de chat je vraag om de analyse voor deze stap op te bouwen.";
      }
      if (reportMetaEl) {
        const trace = data.retrieval_trace || null;
        const traceText = trace
          ? `RAG: ${String(trace.algorithm || "-")} · top_k: ${Number(trace.top_k || 0)} · matched_docs: ${Number(
              trace.matched_docs || 0,
            )}`
          : "RAG: nog geen trace";
        const tsText = data.updated_at ? ` · bijgewerkt: ${formatTime(data.updated_at)}` : "";
        reportMetaEl.textContent = `${traceText}${tsText}`;
      }
      if (reportSourcesEl) {
        const citations = normalizeCitations(data.citations);
        reportSourcesEl.innerHTML = citations.length
          ? citations
              .map(
                (c) =>
                  `<button type="button" class="gc-bk-citation-btn" data-doc-id="${escapeAttr(c.id)}" data-doc-filename="${escapeAttr(
                    c.filename,
                  )}" data-doc-score="${escapeAttr(String(c.score || 0))}" data-doc-tags="${escapeAttr(
                    (c.tags || []).join(", "),
                  )}" data-doc-preview="${escapeAttr(c.preview || "")}"><span class="gc-bk-citation-file">${escapeHTML(
                    c.filename,
                  )}</span><span class="gc-bk-citation-meta">${escapeHTML(citationLabel(c))}</span></button>`,
              )
              .join("")
          : '<span class="gc-bk-form-short">Nog geen bronverwijzingen voor deze stap.</span>';
      }
      if (prevBtn) prevBtn.disabled = state.activeStep <= 0;
      if (nextBtn) nextBtn.disabled = state.activeStep >= steps.length - 1;
      if (nextStepBtn) nextStepBtn.disabled = state.activeStep >= steps.length - 1;
    }

    function persistActiveStep() {
      const step = activeStep();
      if (!state.steps[step.id]) state.steps[step.id] = initialStepState();
    }

    async function requestHoofdagent(userText) {
      const step = activeStep();
      const d = state.steps[step.id] || initialStepState();
      const priorReports = steps
        .slice(0, state.activeStep)
        .map((s) => String(state.steps[s.id]?.report_text || "").trim())
        .filter(Boolean)
        .join("\n\n");
      const payload = {
        step_id: String(step.id || "").trim(),
        step_title: String(step.title || "").trim(),
        question: String(userText || "").trim(),
        case_text: String(priorReports || d.report_text || "").trim(),
        step_fields: {
          prior_step_reports: String(priorReports || "").trim(),
          current_step_report: String(d.report_text || "").trim(),
          references: defaultSources.join("; "),
        },
      };

      const headers = {
        "Content-Type": "application/json",
        ...(webhookToken ? { "x-govchat-token": webhookToken } : {}),
      };

      const resp = await fetch(orchestratorWebhookUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(String(data?.error || `Hoofdagent gaf HTTP ${resp.status}`));
      }
      const answer = String(data?.answer || data?.text || "").trim();
      if (!answer) throw new Error("Hoofdagent gaf geen antwoord terug");
      return {
        answer,
        citations: normalizeCitations(data?.citations),
        retrieval_trace: data?.retrieval_trace || null,
      };
    }

    async function sendUserMessage() {
      const text = String(chatInputEl?.value || "").trim();
      if (!text) return;
      addMessage("user", text);
      if (chatInputEl) chatInputEl.value = "";
      persistActiveStep();
      try {
        const result = await requestHoofdagent(text);
        const step = activeStep();
        state.steps[step.id] = {
          report_text: String(result.answer || "").trim(),
          citations: normalizeCitations(result.citations),
          retrieval_trace: result.retrieval_trace || null,
          updated_at: new Date().toISOString(),
        };
        addMessage("assistant", result.answer, { citations: result.citations, retrieval_trace: result.retrieval_trace });
        renderStepForm();
      } catch (err) {
        addMessage(
          "assistant",
          `Hoofdagent niet bereikbaar of fout: ${String(err?.message || err)}. Controleer workflow-sync/token/webhook pad in Beleidskompas Admin.`,
        );
      }
    }

    closeBtn?.addEventListener("click", () => container.remove());
    backBtn?.addEventListener("click", () => openAppOverviewFromMiniApp(container));
    newChatBtn?.addEventListener("click", () => {
      state.messages = [
        {
          role: "assistant",
          text: "Nieuwe sessie gestart. Beschrijf je casus en we lopen de stappen samen door.",
          ts: new Date().toISOString(),
          citations: [],
          retrieval_trace: null,
        },
      ];
      renderChat();
    });
    sendBtn?.addEventListener("click", sendUserMessage);
    chatInputEl?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        sendUserMessage();
      }
    });
    chatLogEl?.addEventListener("click", (e) => {
      const target = e.target && typeof e.target.closest === "function" ? e.target.closest(".gc-bk-citation-btn") : null;
      if (!target) return;
      openCitationPreview({
        id: target.getAttribute("data-doc-id") || "",
        filename: target.getAttribute("data-doc-filename") || "Document",
        score: Number(target.getAttribute("data-doc-score") || 0),
        tags: String(target.getAttribute("data-doc-tags") || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        preview: target.getAttribute("data-doc-preview") || "",
      });
    });

    prevBtn?.addEventListener("click", () => {
      persistActiveStep();
      state.activeStep = Math.max(0, state.activeStep - 1);
      renderStepGroups();
      renderStepForm();
    });
    nextBtn?.addEventListener("click", () => {
      persistActiveStep();
      state.activeStep = Math.min(steps.length - 1, state.activeStep + 1);
      renderStepGroups();
      renderStepForm();
    });

    saveStepBtn?.addEventListener("click", () => {
      persistActiveStep();
      const step = activeStep();
      addMessage("assistant", `Stap ${step.nr} opgeslagen. Wil je verder met de volgende stap?`);
    });
    nextStepBtn?.addEventListener("click", () => {
      persistActiveStep();
      if (state.activeStep < steps.length - 1) {
        state.activeStep += 1;
        renderStepGroups();
        renderStepForm();
        addMessage("assistant", `Doorgaan naar stap ${activeStep().nr}: ${activeStep().title}.`);
      }
    });

    renderStepGroups();
    renderChat();
    renderStepForm();
  }

  function openVersimpelaar(app) {
    if (document.getElementById("gc-vs")) return;
    const webhook = app.url || "";
    const defaultLevel = app.config?.default_level || "B1";
    const webhookToken = String(app.config?.webhook_token || "").trim();
    const levelOptions = Array.isArray(app.config?.language_levels) && app.config.language_levels.length
      ? app.config.language_levels
      : ["B1", "B2"];

    const storedWords = (() => {
      try {
        const raw = localStorage.getItem("gc_versimpelaar_preserved_words");
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter(Boolean).map((w) => String(w).trim()).filter(Boolean) : [];
      } catch {
        return [];
      }
    })();

    let preservedWords = [...new Set(storedWords)];

    const container = document.createElement("div");
    container.id = "gc-vs";
    container.innerHTML = `
      <div class="gc-vs-head">
        <div class="gc-mini-head-left">
          <button id="gc-vs-back" class="gc-mini-nav-btn" type="button">← Overzicht</button>
          <strong>Versimpelaar</strong>
        </div>
        <button id="gc-vs-close">✕</button>
      </div>
      <div class="gc-vs-intro">
        Kies een tekst en breng die eenvoudig naar B1- of B2-niveau.
      </div>
      <div class="gc-vs-controls">
        <label class="gc-vs-level-wrap">Taalniveau
          <select id="gc-vs-level">${levelOptions
            .map(
              (lvl) =>
                `<option value="${escapeAttr(lvl)}" ${lvl === defaultLevel ? "selected" : ""}>${escapeHTML(lvl)}</option>`
            )
            .join("")}</select>
        </label>
      </div>

      <div class="gc-vs-preserved">
        <div class="gc-vs-preserved-title">Begrippen die je wilt behouden</div>
        <div class="gc-vs-preserved-add">
          <input id="gc-vs-word" type="text" placeholder="Voeg woord of term toe" />
          <button id="gc-vs-word-add" type="button">Toevoegen</button>
        </div>
        <div id="gc-vs-words" class="gc-vs-words"></div>
      </div>

      <div class="gc-vs-grid">
        <div>
          <label for="gc-vs-in">Oorspronkelijke tekst</label>
          <textarea id="gc-vs-in" placeholder="Plak of typ hier de tekst die je wilt vereenvoudigen."></textarea>
          <div id="gc-vs-in-meta" class="gc-vs-meta">Woorden: 0</div>
        </div>
        <div>
          <label for="gc-vs-out">Vereenvoudigde tekst</label>
          <textarea id="gc-vs-out" placeholder="Hier zie je straks de vereenvoudigde tekst." readonly></textarea>
          <div id="gc-vs-out-meta" class="gc-vs-meta">Woorden: 0</div>
        </div>
      </div>

      <div class="gc-vs-actions">
        <button id="gc-vs-run">Versimpel</button>
        <button id="gc-vs-copy" type="button">Kopieer tekst</button>
      </div>

      <div id="gc-vs-status" class="gc-vs-status"></div>`;
    document.body.appendChild(container);

    const closeBtn = document.getElementById("gc-vs-close");
    const backBtn = document.getElementById("gc-vs-back");
    const input = document.getElementById("gc-vs-in");
    const output = document.getElementById("gc-vs-out");
    const level = document.getElementById("gc-vs-level");
    const status = document.getElementById("gc-vs-status");
    const runBtn = document.getElementById("gc-vs-run");
    const copyBtn = document.getElementById("gc-vs-copy");
    const inMeta = document.getElementById("gc-vs-in-meta");
    const outMeta = document.getElementById("gc-vs-out-meta");
    const wordInput = document.getElementById("gc-vs-word");
    const addWordBtn = document.getElementById("gc-vs-word-add");
    const wordsWrap = document.getElementById("gc-vs-words");

    function countWords(text) {
      return (text || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean).length;
    }

    function renderWords() {
      if (!wordsWrap) return;
      if (!preservedWords.length) {
        wordsWrap.innerHTML = '<div class="gc-vs-empty">Geen begrippen geselecteerd.</div>';
        localStorage.setItem("gc_versimpelaar_preserved_words", JSON.stringify([]));
        return;
      }

      wordsWrap.innerHTML = preservedWords
        .map(
          (word, idx) =>
            `<button type="button" class="gc-vs-chip" data-vs-word-index="${idx}">${escapeHTML(word)} <span>✕</span></button>`
        )
        .join("");
      localStorage.setItem("gc_versimpelaar_preserved_words", JSON.stringify(preservedWords));

      wordsWrap.querySelectorAll("[data-vs-word-index]").forEach((chip) => {
        chip.addEventListener("click", () => {
          const idx = Number(chip.getAttribute("data-vs-word-index"));
          if (Number.isFinite(idx) && idx >= 0) {
            preservedWords.splice(idx, 1);
            preservedWords = [...new Set(preservedWords)];
            renderWords();
          }
        });
      });
    }

    function refreshWordCounts() {
      if (inMeta && input) inMeta.textContent = `Woorden: ${countWords(input.value)}`;
      if (outMeta && output) outMeta.textContent = `Woorden: ${countWords(output.value)}`;
    }

    closeBtn?.addEventListener("click", () => container.remove());
    backBtn?.addEventListener("click", () => openAppOverviewFromMiniApp(container));

    input?.addEventListener("input", refreshWordCounts);

    addWordBtn?.addEventListener("click", () => {
      const value = (wordInput?.value || "").trim();
      if (!value) return;
      preservedWords = [...new Set([...preservedWords, value])];
      if (wordInput) wordInput.value = "";
      renderWords();
    });

    wordInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addWordBtn?.click();
      }
    });

    copyBtn?.addEventListener("click", async () => {
      if (!output?.value) {
        if (status) status.textContent = "Er is nog geen output om te kopiëren.";
        return;
      }
      try {
        await navigator.clipboard.writeText(output.value);
        if (status) status.textContent = "Tekst gekopieerd.";
      } catch {
        if (status) status.textContent = "Kopiëren mislukt in deze browser.";
      }
    });

    runBtn?.addEventListener("click", async () => {
      if (!input?.value?.trim()) {
        if (status) status.textContent = "Voer eerst tekst in.";
        return;
      }

      if (!webhook) {
        if (status) {
          status.textContent =
            "Webhook ontbreekt. Stel in Apps-config voor Versimpelaar een geldige URL in.";
        }
        return;
      }

      try {
        runBtn.disabled = true;
        if (status) status.textContent = "Bezig met vereenvoudigen...";

        const resp = await fetch(webhook, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(webhookToken ? { "x-govchat-token": webhookToken } : {}),
          },
          body: JSON.stringify({
            text: input.value,
            language_level: level?.value || "B1",
            preserved_words: preservedWords,
          }),
        });

        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

        const data = await resp.json().catch(async () => ({ text: await resp.text() }));
        const result =
          typeof data === "string"
            ? data
            : data.text || data.output || data.result || data.message || JSON.stringify(data);

        if (output) output.value = String(result || "");
        refreshWordCounts();
        if (status) status.textContent = "Klaar.";
      } catch (e) {
        if (status) status.textContent = `Fout: ${e.message}`;
      } finally {
        runBtn.disabled = false;
      }
    });

    renderWords();
    refreshWordCounts();
  }

  function openImageGenerator(app) {
    if (document.getElementById("gc-img")) return;

    const apiBase = String(app.config?.image_jobs_api || app.url || "").trim();

    const container = document.createElement("div");
    container.id = "gc-img";
    container.innerHTML = `
      <div class="gc-img-head">
        <div class="gc-mini-head-left">
          <button id="gc-img-back" class="gc-mini-nav-btn" type="button">← Overzicht</button>
          <strong>Afbeelding generator</strong>
        </div>
        <button id="gc-img-close">✕</button>
      </div>
      <div class="gc-img-intro">
        Start een generatie-opdracht. Je ziet live statusupdates tijdens het genereren.
      </div>
      <div class="gc-img-form-row">
        <label for="gc-img-prompt">Prompt</label>
        <textarea id="gc-img-prompt" placeholder="Beschrijf de gewenste afbeelding zo concreet mogelijk."></textarea>
      </div>
      <div class="gc-img-grid">
        <label for="gc-img-size">Formaat
          <select id="gc-img-size">
            <option value="1024x1024" selected>1024x1024</option>
            <option value="1536x1024">1536x1024</option>
            <option value="1024x1536">1024x1536</option>
          </select>
        </label>
        <label for="gc-img-quality">Kwaliteit
          <select id="gc-img-quality">
            <option value="standard" selected>standard</option>
            <option value="hd">hd</option>
          </select>
        </label>
      </div>
      <div class="gc-img-actions">
        <button id="gc-img-run" type="button">Genereer afbeelding</button>
      </div>
      <div id="gc-img-status" class="gc-img-status" data-kind="idle">
        <span class="gc-spinner" aria-hidden="true" style="display:none"></span>
        <span class="gc-img-status-text">Klaar om een afbeelding te starten.</span>
      </div>
      <div id="gc-img-result" class="gc-img-result" hidden>
        <div class="gc-img-preview-wrap">
          <img id="gc-img-preview" alt="Gegenereerde afbeelding" />
        </div>
        <div class="gc-img-links">
          <a id="gc-img-open" href="#" target="_blank" rel="noopener noreferrer">Open afbeelding in nieuw tabblad</a>
          <button id="gc-img-copy-md" type="button">Kopieer markdown</button>
        </div>
      </div>`;

    document.body.appendChild(container);

    const closeBtn = document.getElementById("gc-img-close");
    const backBtn = document.getElementById("gc-img-back");
    const promptEl = document.getElementById("gc-img-prompt");
    const sizeEl = document.getElementById("gc-img-size");
    const qualityEl = document.getElementById("gc-img-quality");
    const runBtn = document.getElementById("gc-img-run");
    const statusEl = document.getElementById("gc-img-status");
    const resultEl = document.getElementById("gc-img-result");
    const previewEl = document.getElementById("gc-img-preview");
    const openEl = document.getElementById("gc-img-open");
    const copyMdBtn = document.getElementById("gc-img-copy-md");

    let pollingTimer = null;
    let lastMarkdown = "";

    function clearPolling() {
      if (pollingTimer) {
        clearTimeout(pollingTimer);
        pollingTimer = null;
      }
    }

    function closeModal() {
      clearPolling();
      container.remove();
    }

    function setStatus(text, kind = "info") {
      if (!statusEl) return;
      statusEl.dataset.kind = kind;
      const textEl = statusEl.querySelector(".gc-img-status-text");
      if (textEl) textEl.textContent = text || "";
      const spinner = statusEl.querySelector(".gc-spinner");
      if (spinner) {
        spinner.style.display = kind === "success" || kind === "error" ? "none" : "inline-block";
      }
    }

    function getAuthHeaders() {
      return { "Content-Type": "application/json" };
    }

    function isTerminalStatus(s) {
      return s === "succeeded" || s === "failed";
    }

    function renderJobResult(job) {
      const imageUrl = String(job?.image_url || "").trim();
      const markdown = String(job?.markdown || "").trim() || (imageUrl ? `![gegenereerde afbeelding](${imageUrl})` : "");
      lastMarkdown = markdown;

      if (!imageUrl) {
        if (resultEl) resultEl.hidden = true;
        return;
      }

      if (previewEl) previewEl.src = imageUrl;
      if (openEl) openEl.href = imageUrl;
      if (resultEl) resultEl.hidden = false;
    }

    async function pollJob(jobId, delayMs) {
      clearPolling();
      pollingTimer = setTimeout(async () => {
        try {
          const resp = await fetch(`${apiBase}/${encodeURIComponent(jobId)}`, {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
          });

          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

          const job = await resp.json();
          const status = String(job.status || "").trim();
          const message = String(job.message || "").trim();
          const errorMessage = String(job.error || "").trim();

          if (status === "failed") {
            setStatus(errorMessage || message || "Afbeelding genereren is mislukt.", "error");
            runBtn.disabled = false;
            clearPolling();
            return;
          }

          if (status === "succeeded") {
            setStatus(message || "Je afbeelding is klaar.", "success");
            renderJobResult(job);
            runBtn.disabled = false;
            clearPolling();
            return;
          }

          setStatus(message || "Afbeelding wordt verwerkt...", "info");
          const nextDelay = Number(job.poll_after_ms) > 0 ? Number(job.poll_after_ms) : 1200;
          if (!isTerminalStatus(status)) {
            pollJob(jobId, nextDelay);
          }
        } catch (err) {
          setStatus(`Status ophalen mislukt: ${err.message}`, "error");
          runBtn.disabled = false;
          clearPolling();
        }
      }, Math.max(350, Number(delayMs) || 1200));
    }

    closeBtn?.addEventListener("click", closeModal);
    backBtn?.addEventListener("click", () => openAppOverviewFromMiniApp(container));

    copyMdBtn?.addEventListener("click", async () => {
      if (!lastMarkdown) {
        setStatus("Er is nog geen markdown om te kopiëren.", "info");
        return;
      }
      try {
        await navigator.clipboard.writeText(lastMarkdown);
        setStatus("Markdown gekopieerd.", "success");
      } catch {
        setStatus("Kopiëren mislukt in deze browser.", "error");
      }
    });

    runBtn?.addEventListener("click", async () => {
      const prompt = String(promptEl?.value || "").trim();
      if (!prompt) {
        setStatus("Voer eerst een prompt in.", "error");
        return;
      }

      if (!apiBase) {
        setStatus("Image-jobs API ontbreekt. Stel deze in bij de app-configuratie.", "error");
        return;
      }

      runBtn.disabled = true;
      if (resultEl) resultEl.hidden = true;
      setStatus("Aanvraag wordt gestart...", "info");

      try {
        const resp = await fetch(apiBase, {
          method: "POST",
          headers: getAuthHeaders(),
          credentials: "same-origin",
          body: JSON.stringify({
            prompt,
            size: String(sizeEl?.value || "1024x1024"),
            quality: String(qualityEl?.value || "standard"),
          }),
        });

        const rawBody = await resp.text();
        let body;
        try {
          body = rawBody ? JSON.parse(rawBody) : {};
        } catch {
          body = { error: rawBody };
        }
        if (!resp.ok) {
          const msg = String(body?.error || body?.message || `HTTP ${resp.status}`).trim();
          throw new Error(msg || `HTTP ${resp.status}`);
        }

        const jobId = String(body.job_id || "").trim();
        if (!jobId) throw new Error("Geen job-id ontvangen.");

        const firstMessage = String(body.message || "").trim() || "Je afbeelding staat in de wachtrij.";
        setStatus(firstMessage, "info");

        const firstDelay = Number(body.poll_after_ms) > 0 ? Number(body.poll_after_ms) : 1200;
        pollJob(jobId, firstDelay);
      } catch (err) {
        setStatus(`Starten mislukt: ${err.message}`, "error");
        runBtn.disabled = false;
      }
    });
  }

  function openTranscription(app) {
    if (document.getElementById("gc-tr")) return;

    const webhook = String(app.url || "").trim();
    const cfg = app.config || {};
    const webhookToken = String(cfg.webhook_token || "").trim();
    const model = String(cfg.litellm_model || "gpt-4o-transcribe").trim() || "gpt-4o-transcribe";
    const defaultLanguage = String(cfg.language || "nl").trim() || "nl";
    const realtimeEnabled = false;
    const realtimeUrl = String(cfg.realtime_url || "/govchat-api/realtime-stt").trim() || "/govchat-api/realtime-stt";
    const realtimeProvider = String(cfg.realtime_provider || "litellm").trim() || "litellm";
    const realtimeModel = String(cfg.realtime_model || model || "gpt-4o-realtime-preview").trim();
    const realtimeCommitMs = Math.max(500, Math.min(5000, Number(cfg.realtime_commit_ms) || 1200));
    const languageOptions = [
      { code: "nl", label: "Nederlands" },
      { code: "en", label: "Engels" },
      { code: "fr", label: "Frans" },
      { code: "de", label: "Duits" },
      { code: "nl-BE", label: "Vlaams" },
      { code: "it", label: "Italiaans" },
      { code: "es", label: "Spaans" },
      { code: "pt", label: "Portugees" },
      { code: "pl", label: "Pools" },
      { code: "tr", label: "Turks" },
      { code: "ar", label: "Arabisch" },
    ];
    const normalizedDefaultLanguage = defaultLanguage.toLowerCase();
    const hasDefaultLanguageOption = languageOptions.some((opt) => opt.code.toLowerCase() === normalizedDefaultLanguage);
    const languageOptionsHtml = [
      ...languageOptions,
      ...(hasDefaultLanguageOption ? [] : [{ code: defaultLanguage, label: `Aangepast (${defaultLanguage})` }]),
    ]
      .map((opt) => {
        const selected = String(opt.code).toLowerCase() === normalizedDefaultLanguage ? ' selected' : '';
        return `<option value="${escapeAttr(opt.code)}"${selected}>${escapeHTML(opt.label)} (${escapeHTML(opt.code)})</option>`;
      })
      .join("");
    const chunkMs = Math.max(2000, Math.min(15000, Number(cfg.chunk_ms) || 5000));
    const chunkMinMs = Math.max(1200, Math.min(10000, Number(cfg.chunk_min_ms) || 2200));
    const chunkMaxMs = Math.max(chunkMinMs + 800, Math.min(30000, Number(cfg.chunk_max_ms) || 20000));
    const vadSilenceMs = Math.max(350, Math.min(3000, Number(cfg.vad_silence_ms) || 900));
    const vadThresholdRaw = Number(cfg.silence_threshold ?? cfg.vad_threshold);
    const vadThreshold = Math.max(0.002, Math.min(0.08, Number.isFinite(vadThresholdRaw) ? vadThresholdRaw : 0.012));
    const overlapMs = Math.max(0, Math.min(2500, Number(cfg.overlap_ms) || 650));
    const contextPrefix = String(cfg.context_prompt || "Nederlands gesprek, maak een complete en nette transcriptie.").trim();
    const maxDurationMinutes = Math.max(5, Math.min(360, Number(cfg.max_duration_minutes) || 120));
    const includeTimestamps = cfg.include_timestamps !== false;
    const sessionsApiBase = String(cfg.transcript_sessions_api || "/govchat-api/transcript-sessions").trim() || "/govchat-api/transcript-sessions";
    const titleWebhook = String(cfg.title_webhook || "").trim();
    const titleWebhookToken = String(cfg.title_webhook_token || cfg.webhook_token || "").trim();
    const titleModel = String(cfg.title_model || "gpt-4o-mini").trim() || "gpt-4o-mini";
    const titleMaxChars = Math.max(32, Math.min(140, Number(cfg.title_max_chars) || 72));
    const titleTimeoutMs = Math.max(1000, Math.min(15000, Number(cfg.title_timeout_ms) || 6000));

    const container = document.createElement("div");
    container.id = "gc-tr";
    container.innerHTML = `
      <div class="gc-tr-head">
        <div class="gc-mini-head-left">
          <button id="gc-tr-back" class="gc-mini-nav-btn" type="button">← Overzicht</button>
          <strong>Live transcriptie</strong>
        </div>
        <button id="gc-tr-close">✕</button>
      </div>

      <div class="gc-tr-layout">
        <section class="gc-tr-main">
          <div class="gc-tr-controls">
            <div class="gc-tr-control-inputs">
              <label id="gc-tr-source-wrap">Bron
                <select id="gc-tr-source">
                  <option value="mic" selected>Microfoon</option>
                  <option value="system">Systeemgeluid (tab/scherm)</option>
                </select>
              </label>
              <label>Microfoon
                <select id="gc-tr-device"></select>
              </label>
              <label>Taal
                <select id="gc-tr-language">${languageOptionsHtml}</select>
              </label>
            </div>
            <div class="gc-tr-control-actions">
              <div class="gc-tr-btn-group gc-tr-btn-group-primary">
                <button id="gc-tr-start" type="button" title="Start transcriptie met de gekozen bron">Start</button>
                <button id="gc-tr-stop" type="button" disabled title="Stop transcriptie en sluit opname af">Stop</button>
              </div>
              <div class="gc-tr-btn-group gc-tr-btn-group-secondary">
                <button id="gc-tr-refresh" type="button" title="Ververs microfoonlijst">Ververs</button>
                <button id="gc-tr-copy" type="button" title="Kopieer volledige transcriptie">Kopieer</button>
                <button id="gc-tr-clear" type="button" title="Start een nieuwe sessie in dit venster">Nieuwe sessie</button>
                <button id="gc-tr-info-btn" class="gc-tr-icon-info" type="button" aria-label="Toon uitleg" aria-expanded="false" aria-controls="gc-tr-smart-info" title="Uitleg over alle opties">ⓘ</button>
              </div>
              <label class="gc-tr-toggle" title="Toon of verberg timestamps in de transcriptie">
                <input id="gc-tr-show-ts" type="checkbox" ${includeTimestamps ? "checked" : ""}>
                <span>Timestamps tonen</span>
              </label>
            </div>
          </div>

          <div id="gc-tr-smart-info" class="gc-tr-smart-info" hidden>
            <h4>Uitleg transcriptie</h4>
            <div class="gc-tr-smart-grid">
              <section>
                <strong>Kies wat je wilt uitschrijven</strong>
                <ul>
                  <li><strong>Microfoon:</strong> neem je eigen stem op.</li>
                  <li><strong>Systeemgeluid:</strong> neem geluid van een tabblad of vergadering op (bijvoorbeeld Teams in de browser).</li>
                </ul>
              </section>
              <section>
                <strong>Waarom moet je een tab of scherm kiezen?</strong>
                <ul>
                  <li>Je browser laat systeemgeluid alleen toe via “delen”.</li>
                  <li>Deze app gebruikt alleen het geluid voor transcriptie.</li>
                  <li>Met <em>Stop</em> stop je direct de opname.</li>
                </ul>
              </section>
              <section>
                <strong>Teams-overleg uitschrijven (stappen)</strong>
                <ol>
                  <li>Kies bron <em>Systeemgeluid</em> en klik <em>Start</em>.</li>
                  <li>Gebruik je de <strong>Teams desktop-app</strong>? Kies in het deelvenster <strong>Volledig scherm → Volledig scherm</strong> en zet <strong>Ook systeemaudio delen</strong> aan.</li>
                  <li>Kies je <strong>Venster</strong> (in plaats van Volledig scherm), dan komt er meestal <strong>geen audio</strong> mee en werkt transcriptie niet goed.</li>
                  <li>Wil je alleen het vergaderingstabblad delen? Gebruik Teams in de browser en kies het juiste tabblad met audio aan.</li>
                </ol>
              </section>
              <section>
                <strong>Veelgemaakte fouten voorkomen</strong>
                <ul>
                  <li>Geen tekst? Controleer of audio-delen echt aan staat in het deelvenster.</li>
                  <li>Verkeerde bron gekozen? Zet op <em>Systeemgeluid</em> voor vergaderaudio.</li>
                  <li>Microfoonlijst leeg? Klik <em>Ververs</em> of herstart browser-permissies.</li>
                </ul>
              </section>
              <section>
                <strong>Wat doen de knoppen?</strong>
                <ul>
                  <li><strong>Start / Stop:</strong> transcriptie starten of stoppen.</li>
                  <li><strong>Ververs:</strong> vernieuwt de lijst met microfoons.</li>
                  <li><strong>Kopieer:</strong> kopieert de volledige tekst.</li>
                  <li><strong>Nieuwe sessie:</strong> start in dit venster met een lege transcriptie.</li>
                  <li><strong>Timestamps tonen:</strong> tijd erbij tonen (aan/uit).</li>
                </ul>
              </section>
              <section>
                <strong>Automatische verwerking</strong>
                <p>De app verstuurt stukjes audio automatisch op logische pauzes. Je hoeft hier niets voor in te stellen tijdens gebruik.</p>
              </section>
            </div>
          </div>

          <div class="gc-tr-wave-wrap">
            <canvas id="gc-tr-wave" width="1200" height="160" aria-label="Audio visualisatie"></canvas>
          </div>

          <div class="gc-tr-meta">
            <span id="gc-tr-timer">00:00</span>
            <span id="gc-tr-count">0 segmenten</span>
            <span id="gc-tr-hint">Model: ${escapeHTML(model)} · Taal: ${escapeHTML(defaultLanguage)} · Slim chunken (VAD + overlap)</span>
          </div>

          <div id="gc-tr-status" class="gc-tr-status">Klaar om te starten.</div>
          <div id="gc-tr-list" class="gc-tr-list" aria-live="polite"></div>
        </section>

        <aside class="gc-tr-side">
          <div class="gc-tr-card">
            <h4>Sessiehistorie</h4>
            <div class="gc-tr-session-toolbar">
              <label>Sorteer
                <select id="gc-tr-session-sort">
                  <option value="newest" selected>Nieuw → oud</option>
                  <option value="oldest">Oud → nieuw</option>
                  <option value="duration">Langste duur</option>
                  <option value="words">Meeste woorden</option>
                  <option value="title">Titel (A-Z)</option>
                </select>
              </label>
            </div>
            <div id="gc-tr-session-list" class="gc-tr-session-list"></div>
          </div>
        </aside>
      </div>`;

    document.body.appendChild(container);

    const closeBtn = document.getElementById("gc-tr-close");
    const backBtn = document.getElementById("gc-tr-back");
    const refreshBtn = document.getElementById("gc-tr-refresh");
    const startBtn = document.getElementById("gc-tr-start");
    const stopBtn = document.getElementById("gc-tr-stop");
    const copyBtn = document.getElementById("gc-tr-copy");
    const clearBtn = document.getElementById("gc-tr-clear");
    const deviceSelect = document.getElementById("gc-tr-device");
    const sourceSelect = document.getElementById("gc-tr-source");
    const sourceWrap = document.getElementById("gc-tr-source-wrap");
    const deviceWrap = deviceSelect?.closest("label") || null;
    const languageInput = document.getElementById("gc-tr-language");
    const infoBtn = document.getElementById("gc-tr-info-btn");
    const smartInfoEl = document.getElementById("gc-tr-smart-info");
    const showTsInput = document.getElementById("gc-tr-show-ts");
    const statusEl = document.getElementById("gc-tr-status");
    const timerEl = document.getElementById("gc-tr-timer");
    const countEl = document.getElementById("gc-tr-count");
    const listEl = document.getElementById("gc-tr-list");
    const waveCanvas = document.getElementById("gc-tr-wave");
    const hintEl = document.getElementById("gc-tr-hint");
    const sessionSortEl = document.getElementById("gc-tr-session-sort");
    const sessionListEl = document.getElementById("gc-tr-session-list");

    let mediaStream = null;
    let captureStream = null;
    let mediaRecorder = null;
    let chunkTimer = null;
    let running = false;
    let selectedLanguage = defaultLanguage;
    let sessionId = `tr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let chunkIndex = 0;
    let startedAt = 0;
    let timerInterval = null;

    let audioCtx = null;
    let analyser = null;
    let waveAnim = 0;
    let realtimeWs = null;
    let realtimeCommitTimer = null;
    let realtimeBufferedSinceCommit = false;
    let processorNode = null;
    let mediaSourceNode = null;
    let vadTimer = null;
    let chunkStartedAtMs = 0;
    let lastVoiceAtMs = 0;
    let voiceSeenInChunk = false;
    let chunkStopping = false;
    let uploadQueue = Promise.resolve();
    let showTimestamps = includeTimestamps;
    let promptMemory = "";
    let timelineCursorSec = 0;
    let lastMergedText = "";
    let currentHistorySort = "newest";
    let recordingStartSegmentIndex = 0;
    let recordingSource = "mic";
    let recordingDeviceLabel = "";
    let recordingLanguage = defaultLanguage;
    let historyApiReady = false;
    const pendingTitleSessionIds = new Set();
    const activeSessionPlaceholder = "Huidige sessie";
    const pendingTitleLabel = "Titel wordt achteraf gegenereerd";
    const pendingRetitleLabel = "Titel wordt opnieuw gegenereerd";
    const pendingTitleModeBySessionId = new Map();
    const generatedTitleSessionIds = new Set();
    let activeHistorySessionId = "";
    let focusedHistorySessionId = "";

    let segments = [];

    let sessionHistory = [];

    async function fetchTranscriptSessions(sort = currentHistorySort) {
      const url = new URL(sessionsApiBase, window.location.origin);
      url.searchParams.set("sort", String(sort || "newest"));
      const res = await fetch(url.toString(), {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(String(body?.error || `HTTP ${res.status}`));
      }
      return body;
    }

    async function createTranscriptSession(entry) {
      const res = await fetch(sessionsApiBase, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(entry),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(String(body?.error || `HTTP ${res.status}`));
      }
      return body;
    }

    async function patchTranscriptSession(id, payload) {
      const res = await fetch(`${sessionsApiBase}/${encodeURIComponent(id)}`, {
        method: "PATCH",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload || {}),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(String(body?.error || `HTTP ${res.status}`));
      }
      return body;
    }

    async function removeTranscriptSession(id) {
      const res = await fetch(`${sessionsApiBase}/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(String(body?.error || `HTTP ${res.status}`));
      }
      return body;
    }

    function countWords(text) {
      return String(text || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean).length;
    }

    function sessionTitleFromText(text) {
      const words = String(text || "")
        .replace(/[\n\r\t]+/g, " ")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 10);
      return words.length ? words.join(" ") : "Transcriptie sessie";
    }

    function normalizeSessionTitle(title, fallbackText) {
      const cleaned = String(title || "")
        .replace(/[\n\r\t]+/g, " ")
        .replace(/\s+/g, " ")
        .replace(/^\s*["'`]+|["'`]+\s*$/g, "")
        .trim();
      const clipped = cleaned.length > titleMaxChars ? cleaned.slice(0, titleMaxChars).trim() : cleaned;
      return clipped || sessionTitleFromText(fallbackText);
    }

    async function generateSessionTitleWithLlm({ text, language }) {
      const fallback = sessionTitleFromText(text);
      if (!titleWebhook) {
        return {
          title: fallback,
          generated: false,
          reason: "Titel-webhook ontbreekt",
        };
      }

      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timeoutId = controller ? setTimeout(() => controller.abort(), titleTimeoutMs) : null;

      try {
        const resp = await fetch(titleWebhook, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(titleWebhookToken ? { "x-govchat-token": titleWebhookToken } : {}),
          },
          body: JSON.stringify({
            text,
            language: String(language || selectedLanguage || defaultLanguage || "nl").trim() || "nl",
            model: titleModel,
            max_chars: titleMaxChars,
          }),
          signal: controller ? controller.signal : undefined,
        });

        const rawBody = await resp.text();
        let payload;
        try {
          payload = rawBody ? JSON.parse(rawBody) : {};
        } catch {
          payload = { title: rawBody };
        }
        if (!resp.ok) {
          throw new Error(String(payload?.error || payload?.message || `HTTP ${resp.status}`));
        }
        return {
          title: normalizeSessionTitle(payload?.title || payload?.response || payload?.text, text),
          generated: true,
          reason: "",
        };
      } catch (err) {
        return {
          title: fallback,
          generated: false,
          reason: String(err?.message || err || "Titelgeneratie mislukt"),
        };
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }

    function formatDuration(ms) {
      const sec = Math.max(0, Math.round(Number(ms || 0) / 1000));
      const mm = Math.floor(sec / 60);
      const ss = sec % 60;
      if (mm >= 60) return fmtTimer(ms);
      return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
    }

    function sortSessionHistory(items) {
      const arr = [...(Array.isArray(items) ? items : [])];
      if (currentHistorySort === "oldest") {
        return arr.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
      }
      if (currentHistorySort === "duration") {
        return arr.sort((a, b) => Number(b.durationMs || 0) - Number(a.durationMs || 0));
      }
      if (currentHistorySort === "words") {
        return arr.sort((a, b) => Number(b.wordCount || 0) - Number(a.wordCount || 0));
      }
      if (currentHistorySort === "title") {
        return arr.sort((a, b) => String(a.title || "").localeCompare(String(b.title || ""), "nl"));
      }
      return arr.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    }

    function renderSessionHistory() {
      if (!sessionListEl) return;
      const items = sortSessionHistory(sessionHistory);
      if (!items.length) {
        sessionListEl.innerHTML = '<div class="gc-tr-empty">Nog geen opgeslagen sessies.</div>';
        return;
      }

      sessionListEl.innerHTML = items
        .map((s) => {
          const sessionRowId = String(s.id || "").trim();
          const isPendingTitle = pendingTitleSessionIds.has(String(s.id || "").trim());
          const isFocusedSession = Boolean(focusedHistorySessionId && sessionRowId === focusedHistorySessionId);
          const isActiveRecording = Boolean(running && activeHistorySessionId && sessionRowId === activeHistorySessionId);
          const when = new Date(Number(s.createdAt || Date.now())).toLocaleString("nl-NL");
          const meta = `${formatDuration(s.durationMs)} · ${Number(s.wordCount || 0)} woorden · ${escapeHTML(String(s.inputSource || "bron onbekend"))}`;
          const rawTitle = String(s.title || "").trim();
          const isSyntheticPendingTitle =
            rawTitle === pendingTitleLabel ||
            rawTitle === pendingRetitleLabel ||
            rawTitle === `${pendingTitleLabel}…` ||
            rawTitle === `${pendingRetitleLabel}…`;
          const titleText = isSyntheticPendingTitle
            ? activeSessionPlaceholder
            : rawTitle || "Transcriptie sessie";
          const pendingMode = String(pendingTitleModeBySessionId.get(sessionRowId) || "auto");
          const pendingText = pendingMode === "retitle" ? pendingRetitleLabel : pendingTitleLabel;
          const pendingMeta = isPendingTitle ? `<div class="gc-tr-session-pending">${escapeHTML(pendingText)}…</div>` : "";
          const activeMeta = isActiveRecording ? '<div class="gc-tr-session-active">Opname bezig…</div>' : "";
          const focusedMeta = !isActiveRecording && isFocusedSession ? '<div class="gc-tr-session-active">Opname gestopt</div>' : "";
          return `
            <div class="gc-tr-session-item${isPendingTitle ? " is-pending-title" : ""}${isActiveRecording ? " is-active-recording" : ""}${isFocusedSession ? " is-focused-session" : ""}" data-session-id="${escapeAttr(s.id)}">
              <div class="gc-tr-session-title">${escapeHTML(titleText)}</div>
              ${activeMeta}
              ${focusedMeta}
              ${pendingMeta}
              <div class="gc-tr-session-meta">${escapeHTML(meta)}</div>
              <div class="gc-tr-session-meta">${escapeHTML(when)}</div>
              <div class="gc-tr-session-actions">
                <button type="button" data-session-action="open">Open</button>
                <button type="button" data-session-action="rename">Hernoem</button>
                <button type="button" data-session-action="retitle">Genereer titel opnieuw</button>
                <button type="button" data-session-action="delete">Verwijder</button>
              </div>
            </div>`;
        })
        .join("");
    }

    async function refreshSessionHistoryFromServer() {
      try {
        const payload = await fetchTranscriptSessions(currentHistorySort);
        sessionHistory = Array.isArray(payload?.sessions) ? payload.sessions : [];
        historyApiReady = true;
        renderSessionHistory();
      } catch (err) {
        historyApiReady = false;
        sessionHistory = [];
        renderSessionHistory();
        setStatus(`Sessiehistorie niet beschikbaar: ${String(err?.message || err)}`, "error");
      }
    }

    function currentRecordingText() {
      const savedSegments = segments.slice(recordingStartSegmentIndex);
      return savedSegments.map((s) => String(s.text || "").trim()).filter(Boolean).join(" ").trim();
    }

    function updateActiveSessionPreview() {
      if (!activeHistorySessionId) return;
      const idx = sessionHistory.findIndex((s) => String(s.id || "").trim() === activeHistorySessionId);
      if (idx < 0) return;
      const now = Date.now();
      const text = currentRecordingText();
      const savedSegments = segments.slice(recordingStartSegmentIndex);
      sessionHistory[idx] = {
        ...sessionHistory[idx],
        updatedAt: now,
        durationMs: Math.max(0, now - Number(startedAt || now)),
        wordCount: countWords(text),
        language: recordingLanguage || selectedLanguage,
        text,
        segments: savedSegments,
      };
      renderSessionHistory();
    }

    async function saveSessionSnapshot() {
      if (uploadQueue && typeof uploadQueue.then === "function") {
        try {
          await uploadQueue;
        } catch {
          // no-op: snapshot should still proceed with available transcript state
        }
      }

      const savedSegments = segments.slice(recordingStartSegmentIndex);
      const text = currentRecordingText();

      const now = Date.now();
      const sessionIdForSave = activeHistorySessionId || `trs-${now}-${Math.random().toString(36).slice(2, 8)}`;
      const entry = {
        id: sessionIdForSave,
        title: activeSessionPlaceholder,
        createdAt: Number(startedAt || now),
        updatedAt: now,
        durationMs: Math.max(0, now - Number(startedAt || now)),
        inputSource: recordingSource === "system" ? "Systeemgeluid" : "Microfoon",
        inputDevice: recordingDeviceLabel || (recordingSource === "system" ? "Systeemgeluid" : "Onbekend"),
        wordCount: countWords(text),
        language: recordingLanguage || selectedLanguage,
        text,
        segments: savedSegments,
      };
      try {
        if (activeHistorySessionId) {
          await patchTranscriptSession(activeHistorySessionId, {
            updatedAt: now,
            durationMs: entry.durationMs,
            inputSource: entry.inputSource,
            inputDevice: entry.inputDevice,
            wordCount: entry.wordCount,
            language: entry.language,
            text: entry.text,
            segments: entry.segments,
          });
        } else {
          await createTranscriptSession(entry);
          activeHistorySessionId = entry.id;
        }
        await refreshSessionHistoryFromServer();
        updateActiveSessionPreview();

        if (!text) {
          pendingTitleSessionIds.delete(entry.id);
          await patchTranscriptSession(entry.id, { title: activeSessionPlaceholder });
          await refreshSessionHistoryFromServer();
          setStatus("Sessie gestopt zonder transcriptietekst. Titel blijft op ‘Huidige sessie’.", "info");
          renderSessionHistory();
          return;
        }

        pendingTitleSessionIds.add(entry.id);
        pendingTitleModeBySessionId.set(entry.id, "auto");
        renderSessionHistory();
        setStatus("Sessie gestopt. Titel wordt gegenereerd…", "info");

        (async () => {
          const titleResult = await generateSessionTitleWithLlm({
            text,
            language: recordingLanguage || selectedLanguage,
          });

          if (!pendingTitleSessionIds.has(entry.id)) return;

          const latest = sessionHistory.find((s) => s.id === entry.id);
          if (latest) {
            const latestTitle = String(latest.title || "").trim();
            if (latestTitle && latestTitle !== pendingTitleLabel && latestTitle !== activeSessionPlaceholder) {
              pendingTitleSessionIds.delete(entry.id);
              pendingTitleModeBySessionId.delete(entry.id);
              renderSessionHistory();
              return;
            }
          }

          try {
            await patchTranscriptSession(entry.id, { title: titleResult.title });
            await refreshSessionHistoryFromServer();
            generatedTitleSessionIds.add(entry.id);
            if (titleResult.generated) {
              setStatus(`Titel automatisch gegenereerd: ${titleResult.title}`, "success");
            } else {
              setStatus(`Automatische titelgeneratie niet gelukt (${titleResult.reason}); terugvaltitel gebruikt.`, "info");
            }
          } catch {
            // no-op: fallback/pending title remains available
          } finally {
            pendingTitleSessionIds.delete(entry.id);
            pendingTitleModeBySessionId.delete(entry.id);
            renderSessionHistory();
          }
        })();
      } catch (err) {
        pendingTitleSessionIds.delete(entry.id);
        pendingTitleModeBySessionId.delete(entry.id);
        setStatus(`Opslaan sessie mislukt: ${String(err?.message || err)}`, "error");
      }
    }

    function openHistorySession(id) {
      const hit = sessionHistory.find((s) => s.id === id);
      if (!hit) return;
      focusedHistorySessionId = id;
      segments = Array.isArray(hit.segments) ? hit.segments.map((s) => ({ ...s })) : [];
      timelineCursorSec = Number(segments[segments.length - 1]?.end || 0);
      promptMemory = "";
      lastMergedText = "";
      renderSegments();
      renderSessionHistory();
      timerEl.textContent = formatDuration(hit.durationMs);
      setStatus(`Sessie geladen: ${hit.title}`, "info");
    }

    async function regenerateHistorySessionTitle(id) {
      const hit = sessionHistory.find((s) => s.id === id);
      if (!hit) return;
      const text = String(hit.text || "").trim();
      if (!text) {
        setStatus("Geen transcriptietekst beschikbaar om een titel te genereren.", "info");
        return;
      }

      pendingTitleSessionIds.add(id);
      pendingTitleModeBySessionId.set(id, "retitle");
      try {
        renderSessionHistory();
        setStatus("Titel opnieuw genereren gestart…", "info");

        const titleResult = await generateSessionTitleWithLlm({
          text,
          language: String(hit.language || selectedLanguage || defaultLanguage || "nl").trim() || "nl",
        });

        await patchTranscriptSession(id, { title: titleResult.title });
        await refreshSessionHistoryFromServer();
        generatedTitleSessionIds.add(id);
        if (titleResult.generated) {
          setStatus(`Titel opnieuw gegenereerd: ${titleResult.title}`, "success");
        } else {
          setStatus(`Titel opnieuw genereren viel terug op standaard (${titleResult.reason}).`, "info");
        }
      } catch (err) {
        setStatus(`Titel opnieuw genereren mislukt: ${String(err?.message || err)}`, "error");
      } finally {
        pendingTitleSessionIds.delete(id);
        pendingTitleModeBySessionId.delete(id);
        renderSessionHistory();
      }
    }

    async function renameHistorySession(id) {
      const hit = sessionHistory.find((s) => s.id === id);
      if (!hit) return;
      const next = String(window.prompt("Nieuwe sessienaam", hit.title || "Transcriptie sessie") || "").trim();
      if (!next) return;
      pendingTitleSessionIds.delete(id);
      pendingTitleModeBySessionId.delete(id);
      generatedTitleSessionIds.add(id);
      try {
        await patchTranscriptSession(id, { title: next });
        await refreshSessionHistoryFromServer();
      } catch (err) {
        setStatus(`Hernoemen mislukt: ${String(err?.message || err)}`, "error");
      }
    }

    async function deleteHistorySession(id) {
      const hit = sessionHistory.find((s) => s.id === id);
      if (!hit) return;
      const ok = window.confirm(`Sessie verwijderen?\n\n${hit.title || "Transcriptie sessie"}`);
      if (!ok) return;
      pendingTitleSessionIds.delete(id);
      pendingTitleModeBySessionId.delete(id);
      generatedTitleSessionIds.delete(id);
      try {
        await removeTranscriptSession(id);
        await refreshSessionHistoryFromServer();
      } catch (err) {
        setStatus(`Verwijderen mislukt: ${String(err?.message || err)}`, "error");
      }
    }

    function closeModal() {
      stopRecording();
      container.remove();
    }

    function setStatus(text, kind) {
      if (!statusEl) return;
      statusEl.textContent = text || "";
      statusEl.dataset.kind = kind || "info";
    }

    function updateHint() {
      if (!hintEl) return;
      if (realtimeEnabled) {
        hintEl.textContent = `Realtime: actief · Provider: ${realtimeProvider} · Model: ${realtimeModel} · Taal: ${selectedLanguage}`;
        return;
      }
      hintEl.textContent = `Model: ${model} · Taal: ${selectedLanguage} · VAD stilte: ${vadSilenceMs}ms · Chunk: ${chunkMinMs}-${chunkMaxMs}ms · Overlap: ${overlapMs}ms`;
    }

    function sourceMode() {
      return String(sourceSelect?.value || "mic").trim() || "mic";
    }

    function updateSourceUi() {
      const mode = sourceMode();
      if (deviceWrap) {
        deviceWrap.style.display = mode === "system" ? "none" : "inline-flex";
      }
      if (mode === "system") {
        setStatus("Systeemgeluid gebruikt scherm/tab-capture. Kies in de browser-share dialoog een tab met audio.", "info");
      }
    }

    function fmtTs(sec) {
      const n = Number(sec);
      if (!Number.isFinite(n) || n < 0) return "00:00";
      const mm = String(Math.floor(n / 60)).padStart(2, "0");
      const ss = String(Math.floor(n % 60)).padStart(2, "0");
      return `${mm}:${ss}`;
    }

    function fmtTimer(ms) {
      const total = Math.max(0, Math.floor(ms / 1000));
      const hh = Math.floor(total / 3600);
      const mm = Math.floor((total % 3600) / 60);
      const ss = total % 60;
      if (hh > 0) return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
      return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
    }

    function normalizeWords(s) {
      return String(s || "")
        .toLowerCase()
        .replace(/[\n\r\t]+/g, " ")
        .replace(/[.,!?;:()[\]{}\"'`]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    function mergeChunkText(previousText, incomingText) {
      const prev = String(previousText || "").trim();
      const next = String(incomingText || "").trim();
      if (!next) return prev;
      if (!prev) return next;

      const prevNorm = normalizeWords(prev);
      const nextNorm = normalizeWords(next);
      if (!nextNorm) return prev;
      if (prevNorm.includes(nextNorm)) return prev;

      const prevWords = prev.split(/\s+/).filter(Boolean);
      const nextWords = next.split(/\s+/).filter(Boolean);
      const prevNormWords = normalizeWords(prev).split(/\s+/).filter(Boolean);
      const nextNormWords = normalizeWords(next).split(/\s+/).filter(Boolean);

      const maxK = Math.min(20, prevNormWords.length, nextNormWords.length);
      let overlap = 0;
      for (let k = maxK; k >= 2; k -= 1) {
        const a = prevNormWords.slice(prevNormWords.length - k).join(" ");
        const b = nextNormWords.slice(0, k).join(" ");
        if (a && b && a === b) {
          overlap = k;
          break;
        }
      }

      if (overlap > 0) {
        return `${prev} ${nextWords.slice(overlap).join(" ")}`.trim();
      }

      return `${prev} ${next}`.trim();
    }

    function updatePromptMemory(text) {
      const merged = mergeChunkText(promptMemory, text);
      const words = merged.split(/\s+/).filter(Boolean);
      promptMemory = words.slice(-60).join(" ");
    }

    function buildPromptForChunk() {
      return [contextPrefix, promptMemory].filter(Boolean).join("\n").trim();
    }

    function renderSegments() {
      if (!listEl) return;
      listEl.innerHTML = segments
        .map((s) => {
          const ts = showTimestamps ? `<span class="gc-tr-ts">${escapeHTML(fmtTs(s.start))}–${escapeHTML(fmtTs(s.end))}</span>` : "";
          return `
            <div class="gc-tr-segment" data-segment-id="${escapeAttr(s.id)}">
              <div class="gc-tr-segment-head">
                ${ts}
              </div>
              <div class="gc-tr-text">${escapeHTML(s.text || "")}</div>
            </div>`;
        })
        .join("");

      countEl.textContent = `${segments.length} segmenten`;
      listEl.scrollTop = listEl.scrollHeight;
    }

    function buildCopyText() {
      return segments
        .map((s) => {
          const ts = showTimestamps ? `[${fmtTs(s.start)}-${fmtTs(s.end)}] ` : "";
          return `${ts}${s.text}`;
        })
        .join("\n");
    }

    async function blobToBase64(blob) {
      const buf = await blob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    }

    function encodeWavFromAudioBuffer(audioBuffer) {
      const numChannels = audioBuffer.numberOfChannels;
      const sampleRate = audioBuffer.sampleRate;
      const numFrames = audioBuffer.length;
      const bytesPerSample = 2;
      const blockAlign = numChannels * bytesPerSample;
      const byteRate = sampleRate * blockAlign;
      const dataSize = numFrames * blockAlign;
      const buffer = new ArrayBuffer(44 + dataSize);
      const view = new DataView(buffer);

      let offset = 0;
      const writeString = (s) => {
        for (let i = 0; i < s.length; i++) view.setUint8(offset++, s.charCodeAt(i));
      };
      const writeUint32 = (v) => {
        view.setUint32(offset, v, true);
        offset += 4;
      };
      const writeUint16 = (v) => {
        view.setUint16(offset, v, true);
        offset += 2;
      };

      writeString("RIFF");
      writeUint32(36 + dataSize);
      writeString("WAVE");
      writeString("fmt ");
      writeUint32(16);
      writeUint16(1);
      writeUint16(numChannels);
      writeUint32(sampleRate);
      writeUint32(byteRate);
      writeUint16(blockAlign);
      writeUint16(16);
      writeString("data");
      writeUint32(dataSize);

      const channels = [];
      for (let c = 0; c < numChannels; c++) channels.push(audioBuffer.getChannelData(c));

      let pcmOffset = 44;
      for (let i = 0; i < numFrames; i++) {
        for (let c = 0; c < numChannels; c++) {
          const sample = Math.max(-1, Math.min(1, channels[c][i] || 0));
          view.setInt16(pcmOffset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
          pcmOffset += 2;
        }
      }

      return new Blob([buffer], { type: "audio/wav" });
    }

    async function normalizeAudioBlobForTranscription(blob) {
      const srcType = String(blob?.type || "").toLowerCase();
      if (!blob || !srcType.startsWith("audio/")) return blob;
      if (srcType.includes("wav")) return blob;

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return blob;

      let ctx = null;
      try {
        const arr = await blob.arrayBuffer();
        ctx = new AudioCtx();
        const audioBuffer = await ctx.decodeAudioData(arr.slice(0));
        return encodeWavFromAudioBuffer(audioBuffer);
      } catch {
        return blob;
      } finally {
        try {
          await ctx?.close();
        } catch {
          // no-op
        }
      }
    }

    function float32ToBase64Pcm16(samples) {
      const input = samples || new Float32Array(0);
      const bytes = new Uint8Array(input.length * 2);
      let o = 0;
      for (let i = 0; i < input.length; i += 1) {
        const s = Math.max(-1, Math.min(1, input[i] || 0));
        const v = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
        bytes[o++] = v & 0xff;
        bytes[o++] = (v >> 8) & 0xff;
      }

      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    }

    function buildRealtimeWsUrl() {
      const base = new URL(realtimeUrl, window.location.origin);
      if (base.protocol === "http:") base.protocol = "ws:";
      if (base.protocol === "https:") base.protocol = "wss:";
      if (webhookToken) {
        base.searchParams.set("token", webhookToken);
      }
      return base.toString();
    }

    function scheduleRealtimeCommit() {
      if (!running || !realtimeEnabled || !realtimeWs || realtimeWs.readyState !== WebSocket.OPEN) return;
      if (realtimeCommitTimer) clearTimeout(realtimeCommitTimer);
      realtimeCommitTimer = setTimeout(() => {
        if (!running || !realtimeWs || realtimeWs.readyState !== WebSocket.OPEN) return;
        if (!realtimeBufferedSinceCommit) return;
        realtimeBufferedSinceCommit = false;
        realtimeWs.send(JSON.stringify({ type: "audio.commit" }));
      }, realtimeCommitMs);
    }

    function attachRealtimeWs() {
      const ws = new WebSocket(buildRealtimeWsUrl());
      realtimeWs = ws;

      ws.addEventListener("open", () => {
        ws.send(
          JSON.stringify({
            type: "start",
            provider: realtimeProvider,
            model: realtimeModel,
            language: selectedLanguage,
            ...(webhookToken ? { token: webhookToken } : {}),
          }),
        );
      });

      ws.addEventListener("message", (ev) => {
        let payload = null;
        try {
          payload = JSON.parse(String(ev?.data || ""));
        } catch {
          payload = null;
        }
        if (!payload || typeof payload !== "object") return;

        if (payload.type === "ready") {
          setStatus("Realtime transcriptie verbonden.", "success");
          return;
        }

        if (payload.type === "transcript.final") {
          const seg = payload.segment || {};
          const text = String(seg.text || "").trim();
          if (!text) return;
          const next = {
            id: String(seg.id || `${sessionId}-rt-${Date.now()}`),
            start: Number(seg.start || 0),
            end: Number(seg.end || seg.start || 0),
            text,
            speaker: String(seg.speaker || "spreker-1").trim() || "spreker-1",
          };
          segments.push(next);
          renderSegments();
          setStatus("Live transcriptie bijgewerkt.", "success");
          return;
        }

        if (payload.type === "error") {
          setStatus(`Realtime fout: ${String(payload.error || "Onbekende fout")}`, "error");
        }
      });

      ws.addEventListener("close", () => {
        if (running) {
          setStatus("Realtime verbinding gesloten.", "error");
        }
      });

      ws.addEventListener("error", () => {
        setStatus("Realtime verbinding mislukt.", "error");
      });
    }

    async function sendChunk(blob, index) {
      if (!webhook) {
        setStatus("Webhook ontbreekt. Stel een geldige transcriptie-webhook in bij de app-configuratie.", "error");
        return;
      }

      if (!blob || blob.size < 800) return;

      try {
        const normalizedBlob = await normalizeAudioBlobForTranscription(blob);
        const audioBase64 = await blobToBase64(normalizedBlob);
        const resp = await fetch(webhook, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(webhookToken ? { "x-govchat-token": webhookToken } : {}),
          },
          body: JSON.stringify({
            audio_base64: audioBase64,
            mime_type: normalizedBlob?.type || blob.type || "audio/webm",
            chunk_index: index,
            session_id: sessionId,
            model,
            language: selectedLanguage,
            prompt: buildPromptForChunk(),
          }),
        });

        const rawBody = await resp.text();
        let payload;
        try {
          payload = rawBody ? JSON.parse(rawBody) : {};
        } catch {
          payload = { text: rawBody };
        }
        if (!resp.ok) {
          throw new Error(String(payload?.error || payload?.message || `HTTP ${resp.status}`));
        }

        const fallbackText = String(payload?.text || payload?.transcript || "").trim();
        const incoming = Array.isArray(payload?.segments) ? payload.segments : [];
        const normalized = incoming.length
          ? incoming
              .map((seg, i) => ({
                id: `${sessionId}-${index}-${i}`,
                start: Number(seg.start || seg.start_sec || 0),
                end: Number(seg.end || seg.end_sec || seg.start || 0),
                text: String(seg.text || "").trim(),
              }))
              .filter((s) => s.text)
          : fallbackText
          ? [
              {
                id: `${sessionId}-${index}-0`,
                start: timelineCursorSec,
                end: timelineCursorSec + Math.max(0.3, chunkMaxMs / 1000),
                text: fallbackText,
              },
            ]
          : [];

        if (normalized.length) {
          const chunkText = normalized.map((s) => String(s.text || "").trim()).filter(Boolean).join(" ").trim();
          if (!chunkText) return;
          const mergedText = mergeChunkText(lastMergedText, chunkText);
          const appended = mergedText.slice(lastMergedText.length).trim();
          lastMergedText = mergedText;
          updatePromptMemory(mergedText);
          if (!appended) return;
          const start = timelineCursorSec;
          const end = Math.max(start + 0.2, start + Math.max(0.2, blob.size / 32000));
          timelineCursorSec = end;
          segments.push({
            id: `${sessionId}-${index}-merged`,
            start,
            end,
            text: appended,
          });
          renderSegments();
          updateActiveSessionPreview();
          setStatus("Live transcriptie bijgewerkt.", "success");
        }
      } catch (err) {
        setStatus(`Chunk ${index} mislukt: ${err.message}`, "error");
      }
    }

    function stopWave() {
      if (waveAnim) cancelAnimationFrame(waveAnim);
      waveAnim = 0;
    }

    function drawWave() {
      if (!analyser || !waveCanvas) return;
      const ctx = waveCanvas.getContext("2d");
      if (!ctx) return;
      const w = waveCanvas.width;
      const h = waveCanvas.height;
      const data = new Uint8Array(analyser.frequencyBinCount);

      const loop = () => {
        analyser.getByteFrequencyData(data);
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "rgba(37,99,235,.10)";
        ctx.fillRect(0, 0, w, h);

        const bars = 96;
        const step = Math.floor(data.length / bars) || 1;
        const barW = w / bars;

        for (let i = 0; i < bars; i++) {
          const v = data[i * step] / 255;
          const bh = Math.max(4, v * (h - 10));
          const x = i * barW;
          const y = (h - bh) / 2;
          ctx.fillStyle = `rgba(${25 + Math.floor(180 * v)}, ${99 + Math.floor(80 * v)}, 235, 0.95)`;
          ctx.fillRect(x + 1, y, Math.max(2, barW - 2), bh);
        }
        waveAnim = requestAnimationFrame(loop);
      };

      loop();
    }

    async function refreshDevices() {
      if (!deviceSelect) return;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const inputs = devices.filter((d) => d.kind === "audioinput");
        if (!inputs.length) {
          deviceSelect.innerHTML = '<option value="">Geen microfoon gevonden</option>';
          setStatus("Geen microfoon gevonden. Controleer apparaat, browser-permissies of kies Systeemgeluid.", "info");
          return;
        }
        deviceSelect.innerHTML = inputs
          .map((d, i) => `<option value="${escapeAttr(d.deviceId)}">${escapeHTML(d.label || `Microfoon ${i + 1}`)}</option>`)
          .join("");
      } catch {
        deviceSelect.innerHTML = '<option value="">Microfoonlijst niet beschikbaar</option>';
      }
    }

    async function startRecording() {
      if (running) return;
      if (!realtimeEnabled && !webhook) {
        setStatus("Transcriptie-webhook ontbreekt in appconfiguratie.", "error");
        return;
      }

      try {
        const mode = sourceMode();
        if (mode === "system") {
          captureStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: true,
          });
          const audioTracks = captureStream.getAudioTracks();
          if (!audioTracks.length) {
            throw new Error("Geen systeem-audio ontvangen. Kies bij delen een tab/scherm met audio.");
          }
          mediaStream = new MediaStream(audioTracks);
        } else {
          const constraints = {
            audio: deviceSelect?.value ? { deviceId: { exact: deviceSelect.value } } : true,
          };
          mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
          captureStream = null;
        }

        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioCtx.createMediaStreamSource(mediaStream);
        mediaSourceNode = source;
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        drawWave();

        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")
          ? "audio/ogg;codecs=opus"
          : "audio/webm";

        running = true;
        startedAt = Date.now();
        sessionId = `tr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        activeHistorySessionId = `trs-${startedAt}-${Math.random().toString(36).slice(2, 8)}`;
        chunkIndex = 0;
        recordingStartSegmentIndex = segments.length;
        recordingSource = mode;
        recordingLanguage = selectedLanguage;
        recordingDeviceLabel =
          mode === "system"
            ? "Systeemgeluid"
            : String(deviceSelect?.selectedOptions?.[0]?.textContent || "Microfoon").trim() || "Microfoon";

        const draftEntry = {
          id: activeHistorySessionId,
          title: activeSessionPlaceholder,
          createdAt: Number(startedAt || Date.now()),
          updatedAt: Number(startedAt || Date.now()),
          durationMs: 0,
          inputSource: recordingSource === "system" ? "Systeemgeluid" : "Microfoon",
          inputDevice: recordingDeviceLabel || (recordingSource === "system" ? "Systeemgeluid" : "Onbekend"),
          wordCount: 0,
          language: recordingLanguage || selectedLanguage,
          text: "",
          segments: [],
        };
        try {
          await createTranscriptSession(draftEntry);
          historyApiReady = true;
          pendingTitleSessionIds.add(draftEntry.id);
          focusedHistorySessionId = draftEntry.id;
          await refreshSessionHistoryFromServer();
          setStatus("Opname gestart. Sessie is direct opgeslagen; titel volgt automatisch.", "success");
        } catch (err) {
          setStatus(`Opname gestart, maar concept-sessie opslaan mislukte: ${String(err?.message || err)}`, "error");
        }

        if (realtimeEnabled) {
          attachRealtimeWs();

          const bufferSize = 4096;
          processorNode = audioCtx.createScriptProcessor(bufferSize, 1, 1);
          source.connect(processorNode);
          processorNode.connect(audioCtx.destination);
          processorNode.onaudioprocess = (ev) => {
            if (!running || !realtimeWs || realtimeWs.readyState !== WebSocket.OPEN) return;
            const channel = ev.inputBuffer.getChannelData(0);
            if (!channel || !channel.length) return;
            const audio = float32ToBase64Pcm16(channel);
            if (!audio) return;
            realtimeBufferedSinceCommit = true;
            realtimeWs.send(JSON.stringify({ type: "audio.append", audio }));
            scheduleRealtimeCommit();
          };
        }

        const startChunkRecorder = () => {
          if (!mediaStream) return;
          const rec = new MediaRecorder(mediaStream, { mimeType });
          mediaRecorder = rec;
          const parts = [];

          rec.addEventListener("dataavailable", (ev) => {
            if (ev.data && ev.data.size > 0) parts.push(ev.data);
          });

          rec.addEventListener("stop", async () => {
            const nextChunkStart = Date.now();
            const hasAudio = parts.length > 0;
            const blob = hasAudio ? new Blob(parts, { type: mimeType }) : null;
            const idx = hasAudio ? chunkIndex++ : -1;

            chunkStopping = false;
            if (running) {
              chunkStartedAtMs = nextChunkStart;
              lastVoiceAtMs = nextChunkStart;
              voiceSeenInChunk = false;
              startChunkRecorder();
            }

            if (blob) {
              uploadQueue = uploadQueue
                .then(() => sendChunk(blob, idx))
                .catch((err) => {
                  setStatus(`Chunk ${idx} mislukt: ${err?.message || String(err)}`, "error");
                });
            }
          });

          rec.start();
        };

        const requestChunkFlush = ({ force = false } = {}) => {
          if (chunkStopping) return;
          const rec = mediaRecorder;
          if (!rec || rec.state !== "recording") return;
          if (!force && !voiceSeenInChunk) return;
          chunkStopping = true;
          try {
            rec.stop();
          } catch {
            chunkStopping = false;
          }
        };

        chunkStartedAtMs = Date.now();
        lastVoiceAtMs = Date.now();
        voiceSeenInChunk = false;

        const waveData = new Uint8Array(analyser.fftSize);
        vadTimer = setInterval(() => {
          if (!running || !analyser) return;
          analyser.getByteTimeDomainData(waveData);
          let sum = 0;
          for (let i = 0; i < waveData.length; i += 1) {
            const v = (waveData[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / waveData.length);
          const now = Date.now();
          if (rms >= vadThreshold) {
            voiceSeenInChunk = true;
            lastVoiceAtMs = now;
          }

          const elapsed = now - chunkStartedAtMs;
          const silence = now - lastVoiceAtMs;
          if (elapsed >= chunkMaxMs) {
            requestChunkFlush({ force: true });
            return;
          }
          if (voiceSeenInChunk && elapsed >= chunkMinMs && silence >= vadSilenceMs) {
            requestChunkFlush({ force: true });
          }
        }, 120);

        startChunkRecorder();

        timerInterval = setInterval(() => {
          const elapsed = Date.now() - startedAt;
          timerEl.textContent = fmtTimer(elapsed);
          updateActiveSessionPreview();
          if (elapsed > maxDurationMinutes * 60 * 1000) {
            setStatus("Maximale opnameduur bereikt. Opname is gestopt.", "info");
            stopRecording();
          }
        }, 300);

        startBtn.disabled = true;
        stopBtn.disabled = false;
        setStatus(
          "Opname gestart. Slimme chunking (VAD + overlap) is actief...",
          "info",
        );
      } catch (err) {
        setStatus(`Starten mislukt: ${err.message}`, "error");
      }
    }

    function stopRecording() {
      if (!running) return;
      running = false;
      const recorderToStop = mediaRecorder;
      let recorderStoppedPromise = Promise.resolve();
      if (recorderToStop && recorderToStop.state === "recording") {
        recorderStoppedPromise = new Promise((resolve) => {
          let settled = false;
          const done = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          try {
            recorderToStop.addEventListener("stop", done, { once: true });
          } catch {
            // no-op
          }
          setTimeout(done, 1500);
        });
      }
      if (chunkTimer) clearTimeout(chunkTimer);
      chunkTimer = null;
      if (vadTimer) clearInterval(vadTimer);
      vadTimer = null;
      if (realtimeCommitTimer) clearTimeout(realtimeCommitTimer);
      realtimeCommitTimer = null;
      realtimeBufferedSinceCommit = false;
      try {
        recorderToStop?.stop();
      } catch {
        // no-op
      }
      mediaRecorder = null;

      if (realtimeWs) {
        try {
          if (realtimeWs.readyState === WebSocket.OPEN) {
            realtimeWs.send(JSON.stringify({ type: "stop" }));
          }
          realtimeWs.close();
        } catch {
          // no-op
        }
      }
      realtimeWs = null;

      if (processorNode) {
        try {
          processorNode.disconnect();
        } catch {
          // no-op
        }
      }
      processorNode = null;

      if (mediaSourceNode) {
        try {
          mediaSourceNode.disconnect();
        } catch {
          // no-op
        }
      }
      mediaSourceNode = null;

      if (mediaStream) {
        mediaStream.getTracks().forEach((t) => t.stop());
      }
      mediaStream = null;

      if (captureStream) {
        captureStream.getTracks().forEach((t) => t.stop());
      }
      captureStream = null;

      if (audioCtx) {
        audioCtx.close().catch(() => undefined);
      }
      audioCtx = null;
      analyser = null;
      stopWave();

      if (timerInterval) clearInterval(timerInterval);
      timerInterval = null;

      startBtn.disabled = false;
      stopBtn.disabled = true;
      if (activeHistorySessionId) {
        focusedHistorySessionId = activeHistorySessionId;
      }
      renderSessionHistory();
      setStatus("Opname gestopt.", "info");
      recorderStoppedPromise.finally(() => {
        saveSessionSnapshot();
      });
    }

    copyBtn?.addEventListener("click", async () => {
      const text = buildCopyText();
      if (!text.trim()) {
        setStatus("Nog geen transcriptie om te kopiëren.", "info");
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        setStatus("Transcriptie gekopieerd.", "success");
      } catch {
        setStatus("Kopiëren mislukt in deze browser.", "error");
      }
    });

    clearBtn?.addEventListener("click", () => {
      if (running) {
        setStatus("Stop eerst de opname voordat je een nieuwe sessie start.", "info");
        return;
      }
      segments = [];
      promptMemory = "";
      lastMergedText = "";
      timelineCursorSec = 0;
      activeHistorySessionId = "";
      focusedHistorySessionId = "";
      recordingStartSegmentIndex = 0;
      renderSegments();
      renderSessionHistory();
      timerEl.textContent = "00:00";
      setStatus("Nieuwe sessie gestart. Klaar om op te nemen.", "info");
    });

    refreshBtn?.addEventListener("click", refreshDevices);
    sourceSelect?.addEventListener("change", updateSourceUi);
    languageInput?.addEventListener("change", () => {
      selectedLanguage = String(languageInput.value || "").trim() || defaultLanguage;
      updateHint();
    });
    showTsInput?.addEventListener("change", () => {
      showTimestamps = Boolean(showTsInput.checked);
      renderSegments();
    });
    infoBtn?.addEventListener("click", () => {
      if (!smartInfoEl) return;
      const open = smartInfoEl.hidden;
      smartInfoEl.hidden = !open;
      infoBtn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    sessionSortEl?.addEventListener("change", () => {
      currentHistorySort = String(sessionSortEl.value || "newest");
      refreshSessionHistoryFromServer();
    });
    sessionListEl?.addEventListener("click", (ev) => {
      const btn = ev.target?.closest?.("button[data-session-action]");
      if (!btn) return;
      const row = btn.closest("[data-session-id]");
      const id = String(row?.getAttribute("data-session-id") || "").trim();
      if (!id) return;
      focusedHistorySessionId = id;
      renderSessionHistory();
      const action = String(btn.getAttribute("data-session-action") || "").trim();
      if (action === "open") {
        openHistorySession(id);
        return;
      }
      if (action === "rename") {
        renameHistorySession(id);
        return;
      }
      if (action === "retitle") {
        regenerateHistorySessionTitle(id);
        return;
      }
      if (action === "delete") {
        deleteHistorySession(id);
      }
    });
    startBtn?.addEventListener("click", startRecording);
    stopBtn?.addEventListener("click", stopRecording);
    closeBtn?.addEventListener("click", closeModal);
    backBtn?.addEventListener("click", () => openAppOverviewFromMiniApp(container));

    refreshDevices();
    updateSourceUi();
    updateHint();
    renderSessionHistory();
    refreshSessionHistoryFromServer();
    renderSegments();
  }

  function escapeHTML(str) {
    const d = document.createElement("div");
    d.textContent = str || "";
    return d.innerHTML;
  }

  function escapeAttr(str) {
    return (str || "")
      .replace(/&/g, "&amp;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
})();
