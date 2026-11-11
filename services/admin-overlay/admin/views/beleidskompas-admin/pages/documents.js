// Document library: the template's documents in a Finder list, with a wide preview.
import * as api from "../api.js";
import { h, icon, toast, askText, formatDate, formatBytes } from "../dom.js";
import { finder } from "../components/finder.js";
import { toggle } from "../components/toggle.js";
import { template } from "../app.js";

export function renderDocuments({ store, render }) {
  const tpl = template();
  const docs = store.documents;
  const ui = store.ui;
  const selected = docs.find((d) => d.id === ui.docId) || null;

  const reloadDocs = async () => {
    store.documents = await api.listDocuments(tpl.id);
    render();
  };

  const files = docs.map((d) => {
    const active = api.isDocumentActive(d);
    return {
      id: d.id,
      name: d.filename,
      muted: !active,
      trailing: toggle({
        checked: active,
        label: null,
        onChange: async (v) => {
          try {
            await api.updateDocument(tpl.id, d.id, { active: v });
            await reloadDocs();
          } catch (err) {
            toast(`Opslaan mislukt: ${err.message}`, "error");
          }
        },
      }),
    };
  });

  const preview = selected ? docPreview(selected, { tpl, store, reloadDocs }) : emptyPreview();

  const uploadInput = h("input", { type: "file", multiple: true, hidden: true });
  uploadInput.addEventListener("change", async () => {
    try {
      for (const file of uploadInput.files || []) await api.uploadDocument(tpl.id, file);
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
    h("button", { class: "btn btn-secondary", disabled: tpl.mock, onClick: () => uploadInput.click() }, icon("upload", 14), "Uploaden"),
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

  return { controls, content };
}

function emptyPreview() {
  return h("div", { class: "preview-empty" }, icon("file", 40), h("p", {}, "Selecteer een document om het te bekijken."));
}

function docPreview(doc, { tpl, store, reloadDocs }) {
  const readOnly = tpl.mock;
  const usedIn = store.flow.steps.filter((s) => api.getStepDocumentIds(s).has(String(doc.id)));

  const actions = h(
    "div",
    { class: "preview-actions" },
    h(
      "button",
      {
        class: "btn btn-small btn-secondary",
        disabled: readOnly,
        onClick: async () => {
          const name = await askText({ title: "Document hernoemen", label: "Bestandsnaam", value: doc.filename, confirm: "Hernoemen", required: true });
          if (!name || name === doc.filename) return;
          try {
            await api.updateDocument(tpl.id, doc.id, { filename: name });
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
            await api.deleteDocument(tpl.id, doc.id);
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
    ),
    h("pre", { class: "preview-text" }, doc.preview_text || "Geen voorbeeld beschikbaar."),
  );
}
