// Document library: the template's documents in a Finder list, with a wide preview.
import * as api from "../api.js";
import { h, icon, toast, askText, formatDate, formatBytes } from "../dom.js";
import { finder } from "../components/finder.js";

// How the index_status of a document shows: the text and the look of its badge.
const INDEX_STATUS = {
  pending: { label: "In de wachtrij", look: "badge-waiting" },
  indexing: { label: "Wordt ingelezen", look: "badge-waiting" },
  ready: { label: "Klaar voor gebruik", look: "badge-live" },
  failed: { label: "Inlezen mislukt", look: "badge-failed" },
};

const REFRESH_EVERY_MS = 3000;
let refreshTimer = null;

const isBusy = (doc) => doc.index_status === "pending" || doc.index_status === "indexing";
const statusesOf = (docs) => docs.map((doc) => `${doc.id}:${doc.index_status}`).join();
const onThisPage = () => location.hash.includes("editor/documents");

function statusBadge(doc) {
  const status = INDEX_STATUS[doc.index_status];
  return status ? h("span", { class: `badge ${status.look}` }, status.label) : null;
}

/** While a document waits or is being indexed, asks every few seconds for
 *  the statuses and redraws the page when one changed. */
function watchIndexing(store, render) {
  clearTimeout(refreshTimer);
  if (!store.documents.some(isBusy)) return;

  refreshTimer = setTimeout(async () => {
    if (!onThisPage()) return;
    const before = statusesOf(store.documents);
    store.documents = await api.listDocuments().catch(() => store.documents);
    if (statusesOf(store.documents) !== before) render();
    else watchIndexing(store, render);
  }, REFRESH_EVERY_MS);
}

export function renderDocuments({ store, render }) {
  const docs = store.documents;
  const ui = store.ui;
  const selected = docs.find((d) => d.id === ui.docId) || null;

  const reloadDocs = async () => {
    store.documents = await api.listDocuments();
    render();
  };

  // A document that is ready needs no badge in the list.
  const files = docs.map((d) => ({ id: d.id, name: d.filename, badge: d.index_status === "ready" ? null : statusBadge(d) }));

  const preview = selected ? docPreview(selected, { store, reloadDocs }) : emptyPreview();

  const uploadInput = h("input", { type: "file", multiple: true, hidden: true });
  uploadInput.addEventListener("change", async () => {
    try {
      const uploaded = [];
      for (const file of uploadInput.files || []) uploaded.push((await api.uploadDocument(file)).document);
      toast("Document(en) geüpload", "success");
      // Select and preview the (first) uploaded document.
      if (uploaded[0]) ui.docId = uploaded[0].id;
      await reloadDocs();
      document.querySelector(".finder-item.is-selected")?.scrollIntoView({ block: "nearest" });
    } catch (err) {
      toast(`Uploaden mislukt: ${err.message}`, "error");
    } finally {
      uploadInput.value = "";
    }
  });

  const controls = [
    h("button", { class: "btn btn-secondary", onClick: () => uploadInput.click() }, icon("upload", 14), "Uploaden"),
    uploadInput,
  ];

  const content = finder({
    files,
    selectedFile: selected?.id ?? null,
    onFile: (id) => {
      // The redraw rebuilds the list (and starts the new preview at the top); keep the list where it was.
      const listTop = document.querySelector(".finder-files")?.scrollTop || 0;
      ui.docId = id;
      render();
      document.querySelector(".finder-files").scrollTop = listTop;
    },
    preview,
  });

  watchIndexing(store, render);

  return { controls, content };
}

function emptyPreview() {
  return h("div", { class: "preview-empty" }, icon("file", 40), h("p", {}, "Selecteer een document om het te bekijken."));
}

/** Why indexing the document failed, with a button to try again. */
function indexFailure(doc, reloadDocs) {
  const tryAgain = async () => {
    try {
      await api.reindexDocument(doc.id);
      await reloadDocs();
    } catch (err) {
      toast(`Opnieuw inlezen mislukt: ${err.message}`, "error");
    }
  };

  return h(
    "div",
    { class: "notice notice-error" },
    h("span", {}, `Inlezen is mislukt: ${doc.index_error}`),
    h("button", { class: "btn btn-small btn-secondary", onClick: tryAgain }, "Opnieuw inlezen"),
  );
}

function docPreview(doc, { store, reloadDocs }) {
  const usedIn = store.flow.steps.filter((s) => api.stepDocumentIds(s).has(doc.id));

  const actions = h(
    "div",
    { class: "preview-actions" },
    h(
      "button",
      {
        class: "btn btn-small btn-secondary",
        onClick: async () => {
          const name = await askText({ title: "Document hernoemen", label: "Bestandsnaam", value: doc.filename, confirm: "Hernoemen", required: true });
          if (!name || name === doc.filename) return;
          try {
            await api.updateDocument(doc.id, { filename: name });
            await reloadDocs();
          } catch (err) {
            toast(`Hernoemen mislukt: ${err.message}`, "error");
          }
        },
      },
      "Hernoemen",
    ),
    h("a", { class: "btn btn-small btn-secondary", href: api.downloadUrl(doc.id), download: doc.filename }, icon("download", 14), "Downloaden"),
    h(
      "button",
      {
        class: "btn btn-small btn-danger",
        onClick: async () => {
          if (!confirm(`“${doc.filename}” verwijderen?`)) return;
          try {
            await api.deleteDocument(doc.id);
            store.ui.docId = null;
            await reloadDocs();
          } catch (err) {
            toast(`Verwijderen mislukt: ${err.message}`, "error");
          }
        },
      },
      icon("trash", 14),
      "Verwijderen",
    ),
  );

  return h(
    "div",
    { class: "preview" },
    h("div", { class: "preview-head" }, h("h2", {}, doc.filename), actions),
    h(
      "dl",
      { class: "kv kv-inline" },
      h("dt", {}, "Type"), h("dd", {}, doc.mime_type),
      h("dt", {}, "Grootte"), h("dd", {}, formatBytes(doc.size_bytes)),
      h("dt", {}, "Geüpload"), h("dd", {}, formatDate(doc.uploaded_at)),
      h("dt", {}, "Gebruikt in"), h("dd", {}, usedIn.length ? usedIn.map((s) => s.title).join(", ") : "geen stappen"),
      h("dt", {}, "Status"), h("dd", {}, statusBadge(doc)),
    ),
    doc.index_status === "failed" ? indexFailure(doc, reloadDocs) : null,
    h("pre", { class: "preview-text" }, doc.preview_text || "Geen voorbeeld beschikbaar."),
  );
}
