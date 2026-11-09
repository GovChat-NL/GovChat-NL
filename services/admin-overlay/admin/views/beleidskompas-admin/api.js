// All data access for the Beleidskompas admin UI lives here.

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

// WIRED: GET /api/beleidskompas/state → { templates, settings, live, workflow_manifest }
export const getState = () => request("GET", `${BASE}/state`);

// WIRED: GET /api/beleidskompas/workflows/status
export const getWorkflowStatus = () => request("GET", `${BASE}/workflows/status?source=live`);

// WIRED: POST /api/beleidskompas/workflows/sync (regenerates the workflow files from the live template)
export const syncWorkflows = () => request("POST", `${BASE}/workflows/sync`, { source: "live" });

// WIRED: POST /api/beleidskompas/settings
export const saveSettings = (settings) => request("POST", `${BASE}/settings`, settings);

// WIRED: POST /api/beleidskompas/templates/:id/versions. Saves the flow as a new version; published when the template is live.
export const publishVersion = (templateId, flow, note) => request("POST", `${BASE}/templates/${templateId}/versions`, { flow, note });

// WIRED: GET /api/beleidskompas/templates/:id/export (one template as JSON)
export const exportUrl = (templateId) => `${BASE}/templates/${templateId}/export`;

// WIRED: POST /api/beleidskompas/import
export const importState = (json) => request("POST", `${BASE}/import`, json);

export const listTemplates = (state) => state.templates;

// WIRED: POST /api/beleidskompas/templates (copy of templateId with the given flow)
export const saveAsNewTemplate = (templateId, name, flow) =>
  request("POST", `${BASE}/templates`, { name, flow, from_template_id: templateId }).then((d) => d.template);

// ── Documents ──────────────────────────────────────────────────────

// WIRED: GET /api/beleidskompas/templates/:id/documents (without file contents)
export const listDocuments = (templateId) => request("GET", `${BASE}/templates/${templateId}/documents`).then((d) => d.documents || []);

// WIRED: POST /api/beleidskompas/templates/:id/documents (file sent as base64)
export async function uploadDocument(templateId, file) {
  const contentBase64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return request("POST", `${BASE}/templates/${templateId}/documents`, {
    filename: file.name,
    mime_type: file.type || "application/octet-stream",
    content_base64: contentBase64,
  });
}

// WIRED: PATCH /api/beleidskompas/templates/:id/documents/:docId ({ filename } or { active })
export const updateDocument = (templateId, id, patch) => request("PATCH", `${BASE}/templates/${templateId}/documents/${id}`, patch);

// WIRED: DELETE /api/beleidskompas/templates/:id/documents/:docId
export const deleteDocument = (templateId, id) => request("DELETE", `${BASE}/templates/${templateId}/documents/${id}`);

// WIRED: GET /api/beleidskompas/documents/:id/download
export const downloadUrl = (id) => `${BASE}/documents/${id}/download`;

export const isDocumentActive = (doc) => doc.active;

// Step documents live in the flow (step.document_ids, as strings) and are saved on publish.
export const getStepDocumentIds = (step) => new Set((step.document_ids || []).map(String));
export function setStepDocument(step, docId, checked) {
  const ids = getStepDocumentIds(step);
  if (checked) ids.add(String(docId));
  else ids.delete(String(docId));
  step.document_ids = [...ids];
}

// ── Feedback ───────────────────────────────────────────────────────

// WIRED: GET /api/beleidskompas-feedback → anonymous items { id, rating, comment, step_id, created_at }.
// Items carry no template or version yet; they are attributed to the first template, and the
// version is guessed as the one published last before the feedback.
export async function listFeedback(templates) {
  const data = await request("GET", "/api/beleidskompas-feedback");
  const real = templates[0];
  const byDate = [...(real?.versions || [])].sort((a, b) => a.published_at.localeCompare(b.published_at));
  return (data.items || []).map((item) => {
    const version = [...byDate].reverse().find((v) => v.published_at <= item.created_at) || byDate[0];
    return {
      ...item,
      template_id: real?.id,
      version_id: version?.id || null,
    };
  });
}
