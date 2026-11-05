// Document library: the template's documents in a Finder, grouped by tag, with a wide preview.
import * as api from "../api.js";
import { h, icon, toast, askText, formatDate, formatBytes } from "../dom.js";
import { finder } from "../components/finder.js";
import { toggle } from "../components/toggle.js";
import { template } from "../app.js";
import { chipEditor } from "./editor.js";

const ALL = "__all";
const UNTAGGED = "__untagged";

export function renderDocuments({ store, render }) {
  const tpl = template();
  const docs = store.documents;
  const ui = store.ui;

  const tags = [...new Set(docs.flatMap((d) => d.tags || []))].sort((a, b) => a.localeCompare(b, "nl"));
  const folders = [
    { id: ALL, label: "Alle documenten", count: docs.length },
    ...tags.map((t) => ({ id: t, label: t, count: docs.filter((d) => (d.tags || []).includes(t)).length })),
    { id: UNTAGGED, label: "Zonder tag", count: docs.filter((d) => !(d.tags || []).length).length },
  ];
  if (!folders.some((f) => f.id === ui.folder)) ui.folder = ALL;

  const inFolder = docs.filter((d) =>
    ui.folder === ALL ? true : ui.folder === UNTAGGED ? !(d.tags || []).length : (d.tags || []).includes(ui.folder),
  );
  const selected = docs.find((d) => d.id === ui.docId) || null;

  const reloadDocs = async () => {
    store.documents = await api.listDocuments();
    render();
  };

  const files = inFolder.map((d) => {
    const active = api.isDocumentActive(tpl.id, d.id);
    return {
      id: d.id,
      name: d.filename,
      muted: !active,
      trailing: toggle({
        checked: active,
        label: null,
        onChange: (v) => {
          api.setDocumentActive(tpl.id, d.id, v);
          render();
        },
      }),
    };
  });

  const preview = selected ? docPreview(selected, { tpl, store, reloadDocs, render }) : emptyPreview();
  const folderLabel = folders.find((f) => f.id === ui.folder)?.label;

  const uploadInput = h("input", { type: "file", multiple: true, hidden: true });
  uploadInput.addEventListener("change", async () => {
    const tagsForUpload = ui.folder !== ALL && ui.folder !== UNTAGGED ? [ui.folder] : [];
    try {
      for (const file of uploadInput.files || []) await api.uploadDocument(file, tagsForUpload);
      toast("Document(en) geüpload", "success");
      await reloadDocs();
    } catch (err) {
      toast(`Uploaden mislukt: ${err.message}`, "error");
    } finally {
      uploadInput.value = "";
    }
  });

  const controls = [
    h("button", { class: "btn btn-secondary", disabled: tpl.mock, onClick: () => uploadInput.click() }, icon("upload", 14), "Uploaden"),
    uploadInput,
  ];

  const content = finder({
    folders,
    selectedFolder: ui.folder,
    onFolder: (id) => { ui.folder = id; render(); },
    files,
    selectedFile: selected && inFolder.includes(selected) ? selected.id : null,
    onFile: (id) => { ui.docId = id; render(); },
    preview,
    path: ["Documentenbibliotheek", folderLabel, selected?.filename].filter(Boolean),
  });

  return { controls, content };
}

function emptyPreview() {
  return h("div", { class: "preview-empty" }, icon("file", 40), h("p", {}, "Selecteer een document om het te bekijken."));
}

function docPreview(doc, { tpl, store, reloadDocs }) {
  const readOnly = tpl.mock;
  const usedIn = store.flow.steps.filter((s) => api.getStepDocumentIds(tpl.id, s, store.documents).has(doc.id));
  const tagHolder = { tags: [...(doc.tags || [])] };

  const actions = h(
    "div",
    { class: "preview-actions" },
    h(
      "button",
      {
        class: "btn btn-small btn-secondary",
        disabled: readOnly,
        onClick: async () => {
          const name = await askText({ title: "Document hernoemen", label: "Bestandsnaam", placeholder: doc.filename, confirm: "Hernoemen", required: true });
          if (!name) return;
          try {
            await api.updateDocument(doc.id, { filename: name, tags: doc.tags });
            await reloadDocs();
          } catch (err) {
            toast(`Hernoemen mislukt: ${err.message}`, "error");
          }
        },
      },
      "Hernoemen",
    ),
    readOnly
      ? h("button", { class: "btn btn-small btn-secondary", disabled: true }, icon("download", 14), "Downloaden")
      : h("a", { class: "btn btn-small btn-secondary", href: api.downloadUrl(doc.id), download: doc.filename }, icon("download", 14), "Downloaden"),
    h(
      "button",
      {
        class: "btn btn-small btn-danger",
        disabled: readOnly,
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

  const tagsEditor = readOnly
    ? h("div", { class: "chips" }, (doc.tags || []).map((t) => h("span", { class: "chip" }, t)))
    : chipEditor(tagHolder, "tags", async () => {
        try {
          await api.updateDocument(doc.id, { filename: doc.filename, tags: tagHolder.tags });
          await reloadDocs();
        } catch (err) {
          toast(`Tags opslaan mislukt: ${err.message}`, "error");
        }
      });

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
    ),
    h("div", { class: "field" }, h("span", { class: "field-label" }, "Tags"), tagsEditor),
    h("pre", { class: "preview-text" }, doc.preview_text || "Geen voorbeeld beschikbaar."),
  );
}
