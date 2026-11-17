// Admin templates, versions and documents are persisted through the PostgreSQL-backed API.

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

// WIRED: POST /api/beleidskompas/settings
export const saveSettings = (settings) => request("POST", `${BASE}/settings`, settings);

// Creating and saving do not deploy: the selected saved version goes live via Deploy.
export const saveVersion = (templateId, flow, note) =>
  request("POST", `${BASE}/templates/${templateId}/versions`, { flow, note });

export const deployVersion = (tpl, versionId) =>
  request("POST", `${BASE}/templates/${tpl.id}/versions/${versionId}/deploy`);

export const exportUrl = (templateId) => `${BASE}/templates/${templateId}/export`;
export const importState = (json) => request("POST", `${BASE}/import`, json);
export const listTemplates = (state) => state.templates;
export const saveAsNewTemplate = (name, flow) =>
  request("POST", `${BASE}/templates`, { name, flow }).then((data) => data.template);

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

// Document selections are saved with each version; assistant retrieval does not use them yet.
export const stepDocumentIds = (step) => new Set((step.document_ids || []).map(String));

// Feedback currently has no reliable template/version or original-answer attribution.
// Show only what the server actually recorded.
export async function listFeedback() {
  const data = await request("GET", "/api/beleidskompas-feedback");
  return data.items || [];
}
