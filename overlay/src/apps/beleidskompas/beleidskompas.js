import { escapeHTML, escapeAttr } from "../../shared/html.js";
import { openHelpModal } from "../../shared/help.js";
import {
  sendBeleidskompasChatMessage,
  fetchBeleidskompasHistory,
  listRecentBeleidskompasConversations,
  parseCitationsMetaBlock,
} from "./beleidskompas-api.js";

const BELEIDSKOMPAS_CONVERSATION_STORAGE_KEY = "gc_bk_conversation_id";

/** Reveals `fullText` progressively over ~`durationMs`, calling
 *  `onTick(partialText)` each frame - a client-side typewriter effect,
 *  since the backend delivers the whole answer in one delta (see
 *  extractDeltaText) rather than true token-by-token streaming. Returns a
 *  controller so a caller can jump straight to the full text (`finish()`)
 *  once the authoritative `final` SSE event arrives. */
function typewriterReveal(fullText, onTick, durationMs) {
  const frameMs = 30;
  const frames = Math.max(1, Math.round((durationMs || 700) / frameMs));
  const step = Math.max(1, Math.ceil(fullText.length / frames));
  let shown = 0;
  let done = false;
  let timer = null;

  function tick() {
    if (done) return;
    shown = Math.min(fullText.length, shown + step);
    onTick(fullText.slice(0, shown));
    if (shown < fullText.length) timer = setTimeout(tick, frameMs);
    else done = true;
  }
  timer = setTimeout(tick, frameMs);

  return {
    finish() {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      onTick(fullText);
    },
  };
}

// Iconen uit de vorige Beleidskompas-assistent (Heroicons-paden, zoals daar
// inline gebruikt), zodat de knoppen er hetzelfde uitzien als in die versie.
const BK_ICON = {
  pencil:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>',
  send:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg>',
  chevronLeft:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/></svg>',
  chevronRight:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>',
  chevronDown:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>',
  info:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M12 3a9 9 0 100 18 9 9 0 000-18z"/></svg>',
  chart:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>',
  close:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>',
  back:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M10 19l-7-7 7-7m-7 7h18"/></svg>',
};

// Opens the Beleidskompas screen for `app` (its entry in apps.json).
// `flowConfig` is the published step configuration, `backUrl` is where the
// "Chat" button goes, and `help` holds what the manual needs: its text
// (`data`), the name of the installation (`appName`) and the storage key
// of the "don't show again" setting (`storageKey`). Everything else the
// screen needs, it fetches itself through beleidskompas-api.js.
export function openBeleidskompas(app, { flowConfig, backUrl, help }) {
  if (document.getElementById("gc-bk")) return;

  const cfg = {
    ...(app?.config && typeof app.config === "object" ? app.config : {}),
    ...(flowConfig && typeof flowConfig === "object" ? flowConfig : {}),
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

  let storedConversationId = "";
  try {
    storedConversationId = String(sessionStorage.getItem(BELEIDSKOMPAS_CONVERSATION_STORAGE_KEY) || "").trim();
  } catch (_) {
    storedConversationId = "";
  }

  const state = {
    activeStep: 0,
    conversationId: storedConversationId || null,
    lastMessageId: null,
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

  const container = document.createElement("div");
  container.id = "gc-bk";
  container.innerHTML = `
    <div class="gc-bk-head">
      <div class="gc-mini-head-left">
        <button id="gc-bk-back" class="gc-mini-nav-btn" type="button">← Chat</button>
        <strong>${escapeHTML(String(cfg.title || "Beleidskompas"))}</strong>
      </div>
      <div class="gc-mini-head-left">
        <button id="gc-bk-help" class="gc-mini-nav-btn" type="button">Handleiding</button>
        <button id="gc-bk-view-toggle" class="gc-mini-nav-btn" type="button" aria-pressed="false">Stappenoverzicht</button>
      </div>
    </div>

    <div class="gc-bk-note">
      ${BK_ICON.info}
      <span>${escapeHTML(String(cfg.disclaimer || "Ondersteunend hulpmiddel, geen automatische besluitvorming."))}</span>
    </div>

    <div id="gc-bk-overview" class="gc-bk-overview" hidden>
      <div class="gc-bk-overview-intro">
        <h3>Vier stappen (SiS 4.0)</h3>
        <p>Kies een stap om die uit te werken. Je casus en eerdere uitwerkingen blijven bewaard als je tussen stappen wisselt.</p>
      </div>
      <div id="gc-bk-overview-cards" class="gc-bk-overview-cards"></div>
    </div>

    <div id="gc-bk-workspace" class="gc-bk-grid">
      <aside class="gc-bk-stepper" aria-label="Processtappen">
        <div id="gc-bk-step-groups" class="gc-bk-step-groups"></div>
        <div class="gc-bk-recent-cases">
          <h4>Eerdere casussen</h4>
          <div id="gc-bk-recent-cases-list" class="gc-bk-recent-cases-list"></div>
        </div>
      </aside>

      <section class="gc-bk-card gc-bk-chat">
        <div class="gc-bk-card-head">
          <h2 id="gc-bk-convo-title">Nieuw gesprek</h2>
          <button id="gc-bk-new-chat" class="gc-bk-head-btn" type="button" title="Nieuw gesprek" aria-label="Nieuw gesprek">${BK_ICON.pencil}</button>
        </div>
        <div id="gc-bk-chat-log" class="gc-bk-chat-log" role="log" aria-live="polite" aria-label="Gesprek"></div>
        <div class="gc-bk-chat-compose">
          <div class="gc-bk-compose-field">
            <input id="gc-bk-chat-input" type="text" placeholder="Stel een vraag..." aria-label="Stel een vraag over je casus" />
            <button id="gc-bk-send" type="button" title="Verzenden" aria-label="Verzenden">${BK_ICON.send}</button>
          </div>
        </div>
      </section>

      <section class="gc-bk-card gc-bk-step">
        <div class="gc-bk-card-head">
          <h2 id="gc-bk-form-title"></h2>
          <div class="gc-bk-step-nav">
            <button id="gc-bk-prev" type="button" title="Vorige stap" aria-label="Vorige stap">${BK_ICON.chevronLeft}</button>
            <button id="gc-bk-next" type="button" title="Volgende stap" aria-label="Volgende stap">${BK_ICON.chevronRight}</button>
            <button id="gc-bk-step-info" class="gc-bk-info-badge" type="button" title="Toelichting bij deze stap" aria-label="Toelichting bij deze stap">i</button>
          </div>
        </div>
        <div class="gc-bk-step-body">
          <div id="gc-bk-form-short" class="gc-bk-form-short"></div>
          <div id="gc-bk-report-status" class="gc-bk-step-status"></div>
          <div id="gc-bk-report-body" class="gc-bk-step-text"></div>
          <div id="gc-bk-report-sources" class="gc-bk-citations"></div>
          <div id="gc-bk-report-meta" class="gc-bk-step-meta"></div>
        </div>
        <div class="gc-bk-step-foot">
          <button id="gc-bk-save-step" type="button">Markeer stap gereed</button>
          <button id="gc-bk-next-step" type="button">Volgende stap</button>
        </div>
      </section>
    </div>`;

  document.body.appendChild(container);

  const backBtn = document.getElementById("gc-bk-back");
  const newChatBtn = document.getElementById("gc-bk-new-chat");
  const convoTitleEl = document.getElementById("gc-bk-convo-title");
  const stepInfoBtn = document.getElementById("gc-bk-step-info");
  const overviewEl = document.getElementById("gc-bk-overview");
  const overviewCardsEl = document.getElementById("gc-bk-overview-cards");
  const workspaceEl = document.getElementById("gc-bk-workspace");
  const viewToggleBtn = document.getElementById("gc-bk-view-toggle");
  const stepGroupsEl = document.getElementById("gc-bk-step-groups");
  const recentCasesListEl = document.getElementById("gc-bk-recent-cases-list");
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
      .map((m, idx) => {
        const isUser = m.role === "user";
        return `
          <div class="gc-bk-msg-row ${isUser ? "is-user" : "is-assistant"}">
            <div class="gc-bk-msg-col">
              <div class="gc-bk-msg">
                ${isUser
                  ? ""
                  : `<div class="gc-bk-msg-author"><span class="gc-bk-msg-avatar">${BK_ICON.chart}</span><span class="gc-bk-msg-name">Beleidskompas</span></div>`}
                <div class="gc-bk-msg-text">${
                  m.pending && !m.text
                    ? '<span class="gc-bk-typing-dots"><span></span><span></span><span></span></span>'
                    : messageBodyHTML(m)
                }</div>
                ${Array.isArray(m.citations) && m.citations.length
                  ? `<div class="gc-bk-citations">${m.citations.map(citationButtonHTML).join("")}</div>`
                  : ""}
                ${!isUser && !m.pending && m.text ? feedbackHTML(m, idx) : ""}
              </div>
              <div class="gc-bk-msg-time">${escapeHTML(formatTime(m.ts))}</div>
            </div>
          </div>`;
      })
      .join("");
    chatLogEl.scrollTop = chatLogEl.scrollHeight;
  }

  /** Beleidskompas levert platte tekst met "## kop"-regels en **vet**. Net
   *  als de vorige versie wordt die lichte opmaak omgezet, zodat de
   *  uitwerking leesbaar is in plaats van ruwe markdown.
   *
   *  De regeleindes van het model moeten blijven staan, maar de opmaak van
   *  de omliggende HTML-templates juist niet - daarom staat pre-wrap alleen
   *  op deze .gc-bk-pre-wrapper en niet op de containers eromheen. */
  function formatRichText(text) {
    const formatted = escapeHTML(String(text || ""))
      .replace(/^#{1,6}\s*(.+)$/gm, '<span class="gc-bk-rich-h">$1</span>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    return `<span class="gc-bk-pre">${formatted}</span>`;
  }

  /** De uitwerking heeft een vaste opbouw (composeAnswerText in logic.js):
   *  optioneel een demo-waarschuwing, dan "## kop"-secties waarvan publiek/
   *  provinciaal belang met "Oordeel: ..." beginnen, en na een "---"-regel de
   *  disclaimer. Die opbouw wordt hier ontleed zodat het stappanel oordelen
   *  als badge kan tonen in plaats van één lap tekst. Geeft null terug als de
   *  tekst niet die vorm heeft (bijv. een foutmelding). */
  function parseAdvice(text) {
    const raw = String(text || "").trim();
    if (!raw) return null;

    let body = raw;
    let disclaimer = "";
    const sepIdx = body.lastIndexOf("\n---\n");
    if (sepIdx > -1) {
      disclaimer = body.slice(sepIdx + 5).trim();
      body = body.slice(0, sepIdx);
    }

    const intro = [];
    const sections = [];
    let current = null;
    body.split("\n").forEach((line) => {
      const heading = /^#{2,6}\s*(.+)$/.exec(line);
      if (heading) {
        current = { heading: heading[1].trim(), lines: [] };
        sections.push(current);
        return;
      }
      (current ? current.lines : intro).push(line);
    });
    if (!sections.length) return null;

    const introText = intro.join("\n").trim();
    return {
      isDemo: introText.startsWith("⚠️"),
      disclaimer,
      sections: sections.map((s) => {
        let sectionText = s.lines.join("\n").trim();
        const verdictMatch = /^\**Oordeel:?\**\s*(.+)$/im.exec(sectionText);
        if (verdictMatch) sectionText = sectionText.replace(verdictMatch[0], "").trim();
        return {
          heading: s.heading,
          text: sectionText,
          verdict: verdictMatch ? verdictMatch[1].replaceAll("*", "").trim() : "",
        };
      }),
    };
  }

  function verdictClass(verdict) {
    const v = String(verdict || "").toLowerCase();
    if (v.startsWith("ja")) return "is-yes";
    if (v.startsWith("nee")) return "is-no";
    return "is-unclear";
  }

  /** Verwijs naar het specialistenteam als de casus niet eenduidig te
   *  beoordelen is. Dit is een signaal van de interface op basis van de
   *  oordelen en het aantal openstaande aannames - geen uitspraak van het
   *  model zelf, dus ook zo benoemd in de tekst van de callout. */
  function needsSpecialistTeam(advice) {
    if (!advice) return false;
    const verdicts = advice.sections.map((s) => String(s.verdict || "").toLowerCase()).filter(Boolean);
    if (verdicts.some((v) => !v.startsWith("ja"))) return true;
    const assumptions = advice.sections.find((s) => /aannames/i.test(s.heading));
    const openItems = assumptions
      ? assumptions.text.split("\n").filter((l) => l.trim().startsWith("-") && !/geen\s*$/i.test(l.trim())).length
      : 0;
    return openItems >= 3;
  }

  function adviceHTML(advice) {
    const collapsedByDefault = (heading) => /redenering|aannames/i.test(heading);
    const blocks = advice.sections
      // De bronnenlijst staat in het bericht zelf (voor de gewone
      // LibreChat-weergave); hier tonen de aanklikbare bronchips die al.
      .filter((s) => !/^bronnen$/i.test(s.heading) && s.text)
      .map((s) => {
        const open = collapsedByDefault(s.heading) ? "" : " open";
        const badge = s.verdict
          ? `<span class="gc-bk-verdict ${verdictClass(s.verdict)}">${escapeHTML(s.verdict)}</span>`
          : "";
        return `<details class="gc-bk-advice-block"${open}><summary><span class="gc-bk-advice-heading">${escapeHTML(
          s.heading,
        )}</span>${badge}</summary><div class="gc-bk-advice-text">${formatRichText(s.text)}</div></details>`;
      })
      .join("");

    const demoBadge = advice.isDemo
      ? '<div class="gc-bk-advice-demo" role="status">Demo-uitvoer: deterministische placeholder, geen AI-beoordeling.</div>'
      : "";
    const specialist =
      needsSpecialistTeam(advice) && specialistTeam
        ? `<div class="gc-bk-specialist"><strong>Niet eenduidig beoordeeld.</strong> ${escapeHTML(specialistTeam)}</div>`
        : "";
    const disclaimer = advice.disclaimer
      ? `<p class="gc-bk-advice-disclaimer">${escapeHTML(advice.disclaimer)}</p>`
      : "";

    return `${demoBadge}${specialist}<div class="gc-bk-advice">${blocks}</div>${disclaimer}`;
  }

  /** Waardering per antwoord, anoniem verstuurd (geen gebruiker of
   *  casus-id) naar de admin-overlay, waar beheerders het terugzien.
   *  Een toelichting is optioneel en verschijnt na een duim. */
  function feedbackHTML(message, index) {
    if (message.feedbackSent) {
      return '<div class="gc-bk-feedback is-sent">Bedankt, je anonieme feedback is opgeslagen.</div>';
    }
    return `
      <div class="gc-bk-feedback" data-feedback-for="${index}">
        ${message.feedbackError ? `<span class="gc-bk-feedback-label">Versturen mislukt (${escapeHTML(message.feedbackError)}), probeer opnieuw.</span>` : ""}
        <span class="gc-bk-feedback-label">Was dit bruikbaar?</span>
        <button type="button" class="gc-bk-feedback-btn ${message.feedbackRating === "up" ? "is-chosen" : ""}" data-feedback-rating="up" aria-label="Wel bruikbaar">👍</button>
        <button type="button" class="gc-bk-feedback-btn ${message.feedbackRating === "down" ? "is-chosen" : ""}" data-feedback-rating="down" aria-label="Niet bruikbaar">👎</button>
        ${message.feedbackRating
          ? `<input type="text" class="gc-bk-feedback-comment" placeholder="Toelichting (optioneel, anoniem)" aria-label="Toelichting bij je feedback" maxlength="2000" />
             <button type="button" class="gc-bk-feedback-send" data-feedback-send="1">Versturen</button>`
          : ""}
      </div>`;
  }

  async function submitFeedback(message, comment) {
    try {
      const resp = await fetch("/govchat-api/beleidskompas-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rating: message.feedbackRating,
          comment: String(comment || ""),
          step_id: activeStep().id,
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      message.feedbackSent = true;
    } catch (err) {
      message.feedbackError = String(err?.message || err);
    }
    renderChat();
  }

  /** De volledige uitwerking staat rechts in het stappanel; in het gesprek
   *  blijft alleen de samenvatting staan, met de rest achter een uitklapper.
   *  Anders staat dezelfde lap tekst twee keer naast elkaar. */
  function messageBodyHTML(message) {
    if (message.role !== "assistant") return formatRichText(message.text);
    const advice = parseAdvice(message.text);
    if (!advice) return formatRichText(message.text);
    const summary = advice.sections.find((s) => /samenvatting/i.test(s.heading)) || advice.sections[0];
    // Bronnen staan al als aanklikbare chips onder het bericht.
    const rest = advice.sections.filter((s) => s !== summary && !/^bronnen$/i.test(s.heading) && s.text);
    if (!rest.length) return formatRichText(summary.text);
    const restHTML = rest
      .map((s) => {
        const badge = s.verdict
          ? ` <span class="gc-bk-verdict ${verdictClass(s.verdict)}">${escapeHTML(s.verdict)}</span>`
          : "";
        return `<p class="gc-bk-msg-more-head"><span class="gc-bk-rich-h">${escapeHTML(s.heading)}</span>${badge}</p>${formatRichText(s.text)}`;
      })
      .join("");
    return `${formatRichText(summary.text)}<details class="gc-bk-msg-more"><summary>Volledige uitwerking</summary><div>${restHTML}</div></details>`;
  }

  function citationButtonHTML(c) {
    return `<button type="button" class="gc-bk-citation-btn" data-doc-id="${escapeAttr(c.id)}" data-doc-filename="${escapeAttr(
      c.filename,
    )}" data-doc-score="${escapeAttr(String(c.score || 0))}" data-doc-tags="${escapeAttr(
      (c.tags || []).join(", "),
    )}" data-doc-preview="${escapeAttr(c.preview || "")}" title="${escapeAttr(
      c.filename,
    )}"><span class="gc-bk-citation-file">${escapeHTML(c.filename)}</span><span class="gc-bk-citation-meta">${escapeHTML(
      citationLabel(c),
    )}</span></button>`;
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
    wireModal(modal);
  }

  /** Een modal moet met Escape te sluiten zijn, de focus krijgen bij
   *  openen en die teruggeven aan het element dat hem opende. */
  function wireModal(modal) {
    const previousFocus = document.activeElement;
    const close = () => {
      document.removeEventListener("keydown", onKeyDown);
      modal.remove();
      if (previousFocus && typeof previousFocus.focus === "function") previousFocus.focus();
    };
    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    modal.querySelector(".gc-bk-doc-close")?.addEventListener("click", close);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) close();
    });
    modal.querySelector(".gc-bk-doc-close")?.focus();
  }

  /** Overzichtspagina van het vier-stappenplan met doorklik naar
   *  de uitwerking per stap. Status komt uit dezelfde state als de stepper,
   *  dus wisselen van stap raakt de casus niet kwijt. */
  function renderOverview() {
    if (!overviewCardsEl) return;
    overviewCardsEl.innerHTML = steps
      .map((s, idx) => {
        const done = Boolean(String(state.steps[s.id]?.report_text || "").trim());
        const isActive = idx === state.activeStep;
        const status = done ? "Uitgewerkt" : isActive ? "Actief" : "Open";
        const statusClass = done ? "is-done" : isActive ? "is-active" : "";
        return `
          <button type="button" class="gc-bk-overview-card ${statusClass}" data-overview-step="${idx}">
            <span class="gc-bk-overview-nr">Stap ${escapeHTML(String(s.nr))}</span>
            <span class="gc-bk-overview-title">${escapeHTML(s.title)}</span>
            <span class="gc-bk-overview-short">${escapeHTML(s.short || "")}</span>
            <span class="gc-bk-overview-status ${statusClass}">${status}</span>
          </button>`;
      })
      .join("");

    overviewCardsEl.querySelectorAll("[data-overview-step]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-overview-step"));
        if (!Number.isFinite(idx)) return;
        persistActiveStep();
        state.activeStep = Math.max(0, Math.min(steps.length - 1, idx));
        renderStepGroups();
        renderStepForm();
        setView("workspace");
      });
    });
  }

  function setView(view) {
    const isOverview = view === "overview";
    if (overviewEl) overviewEl.hidden = !isOverview;
    if (workspaceEl) workspaceEl.hidden = isOverview;
    if (viewToggleBtn) {
      viewToggleBtn.textContent = isOverview ? "Naar de uitwerking" : "Stappenoverzicht";
      viewToggleBtn.setAttribute("aria-pressed", isOverview ? "true" : "false");
    }
    if (isOverview) renderOverview();
  }

  /** Stepper zoals in de vorige versie: per stap een inklapbare kop met
   *  daaronder de titel en de checkvragen. De actieve stap staat open en
   *  is amber; stappen met een uitwerking zijn groen. */
  function renderStepGroups() {
    if (!stepGroupsEl) return;
    stepGroupsEl.innerHTML = steps
      .map((s, idx) => {
        const isActive = idx === state.activeStep;
        const isDone = Boolean(String(state.steps[s.id]?.report_text || "").trim());
        const classes = ["gc-bk-step-group"];
        if (isActive) classes.push("is-open", "is-active");
        if (isDone && !isActive) classes.push("is-done");
        const questions = Array.isArray(s.help) ? s.help : [];
        return `
          <section class="${classes.join(" ")}">
            <button type="button" class="gc-bk-step-group-head" data-step-index="${idx}" aria-expanded="${isActive ? "true" : "false"}" aria-controls="gc-bk-step-items-${idx}">
              <span>Stap ${escapeHTML(String(s.nr))}${isDone ? " ✓" : ""}</span>
              ${BK_ICON.chevronDown}
            </button>
            <div class="gc-bk-step-group-items" id="gc-bk-step-items-${idx}">
              <button type="button" class="gc-bk-step-link is-title" data-step-info="${idx}" title="Toelichting bij deze stap">${escapeHTML(s.title)}</button>
              ${questions
                .map(
                  (q) =>
                    `<button type="button" class="gc-bk-step-link" data-step-info="${idx}" title="${escapeAttr(q)}">${escapeHTML(q)}</button>`,
                )
                .join("")}
            </div>
          </section>`;
      })
      .join("");

    stepGroupsEl.querySelectorAll("[data-step-index]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-step-index"));
        if (!Number.isFinite(idx)) return;
        persistActiveStep();
        state.activeStep = Math.max(0, Math.min(steps.length - 1, idx));
        renderStepGroups();
        renderStepForm();
      });
    });
    stepGroupsEl.querySelectorAll("[data-step-info]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = Number(btn.getAttribute("data-step-info"));
        if (Number.isFinite(idx)) openStepInfo(steps[idx]);
      });
    });
    // Stepper en overzicht tonen dezelfde status; samen bijwerken.
    renderOverview();
  }

  /** Toelichting per stap (info, checkvragen, diepere vragen). Hergebruikt
   *  de modal-opmaak van de bronpreview. */
  function openStepInfo(step) {
    if (!step) return;
    const existing = document.getElementById("gc-bk-doc-preview");
    if (existing) existing.remove();

    const list = (items) =>
      Array.isArray(items) && items.length
        ? `<ul>${items.map((i) => `<li>${escapeHTML(i)}</li>`).join("")}</ul>`
        : "<p>-</p>";

    const modal = document.createElement("div");
    modal.id = "gc-bk-doc-preview";
    modal.className = "gc-bk-doc-modal";
    modal.innerHTML = `
      <div class="gc-bk-doc-dialog" role="dialog" aria-modal="true" aria-label="Toelichting bij de stap">
        <div class="gc-bk-doc-head">
          <div>
            <div class="gc-bk-doc-title">Stap ${escapeHTML(String(step.nr))} · ${escapeHTML(step.title)}</div>
            <div class="gc-bk-doc-meta">${escapeHTML(step.short || "")}</div>
          </div>
          <button type="button" class="gc-bk-doc-close" aria-label="Sluiten">✕</button>
        </div>
        <div class="gc-bk-doc-body is-rich">
          <h5>Waar gaat deze stap over?</h5>
          <p>${escapeHTML(step.info || "-")}</p>
          <h5>Checkvragen</h5>
          ${list(step.help)}
          <h5>Diepere vragen</h5>
          ${list(step.deep)}
        </div>
      </div>`;
    document.body.appendChild(modal);
    wireModal(modal);
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
      reportStatusEl.textContent = data.report_text ? `Uitwerking beschikbaar voor stap ${step.nr}.` : "";
    }
    if (reportBodyEl) {
      const hasReport = Boolean(String(data.report_text || "").trim());
      const advice = hasReport ? parseAdvice(data.report_text) : null;
      if (advice) reportBodyEl.innerHTML = adviceHTML(advice);
      else if (hasReport) reportBodyEl.innerHTML = formatRichText(data.report_text);
      else reportBodyEl.textContent = "Begin met het invoeren van een casus en start het proces. De uitwerking van deze stap verschijnt hier.";
      reportBodyEl.classList.toggle("is-placeholder", !hasReport);
    }
    if (reportMetaEl) {
      const trace = data.retrieval_trace || null;
      const tsText = data.updated_at ? ` · bijgewerkt: ${formatTime(data.updated_at)}` : "";
      reportMetaEl.textContent = trace
        ? `RAG: ${String(trace.algorithm || "-")} · top_k: ${Number(trace.top_k || 0)} · matched_docs: ${Number(
            trace.matched_docs || 0,
          )}${tsText}`
        : "";
    }
    if (reportSourcesEl) {
      const citations = normalizeCitations(data.citations);
      reportSourcesEl.innerHTML = citations.map(citationButtonHTML).join("");
    }
    if (prevBtn) prevBtn.disabled = state.activeStep <= 0;
    if (nextBtn) nextBtn.disabled = state.activeStep >= steps.length - 1;
    if (nextStepBtn) nextStepBtn.disabled = state.activeStep >= steps.length - 1;
  }

  function persistActiveStep() {
    const step = activeStep();
    if (!state.steps[step.id]) state.steps[step.id] = initialStepState();
  }

  function persistConversationId(conversationId) {
    state.conversationId = conversationId || null;
    try {
      if (conversationId) sessionStorage.setItem(BELEIDSKOMPAS_CONVERSATION_STORAGE_KEY, conversationId);
      else sessionStorage.removeItem(BELEIDSKOMPAS_CONVERSATION_STORAGE_KEY);
    } catch (_) {
      // sessionStorage unavailable (private mode etc.) - conversation still
      // works for this page view, it just won't survive a reload.
    }
  }

  async function requestHoofdagent(userText, onDelta) {
    const step = activeStep();
    const d = state.steps[step.id] || initialStepState();
    const priorReports = steps
      .slice(0, state.activeStep)
      .map((s) => String(state.steps[s.id]?.report_text || "").trim())
      .filter(Boolean)
      .join("\n\n");

    // Beleidskompas is a real LibreChat custom endpoint now (govchat-beleidskompas):
    // the only channel to the backend is the chat message's plain text, so the
    // structured context (step, prior reports, sources) is composed into one
    // labeled blob rather than sent as separate JSON fields.
    const lines = [`Stap: ${step.id} (${step.title})`];
    if (priorReports || d.report_text) lines.push(`Casus/eerdere bevindingen: ${String(priorReports || d.report_text).trim()}`);
    if (defaultSources.length) lines.push(`Bekende bronnen: ${defaultSources.join("; ")}`);
    lines.push(`Vraag: ${String(userText || "").trim()}`);
    const composedText = lines.join("\n");

    const result = await sendBeleidskompasChatMessage({
      text: composedText,
      conversationId: state.conversationId,
      parentMessageId: state.lastMessageId,
      onDelta,
    });

    if (!result.text) throw new Error("Beleidskompas gaf geen antwoord terug");
    if (result.conversationId && result.conversationId !== state.conversationId) {
      persistConversationId(result.conversationId);
    }
    if (result.messageId) state.lastMessageId = result.messageId;

    // Citations/retrieval_trace survive the real chat pipeline via an
    // invisible trailing block in the message text (parseCitationsMetaBlock),
    // since n8n-openai-bridge only forwards plain text between LibreChat
    // and n8n otherwise.
    return { answer: result.text, citations: result.citations, retrieval_trace: result.retrieval_trace };
  }

  function setComposerDisabled(disabled) {
    if (sendBtn) sendBtn.disabled = disabled;
    if (chatInputEl) chatInputEl.disabled = disabled;
  }

  async function sendUserMessage() {
    const text = String(chatInputEl?.value || "").trim();
    if (!text || sendBtn?.disabled) return;
    addMessage("user", text);
    if (chatInputEl) chatInputEl.value = "";
    persistActiveStep();
    setComposerDisabled(true);

    // Pending assistant bubble: shows typing dots immediately, then gets
    // filled in by a client-side typewriter reveal as soon as the answer
    // text is available (ahead of the final/persisted SSE event) - the
    // backend delivers one blocking response, not real token streaming,
    // so this is a simulated reveal rather than true incremental data.
    state.messages.push({ role: "assistant", text: "", ts: new Date().toISOString(), citations: [], retrieval_trace: null, pending: true });
    const pendingMessage = state.messages[state.messages.length - 1];
    renderChat();

    // Whether on_message_delta events carry the full text-so-far or a
    // small incremental fragment varies between runs (observed both), so
    // each delta is merged defensively: treated as the new full snapshot
    // if it extends what's already shown, otherwise appended.
    let reveal = null;
    let accumulatedDeltaText = "";
    const onDelta = (deltaText) => {
      accumulatedDeltaText = deltaText.startsWith(accumulatedDeltaText) ? deltaText : accumulatedDeltaText + deltaText;
      if (reveal) reveal.finish();
      reveal = typewriterReveal(accumulatedDeltaText, (shownText) => {
        pendingMessage.text = shownText;
        renderChat();
      });
    };

    try {
      const result = await requestHoofdagent(text, onDelta);
      if (reveal) reveal.finish();
      pendingMessage.pending = false;
      pendingMessage.text = String(result.answer || "").trim();
      pendingMessage.citations = normalizeCitations(result.citations);
      pendingMessage.retrieval_trace = result.retrieval_trace || null;
      const step = activeStep();
      state.steps[step.id] = {
        report_text: pendingMessage.text,
        citations: pendingMessage.citations,
        retrieval_trace: pendingMessage.retrieval_trace,
        updated_at: new Date().toISOString(),
      };
      renderChat();
      renderStepGroups();
      renderStepForm();
      renderRecentCases();
    } catch (err) {
      if (reveal) reveal.finish();
      pendingMessage.pending = false;
      pendingMessage.text = `Beleidskompas niet bereikbaar of fout: ${String(err?.message || err)}. Probeer het opnieuw of open een nieuwe chat.`;
      renderChat();
    } finally {
      setComposerDisabled(false);
      chatInputEl?.focus();
    }
  }

  backBtn?.addEventListener("click", () => {
    window.location.href = backUrl;
  });
  stepInfoBtn?.addEventListener("click", () => openStepInfo(activeStep()));
  viewToggleBtn?.addEventListener("click", () => setView(overviewEl?.hidden ? "overview" : "workspace"));
  // De algemene handleiding (met het Beleidskompas-hoofdstuk) is vanuit
  // de app zelf bereikbaar - de zwevende hulpknop valt achter deze overlay.
  document.getElementById("gc-bk-help")?.addEventListener("click", () => {
    openHelpModal(help.data, { appName: help.appName, storageKey: help.storageKey });
  });
  newChatBtn?.addEventListener("click", () => {
    persistConversationId(null);
    state.lastMessageId = null;
    state.steps = {};
    steps.forEach((s) => {
      state.steps[s.id] = initialStepState();
    });
    state.activeStep = 0;
    state.messages = [
      {
        role: "assistant",
        text: "Nieuwe sessie gestart. Beschrijf je casus en we lopen de stappen samen door.",
        ts: new Date().toISOString(),
        citations: [],
        retrieval_trace: null,
      },
    ];
    setConversationTitle("");
    renderChat();
    renderStepGroups();
    renderStepForm();
    renderRecentCases();
  });
  sendBtn?.addEventListener("click", sendUserMessage);
  chatInputEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendUserMessage();
    }
  });
  chatLogEl?.addEventListener("click", (e) => {
    if (e.target && typeof e.target.closest === "function") {
      const feedbackRow = e.target.closest("[data-feedback-for]");
      const ratingBtn = e.target.closest("[data-feedback-rating]");
      const sendBtnEl = e.target.closest("[data-feedback-send]");
      if (feedbackRow && (ratingBtn || sendBtnEl)) {
        const message = state.messages[Number(feedbackRow.getAttribute("data-feedback-for"))];
        if (!message) return;
        if (ratingBtn) {
          message.feedbackRating = ratingBtn.getAttribute("data-feedback-rating");
          message.feedbackError = "";
          renderChat();
          return;
        }
        const comment = feedbackRow.querySelector(".gc-bk-feedback-comment")?.value || "";
        submitFeedback(message, comment);
        return;
      }
    }
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

  /** Loads a case's full history into the current view - shared by the
   *  "resume on reopen" path and clicking an entry in "Eerdere casussen". */
  async function resumeConversation(conversationId) {
    const history = await fetchBeleidskompasHistory(conversationId);
    persistConversationId(conversationId);
    if (!history.length) {
      state.messages = [];
      state.lastMessageId = null;
      renderChat();
      renderStepForm();
      return;
    }
    state.messages = history.map((m) => ({
      role: m.role,
      text: m.text,
      ts: m.ts,
      citations: normalizeCitations(m.citations),
      retrieval_trace: m.retrieval_trace || null,
    }));
    const lastUser = history.filter((m) => m.role === "user").slice(-1)[0];
    const lastAssistant = history.filter((m) => m.role === "assistant").slice(-1)[0];
    state.lastMessageId = (lastAssistant || lastUser || {}).messageId || null;
    if (lastAssistant) {
      const step = activeStep();
      state.steps[step.id] = {
        report_text: lastAssistant.text,
        citations: normalizeCitations(lastAssistant.citations),
        retrieval_trace: lastAssistant.retrieval_trace || null,
        updated_at: lastAssistant.ts,
      };
    }
    renderChat();
    renderStepGroups();
    renderStepForm();
  }

  /** Kop van de gesprekskaart: de door LibreChat gegenereerde casustitel
   *  zodra die er is, anders "Nieuw gesprek". */
  function setConversationTitle(title) {
    if (!convoTitleEl) return;
    const clean = String(title || "").trim();
    convoTitleEl.textContent = clean || "Nieuw gesprek";
    convoTitleEl.title = clean;
  }

  function formatRelativeCaseDate(iso) {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleString("nl-NL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    } catch (_) {
      return "";
    }
  }

  async function renderRecentCases() {
    if (!recentCasesListEl) return;
    try {
      const cases = await listRecentBeleidskompasConversations(8);
      if (!cases.length) {
        recentCasesListEl.innerHTML = '<div class="gc-bk-recent-cases-empty">Nog geen eerdere casussen.</div>';
        return;
      }
      const current = cases.find((c) => c.conversationId === state.conversationId);
      if (current) setConversationTitle(current.title);
      recentCasesListEl.innerHTML = cases
        .map((c) => {
          const isActive = c.conversationId === state.conversationId;
          return `<button type="button" class="gc-bk-recent-case-link ${isActive ? "is-active" : ""}" data-conversation-id="${escapeAttr(c.conversationId)}" title="${escapeAttr(c.title)}">${escapeHTML(formatRelativeCaseDate(c.updatedAt))} · ${escapeHTML(c.title.slice(0, 60))}</button>`;
        })
        .join("");
      recentCasesListEl.querySelectorAll("[data-conversation-id]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const conversationId = btn.getAttribute("data-conversation-id");
          if (!conversationId || conversationId === state.conversationId) return;
          persistActiveStep();
          try {
            await resumeConversation(conversationId);
            await renderRecentCases();
          } catch (err) {
            addMessage("assistant", `Kon deze casus niet laden (${String(err?.message || err)}).`);
          }
        });
      });
    } catch (err) {
      recentCasesListEl.innerHTML = '<div class="gc-bk-recent-cases-empty">Kon casuslijst niet laden.</div>';
    }
  }

  renderStepGroups();
  renderChat();
  renderStepForm();
  renderRecentCases();
  // Een nieuwe sessie begint op de overzichtspagina; wordt een casus
  // hervat, dan meteen in de uitwerking zodat je verder kunt waar je was.
  setView(state.conversationId ? "workspace" : "overview");

  // Resume a previously-persisted case (real LibreChat conversation) if one
  // was left open in this browser tab/session, instead of always starting
  // from an empty chat log.
  if (state.conversationId) {
    resumeConversation(state.conversationId).catch((err) => {
      // Stored conversation is gone/inaccessible (deleted, session
      // expired) - clear it and let the user start a fresh case instead
      // of silently failing on every future message.
      persistConversationId(null);
      addMessage("assistant", `Kon vorige casus niet laden (${String(err?.message || err)}). Start een nieuwe chat.`);
    });
  }
}
