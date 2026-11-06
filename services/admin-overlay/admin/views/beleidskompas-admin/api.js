// All data access for the Beleidskompas admin UI lives here.
// Each function is marked:
//   WIRED: calls the admin server (server.js), the data is real.
//   MOCK:  no backend yet; sample or in-memory data. The number points to a section of
//          ADMIN_UI_FUTURE_WORK.md, private notes kept locally for now (gitignored),
//          on what is missing and which ADO item covers it.

import { MOCK_TEMPLATES, REAL_TEMPLATE, mockAnswerText } from "./mock-data.js";

const BASE = "/api/beleidskompas";

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // requireAuth redirects to /login when the admin session is gone.
  if (res.redirected && new URL(res.url).pathname === "/login") {
    window.location.href = "/login";
    throw new Error("Sessie verlopen");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── Template, versions, settings ───────────────────────────────────

// WIRED: GET /api/beleidskompas/state → { state, workflow_manifest }
export const getState = () => request("GET", `${BASE}/state`);

// WIRED: GET /api/beleidskompas/workflows/status
export const getWorkflowStatus = () => request("GET", `${BASE}/workflows/status?source=live`);

// WIRED: POST /api/beleidskompas/workflows/sync (regenerates the workflow files from the live template)
export const syncWorkflows = () => request("POST", `${BASE}/workflows/sync`, { source: "live" });

// WIRED: POST /api/beleidskompas/settings
export const saveSettings = (settings) => request("POST", `${BASE}/settings`, settings);

// WIRED: POST /api/beleidskompas/publish. Saves the flow and publishes it as a new version in one call.
export const publishVersion = (flow, note) => request("POST", `${BASE}/publish`, { flow, note });

// WIRED: GET /api/beleidskompas/export (the whole state as JSON)
export const exportUrl = () => `${BASE}/export`;

// WIRED: POST /api/beleidskompas/import
export const importState = (json) => request("POST", `${BASE}/import`, json);

// MOCK #1: the server stores one template without a name. The real one is shown as
// REAL_TEMPLATE with the server's versions; the others are sample templates.
export function listTemplates(state) {
  const real = {
    ...REAL_TEMPLATE,
    live_version_id: state.live_version_id,
    versions: state.versions,
  };
  return [real, ...MOCK_TEMPLATES];
}

// MOCK #1: "Opslaan als nieuw template" only adds the template to this browser tab.
export function saveAsNewTemplate(name, flow) {
  const now = new Date().toISOString();
  const id = `mock-${Date.now()}`;
  const template = {
    id,
    name,
    mock: true,
    live_version_id: `${id}-v1`,
    versions: [{ id: `${id}-v1`, published_at: now, published_by: "Mock", note: "Eerste versie", is_live: true, snapshot: structuredClone(flow) }],
    documents: [],
    feedback: [],
  };
  MOCK_TEMPLATES.push(template);
  return template;
}

// ── Documents ──────────────────────────────────────────────────────

// WIRED: GET /api/beleidskompas/documents (one shared library, without file contents)
export const listDocuments = () => request("GET", `${BASE}/documents`).then((d) => d.documents || []);

// WIRED: POST /api/beleidskompas/documents (file sent as base64)
export async function uploadDocument(file) {
  const contentBase64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return request("POST", `${BASE}/documents`, {
    filename: file.name,
    mime_type: file.type || "application/octet-stream",
    content_base64: contentBase64,
  });
}

// WIRED: PATCH /api/beleidskompas/documents/:id (rename)
export const updateDocument = (id, patch) => request("PATCH", `${BASE}/documents/${encodeURIComponent(id)}`, patch);

// WIRED: DELETE /api/beleidskompas/documents/:id
export const deleteDocument = (id) => request("DELETE", `${BASE}/documents/${encodeURIComponent(id)}`);

// WIRED: GET /api/beleidskompas/documents/:id/download
export const downloadUrl = (id) => `${BASE}/documents/${encodeURIComponent(id)}/download`;

// MOCK #3: "Actief in dit template" is kept in this browser tab only; the server has
// one library for all templates and versions.
const inactiveDocs = new Set();
export const isDocumentActive = (templateId, docId) => !inactiveDocs.has(`${templateId}:${docId}`);
export function setDocumentActive(templateId, docId, active) {
  const key = `${templateId}:${docId}`;
  if (active) inactiveDocs.delete(key);
  else inactiveDocs.add(key);
}

// MOCK #2: step documents are kept in this browser tab only. The server's steps
// pick documents by tag (doc_tags), so the first selection is every document
// sharing a tag with the step.
const stepDocs = new Map();
export function getStepDocumentIds(templateId, step, documents) {
  const key = `${templateId}:${step.id}`;
  if (!stepDocs.has(key)) {
    const stepTags = new Set((step.doc_tags || []).map((t) => t.toLowerCase()));
    stepDocs.set(key, new Set(documents.filter((d) => (d.tags || []).some((t) => stepTags.has(t.toLowerCase()))).map((d) => d.id)));
  }
  return stepDocs.get(key);
}
export function setStepDocument(templateId, stepId, docId, checked) {
  const ids = stepDocs.get(`${templateId}:${stepId}`) || new Set();
  if (checked) ids.add(docId);
  else ids.delete(docId);
  stepDocs.set(`${templateId}:${stepId}`, ids);
}

// ── Feedback ───────────────────────────────────────────────────────

// WIRED: GET /api/beleidskompas-feedback → anonymous items { id, rating, comment, step_id, created_at }.
// MOCK #4: items carry no template or version yet. Real feedback can only come from the one
// real template; its version is guessed as the one published last before the feedback.
// MOCK #5: the answer the user reacted to is not stored, so a sample text is shown.
export async function listFeedback(templates) {
  const data = await request("GET", "/api/beleidskompas-feedback");
  const real = templates.find((t) => !t.mock);
  const byDate = [...(real?.versions || [])].sort((a, b) => a.published_at.localeCompare(b.published_at));
  const realItems = (data.items || []).map((item) => {
    const version = [...byDate].reverse().find((v) => v.published_at <= item.created_at) || byDate[0];
    return {
      ...item,
      template_id: real?.id,
      version_id: version?.id || null,
      answer_text: mockAnswerText(item.step_id),
    };
  });
  const mockItems = templates.filter((t) => t.mock).flatMap((t) => t.feedback || []);
  return [...realItems, ...mockItems];
}
