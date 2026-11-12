const express = require("express");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const sharp = require("sharp");
const { WebSocket, WebSocketServer } = require("ws");
const beleidskompas = require("./lib/beleidskompas");

const app = express();
const PORT = process.env.PORT || 3002;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || "").trim();
const DATA_DIR = process.env.DATA_DIR || "/data";
const PUBLISH_DIR = process.env.PUBLISH_DIR || "/publish";
const SESSION_SECRET = crypto.randomBytes(32).toString("hex");
const IMAGE_JOBS_ENABLED = String(process.env.IMAGE_JOBS_ENABLED || "false").toLowerCase() === "true";
const IMAGE_JOBS_WEBHOOK_URL = String(
  process.env.IMAGE_JOBS_WEBHOOK_URL || "http://n8n:5678/webhook/image-generator",
).trim();
const IMAGE_JOBS_WEBHOOK_TOKEN = String(
  process.env.IMAGE_JOBS_WEBHOOK_TOKEN || process.env.N8N_WEBHOOK_TOKEN || "",
).trim();
const IMAGE_JOBS_CONCURRENCY = Math.max(
  1,
  Number.parseInt(String(process.env.IMAGE_JOBS_CONCURRENCY || "1"), 10) || 1,
);
const IMAGE_JOBS_TTL_HOURS = Math.max(
  1,
  Number.parseInt(String(process.env.IMAGE_JOBS_TTL_HOURS || "24"), 10) || 24,
);
const CRAWLER_N8N_WEBHOOK_URL = String(
  process.env.CRAWLER_N8N_WEBHOOK_URL || "http://n8n:5678/webhook/govcrawler-run",
).trim();
const CRAWLER_N8N_WEBHOOK_TOKEN = String(
  process.env.CRAWLER_N8N_WEBHOOK_TOKEN || process.env.N8N_WEBHOOK_TOKEN || "",
).trim();
const CRAWLER_INTERNAL_TOKEN = String(
  process.env.CRAWLER_INTERNAL_TOKEN || process.env.N8N_WEBHOOK_TOKEN || "",
).trim();
const CRAWLER_RUNS_LIMIT = Math.max(
  10,
  Number.parseInt(String(process.env.CRAWLER_RUNS_LIMIT || "200"), 10) || 200,
);
const REALTIME_STT_TOKEN = String(
  process.env.REALTIME_STT_TOKEN || process.env.N8N_WEBHOOK_TOKEN || "",
).trim();
const REALTIME_STT_PROVIDER_DEFAULT = String(process.env.REALTIME_STT_PROVIDER || "litellm").trim().toLowerCase() || "litellm";
const LITELLM_REALTIME_URL = String(
  process.env.LITELLM_REALTIME_URL || `${String(process.env.LITELLM_URL || "http://litellm:4000").replace(/\/$/, "")}/v1/realtime`,
).trim();
const LITELLM_REALTIME_MODEL_DEFAULT = String(process.env.LITELLM_REALTIME_MODEL || "gpt-4o-realtime-preview").trim();
const LITELLM_REALTIME_API_KEY = String(process.env.LITELLM_REALTIME_API_KEY || process.env.LITELLM_API_KEY || "").trim();
const AZURE_OPENAI_REALTIME_API_BASE = String(process.env.AZURE_OPENAI_REALTIME_API_BASE || "").trim();
const AZURE_OPENAI_REALTIME_API_VERSION = String(process.env.AZURE_OPENAI_REALTIME_API_VERSION || "").trim();
const AZURE_OPENAI_REALTIME_API_KEY = String(process.env.AZURE_OPENAI_REALTIME_API_KEY || "").trim();
const AZURE_OPENAI_REALTIME_MODEL = String(process.env.AZURE_OPENAI_REALTIME_MODEL || "").trim();
const ORCHESTRATOR_IMAGE_DATA_URL_MAX_CHARS_DEFAULT = Math.max(
  50000,
  Number.parseInt(String(process.env.N8N_ORCHESTRATOR_IMAGE_DATA_URL_MAX_CHARS || "450000"), 10) || 450000,
);
const ORCHESTRATOR_IMAGE_MAX_RESOLUTION_PX_DEFAULT = Math.max(
  512,
  Number.parseInt(String(process.env.N8N_ORCHESTRATOR_IMAGE_MAX_RESOLUTION_PX || "1568"), 10) || 1568,
);
const LIBRECHAT_INTERNAL_URL = String(process.env.LIBRECHAT_INTERNAL_URL || "http://librechat:3080").trim();
const TRANSCRIPT_SESSIONS_FILE = "transcript-sessions.json";
const BELEIDSKOMPAS_STATE_FILE = "beleidskompas-state.json";
const BELEIDSKOMPAS_LIVE_FILE = "beleidskompas-config.json";
const BELEIDSKOMPAS_FEEDBACK_FILE = "beleidskompas-feedback.json";
const BELEIDSKOMPAS_FEEDBACK_MAX = 500;
const TRANSCRIPT_AUTH_DEBUG = String(process.env.TRANSCRIPT_AUTH_DEBUG || "false").toLowerCase() === "true";
const LIBRECHAT_JWT_REFRESH_SECRET = String(process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET || "").trim();

// Active sessions (in-memory, resets on restart)
const sessions = new Map();
const imageJobs = new Map();
const imageJobQueue = [];
let imageWorkersActive = 0;
const realtimeWss = new WebSocketServer({ noServer: true });

function sendWs(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // no-op
  }
}

function parseJsonMaybe(raw) {
  try {
    return JSON.parse(String(raw || ""));
  } catch {
    return null;
  }
}

function withQuery(urlString, key, value) {
  const out = new URL(urlString);
  if (value !== undefined && value !== null && String(value).trim()) {
    out.searchParams.set(key, String(value).trim());
  }
  return out;
}

function toWebSocketUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  if (parsed.protocol === "https:") parsed.protocol = "wss:";
  return parsed.toString();
}

function decodeBase64Url(input) {
  const raw = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (raw.length % 4)) % 4;
  const padded = raw + "=".repeat(padLen);
  return Buffer.from(padded, "base64").toString("utf-8");
}

function verifyJwtHs256(token, secret) {
  try {
    if (!token || !secret) return null;
    const parts = String(token).split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    const signingInput = `${headerB64}.${payloadB64}`;

    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(signingInput)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");

    const sigA = Buffer.from(String(sigB64 || ""));
    const sigB = Buffer.from(String(expectedSig || ""));
    if (sigA.length !== sigB.length || !crypto.timingSafeEqual(sigA, sigB)) return null;

    const header = JSON.parse(decodeBase64Url(headerB64));
    if (String(header?.alg || "").toUpperCase() !== "HS256") return null;

    const payload = JSON.parse(decodeBase64Url(payloadB64));
    const nowSec = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(Number(payload?.exp)) || Number(payload.exp) <= nowSec) return null;
    if (Number.isFinite(Number(payload?.nbf)) && Number(payload.nbf) > nowSec) return null;
    return payload;
  } catch {
    return null;
  }
}

function resolveUserFromVerifiedRefreshToken(req) {
  const token = String(req.cookies?.refreshToken || "").trim();
  if (!token || !LIBRECHAT_JWT_REFRESH_SECRET) return null;

  const payload = verifyJwtHs256(token, LIBRECHAT_JWT_REFRESH_SECRET);
  if (!payload || typeof payload !== "object") return null;

  const id = String(payload.id || payload.userId || payload.sub || "").trim();
  if (!id) return null;

  return {
    id,
    email: undefined,
    username: undefined,
    label: id,
    source: "refreshToken",
  };
}

function resolveRealtimeTarget({ provider, model, language }) {
  const selectedProvider = String(provider || REALTIME_STT_PROVIDER_DEFAULT || "litellm").trim().toLowerCase();

  if (selectedProvider === "azure" || selectedProvider === "azure_direct") {
    if (!AZURE_OPENAI_REALTIME_API_BASE) {
      throw new Error("AZURE_OPENAI_REALTIME_API_BASE ontbreekt");
    }
    if (!AZURE_OPENAI_REALTIME_API_KEY) {
      throw new Error("AZURE_OPENAI_REALTIME_API_KEY ontbreekt");
    }

    const effectiveModel = String(model || AZURE_OPENAI_REALTIME_MODEL || "").trim();
    if (!effectiveModel) {
      throw new Error("Realtime model ontbreekt voor Azure");
    }

    const realtimeBase = toWebSocketUrl(AZURE_OPENAI_REALTIME_API_BASE);
    let targetUrl = withQuery(realtimeBase, "model", effectiveModel);
    if (AZURE_OPENAI_REALTIME_API_VERSION) {
      targetUrl = withQuery(targetUrl.toString(), "api-version", AZURE_OPENAI_REALTIME_API_VERSION);
    }

    return {
      provider: "azure_direct",
      model: effectiveModel,
      language: String(language || "").trim() || undefined,
      url: targetUrl.toString(),
      headers: {
        "api-key": AZURE_OPENAI_REALTIME_API_KEY,
      },
    };
  }

  if (!LITELLM_REALTIME_API_KEY) {
    throw new Error("LITELLM_REALTIME_API_KEY/LITELLM_API_KEY ontbreekt");
  }

  const effectiveModel = String(model || LITELLM_REALTIME_MODEL_DEFAULT || "").trim();
  if (!effectiveModel) {
    throw new Error("Realtime model ontbreekt voor LiteLLM");
  }

  const realtimeBase = toWebSocketUrl(LITELLM_REALTIME_URL);
  const targetUrl = withQuery(realtimeBase, "model", effectiveModel);

  return {
    provider: "litellm",
    model: effectiveModel,
    language: String(language || "").trim() || undefined,
    url: targetUrl.toString(),
    headers: {
      Authorization: `Bearer ${LITELLM_REALTIME_API_KEY}`,
    },
  };
}

function extractTranscriptFromRealtimeEvent(evt) {
  if (!evt || typeof evt !== "object") return null;

  if (evt.type === "response.audio_transcript.delta") {
    const t = String(evt.delta || "");
    return t ? { kind: "delta", text: t } : null;
  }
  if (evt.type === "response.audio_transcript.done") {
    const t = String(evt.transcript || "").trim();
    return t ? { kind: "final", text: t } : null;
  }
  if (evt.type === "conversation.item.input_audio_transcription.completed") {
    const t = String(evt.transcript || evt.text || "").trim();
    return t ? { kind: "final", text: t } : null;
  }
  if (evt.type === "response.output_text.delta") {
    const t = String(evt.delta || "");
    return t ? { kind: "delta", text: t } : null;
  }
  if (evt.type === "response.output_text.done") {
    const t = String(evt.text || "").trim();
    return t ? { kind: "final", text: t } : null;
  }

  return null;
}

// ── Middleware ──────────────────────────────────────────────────────
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// CORS for public, read-only configuration endpoints
app.use("/api/config", (req, res, next) => {
  res.set("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use("/api/transcript-sessions", (req, res, next) => {
  res.set("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use("/api/beleidskompas-feedback", (req, res, next) => {
  res.set("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/api/realtime-stt", (req, res) => {
  return res.json({
    ok: true,
    transport: "websocket",
    ws_path: "/api/realtime-stt",
    provider_default: REALTIME_STT_PROVIDER_DEFAULT,
  });
});

// ── Data helpers ───────────────────────────────────────────────────
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function initDefaults() {
  ensureDataDir();
  const jsonDefaults = ["help-content.json", "apps.json", "crawler-config.json", "orchestrator-config.json"];
  for (const file of jsonDefaults) {
    const target = path.join(DATA_DIR, file);
    if (!fs.existsSync(target)) {
      const source = path.join(__dirname, "defaults", file);
      if (fs.existsSync(source)) {
        fs.copyFileSync(source, target);
        console.log(`[init] Copied default ${file} to ${DATA_DIR}`);
      }
    }
  }

  // Keep apps.json synced with repository defaults to avoid stale webhook URL/token
  // from older volumes when n8n integration is enabled.
  const appsSource = path.join(__dirname, "defaults", "apps.json");
  const appsTarget = path.join(DATA_DIR, "apps.json");
  if (fs.existsSync(appsSource)) {
    fs.copyFileSync(appsSource, appsTarget);
    console.log(`[init] Synced runtime config apps.json to ${DATA_DIR}`);
  }

  const crawlerRunsPath = path.join(DATA_DIR, "crawler-runs.json");
  if (!fs.existsSync(crawlerRunsPath)) {
    fs.writeFileSync(crawlerRunsPath, JSON.stringify({ runs: [] }, null, 2), "utf-8");
    console.log(`[init] Created crawler-runs.json in ${DATA_DIR}`);
  }

  const beleidskompasStatePath = path.join(DATA_DIR, BELEIDSKOMPAS_STATE_FILE);
  if (!fs.existsSync(beleidskompasStatePath)) {
    writePrivateJSON(BELEIDSKOMPAS_STATE_FILE, defaultBeleidskompasState());
    console.log(`[init] Created ${BELEIDSKOMPAS_STATE_FILE} in ${DATA_DIR}`);
  }

  const beleidskompasState = readBeleidskompasState();
  publishBeleidskompasLiveConfig(beleidskompasState.live, beleidskompasState.live_version_id);
}

function readJSON(filename) {
  const filepath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filepath)) return null;
  return JSON.parse(fs.readFileSync(filepath, "utf-8"));
}

function readPrivateJSON(filename) {
  const filepath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filepath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filepath, "utf-8"));
  } catch {
    return null;
  }
}

function writePrivateJSON(filename, data) {
  ensureDataDir();
  const filepath = path.join(DATA_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), "utf-8");
}

function writeJSON(filename, data) {
  ensureDataDir();
  const filepath = path.join(DATA_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), "utf-8");
  // Also publish to shared static volume for Open WebUI
  publishFile(filename, data);
}

function cloneJSON(input) {
  return JSON.parse(JSON.stringify(input));
}

function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((v) => String(v || "").trim()).filter(Boolean))];
}

function defaultStepRagSettings(step = {}) {
  return {
    algorithm: "hybrid",
    top_k: 3,
    min_score: 0.08,
    tag_filter_mode: "any",
    required_tags: normalizeTags(step?.doc_tags || []),
  };
}

function normalizeStepRagSettings(input, fallbackStep = {}) {
  const fallback = defaultStepRagSettings(fallbackStep);
  const src = input && typeof input === "object" ? input : {};
  const algorithmRaw = String(src.algorithm || fallback.algorithm || "hybrid").trim().toLowerCase();
  const algorithm = ["needle", "haystack", "hybrid"].includes(algorithmRaw) ? algorithmRaw : "hybrid";
  const topK = Math.max(1, Math.min(20, Number.parseInt(String(src.top_k ?? fallback.top_k ?? 3), 10) || 3));
  const minScore = Math.max(0, Math.min(1, Number.parseFloat(String(src.min_score ?? fallback.min_score ?? 0.08)) || 0));
  const modeRaw = String(src.tag_filter_mode || fallback.tag_filter_mode || "any").trim().toLowerCase();
  const tagFilterMode = modeRaw === "all" ? "all" : "any";
  const requiredTags = normalizeTags(src.required_tags || fallback.required_tags || []);
  return {
    algorithm,
    top_k: topK,
    min_score: minScore,
    tag_filter_mode: tagFilterMode,
    required_tags: requiredTags,
  };
}

function normalizeBeleidskompasDocuments(input) {
  const documentsRaw = Array.isArray(input) ? input : [];
  return documentsRaw.map((d) => ({
    id: String(d?.id || crypto.randomUUID()).trim() || crypto.randomUUID(),
    filename: String(d?.filename || "document").trim() || "document",
    mime_type: String(d?.mime_type || "application/octet-stream").trim() || "application/octet-stream",
    uploaded_at: String(d?.uploaded_at || new Date().toISOString()).trim(),
    size_bytes: Math.max(0, Number(d?.size_bytes || 0)),
    tags: normalizeTags(d?.tags || []),
    preview_text: String(d?.preview_text || "").trim(),
    content_base64: String(d?.content_base64 || "").trim(),
  }));
}

// The seed template: generated from the agent's prompt files by
// agents/beleidskompas/generate-workflow.js (make generate-workflows).
const BELEIDSKOMPAS_DEFAULT_TEMPLATE = JSON.parse(
  fs.readFileSync(path.join(__dirname, "defaults", "beleidskompas-template.json"), "utf-8"),
);

function defaultBeleidskompasFlow() {
  const template = cloneJSON(BELEIDSKOMPAS_DEFAULT_TEMPLATE);
  return { ...template, steps: template.steps.map((step) => ({ ...step, rag: defaultStepRagSettings(step) })) };
}

// The default substeps from before they followed steps.json. A saved step that still has exactly
// these gets the current default substeps; any other substeps stay as the admin saved them.
const OLD_DEFAULT_SUBSTEPS = {
  stap1: "1.1 Casus context|1.2 Toetsing publiek|1.3 Toetsing provinciaal",
  stap2: "2.1 Rolopties|2.2 Afweging",
  stap3: "3.1 Selectie|3.2 Weging|3.3 Voorkeur",
  stap4: "4.1 Sturing|4.2 Toezicht|4.3 KPI’s",
};

/** The saved value, or the default when it is empty: a prompt-like field
 *  that is blank means "the seed text", so an older state gets the prompts. */
function textOrDefault(value, fallback) {
  return String(value ?? "").trim() || String(fallback ?? "").trim();
}

function normalizeBeleidskompasFlow(input) {
  const fallback = defaultBeleidskompasFlow();
  const src = input && typeof input === "object" ? input : {};
  const stepsRaw = Array.isArray(src.steps) ? src.steps : fallback.steps;

  // The four steps are fixed (the SiS 4.0 pillars): a saved step is matched by id, the rest is dropped.
  const steps = fallback.steps.map((fb, idx) => {
    const step = stepsRaw.find((s) => s && String(s.id || "").trim() === fb.id) || {};
    let substepsRaw = Array.isArray(step.substeps) ? step.substeps : fb.substeps;
    const oldDefault = OLD_DEFAULT_SUBSTEPS[fb.id];
    if (oldDefault === substepsRaw.map((s) => `${s?.id} ${s?.title}`).join("|")) substepsRaw = fb.substeps;
    return {
      id: fb.id,
      nr: idx + 1,
      title: String(step.title || fb.title).trim() || fb.title,
      // An empty string is the admin's choice; defaults only fill fields that are missing.
      description: String(step.description ?? fb.description ?? "").trim(),
      prompt: textOrDefault(step.prompt, fb.prompt),
      doc_tags: normalizeTags(step.doc_tags || fb.doc_tags),
      // Documents picked in the Flow builder; nothing reads them yet. Missing = not picked yet.
      document_ids: Array.isArray(step.document_ids) ? [...new Set(step.document_ids.map(String))] : undefined,
      rag: normalizeStepRagSettings(step.rag || fb.rag || {}, step.id ? step : fb),
      substeps: substepsRaw.map((sub, subIdx) => {
        const id = String(sub?.id || `${idx + 1}.${subIdx + 1}`).trim() || `${idx + 1}.${subIdx + 1}`;
        const sfb = fb.substeps.find((d) => d.id === id) || {};
        return {
          id,
          title: String(sub?.title || `Substap ${subIdx + 1}`).trim() || `Substap ${subIdx + 1}`,
          description: String(sub?.description || "").trim(),
          prompt: textOrDefault(sub?.prompt, sfb.prompt),
          answer_format: textOrDefault(sub?.answer_format, sfb.answer_format),
        };
      }),
    };
  });

  const messagesRaw = src.messages && typeof src.messages === "object" ? src.messages : {};
  return {
    title: String(src.title || fallback.title).trim() || fallback.title,
    disclaimer: String(src.disclaimer || fallback.disclaimer).trim() || fallback.disclaimer,
    specialist_team: String(src.specialist_team || fallback.specialist_team).trim() || fallback.specialist_team,
    report_disclaimer: textOrDefault(src.report_disclaimer, fallback.report_disclaimer),
    rules: textOrDefault(src.rules, fallback.rules),
    report_prompt: textOrDefault(src.report_prompt, fallback.report_prompt),
    conversation_prompt: textOrDefault(src.conversation_prompt, fallback.conversation_prompt),
    orchestrator_prompt: textOrDefault(src.orchestrator_prompt, fallback.orchestrator_prompt),
    messages: Object.fromEntries(Object.keys(fallback.messages).map((key) => [key, textOrDefault(messagesRaw[key], fallback.messages[key])])),
    sources: normalizeTags(src.sources || fallback.sources),
    steps,
  };
}

function defaultBeleidskompasState() {
  const baseFlow = defaultBeleidskompasFlow();
  const now = new Date().toISOString();
  return {
    draft: cloneJSON(baseFlow),
    live: cloneJSON(baseFlow),
    live_version_id: "v1",
    versions: [
      {
        id: "v1",
        published_at: now,
        published_by: "System",
        note: "Initiële versie",
        is_live: true,
        snapshot: cloneJSON(baseFlow),
      },
    ],
    documents: [],
    settings: {
      retention_days: 365,
      enforce_source_citation: true,
      require_human_validation: true,
      default_model: "govchat-default",
    },
  };
}

function normalizeBeleidskompasState(input) {
  const fallback = defaultBeleidskompasState();
  const src = input && typeof input === "object" ? input : {};
  const draft = normalizeBeleidskompasFlow(src.draft || src.flow || fallback.draft);
  const live = normalizeBeleidskompasFlow(src.live || fallback.live);
  const versionsRaw = Array.isArray(src.versions) ? src.versions : fallback.versions;
  const versions = versionsRaw.map((v, idx) => ({
    id: String(v?.id || `v${idx + 1}`).trim() || `v${idx + 1}`,
    published_at: String(v?.published_at || new Date().toISOString()).trim(),
    published_by: String(v?.published_by || "Onbekend").trim() || "Onbekend",
    note: String(v?.note || "").trim(),
    is_live: Boolean(v?.is_live),
    snapshot: normalizeBeleidskompasFlow(v?.snapshot || draft),
  }));

  const documents = normalizeBeleidskompasDocuments(src.documents || []);

  const settings = {
    ...fallback.settings,
    ...(src.settings && typeof src.settings === "object" ? src.settings : {}),
  };

  let liveVersionId = String(src.live_version_id || fallback.live_version_id || "").trim();
  if (!versions.some((v) => v.id === liveVersionId)) {
    liveVersionId = versions[0]?.id || "v1";
  }
  for (const v of versions) {
    v.is_live = v.id === liveVersionId;
  }

  return {
    draft,
    live,
    live_version_id: liveVersionId,
    versions,
    documents,
    settings,
  };
}

function readBeleidskompasState() {
  const raw = readPrivateJSON(BELEIDSKOMPAS_STATE_FILE);
  return normalizeBeleidskompasState(raw || defaultBeleidskompasState());
}

function writeBeleidskompasState(state) {
  const normalized = normalizeBeleidskompasState(state);
  writePrivateJSON(BELEIDSKOMPAS_STATE_FILE, normalized);
  return normalized;
}

// beleidskompas-config.json is public (nginx serves it without auth), so it holds only what the
// Beleidskompas page reads (buildConfig in overlay/src/apps/beleidskompas/config.js) plus the step titles.
function publicBeleidskompasConfig(flow, versionId) {
  const { title, disclaimer, specialist_team, steps } = normalizeBeleidskompasFlow(flow);
  return {
    version_id: String(versionId || "").trim(),
    title,
    disclaimer,
    specialist_team,
    steps: steps.map(({ id, nr, title, description, substeps }) => ({
      id,
      nr,
      title,
      description,
      substeps: substeps.map((s) => ({ id: s.id, title: s.title })),
    })),
  };
}

function publishBeleidskompasLiveConfig(flow, versionId) {
  writeJSON(BELEIDSKOMPAS_LIVE_FILE, publicBeleidskompasConfig(flow, versionId));
}

/** The live template as the orchestrator reads it (GET /api/beleidskompas/live). */
function liveBeleidskompasTemplate() {
  const state = readBeleidskompasState();
  return { version_id: state.live_version_id, flow: state.live, settings: { default_model: state.settings.default_model } };
}

function publishFile(filename, data) {
  try {
    if (!fs.existsSync(PUBLISH_DIR)) {
      fs.mkdirSync(PUBLISH_DIR, { recursive: true });
    }
    const target = path.join(PUBLISH_DIR, filename);
    fs.writeFileSync(target, JSON.stringify(data, null, 2), "utf-8");
    console.log(`[publish] ${filename} → ${PUBLISH_DIR}`);
  } catch (err) {
    console.warn(`[publish] Failed to publish ${filename}: ${err.message}`);
  }
}

function publishAll() {
  const jsonFiles = ["help-content.json", "apps.json", "orchestrator-config.json"];
  for (const file of jsonFiles) {
    const data = readJSON(file);
    if (data) publishFile(file, data);
  }
  const bkState = readBeleidskompasState();
  publishBeleidskompasLiveConfig(bkState.live, bkState.live_version_id);
}

function readCrawlerConfig() {
  const fallback = {
    enabled: false,
    timezone: "Europe/Amsterdam",
    crawl_interval_minutes: 1440,
    max_pages_per_run: 200,
    max_depth: 3,
    request_timeout_ms: 15000,
    user_agent: "GovChatCrawler/1.0 (+https://govchat.nl)",
    respect_robots_txt: true,
    include_file_types: ["text/html", "application/pdf"],
    embedding_enabled: true,
    embedding_model: String(process.env.CRAWLER_EMBEDDING_MODEL || "govchat-embedding").trim() || "govchat-embedding",
    embedding_max_chars: 8000,
    skip_embedding_for_unchanged: true,
    sources: [],
  };
  const stored = readJSON("crawler-config.json");
  if (!stored || typeof stored !== "object") return fallback;
  return {
    ...fallback,
    ...stored,
    sources: Array.isArray(stored.sources) ? stored.sources : [],
  };
}

function readOrchestratorConfig() {
  const fallback = {
    image_data_url_max_chars: ORCHESTRATOR_IMAGE_DATA_URL_MAX_CHARS_DEFAULT,
    image_max_resolution_px: ORCHESTRATOR_IMAGE_MAX_RESOLUTION_PX_DEFAULT,
  };
  const stored = readJSON("orchestrator-config.json");
  if (!stored || typeof stored !== "object") return fallback;
  const maxChars = Math.max(
    50000,
    Number.parseInt(String(stored.image_data_url_max_chars || fallback.image_data_url_max_chars), 10) ||
      fallback.image_data_url_max_chars,
  );
  const maxResolutionPx = Math.max(
    512,
    Number.parseInt(String(stored.image_max_resolution_px || fallback.image_max_resolution_px), 10) ||
      fallback.image_max_resolution_px,
  );
  return {
    image_data_url_max_chars: maxChars,
    image_max_resolution_px: maxResolutionPx,
  };
}

function validateOrchestratorConfig(input) {
  if (!input || typeof input !== "object") {
    throw new Error("Orchestrator-configuratie ontbreekt of is ongeldig");
  }

  const imageDataUrlMaxChars = Math.max(
    50000,
    Number.parseInt(String(input.image_data_url_max_chars || ORCHESTRATOR_IMAGE_DATA_URL_MAX_CHARS_DEFAULT), 10) ||
      ORCHESTRATOR_IMAGE_DATA_URL_MAX_CHARS_DEFAULT,
  );

  const imageMaxResolutionPx = Math.max(
    512,
    Number.parseInt(
      String(input.image_max_resolution_px || ORCHESTRATOR_IMAGE_MAX_RESOLUTION_PX_DEFAULT),
      10,
    ) || ORCHESTRATOR_IMAGE_MAX_RESOLUTION_PX_DEFAULT,
  );

  return {
    image_data_url_max_chars: imageDataUrlMaxChars,
    image_max_resolution_px: imageMaxResolutionPx,
  };
}

function decodeDataUrlImage(dataUrl) {
  const m = String(dataUrl || "").match(/^data:([^;,]+);base64,(.+)$/i);
  if (!m) {
    throw new Error("Ongeldige data-url voor afbeelding");
  }
  return {
    mime: String(m[1] || "").toLowerCase(),
    base64: String(m[2] || ""),
  };
}

function pickOutputFormat(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("png")) return { format: "png", mime: "image/png" };
  if (m.includes("webp")) return { format: "webp", mime: "image/webp" };
  if (m.includes("gif")) return { format: "png", mime: "image/png" };
  return { format: "jpeg", mime: "image/jpeg" };
}

async function normalizeImageDataUrl(dataUrl, options = {}) {
  const { mime, base64 } = decodeDataUrlImage(dataUrl);
  const inputBuffer = Buffer.from(base64, "base64");
  const maxResolutionPx = Math.max(512, Number.parseInt(String(options.max_resolution_px || "1568"), 10) || 1568);
  const maxChars = Math.max(50000, Number.parseInt(String(options.max_chars || "450000"), 10) || 450000);

  const inputMeta = await sharp(inputBuffer).metadata();
  const width = Number(inputMeta.width || 0);
  const height = Number(inputMeta.height || 0);
  const longestEdge = Math.max(width, height);
  const needsResize = longestEdge > maxResolutionPx;

  let pipeline = sharp(inputBuffer, { animated: false }).rotate();
  if (needsResize) {
    pipeline = pipeline.resize({
      width: maxResolutionPx,
      height: maxResolutionPx,
      fit: "inside",
      withoutEnlargement: true,
      kernel: "lanczos3",
    });
  }

  const picked = pickOutputFormat(mime);
  if (picked.format === "jpeg") {
    pipeline = pipeline.jpeg({ quality: 82, mozjpeg: true });
  } else if (picked.format === "png") {
    pipeline = pipeline.png({ compressionLevel: 9, palette: true });
  } else {
    pipeline = pipeline.webp({ quality: 82 });
  }

  let outputBuffer = await pipeline.toBuffer();
  let outMime = picked.mime;
  let outputDataUrl = `data:${outMime};base64,${outputBuffer.toString("base64")}`;

  // Second pass to enforce max char budget if still oversized.
  if (outputDataUrl.length > maxChars) {
    const fallbackBuffer = await sharp(outputBuffer)
      .resize({ width: Math.min(maxResolutionPx, 1024), height: Math.min(maxResolutionPx, 1024), fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 74, mozjpeg: true })
      .toBuffer();
    outputBuffer = fallbackBuffer;
    outMime = "image/jpeg";
    outputDataUrl = `data:${outMime};base64,${outputBuffer.toString("base64")}`;
  }

  const outMeta = await sharp(outputBuffer).metadata();
  return {
    image_data_url: outputDataUrl,
    changed: outputDataUrl !== String(dataUrl || ""),
    input: {
      mime,
      width,
      height,
      chars: String(dataUrl || "").length,
    },
    output: {
      mime: outMime,
      width: Number(outMeta.width || 0),
      height: Number(outMeta.height || 0),
      chars: outputDataUrl.length,
    },
  };
}

function validateCrawlerConfig(input) {
  if (!input || typeof input !== "object") {
    throw new Error("Crawler-configuratie ontbreekt of is ongeldig");
  }

  const cfg = {
    enabled: Boolean(input.enabled),
    timezone: String(input.timezone || "Europe/Amsterdam").trim() || "Europe/Amsterdam",
    crawl_interval_minutes: Math.max(
      15,
      Number.parseInt(String(input.crawl_interval_minutes || "1440"), 10) || 1440,
    ),
    max_pages_per_run: Math.max(
      10,
      Number.parseInt(String(input.max_pages_per_run || "200"), 10) || 200,
    ),
    max_depth: Math.max(1, Number.parseInt(String(input.max_depth || "3"), 10) || 3),
    request_timeout_ms: Math.max(
      3000,
      Number.parseInt(String(input.request_timeout_ms || "15000"), 10) || 15000,
    ),
    user_agent:
      String(input.user_agent || "GovChatCrawler/1.0 (+https://govchat.nl)").trim() ||
      "GovChatCrawler/1.0 (+https://govchat.nl)",
    respect_robots_txt: input.respect_robots_txt !== false,
    include_file_types: Array.isArray(input.include_file_types)
      ? input.include_file_types.map((v) => String(v || "").trim()).filter(Boolean)
      : ["text/html", "application/pdf"],
    embedding_enabled: input.embedding_enabled !== false,
    embedding_model: String(input.embedding_model || "govchat-embedding").trim() || "govchat-embedding",
    embedding_max_chars: Math.max(
      1000,
      Number.parseInt(String(input.embedding_max_chars || "8000"), 10) || 8000,
    ),
    skip_embedding_for_unchanged: input.skip_embedding_for_unchanged !== false,
    sources: [],
  };

  const rawSources = Array.isArray(input.sources) ? input.sources : [];
  for (let i = 0; i < rawSources.length; i += 1) {
    const s = rawSources[i] || {};
    const id = String(s.id || `source-${i + 1}`).trim();
    const name = String(s.name || id).trim();
    const startUrl = String(s.start_url || "").trim();
    if (!startUrl) {
      throw new Error(`Bron ${i + 1} mist start_url`);
    }
    let urlObj;
    try {
      urlObj = new URL(startUrl);
    } catch {
      throw new Error(`Bron ${i + 1} heeft ongeldige start_url`);
    }
    if (!["http:", "https:"].includes(urlObj.protocol)) {
      throw new Error(`Bron ${i + 1} gebruikt geen http/https URL`);
    }

    cfg.sources.push({
      id,
      name,
      enabled: s.enabled !== false,
      start_url: startUrl,
      sitemap_urls: Array.isArray(s.sitemap_urls)
        ? s.sitemap_urls.map((v) => String(v || "").trim()).filter(Boolean)
        : [],
      allowed_domains: Array.isArray(s.allowed_domains)
        ? s.allowed_domains.map((v) => String(v || "").trim().toLowerCase()).filter(Boolean)
        : [urlObj.hostname.toLowerCase()],
      allowed_path_prefixes: Array.isArray(s.allowed_path_prefixes)
        ? s.allowed_path_prefixes.map((v) => String(v || "").trim()).filter(Boolean)
        : ["/"],
      include_subdomains: s.include_subdomains !== false,
      max_pages: Math.max(1, Number.parseInt(String(s.max_pages || "75"), 10) || 75),
      max_depth: Math.max(1, Number.parseInt(String(s.max_depth || cfg.max_depth), 10) || cfg.max_depth),
      interval_minutes: Math.max(
        15,
        Number.parseInt(String(s.interval_minutes || cfg.crawl_interval_minutes), 10) ||
          cfg.crawl_interval_minutes,
      ),
    });
  }

  return cfg;
}

function readCrawlerRuns() {
  const data = readJSON("crawler-runs.json");
  if (!data || typeof data !== "object") return [];
  return Array.isArray(data.runs) ? data.runs : [];
}

function toTimestamp(value) {
  const ts = Date.parse(String(value || "").trim());
  return Number.isNaN(ts) ? 0 : ts;
}

function normalizeWebsitePart(value, fallback = "unknown") {
  const out = String(value || "").trim().toLowerCase();
  return out || fallback;
}

function hostFromUrl(value) {
  try {
    return new URL(String(value || "").trim()).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function deriveWebsiteFromIndexedPage(page) {
  const url = String(page?.url || "").trim();
  const host = hostFromUrl(url);
  const domain = normalizeWebsitePart(page?.domain || host || "unknown-domain", "unknown-domain");
  const subwebsite = normalizeWebsitePart(page?.subwebsite || host || domain, domain);
  const sourceId = String(page?.source_id || page?.source_name || subwebsite || domain)
    .trim()
    .toLowerCase();
  const sourceName = String(page?.source_name || page?.source_id || subwebsite || domain).trim();
  const websiteId = `${domain}::${subwebsite}::${sourceId}`;
  return {
    website_id: websiteId,
    domain,
    subwebsite,
    source_id: sourceId,
    source_name: sourceName,
    url,
    path: String(page?.path || "").trim() || "/",
  };
}

function recalculateTokenUsageFromPages(indexedPages) {
  const tokenUsage = {
    total_input_tokens_est: 0,
    total_prompt_tokens: 0,
    total_tokens: 0,
    by_domain: {},
    by_subwebsite: {},
  };

  for (const page of Array.isArray(indexedPages) ? indexedPages : []) {
    const { domain, subwebsite } = deriveWebsiteFromIndexedPage(page);
    const inputTokensEst = Number(page?.input_tokens_est || 0);
    const promptTokens = Number(page?.prompt_tokens || 0);
    const totalTokens = Number(page?.total_tokens || inputTokensEst || 0);

    tokenUsage.total_input_tokens_est += inputTokensEst;
    tokenUsage.total_prompt_tokens += promptTokens;
    tokenUsage.total_tokens += totalTokens;

    if (!tokenUsage.by_domain[domain]) {
      tokenUsage.by_domain[domain] = { pages: 0, total_tokens: 0, prompt_tokens: 0, input_tokens_est: 0 };
    }
    tokenUsage.by_domain[domain].pages += 1;
    tokenUsage.by_domain[domain].total_tokens += totalTokens;
    tokenUsage.by_domain[domain].prompt_tokens += promptTokens;
    tokenUsage.by_domain[domain].input_tokens_est += inputTokensEst;

    if (!tokenUsage.by_subwebsite[subwebsite]) {
      tokenUsage.by_subwebsite[subwebsite] = {
        pages: 0,
        total_tokens: 0,
        prompt_tokens: 0,
        input_tokens_est: 0,
      };
    }
    tokenUsage.by_subwebsite[subwebsite].pages += 1;
    tokenUsage.by_subwebsite[subwebsite].total_tokens += totalTokens;
    tokenUsage.by_subwebsite[subwebsite].prompt_tokens += promptTokens;
    tokenUsage.by_subwebsite[subwebsite].input_tokens_est += inputTokensEst;
  }

  return tokenUsage;
}

function buildCrawlerWebsiteOverview() {
  const runs = readCrawlerRuns();
  const websiteMap = new Map();

  for (const run of runs) {
    const runId = String(run?.run_id || "").trim();
    const runStatus = String(run?.status || "unknown").trim().toLowerCase() || "unknown";
    const runFinishedAt = String(run?.finished_at || run?.started_at || "").trim();
    const runPages = Array.isArray(run?.indexed_pages) ? run.indexed_pages : [];

    for (const page of runPages) {
      const meta = deriveWebsiteFromIndexedPage(page);
      const indexedAt = String(page?.indexed_at || runFinishedAt || "").trim();
      const indexedAtTs = toTimestamp(indexedAt);
      const totalTokens = Number(page?.total_tokens || page?.input_tokens_est || 0);
      const contentType = String(page?.content_type || "unknown").trim() || "unknown";

      let website = websiteMap.get(meta.website_id);
      if (!website) {
        website = {
          website_id: meta.website_id,
          domain: meta.domain,
          subwebsite: meta.subwebsite,
          source_id: meta.source_id,
          source_name: meta.source_name,
          folder_path: `${meta.domain}/${meta.subwebsite}`,
          first_indexed_at: indexedAt || null,
          last_indexed_at: indexedAt || null,
          last_run_id: runId || null,
          last_run_status: runStatus,
          total_pages_indexed: 0,
          unique_url_count: 0,
          total_tokens: 0,
          content_types: {},
          pages: [],
          run_ids: new Set(),
          unique_urls: new Set(),
          _first_indexed_ts: indexedAtTs,
          _last_indexed_ts: indexedAtTs,
        };
        websiteMap.set(meta.website_id, website);
      }

      website.total_pages_indexed += 1;
      website.total_tokens += totalTokens;
      website.content_types[contentType] = Number(website.content_types[contentType] || 0) + 1;
      if (runId) website.run_ids.add(runId);
      if (meta.url) website.unique_urls.add(meta.url);

      if (indexedAtTs >= website._last_indexed_ts) {
        website._last_indexed_ts = indexedAtTs;
        website.last_indexed_at = indexedAt || website.last_indexed_at;
        website.last_run_id = runId || website.last_run_id;
        website.last_run_status = runStatus;
      }
      if (website._first_indexed_ts === 0 || (indexedAtTs > 0 && indexedAtTs <= website._first_indexed_ts)) {
        website._first_indexed_ts = indexedAtTs;
        website.first_indexed_at = indexedAt || website.first_indexed_at;
      }

      website.pages.push({
        url: meta.url || null,
        path: meta.path,
        indexed_at: indexedAt || null,
        content_type: contentType,
        total_tokens: totalTokens,
        embedding_status: String(page?.embedding_status || "-") || "-",
        run_id: runId || null,
      });
    }
  }

  const websites = [...websiteMap.values()]
    .map((website) => {
      const pages = website.pages.sort((a, b) => toTimestamp(b.indexed_at) - toTimestamp(a.indexed_at));
      const recentPages = pages.slice(0, 8);
      return {
        website_id: website.website_id,
        domain: website.domain,
        subwebsite: website.subwebsite,
        source_id: website.source_id,
        source_name: website.source_name,
        folder_path: website.folder_path,
        first_indexed_at: website.first_indexed_at,
        last_indexed_at: website.last_indexed_at,
        last_run_id: website.last_run_id,
        last_run_status: website.last_run_status,
        total_pages_indexed: website.total_pages_indexed,
        unique_url_count: website.unique_urls.size,
        runs_indexed: website.run_ids.size,
        total_tokens: website.total_tokens,
        content_types: website.content_types,
        recent_pages: recentPages,
        pages,
      };
    })
    .sort((a, b) => toTimestamp(b.last_indexed_at) - toTimestamp(a.last_indexed_at));

  const domainMap = new Map();
  for (const website of websites) {
    if (!domainMap.has(website.domain)) {
      domainMap.set(website.domain, {
        key: website.domain,
        name: website.domain,
        total_websites: 0,
        total_pages_indexed: 0,
        last_indexed_at: website.last_indexed_at,
        subfoldersMap: new Map(),
      });
    }
    const domainEntry = domainMap.get(website.domain);
    domainEntry.total_websites += 1;
    domainEntry.total_pages_indexed += Number(website.total_pages_indexed || 0);
    if (toTimestamp(website.last_indexed_at) > toTimestamp(domainEntry.last_indexed_at)) {
      domainEntry.last_indexed_at = website.last_indexed_at;
    }

    const subKey = website.subwebsite;
    if (!domainEntry.subfoldersMap.has(subKey)) {
      domainEntry.subfoldersMap.set(subKey, {
        key: `${website.domain}/${subKey}`,
        name: subKey,
        total_websites: 0,
        total_pages_indexed: 0,
        last_indexed_at: website.last_indexed_at,
        websites: [],
      });
    }
    const subEntry = domainEntry.subfoldersMap.get(subKey);
    subEntry.total_websites += 1;
    subEntry.total_pages_indexed += Number(website.total_pages_indexed || 0);
    if (toTimestamp(website.last_indexed_at) > toTimestamp(subEntry.last_indexed_at)) {
      subEntry.last_indexed_at = website.last_indexed_at;
    }
    subEntry.websites.push({
      website_id: website.website_id,
      source_name: website.source_name,
      source_id: website.source_id,
      total_pages_indexed: website.total_pages_indexed,
      unique_url_count: website.unique_url_count,
      runs_indexed: website.runs_indexed,
      total_tokens: website.total_tokens,
      last_indexed_at: website.last_indexed_at,
      last_run_status: website.last_run_status,
      first_indexed_at: website.first_indexed_at,
    });
  }

  const folders = [...domainMap.values()]
    .map((domainEntry) => ({
      key: domainEntry.key,
      name: domainEntry.name,
      total_websites: domainEntry.total_websites,
      total_pages_indexed: domainEntry.total_pages_indexed,
      last_indexed_at: domainEntry.last_indexed_at,
      subfolders: [...domainEntry.subfoldersMap.values()]
        .map((subEntry) => ({
          key: subEntry.key,
          name: subEntry.name,
          total_websites: subEntry.total_websites,
          total_pages_indexed: subEntry.total_pages_indexed,
          last_indexed_at: subEntry.last_indexed_at,
          websites: subEntry.websites.sort((a, b) => toTimestamp(b.last_indexed_at) - toTimestamp(a.last_indexed_at)),
        }))
        .sort((a, b) => toTimestamp(b.last_indexed_at) - toTimestamp(a.last_indexed_at)),
    }))
    .sort((a, b) => toTimestamp(b.last_indexed_at) - toTimestamp(a.last_indexed_at));

  const totalPagesIndexed = websites.reduce((sum, w) => sum + Number(w.total_pages_indexed || 0), 0);
  const totalTokens = websites.reduce((sum, w) => sum + Number(w.total_tokens || 0), 0);
  const subwebsiteCount = folders.reduce((sum, domainEntry) => sum + (domainEntry.subfolders?.length || 0), 0);

  return {
    generated_at: new Date().toISOString(),
    totals: {
      websites_count: websites.length,
      domains_count: folders.length,
      subwebsites_count: subwebsiteCount,
      pages_indexed: totalPagesIndexed,
      total_tokens: totalTokens,
    },
    folders,
    websites,
  };
}

function removeWebsiteFromCrawlerRuns(websiteId) {
  const targetId = String(websiteId || "").trim();
  if (!targetId) {
    return { removed_pages: 0, affected_runs: 0, changed: false };
  }

  const runs = readCrawlerRuns();
  let removedPages = 0;
  let affectedRuns = 0;
  let changed = false;

  const updatedRuns = runs.map((run) => {
    const pages = Array.isArray(run?.indexed_pages) ? run.indexed_pages : [];
    if (!pages.length) return run;

    const filteredPages = pages.filter((page) => deriveWebsiteFromIndexedPage(page).website_id !== targetId);
    const removedForRun = pages.length - filteredPages.length;
    if (removedForRun <= 0) return run;

    removedPages += removedForRun;
    affectedRuns += 1;
    changed = true;

    return {
      ...run,
      indexed_pages: filteredPages,
      token_usage: recalculateTokenUsageFromPages(filteredPages),
      summary: {
        ...(run?.summary && typeof run.summary === "object" ? run.summary : {}),
        indexed_items: filteredPages.length,
      },
    };
  });

  if (changed) {
    writeCrawlerRuns(updatedRuns);
  }

  return {
    removed_pages: removedPages,
    affected_runs: affectedRuns,
    changed,
  };
}

function getCrawlerRun(runId) {
  const id = String(runId || "").trim();
  if (!id) return null;
  return readCrawlerRuns().find((r) => String(r?.run_id || "") === id) || null;
}

function writeCrawlerRuns(runs) {
  const sorted = [...runs]
    .sort((a, b) => Date.parse(b.finished_at || b.created_at || 0) - Date.parse(a.finished_at || a.created_at || 0))
    .slice(0, CRAWLER_RUNS_LIMIT);
  writeJSON("crawler-runs.json", { runs: sorted });
}

function upsertCrawlerRun(runPartial) {
  const runs = readCrawlerRuns();
  const runId = String(runPartial?.run_id || runPartial?.id || "").trim() || crypto.randomUUID();
  const now = new Date().toISOString();
  const existingIndex = runs.findIndex((r) => String(r?.run_id || "") === runId);

  const next = {
    run_id: runId,
    created_at: String(runPartial?.created_at || runPartial?.started_at || now),
    status: String(runPartial?.status || "finished").trim() || "finished",
    trigger: String(runPartial?.trigger || "manual").trim() || "manual",
    started_at: String(runPartial?.started_at || now),
    finished_at: String(runPartial?.finished_at || now),
    summary: runPartial?.summary && typeof runPartial.summary === "object" ? runPartial.summary : {},
    indexed_pages: Array.isArray(runPartial?.indexed_pages) ? runPartial.indexed_pages : [],
    token_usage: runPartial?.token_usage && typeof runPartial.token_usage === "object"
      ? runPartial.token_usage
      : {},
    error: runPartial?.error ? String(runPartial.error) : null,
  };

  if (existingIndex >= 0) {
    runs[existingIndex] = {
      ...runs[existingIndex],
      ...next,
      summary: {
        ...(runs[existingIndex]?.summary || {}),
        ...(next.summary || {}),
      },
      token_usage: {
        ...(runs[existingIndex]?.token_usage || {}),
        ...(next.token_usage || {}),
      },
    };
  } else {
    runs.push(next);
  }

  writeCrawlerRuns(runs);
  return next;
}

function requestCrawlerRunCancel(runId, requestedBy = "admin-ui") {
  const existing = getCrawlerRun(runId);
  if (!existing) {
    return { ok: false, notFound: true, run: null };
  }

  const terminal = new Set(["finished", "failed", "cancelled", "skipped"]);
  const status = String(existing.status || "").trim().toLowerCase();
  if (terminal.has(status)) {
    return { ok: false, terminal: true, run: existing };
  }

  const now = new Date().toISOString();
  const next = upsertCrawlerRun({
    run_id: existing.run_id,
    status: "cancel_requested",
    trigger: existing.trigger || "manual",
    started_at: existing.started_at || now,
    finished_at: existing.finished_at || now,
    summary: {
      ...(existing.summary || {}),
      cancel_requested_at: now,
      cancel_requested_by: requestedBy,
    },
    indexed_pages: existing.indexed_pages || [],
    token_usage: existing.token_usage || {},
    error: existing.error || null,
  });

  return { ok: true, run: next };
}

function imageJobsDir() {
  return path.join(DATA_DIR, "image-jobs");
}

function ensureImageJobsDir() {
  const dir = imageJobsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function imageJobFilepath(jobId) {
  return path.join(imageJobsDir(), `${jobId}.json`);
}

function saveImageJob(job) {
  ensureImageJobsDir();
  fs.writeFileSync(imageJobFilepath(job.id), JSON.stringify(job, null, 2), "utf-8");
}

function extractToken(req) {
  const auth = String(req.headers.authorization || "").trim();
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return String(req.headers["x-govchat-token"] || "").trim();
}

function normalizeTranscriptSessionInput(input = {}, fallbackId = "") {
  const text = String(input.text || "").trim();
  const segments = Array.isArray(input.segments) ? input.segments : [];
  const now = Date.now();
  const rawId = String(input.id || fallbackId || `trs-${now}-${crypto.randomBytes(4).toString("hex")}`).trim();
  const id = rawId || `trs-${now}-${crypto.randomBytes(4).toString("hex")}`;
  const createdAt = Number(input.createdAt || now);
  const updatedAt = Number(input.updatedAt || now);
  const durationMs = Math.max(0, Number(input.durationMs || 0));
  const wordCount = Math.max(0, Number(input.wordCount || 0));
  const title = String(input.title || "").trim() || "Transcriptie sessie";
  const inputSource = String(input.inputSource || "").trim() || "Onbekend";
  const inputDevice = String(input.inputDevice || "").trim() || "Onbekend";
  const language = String(input.language || "").trim() || "nl";
  return {
    id,
    title,
    createdAt: Number.isFinite(createdAt) ? createdAt : now,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : now,
    durationMs,
    inputSource,
    inputDevice,
    wordCount,
    language,
    text,
    segments,
  };
}

function readTranscriptSessionsStore() {
  const raw = readPrivateJSON(TRANSCRIPT_SESSIONS_FILE);
  if (!raw || typeof raw !== "object") return { users: {} };
  if (!raw.users || typeof raw.users !== "object") return { users: {} };
  return raw;
}

function writeTranscriptSessionsStore(store) {
  const normalized = store && typeof store === "object" ? store : { users: {} };
  if (!normalized.users || typeof normalized.users !== "object") {
    normalized.users = {};
  }
  writePrivateJSON(TRANSCRIPT_SESSIONS_FILE, normalized);
}

function sortTranscriptSessions(items, sort = "newest") {
  const arr = [...(Array.isArray(items) ? items : [])];
  const mode = String(sort || "newest").trim().toLowerCase();
  if (mode === "oldest") {
    return arr.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
  }
  if (mode === "updated") {
    return arr.sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));
  }
  if (mode === "duration") {
    return arr.sort((a, b) => Number(b.durationMs || 0) - Number(a.durationMs || 0));
  }
  if (mode === "words") {
    return arr.sort((a, b) => Number(b.wordCount || 0) - Number(a.wordCount || 0));
  }
  if (mode === "title") {
    return arr.sort((a, b) => String(a.title || "").localeCompare(String(b.title || ""), "nl"));
  }
  return arr.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}

async function resolveLibreChatUserFromRequest(req) {
  const trustedUser = resolveUserFromVerifiedRefreshToken(req);
  if (trustedUser) return trustedUser;

  const debugAttempts = [];
  const inboundHeadersSnapshot = TRANSCRIPT_AUTH_DEBUG
    ? {
        host: String(req.headers?.host || ""),
        origin: String(req.headers?.origin || ""),
        referer: String(req.headers?.referer || ""),
        "user-agent": String(req.headers?.["user-agent"] || ""),
        "x-forwarded-for": String(req.headers?.["x-forwarded-for"] || ""),
        "x-forwarded-proto": String(req.headers?.["x-forwarded-proto"] || ""),
        "x-real-ip": String(req.headers?.["x-real-ip"] || ""),
      }
    : null;
  const pushDebug = (entry) => {
    if (!TRANSCRIPT_AUTH_DEBUG) return;
    debugAttempts.push(entry);
  };
  const flushDebug = (reason = "") => {
    if (!TRANSCRIPT_AUTH_DEBUG) return;
    try {
      console.warn(
        `[transcript-auth] resolve failed (${reason})`,
        JSON.stringify(
          {
            path: String(req.originalUrl || req.url || ""),
            hasCookieHeader: Boolean(String(req.headers?.cookie || "").trim()),
            hasAuthorizationHeader: Boolean(String(req.headers?.authorization || "").trim()),
            inboundHeaders: inboundHeadersSnapshot,
            inboundCookieNames,
            tokenCookieHits,
            bearerVariantsCount: bearerSet.size,
            attempts: debugAttempts,
          },
          null,
          2,
        ),
      );
    } catch {
      // ignore logging errors
    }
  };

  const authHeaderRaw = String(req.headers?.authorization || "").trim();
  let cookieHeader = String(req.headers?.cookie || "").trim();
  if (!cookieHeader && !authHeaderRaw) return null;

  const parseCookieMap = (rawCookie = "") => {
    const out = {};
    String(rawCookie || "")
      .split(";")
      .map((p) => p.trim())
      .filter(Boolean)
      .forEach((part) => {
        const idx = part.indexOf("=");
        if (idx <= 0) return;
        const key = part.slice(0, idx).trim();
        const val = part.slice(idx + 1).trim();
        if (!key) return;
        try {
          out[key] = decodeURIComponent(val);
        } catch {
          out[key] = val;
        }
      });
    return out;
  };

  const cookieMap = parseCookieMap(cookieHeader);
  const inboundCookieNames = Object.keys(cookieMap);
  const rebuildCookieHeader = () => {
    cookieHeader = Object.entries(cookieMap)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join("; ");
  };

  const applySetCookieHeaders = (headersLike) => {
    if (!headersLike) return;
    let setCookies = [];
    if (typeof headersLike.getSetCookie === "function") {
      setCookies = headersLike.getSetCookie();
    } else {
      const raw = headersLike.get?.("set-cookie");
      if (raw) {
        setCookies = String(raw)
          .split(/,(?=[^;,=\s]+=[^;,]+)/g)
          .map((v) => v.trim())
          .filter(Boolean);
      }
    }
    if (!Array.isArray(setCookies) || !setCookies.length) return;
    for (const line of setCookies) {
      const kv = String(line || "")
        .split(";")[0]
        .trim();
      const idx = kv.indexOf("=");
      if (idx <= 0) continue;
      const key = kv.slice(0, idx).trim();
      const val = kv.slice(idx + 1).trim();
      if (!key) continue;
      cookieMap[key] = val;
    }
    rebuildCookieHeader();
  };
  const candidateTokenKeys = [
    "token",
    "accessToken",
    "access_token",
    "jwt",
    "jwtToken",
    "authToken",
    "authorization",
  ];

  const bearerSet = new Set();
  if (authHeaderRaw) {
    const direct = authHeaderRaw.toLowerCase().startsWith("bearer ")
      ? authHeaderRaw.slice(7).trim()
      : authHeaderRaw;
    if (direct) bearerSet.add(`Bearer ${direct}`);
  }
  for (const key of candidateTokenKeys) {
    const val = String(cookieMap[key] || "").trim();
    if (!val) continue;
    if (val.toLowerCase().startsWith("bearer ")) {
      const token = val.slice(7).trim();
      if (token) bearerSet.add(`Bearer ${token}`);
      continue;
    }
    if (val.includes(".")) {
      bearerSet.add(`Bearer ${val}`);
    }
  }
  const tokenCookieHits = candidateTokenKeys.filter((k) => String(cookieMap[k] || "").trim());

  const extractUser = (payload) => {
    if (!payload || typeof payload !== "object") return null;
    const candidateUsers = [
      payload.user,
      payload.data?.user,
      payload.data,
      payload.profile,
      payload,
    ];
    for (const user of candidateUsers) {
      if (!user || typeof user !== "object") continue;
      const id = String(user.id || user._id || user.userId || user.sub || "").trim();
      const email = String(user.email || "").trim();
      const username = String(user.username || user.name || "").trim();
      const key = id || email || username;
      if (!key) continue;
      return {
        id: key,
        email: email || undefined,
        username: username || undefined,
        label: email || username || key,
      };
    }
    return null;
  };

  const extractAccessToken = (payload) => {
    if (!payload || typeof payload !== "object") return "";
    const token = String(
      payload.token ||
        payload.accessToken ||
        payload.access_token ||
        payload.jwt ||
        payload.authToken ||
        payload.data?.token ||
        payload.data?.accessToken ||
        payload.data?.access_token ||
        payload.data?.jwt ||
        "",
    ).trim();
    return token;
  };

  const requestWithAuthVariants = async ({ endpoint, method = "GET", body = undefined }) => {
    const authVariants = ["", ...bearerSet];
    for (const authHeader of authVariants) {
      try {
        const headers = {
          accept: "application/json",
          "user-agent": String(req.headers?.["user-agent"] || "govchat-overlay-admin/1.0"),
          "x-forwarded-for": String(req.headers?.["x-forwarded-for"] || ""),
          "x-forwarded-proto": String(req.headers?.["x-forwarded-proto"] || ""),
          "x-real-ip": String(req.headers?.["x-real-ip"] || ""),
          "x-requested-with": "govchat-overlay-admin",
        };
        if (cookieHeader) headers.cookie = cookieHeader;
        if (authHeader) headers.authorization = authHeader;
        if (body !== undefined) headers["content-type"] = "application/json";

        const res = await fetch(`${LIBRECHAT_INTERNAL_URL}${endpoint}`, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        pushDebug({
          endpoint,
          method,
          status: Number(res.status || 0),
          usedAuthHeader: Boolean(authHeader),
          hadCookieHeader: Boolean(cookieHeader),
          outboundHeaderKeys: Object.keys(headers),
        });
        applySetCookieHeaders(res.headers);
        if (!res.ok) continue;
        const payload = await res.json().catch(() => null);
        if (!payload) {
          pushDebug({ endpoint, method, status: Number(res.status || 0), note: "empty-json" });
        }
        if (!payload || typeof payload !== "object") continue;

        const token = extractAccessToken(payload);
        if (token) bearerSet.add(`Bearer ${token}`);

        const user = extractUser(payload);
        if (user) return user;
      } catch {
        // try next variant/endpoint
      }
    }
    return null;
  };

  const candidates = ["/api/user", "/api/auth/me", "/api/me"];

  for (const endpoint of candidates) {
    const user = await requestWithAuthVariants({ endpoint, method: "GET" });
    if (user) return user;
  }

  // Fallback for deployments where user resolution requires refresh-token exchange first.
  await requestWithAuthVariants({ endpoint: "/api/auth/refresh", method: "POST", body: {} });
  for (const endpoint of candidates) {
    const user = await requestWithAuthVariants({ endpoint, method: "GET" });
    if (user) return user;
  }

  flushDebug("no-user-from-endpoints");
  return null;
}

async function requireLibreChatUser(req, res, next) {
  const user = await resolveLibreChatUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ error: "Niet ingelogd of gebruiker niet resolvebaar" });
  }
  req.librechatUser = user;
  next();
}

function requireImageJobsAuth(req, res, next) {
  if (!IMAGE_JOBS_ENABLED) {
    return res.status(404).json({ error: "Image jobs endpoint staat uit" });
  }

  const user = resolveUserFromVerifiedRefreshToken(req);
  if (!user || !/^[A-Za-z0-9_-]{8,64}$/.test(user.id)) {
    return res.status(401).json({ error: "Niet ingelogd" });
  }

  const requestOrigin = String(req.get("origin") || "").trim();
  if (req.method !== "GET" || requestOrigin) {
    let expectedOrigin = "";
    try {
      expectedOrigin = new URL(PUBLIC_BASE_URL).origin;
    } catch {
      return res.status(503).json({ error: "Server misconfiguratie: PUBLIC_BASE_URL is ongeldig" });
    }
    if (!requestOrigin || requestOrigin !== expectedOrigin) {
      return res.status(403).json({ error: "Cross-origin verzoek geweigerd" });
    }
  }

  const fetchSite = String(req.get("sec-fetch-site") || "").trim().toLowerCase();
  if (fetchSite && fetchSite !== "same-origin") {
    return res.status(403).json({ error: "Cross-site verzoek geweigerd" });
  }

  req.librechatUser = user;
  return next();
}

function requireCrawlerInternalAuth(req, res, next) {
  if (!CRAWLER_INTERNAL_TOKEN) {
    return res.status(503).json({ error: "Server misconfiguratie: CRAWLER_INTERNAL_TOKEN ontbreekt" });
  }

  const supplied = extractToken(req);
  if (!supplied || supplied !== CRAWLER_INTERNAL_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  return next();
}

async function triggerCrawlerRun({ trigger = "manual", requestedBy = "admin-ui" } = {}) {
  if (!CRAWLER_N8N_WEBHOOK_TOKEN) {
    throw new Error("CRAWLER_N8N_WEBHOOK_TOKEN ontbreekt");
  }

  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  upsertCrawlerRun({
    run_id: runId,
    status: "running",
    trigger,
    started_at: startedAt,
    finished_at: startedAt,
    summary: {
      requested_at: startedAt,
      requested_by: requestedBy,
    },
  });

  const response = await fetch(CRAWLER_N8N_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-govchat-token": CRAWLER_N8N_WEBHOOK_TOKEN,
    },
    body: JSON.stringify({
      run_id: runId,
      trigger,
      requested_by: requestedBy,
      requested_at: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(30000),
  });

  let payload = null;
  const raw = await response.text();
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = { raw };
  }

  if (!response.ok) {
    const msg = String(payload?.error || payload?.message || raw || "").trim();
    upsertCrawlerRun({
      run_id: runId,
      status: "failed",
      trigger,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      error: msg || `Crawler webhook gaf HTTP ${response.status}`,
    });
    throw new Error(msg || `Crawler webhook gaf HTTP ${response.status}`);
  }

  return {
    run_id: String(payload?.run_id || runId).trim() || runId,
    response: payload,
  };
}

function statusMessage(status) {
  if (status === "queued") return "Je afbeelding staat in de wachtrij.";
  if (status === "running") return "Je afbeelding wordt nu gegenereerd.";
  if (status === "succeeded") return "Je afbeelding is klaar.";
  if (status === "failed") return "Afbeelding genereren is mislukt.";
  return "Onbekende status.";
}

function toPublicImageJob(job) {
  return {
    job_id: job.id,
    status: job.status,
    message: statusMessage(job.status),
    created_at: job.created_at,
    updated_at: job.updated_at,
    started_at: job.started_at || null,
    completed_at: job.completed_at || null,
    prompt: job.prompt,
    size: job.size,
    quality: job.quality,
    image_url: job.image_url || null,
    markdown: job.markdown || null,
    result_text: job.result_text || null,
    error: job.error || null,
    poll_after_ms: job.status === "queued" || job.status === "running" ? 1200 : 0,
  };
}

function updateImageJob(job, partial) {
  const updated = {
    ...job,
    ...partial,
    updated_at: new Date().toISOString(),
  };
  imageJobs.set(updated.id, updated);
  saveImageJob(updated);
  return updated;
}

function loadPersistedImageJobs() {
  if (!IMAGE_JOBS_ENABLED) return;

  ensureImageJobsDir();
  const entries = fs
    .readdirSync(imageJobsDir(), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"));

  for (const entry of entries) {
    const raw = fs.readFileSync(path.join(imageJobsDir(), entry.name), "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.id || !parsed.status) continue;

    if (parsed.status === "running") {
      parsed.status = "queued";
      parsed.updated_at = new Date().toISOString();
      parsed.error = null;
    }

    imageJobs.set(parsed.id, parsed);
    if (parsed.status === "queued") {
      imageJobQueue.push(parsed.id);
    }
  }
}

function cleanupImageJobs() {
  if (!IMAGE_JOBS_ENABLED) return;

  const now = Date.now();
  const ttlMs = IMAGE_JOBS_TTL_HOURS * 60 * 60 * 1000;
  const terminal = new Set(["succeeded", "failed"]);

  for (const [jobId, job] of imageJobs.entries()) {
    if (!terminal.has(job.status)) continue;
    const updatedAt = Date.parse(job.updated_at || "");
    if (Number.isNaN(updatedAt)) continue;
    if (now - updatedAt < ttlMs) continue;

    imageJobs.delete(jobId);
    const fp = imageJobFilepath(jobId);
    if (fs.existsSync(fp)) {
      fs.unlinkSync(fp);
    }
  }
}

async function runImageJob(jobId) {
  const existing = imageJobs.get(jobId);
  if (!existing) return;

  if (!IMAGE_JOBS_WEBHOOK_TOKEN) {
    updateImageJob(existing, {
      status: "failed",
      completed_at: new Date().toISOString(),
      error: "Afbeelding-generatie is tijdelijk niet beschikbaar.",
    });
    return;
  }

  const running = updateImageJob(existing, {
    status: "running",
    started_at: new Date().toISOString(),
    error: null,
  });

  try {
    const res = await fetch(IMAGE_JOBS_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-govchat-token": IMAGE_JOBS_WEBHOOK_TOKEN,
      },
      body: JSON.stringify({
        prompt: running.prompt,
        size: running.size,
        quality: running.quality,
        user_id: running.user_id,
      }),
      signal: AbortSignal.timeout(240000),
    });

    const raw = await res.text();
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      payload = { response: raw };
    }

    if (!res.ok) {
      updateImageJob(running, {
        status: "failed",
        completed_at: new Date().toISOString(),
        error: "Afbeelding-generatie is mislukt; probeer het later opnieuw.",
      });
      return;
    }

    const imageUrl = String(payload?.image_url || "").trim();
    const expectedImagePrefix = `/images/${running.user_id}/`;
    const imageName = imageUrl.startsWith(expectedImagePrefix)
      ? imageUrl.slice(expectedImagePrefix.length)
      : "";
    if (!/^generated-\d+-[0-9a-f-]{36}\.(png|jpg)$/.test(imageName)) {
      updateImageJob(running, {
        status: "failed",
        completed_at: new Date().toISOString(),
        error: "Afbeelding-generatie is mislukt; probeer het later opnieuw.",
      });
      return;
    }
    const markdown = `![gegenereerde afbeelding](${imageUrl})`;
    const responseText = markdown;

    updateImageJob(running, {
      status: "succeeded",
      completed_at: new Date().toISOString(),
      image_url: imageUrl,
      markdown,
      result_text: responseText,
      error: null,
    });
  } catch (err) {
    updateImageJob(running, {
      status: "failed",
      completed_at: new Date().toISOString(),
      error: "Afbeelding-generatie is tijdelijk niet beschikbaar.",
    });
  }
}

function pumpImageJobs() {
  if (!IMAGE_JOBS_ENABLED) return;

  while (imageWorkersActive < IMAGE_JOBS_CONCURRENCY && imageJobQueue.length > 0) {
    const nextJobId = imageJobQueue.shift();
    if (!nextJobId) continue;

    const nextJob = imageJobs.get(nextJobId);
    if (!nextJob || nextJob.status !== "queued") continue;

    imageWorkersActive += 1;

    runImageJob(nextJobId)
      .catch((err) => {
        console.warn(`[image-jobs] Worker fout: ${err?.message || err}`);
      })
      .finally(() => {
        imageWorkersActive = Math.max(0, imageWorkersActive - 1);
        setImmediate(pumpImageJobs);
      });
  }
}

function createImageJob({ prompt, size, quality, userId }) {
  const now = new Date().toISOString();
  const job = {
    id: crypto.randomUUID(),
    status: "queued",
    created_at: now,
    updated_at: now,
    started_at: null,
    completed_at: null,
    prompt,
    size,
    quality,
    user_id: userId,
    image_url: null,
    markdown: null,
    result_text: null,
    error: null,
  };

  imageJobs.set(job.id, job);
  imageJobQueue.push(job.id);
  saveImageJob(job);
  setImmediate(pumpImageJobs);
  return job;
}

// ── Auth helpers ───────────────────────────────────────────────────
function createSession() {
  const id = crypto.randomBytes(24).toString("hex");
  sessions.set(id, { created: Date.now() });
  return id;
}

function isAuthenticated(req) {
  const sid = req.cookies?.session;
  return sid && sessions.has(sid);
}

function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  res.redirect("/login");
}

// ── View helper ────────────────────────────────────────────────────
function sendView(res, name, vars = {}) {
  const filepath = path.join(__dirname, "views", name);
  let html = fs.readFileSync(filepath, "utf-8");
  for (const [key, value] of Object.entries(vars)) {
    html = html.replaceAll(`{{${key}}}`, value);
  }
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
  res.type("html").send(html);
}

// ── Public API endpoints (no auth) ────────────────────────────────
app.get("/api/config/help-content", (req, res) => {
  const data = readJSON("help-content.json");
  if (!data) return res.status(404).json({ error: "Not found" });
  res.json(data);
});

app.get("/api/config/apps", (req, res) => {
  const data = readJSON("apps.json");
  if (!data) return res.status(404).json({ error: "Not found" });
  res.json(data);
});

app.get("/api/config/orchestrator", (req, res) => {
  res.json(readOrchestratorConfig());
});

app.post("/api/config/orchestrator/normalize-image", async (req, res) => {
  try {
    const imageDataUrl = String(req.body?.image_data_url || "").trim();
    if (!imageDataUrl.startsWith("data:")) {
      return res.status(400).json({ error: "Veld image_data_url met geldige data-url is verplicht" });
    }

    const cfg = readOrchestratorConfig();
    const normalized = await normalizeImageDataUrl(imageDataUrl, {
      max_resolution_px: req.body?.max_resolution_px || cfg.image_max_resolution_px,
      max_chars: req.body?.max_chars || cfg.image_data_url_max_chars,
    });

    return res.json({ ok: true, ...normalized });
  } catch (err) {
    return res.status(400).json({ error: err?.message || String(err) });
  }
});

app.get("/api/crawler/internal/config", requireCrawlerInternalAuth, (req, res) => {
  res.json(readCrawlerConfig());
});

app.get("/api/crawler/internal/runs", requireCrawlerInternalAuth, (req, res) => {
  const limit = Math.max(1, Number.parseInt(String(req.query.limit || "50"), 10) || 50);
  const runs = readCrawlerRuns().slice(0, limit);
  res.json({ runs });
});

app.get("/api/crawler/internal/runs/:runId/cancelled", requireCrawlerInternalAuth, (req, res) => {
  const runId = String(req.params.runId || "").trim();
  const run = getCrawlerRun(runId);
  if (!run) {
    return res.status(404).json({ error: "Run niet gevonden", cancel_requested: false });
  }
  const status = String(run.status || "").trim().toLowerCase();
  const cancelRequested = status === "cancel_requested" || status === "cancelled";
  return res.json({
    run_id: runId,
    status,
    cancel_requested: cancelRequested,
  });
});

app.post("/api/crawler/internal/runs", requireCrawlerInternalAuth, (req, res) => {
  try {
    let payload = req.body;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        payload = { error: payload };
      }
    }
    const run = upsertCrawlerRun(payload || {});
    return res.json({ ok: true, run });
  } catch (err) {
    return res.status(400).json({ error: err.message || String(err) });
  }
});

app.get("/api/internal/image-auth", (req, res) => {
  res.set("Cache-Control", "no-store");
  const owner = String(req.get("x-image-owner") || "").trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(owner)) return res.sendStatus(401);

  const user = resolveUserFromVerifiedRefreshToken(req);
  if (!user || user.id !== owner) return res.sendStatus(401);
  return res.sendStatus(204);
});

app.post("/api/image-jobs", requireImageJobsAuth, (req, res) => {
  const prompt = String(req.body?.prompt || "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .trim();
  const size = String(req.body?.size || "1024x1024").trim().toLowerCase();
  const quality = String(req.body?.quality || "standard").trim().toLowerCase();

  if (!prompt) {
    return res.status(400).json({ error: "Veld \"prompt\" is verplicht" });
  }

  if (prompt.length > 2000) {
    return res.status(400).json({ error: "Prompt is te lang (maximaal 2000 tekens)" });
  }

  const allowedSizes = new Set(["1024x1024", "1536x1024", "1024x1536", "1792x1024", "1024x1792"]);
  const allowedQualities = new Set(["standard", "auto", "low", "medium", "high", "hd"]);
  if (!allowedSizes.has(size) || !allowedQualities.has(quality)) {
    return res.status(400).json({ error: "Ongeldig formaat of kwaliteitsniveau" });
  }

  const activeUserJobs = [...imageJobs.values()].filter(
    (job) => job.user_id === req.librechatUser.id && ["queued", "running"].includes(job.status),
  ).length;
  if (activeUserJobs >= 2) {
    return res.status(429).json({ error: "Je hebt al twee afbeeldingsopdrachten in uitvoering" });
  }

  const job = createImageJob({ prompt, size, quality, userId: req.librechatUser.id });
  return res.status(202).json({
    ...toPublicImageJob(job),
    status_url: `/govchat-api/image-jobs/${job.id}`,
    result_url: `/govchat-api/image-jobs/${job.id}`,
  });
});

app.get("/api/image-jobs/:jobId", requireImageJobsAuth, (req, res) => {
  const jobId = String(req.params.jobId || "").trim();
  const job = imageJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ error: "Job niet gevonden" });
  }

  if (job.user_id !== req.librechatUser.id) {
    return res.status(404).json({ error: "Job niet gevonden" });
  }

  return res.json(toPublicImageJob(job));
});

// ── Login ──────────────────────────────────────────────────────────
app.get("/login", (req, res) => {
  if (isAuthenticated(req)) return res.redirect("/dashboard");
  sendView(res, "login.html", { error: "" });
});

app.post("/login", (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    const sid = createSession();
    res.cookie("session", sid, {
      httpOnly: true,
      sameSite: "strict",
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });
    return res.redirect("/dashboard");
  }
  sendView(res, "login.html", {
    error: '<p class="error">Onjuist wachtwoord. Probeer het opnieuw.</p>',
  });
});

app.get("/logout", (req, res) => {
  const sid = req.cookies?.session;
  if (sid) sessions.delete(sid);
  res.clearCookie("session");
  res.redirect("/login");
});

// ── Admin pages (auth required) ────────────────────────────────────
app.get("/", (req, res) => {
  if (isAuthenticated(req)) return res.redirect("/dashboard");
  res.redirect("/login");
});

app.get("/dashboard", requireAuth, (req, res) => {
  const helpData = readJSON("help-content.json");
  const appsData = readJSON("apps.json");
  const crawlerConfig = readCrawlerConfig();
  const orchestratorConfig = readOrchestratorConfig();
  const beleidskompasState = readBeleidskompasState();
  const helpSections = helpData?.sections?.length || 0;
  const appCount = appsData?.apps?.length || 0;
  const beleidskompasStepCount = Array.isArray(beleidskompasState?.live?.steps)
    ? beleidskompasState.live.steps.length
    : 0;
  const beleidskompasVersionCount = Array.isArray(beleidskompasState?.versions)
    ? beleidskompasState.versions.length
    : 0;
  const beleidskompasDocCount = Array.isArray(beleidskompasState?.documents)
    ? beleidskompasState.documents.length
    : 0;
  sendView(res, "dashboard.html", {
    helpSections: String(helpSections),
    appCount: String(appCount),
    crawlerSources: String(crawlerConfig?.sources?.filter((s) => s?.enabled !== false).length || 0),
    crawlerEnabled: crawlerConfig?.enabled ? "Actief" : "Uitgeschakeld",
    orchestratorImageCap: String(orchestratorConfig?.image_data_url_max_chars || ORCHESTRATOR_IMAGE_DATA_URL_MAX_CHARS_DEFAULT),
    helpTitle: helpData?.title || "(niet ingesteld)",
    appsTitle: appsData?.title || "(niet ingesteld)",
    beleidskompasVersionCount: String(beleidskompasVersionCount),
    beleidskompasStepCount: String(beleidskompasStepCount),
    beleidskompasDocCount: String(beleidskompasDocCount),
  });
});

app.get("/crawler-editor", requireAuth, (req, res) => {
  sendView(res, "crawler-editor.html", {
    jsonData: JSON.stringify(readCrawlerConfig()),
    orchestratorData: JSON.stringify(readOrchestratorConfig()),
  });
});

app.get("/orchestrator-editor", requireAuth, (req, res) => {
  sendView(res, "orchestrator-editor.html", {
    orchestratorData: JSON.stringify(readOrchestratorConfig()),
  });
});

app.get("/help-editor", requireAuth, (req, res) => {
  const data = readJSON("help-content.json") || { title: "", subtitle: "", sections: [] };
  sendView(res, "help-editor.html", {
    jsonData: JSON.stringify(data),
  });
});

app.get("/apps-editor", requireAuth, (req, res) => {
  const data = readJSON("apps.json") || { title: "App Launcher", apps: [] };
  sendView(res, "apps-editor.html", {
    jsonData: JSON.stringify(data),
  });
});

// Beleidskompas admin UI: a shell page plus its ES modules and CSS.
app.get("/beleidskompas-editor", requireAuth, (req, res) => {
  sendView(res, "beleidskompas-admin.html");
});
app.use(
  "/beleidskompas-admin/assets",
  requireAuth,
  express.static(path.join(__dirname, "views", "beleidskompas-admin"), { maxAge: 0 }),
);

// ── Admin API endpoints (auth required) ────────────────────────────
app.post("/api/config/help-content", requireAuth, (req, res) => {
  try {
    writeJSON("help-content.json", req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/config/apps", requireAuth, (req, res) => {
  try {
    writeJSON("apps.json", req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/beleidskompas/state", requireAuth, (req, res) => {
  const state = readBeleidskompasState();
  return res.json({ ok: true, state });
});

// ── Beleidskompas user feedback ──────────────────────────────────
//
// Deliberately anonymous: only the rating, an optional comment, the step and
// substep the feedback is about and the live template version. No user,
// e-mail or conversation id, so the feedback cannot be traced back to a
// person or a case.
function readBeleidskompasFeedback() {
  const stored = readPrivateJSON(BELEIDSKOMPAS_FEEDBACK_FILE);
  const items = stored && Array.isArray(stored.items) ? stored.items : [];
  return items;
}

app.post("/api/beleidskompas-feedback", (req, res) => {
  // Only a logged-in user may rate; who it was is not kept.
  if (!resolveUserFromVerifiedRefreshToken(req)) return res.status(401).json({ error: "Unauthorized" });
  const rating = String(req.body?.rating || "").trim().toLowerCase();
  if (rating !== "up" && rating !== "down") {
    return res.status(400).json({ error: 'Veld "rating" moet "up" of "down" zijn' });
  }
  const comment = String(req.body?.comment || "").trim().slice(0, 2000);
  const stepId = String(req.body?.step_id || "").trim().slice(0, 64);
  const substepId = String(req.body?.substep_id || "").trim().slice(0, 32);
  const versionId = String(req.body?.version_id || "").trim().slice(0, 64);

  const items = readBeleidskompasFeedback();
  items.push({
    id: crypto.randomUUID(),
    rating,
    comment,
    step_id: stepId,
    substep_id: substepId,
    version_id: versionId,
    created_at: new Date().toISOString(),
  });
  writePrivateJSON(BELEIDSKOMPAS_FEEDBACK_FILE, {
    items: items.slice(-BELEIDSKOMPAS_FEEDBACK_MAX),
  });
  return res.status(201).json({ ok: true });
});

app.get("/api/beleidskompas-feedback", requireAuth, (req, res) => {
  const items = readBeleidskompasFeedback();
  const up = items.filter((i) => i.rating === "up").length;
  return res.json({
    items: items.slice().reverse(),
    totals: { total: items.length, up, down: items.length - up },
  });
});

app.get("/api/beleidskompas/export", requireAuth, (req, res) => {
  const state = readBeleidskompasState();
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(200).send(JSON.stringify(state, null, 2));
});

app.post("/api/beleidskompas/import", requireAuth, (req, res) => {
  try {
    const incoming = req.body && typeof req.body === "object" ? req.body : {};
    const current = readBeleidskompasState();
    const next = {
      ...current,
      ...(incoming.state && typeof incoming.state === "object" ? incoming.state : incoming),
    };
    const saved = writeBeleidskompasState(next);
    return res.json({ ok: true, state: saved });
  } catch (err) {
    return res.status(400).json({ error: String(err?.message || err) });
  }
});

app.post("/api/beleidskompas/settings", requireAuth, (req, res) => {
  try {
    const state = readBeleidskompasState();
    const incoming = req.body && typeof req.body === "object" ? req.body : {};
    const nextSettings = {
      ...state.settings,
      ...incoming,
      retention_days: Math.max(1, Number.parseInt(String(incoming.retention_days ?? state.settings?.retention_days ?? 365), 10) || 365),
      enforce_source_citation: Boolean(
        Object.prototype.hasOwnProperty.call(incoming, "enforce_source_citation")
          ? incoming.enforce_source_citation
          : state.settings?.enforce_source_citation,
      ),
      require_human_validation: Boolean(
        Object.prototype.hasOwnProperty.call(incoming, "require_human_validation")
          ? incoming.require_human_validation
          : state.settings?.require_human_validation,
      ),
      default_model: String(incoming.default_model ?? state.settings?.default_model ?? "govchat-default").trim() || "govchat-default",
    };
    state.settings = nextSettings;
    const saved = writeBeleidskompasState(state);
    return res.json({ ok: true, settings: saved.settings });
  } catch (err) {
    return res.status(400).json({ error: String(err?.message || err) });
  }
});

app.post("/api/beleidskompas/publish", requireAuth, (req, res) => {
  try {
    const state = readBeleidskompasState();
    const flow = normalizeBeleidskompasFlow(req.body?.flow || state.draft || state.live);
    const note = String(req.body?.note || "").trim();
    // live: false saves a new version without deploying it (deploy goes through /rollback/:versionId).
    const goLive = req.body?.live !== false;
    const versionId = `v${Date.now()}`;
    const who = "System Administrator";
    const publishedAt = new Date().toISOString();

    if (goLive) for (const v of state.versions) v.is_live = false;
    const version = {
      id: versionId,
      published_at: publishedAt,
      published_by: who,
      note,
      is_live: goLive,
      snapshot: cloneJSON(flow),
    };
    state.versions.unshift(version);
    state.draft = cloneJSON(flow);
    if (goLive) {
      state.live_version_id = versionId;
      state.live = cloneJSON(flow);
    }

    const saved = writeBeleidskompasState(state);
    if (goLive) publishBeleidskompasLiveConfig(saved.live, saved.live_version_id);
    return res.json({ ok: true, version, live: saved.live });
  } catch (err) {
    return res.status(400).json({ error: String(err?.message || err) });
  }
});

app.post("/api/beleidskompas/rollback/:versionId", requireAuth, (req, res) => {
  const versionId = String(req.params.versionId || "").trim();
  if (!versionId) return res.status(400).json({ error: "versionId ontbreekt" });

  const state = readBeleidskompasState();
  const target = state.versions.find((v) => String(v.id || "") === versionId);
  if (!target) return res.status(404).json({ error: "Versie niet gevonden" });

  state.live_version_id = versionId;
  state.live = normalizeBeleidskompasFlow(target.snapshot);
  state.draft = normalizeBeleidskompasFlow(target.snapshot);
  for (const v of state.versions) v.is_live = v.id === versionId;

  const saved = writeBeleidskompasState(state);
  publishBeleidskompasLiveConfig(saved.live, saved.live_version_id);
  return res.json({ ok: true, live: saved.live, version_id: versionId });
});

app.get("/api/beleidskompas/documents", requireAuth, (req, res) => {
  const state = readBeleidskompasState();
  const docs = state.documents.map((d) => ({
    ...d,
    content_base64: undefined,
  }));
  return res.json({ ok: true, documents: docs });
});

app.post("/api/beleidskompas/documents", requireAuth, (req, res) => {
  try {
    const filename = String(req.body?.filename || "").trim();
    const mimeType = String(req.body?.mime_type || "application/octet-stream").trim();
    const contentBase64 = String(req.body?.content_base64 || "").trim();
    const tags = normalizeTags(req.body?.tags || []);
    if (!filename) return res.status(400).json({ error: "filename ontbreekt" });

    const bytes = contentBase64 ? Buffer.from(contentBase64, "base64") : Buffer.from("");
    let previewText = "Preview niet beschikbaar voor dit documenttype.";
    if (mimeType.startsWith("text/") || filename.toLowerCase().endsWith(".md") || filename.toLowerCase().endsWith(".txt")) {
      previewText = bytes.toString("utf-8").slice(0, 4000);
    }

    const state = readBeleidskompasState();
    const doc = {
      id: crypto.randomUUID(),
      filename,
      mime_type: mimeType,
      uploaded_at: new Date().toISOString(),
      size_bytes: bytes.length,
      tags,
      preview_text: previewText,
      content_base64: contentBase64,
    };
    state.documents.unshift(doc);
    writeBeleidskompasState(state);

    return res.status(201).json({ ok: true, document: { ...doc, content_base64: undefined } });
  } catch (err) {
    return res.status(400).json({ error: String(err?.message || err) });
  }
});

app.patch("/api/beleidskompas/documents/:docId", requireAuth, (req, res) => {
  const docId = String(req.params.docId || "").trim();
  if (!docId) return res.status(400).json({ error: "docId ontbreekt" });

  const state = readBeleidskompasState();
  const idx = state.documents.findIndex((d) => String(d.id || "") === docId);
  if (idx < 0) return res.status(404).json({ error: "Document niet gevonden" });

  const current = state.documents[idx];
  current.tags = normalizeTags(req.body?.tags || current.tags || []);
  current.filename = String(req.body?.filename || current.filename || "document").trim() || "document";
  state.documents[idx] = current;
  writeBeleidskompasState(state);
  return res.json({ ok: true, document: { ...current, content_base64: undefined } });
});

app.get("/api/beleidskompas/documents/:docId/download", requireAuth, (req, res) => {
  const docId = String(req.params.docId || "").trim();
  if (!docId) return res.status(400).json({ error: "docId ontbreekt" });

  const state = readBeleidskompasState();
  const doc = state.documents.find((d) => String(d.id || "") === docId);
  if (!doc) return res.status(404).json({ error: "Document niet gevonden" });

  const b64 = String(doc.content_base64 || "").trim();
  if (!b64) return res.status(404).json({ error: "Geen inhoud beschikbaar" });

  const bytes = Buffer.from(b64, "base64");
  res.setHeader("Content-Type", String(doc.mime_type || "application/octet-stream"));
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(String(doc.filename || "document"))}"`);
  return res.status(200).send(bytes);
});

app.delete("/api/beleidskompas/documents/:docId", requireAuth, (req, res) => {
  const docId = String(req.params.docId || "").trim();
  if (!docId) return res.status(400).json({ error: "docId ontbreekt" });

  const state = readBeleidskompasState();
  const before = state.documents.length;
  state.documents = state.documents.filter((d) => String(d.id || "") !== docId);
  if (state.documents.length === before) return res.status(404).json({ error: "Document niet gevonden" });
  writeBeleidskompasState(state);
  return res.json({ ok: true, removed: docId });
});

app.get("/api/transcript-sessions", requireLibreChatUser, (req, res) => {
  const userId = String(req.librechatUser?.id || "").trim();
  if (!userId) return res.status(401).json({ error: "Gebruiker niet gevonden" });
  const sort = String(req.query.sort || "newest").trim().toLowerCase();
  const store = readTranscriptSessionsStore();
  const sessionsForUser = Array.isArray(store.users?.[userId]) ? store.users[userId] : [];
  return res.json({
    ok: true,
    user: req.librechatUser,
    sessions: sortTranscriptSessions(sessionsForUser, sort),
  });
});

app.post("/api/transcript-sessions", requireLibreChatUser, (req, res) => {
  const userId = String(req.librechatUser?.id || "").trim();
  if (!userId) return res.status(401).json({ error: "Gebruiker niet gevonden" });
  const incoming = normalizeTranscriptSessionInput(req.body || {});
  const store = readTranscriptSessionsStore();
  if (!Array.isArray(store.users[userId])) store.users[userId] = [];
  const list = store.users[userId];
  const existingIndex = list.findIndex((s) => String(s.id || "") === String(incoming.id || ""));
  if (existingIndex >= 0) {
    list[existingIndex] = {
      ...list[existingIndex],
      ...incoming,
      updatedAt: Date.now(),
    };
  } else {
    list.unshift(incoming);
  }
  store.users[userId] = sortTranscriptSessions(list, "newest").slice(0, 500);
  writeTranscriptSessionsStore(store);
  return res.json({ ok: true, session: incoming });
});

app.patch("/api/transcript-sessions/:sessionId", requireLibreChatUser, (req, res) => {
  const userId = String(req.librechatUser?.id || "").trim();
  if (!userId) return res.status(401).json({ error: "Gebruiker niet gevonden" });
  const sessionId = String(req.params.sessionId || "").trim();
  if (!sessionId) return res.status(400).json({ error: "sessionId ontbreekt" });

  const store = readTranscriptSessionsStore();
  if (!Array.isArray(store.users[userId])) store.users[userId] = [];
  const idx = store.users[userId].findIndex((s) => String(s.id || "") === sessionId);
  if (idx < 0) return res.status(404).json({ error: "Sessie niet gevonden" });

  const current = store.users[userId][idx] || {};
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const hasTitlePatch = Object.prototype.hasOwnProperty.call(body, "title");
  const nextTitle = hasTitlePatch ? String(body.title || "").trim() : String(current.title || "").trim();
  if (hasTitlePatch && !nextTitle) return res.status(400).json({ error: "Titel mag niet leeg zijn" });

  const rawCreatedAt = Number(body.createdAt);
  const rawDurationMs = Number(body.durationMs);
  const rawWordCount = Number(body.wordCount);
  const rawUpdatedAt = Number(body.updatedAt);

  store.users[userId][idx] = {
    ...current,
    title: nextTitle,
    createdAt: Number.isFinite(rawCreatedAt) ? rawCreatedAt : Number(current.createdAt || Date.now()),
    durationMs: Number.isFinite(rawDurationMs) ? Math.max(0, rawDurationMs) : Math.max(0, Number(current.durationMs || 0)),
    inputSource: String(body.inputSource || "").trim() || String(current.inputSource || "Onbekend"),
    inputDevice: String(body.inputDevice || "").trim() || String(current.inputDevice || "Onbekend"),
    wordCount: Number.isFinite(rawWordCount) ? Math.max(0, rawWordCount) : Math.max(0, Number(current.wordCount || 0)),
    language: String(body.language || "").trim() || String(current.language || "nl"),
    text: typeof body.text === "string" ? body.text : String(current.text || ""),
    segments: Array.isArray(body.segments) ? body.segments : Array.isArray(current.segments) ? current.segments : [],
    updatedAt: Number.isFinite(rawUpdatedAt) ? rawUpdatedAt : Date.now(),
  };
  writeTranscriptSessionsStore(store);
  return res.json({ ok: true, session: store.users[userId][idx] });
});

app.delete("/api/transcript-sessions/:sessionId", requireLibreChatUser, (req, res) => {
  const userId = String(req.librechatUser?.id || "").trim();
  if (!userId) return res.status(401).json({ error: "Gebruiker niet gevonden" });
  const sessionId = String(req.params.sessionId || "").trim();
  if (!sessionId) return res.status(400).json({ error: "sessionId ontbreekt" });

  const store = readTranscriptSessionsStore();
  if (!Array.isArray(store.users[userId])) store.users[userId] = [];
  const before = store.users[userId].length;
  store.users[userId] = store.users[userId].filter((s) => String(s.id || "") !== sessionId);
  if (store.users[userId].length === before) {
    return res.status(404).json({ error: "Sessie niet gevonden" });
  }
  writeTranscriptSessionsStore(store);
  return res.json({ ok: true, removed: sessionId });
});

app.get("/api/crawler/config", requireAuth, (req, res) => {
  res.json(readCrawlerConfig());
});

app.post("/api/crawler/config", requireAuth, (req, res) => {
  try {
    const next = validateCrawlerConfig(req.body || {});
    writeJSON("crawler-config.json", next);
    return res.json({ ok: true, config: next });
  } catch (err) {
    return res.status(400).json({ error: err.message || String(err) });
  }
});

app.get("/api/orchestrator/config", requireAuth, (req, res) => {
  res.json(readOrchestratorConfig());
});

app.post("/api/orchestrator/config", requireAuth, (req, res) => {
  try {
    const next = validateOrchestratorConfig(req.body || {});
    writeJSON("orchestrator-config.json", next);
    return res.json({ ok: true, config: next });
  } catch (err) {
    return res.status(400).json({ error: err.message || String(err) });
  }
});

app.get("/api/crawler/runs", requireAuth, (req, res) => {
  const limit = Math.max(1, Number.parseInt(String(req.query.limit || "50"), 10) || 50);
  const runs = readCrawlerRuns().slice(0, limit);
  res.json({ runs });
});

app.get("/api/crawler/websites", requireAuth, (req, res) => {
  const overview = buildCrawlerWebsiteOverview();
  const includePages = String(req.query.include_pages || "").trim().toLowerCase() === "true";
  if (!includePages) {
    overview.websites = overview.websites.map((website) => {
      const { pages, ...rest } = website;
      return rest;
    });
  }
  return res.json(overview);
});

app.get("/api/crawler/websites/:websiteId", requireAuth, (req, res) => {
  const websiteId = String(req.params.websiteId || "").trim();
  if (!websiteId) {
    return res.status(400).json({ error: "websiteId ontbreekt" });
  }
  const overview = buildCrawlerWebsiteOverview();
  const website = overview.websites.find((entry) => entry.website_id === websiteId);
  if (!website) {
    return res.status(404).json({ error: "Website niet gevonden" });
  }
  return res.json({ website });
});

app.delete("/api/crawler/websites/:websiteId", requireAuth, (req, res) => {
  const websiteId = String(req.params.websiteId || "").trim();
  if (!websiteId) {
    return res.status(400).json({ error: "websiteId ontbreekt" });
  }

  const before = buildCrawlerWebsiteOverview();
  const exists = before.websites.some((website) => website.website_id === websiteId);
  if (!exists) {
    return res.status(404).json({ error: "Website niet gevonden" });
  }

  const removal = removeWebsiteFromCrawlerRuns(websiteId);
  const after = buildCrawlerWebsiteOverview();
  return res.json({
    ok: true,
    removed: {
      website_id: websiteId,
      affected_runs: removal.affected_runs,
      removed_pages: removal.removed_pages,
    },
    totals: after.totals,
  });
});

app.post("/api/crawler/run", requireAuth, async (req, res) => {
  try {
    const result = await triggerCrawlerRun({
      trigger: "manual",
      requestedBy: "admin-ui",
    });
    res.status(202).json({ ok: true, run_id: result.run_id, n8n: result.response || null });
  } catch (err) {
    res.status(502).json({ error: String(err?.message || err || "Crawler run starten mislukt") });
  }
});

app.post("/api/crawler/run/:runId/cancel", requireAuth, (req, res) => {
  const runId = String(req.params.runId || "").trim();
  if (!runId) {
    return res.status(400).json({ error: "runId ontbreekt" });
  }

  const result = requestCrawlerRunCancel(runId, "admin-ui");
  if (result.notFound) {
    return res.status(404).json({ error: "Run niet gevonden" });
  }
  if (result.terminal) {
    return res.status(409).json({ error: "Run is al afgerond", run: result.run });
  }
  if (!result.ok) {
    return res.status(400).json({ error: "Annuleren mislukt" });
  }

  return res.json({ ok: true, run: result.run });
});

realtimeWss.on("connection", (clientWs, req) => {
  const reqUrl = new URL(req.url || "/api/realtime-stt", "http://localhost");
  const suppliedToken = String(
    reqUrl.searchParams.get("token") || req.headers["x-govchat-token"] || req.headers.authorization || "",
  )
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (REALTIME_STT_TOKEN && suppliedToken !== REALTIME_STT_TOKEN) {
    sendWs(clientWs, { type: "error", error: "Unauthorized" });
    clientWs.close(4401, "Unauthorized");
    return;
  }

  let upstreamWs = null;
  let upstreamReady = false;
  let streamStartedAt = Date.now();
  let requestedLanguage = "";

  function closeUpstream() {
    if (upstreamWs) {
      try {
        upstreamWs.close();
      } catch {
        // no-op
      }
    }
    upstreamWs = null;
    upstreamReady = false;
  }

  function ensureUpstream(startPayload = {}) {
    if (upstreamWs) return;
    let target;
    try {
      target = resolveRealtimeTarget({
        provider: startPayload.provider || reqUrl.searchParams.get("provider") || undefined,
        model: startPayload.model || reqUrl.searchParams.get("model") || undefined,
        language: startPayload.language || reqUrl.searchParams.get("language") || undefined,
      });
    } catch (err) {
      sendWs(clientWs, { type: "error", error: String(err?.message || err) });
      return;
    }

    requestedLanguage = String(target.language || "").trim();
    streamStartedAt = Date.now();

    upstreamWs = new WebSocket(target.url, { headers: target.headers });

    upstreamWs.on("open", () => {
      upstreamReady = true;
      sendWs(clientWs, {
        type: "ready",
        provider: target.provider,
        model: target.model,
        language: requestedLanguage || null,
      });

      const sessionUpdate = {
        type: "session.update",
        session: {
          input_audio_format: "pcm16",
          turn_detection: { type: "none" },
        },
      };
      if (requestedLanguage) {
        sessionUpdate.session.input_audio_transcription = {
          model: target.model,
          language: requestedLanguage,
        };
      } else {
        sessionUpdate.session.input_audio_transcription = {
          model: target.model,
        };
      }
      sendWs(upstreamWs, sessionUpdate);
    });

    upstreamWs.on("message", (raw) => {
      const evt = parseJsonMaybe(raw);
      if (!evt) return;

      const transcript = extractTranscriptFromRealtimeEvent(evt);
      if (transcript?.kind === "delta") {
        sendWs(clientWs, { type: "transcript.delta", text: transcript.text });
        return;
      }
      if (transcript?.kind === "final") {
        const sec = Math.max(0, (Date.now() - streamStartedAt) / 1000);
        sendWs(clientWs, {
          type: "transcript.final",
          segment: {
            id: crypto.randomUUID(),
            start: Math.max(0, sec - 1),
            end: sec,
            speaker: "spreker-1",
            text: transcript.text,
          },
        });
        return;
      }

      if (evt.type === "error") {
        sendWs(clientWs, {
          type: "error",
          error: String(evt.error?.message || evt.message || "Realtime upstream fout"),
          upstream: evt,
        });
      }
    });

    upstreamWs.on("close", (code, reason) => {
      upstreamReady = false;
      sendWs(clientWs, {
        type: "upstream.closed",
        code,
        reason: String(reason || ""),
      });
    });

    upstreamWs.on("error", (err) => {
      sendWs(clientWs, { type: "error", error: String(err?.message || err || "Upstream websocket fout") });
    });
  }

  clientWs.on("message", (raw) => {
    const msg = parseJsonMaybe(raw);
    if (!msg || typeof msg !== "object") return;
    const type = String(msg.type || "").trim();

    if (type === "start") {
      ensureUpstream(msg);
      return;
    }

    if (type === "audio.append") {
      ensureUpstream(msg);
      if (upstreamWs && upstreamReady) {
        sendWs(upstreamWs, {
          type: "input_audio_buffer.append",
          audio: String(msg.audio || ""),
        });
      }
      return;
    }

    if (type === "audio.commit") {
      if (upstreamWs && upstreamReady) {
        sendWs(upstreamWs, { type: "input_audio_buffer.commit" });
        sendWs(upstreamWs, {
          type: "response.create",
          response: { modalities: ["text"] },
        });
      }
      return;
    }

    if (type === "stop") {
      if (upstreamWs && upstreamReady) {
        sendWs(upstreamWs, { type: "input_audio_buffer.commit" });
        sendWs(upstreamWs, {
          type: "response.create",
          response: { modalities: ["text"] },
        });
      }
      setTimeout(closeUpstream, 200);
      return;
    }

    if (upstreamWs && upstreamReady && type) {
      sendWs(upstreamWs, msg);
    }
  });

  clientWs.on("close", () => {
    closeUpstream();
  });

  clientWs.on("error", () => {
    closeUpstream();
  });
});

// ── Start ──────────────────────────────────────────────────────────
initDefaults();
loadPersistedImageJobs();

const server = http.createServer(app);

server.on("upgrade", (req, socket, head) => {
  let pathname = "";
  try {
    const parsed = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
    pathname = parsed.pathname;
  } catch {
    pathname = "";
  }

  if (pathname !== "/api/realtime-stt") {
    socket.destroy();
    return;
  }

  realtimeWss.handleUpgrade(req, socket, head, (ws) => {
    realtimeWss.emit("connection", ws, req);
  });
});

// The tests require this file for its functions; only a direct start runs the service.
module.exports = { app, normalizeBeleidskompasFlow, publicBeleidskompasConfig };

if (require.main === module) {
  setInterval(cleanupImageJobs, 10 * 60 * 1000);
  setImmediate(pumpImageJobs);

  // Wait a bit for Open WebUI to finish its startup copy, then publish admin data
  setTimeout(() => {
    publishAll();
    console.log(`[govchat-admin] Published config to ${PUBLISH_DIR}`);
  }, 15000);

  // Beleidskompas reaches its database in the background (see
  // lib/beleidskompas/index.js), so the service listens straight away.
  beleidskompas.start(app, {
    resolveUser: resolveUserFromVerifiedRefreshToken,
    getLive: liveBeleidskompasTemplate,
    getRetentionDays: () => readBeleidskompasState().settings.retention_days,
  });
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[govchat-admin] Running on http://0.0.0.0:${PORT}`);
    console.log(`[govchat-admin] Data directory: ${DATA_DIR}`);
    console.log(`[govchat-admin] Publish directory: ${PUBLISH_DIR}`);
    if (IMAGE_JOBS_ENABLED) {
      console.log(`[govchat-admin] Image jobs enabled (concurrency=${IMAGE_JOBS_CONCURRENCY})`);
    } else {
      console.log("[govchat-admin] Image jobs disabled");
    }
    console.log(
      `[govchat-admin] Crawler webhook: ${CRAWLER_N8N_WEBHOOK_URL} (internal token configured=${Boolean(CRAWLER_INTERNAL_TOKEN)})`,
    );
    console.log(
      `[govchat-admin] Realtime STT bridge: /api/realtime-stt (provider=${REALTIME_STT_PROVIDER_DEFAULT})`,
    );
  });
}
