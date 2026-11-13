// Business logic shared by the Beleidskompas admin routes. No Express here: everything
// that needs the store or the live-publish step is injected, so it can be tested
// with fakes.

const { StoreError } = require("./store-errors");

function createTemplateService({ store }) {
  const notFound = (message) => new StoreError(404, message);

  async function getCurrentOr404(templateId) {
    const current = await store.getCurrent(templateId);
    if (!current) throw notFound("Template niet gevonden");
    return current;
  }

  // Saves a new version of the template with the document added or removed. It does not go live: that is the Deploy page.
  async function setTemplateDocument(templateId, docId, active, label, filename) {
    const current = await getCurrentOr404(templateId);
    const doc = await store.getDocument(docId);
    if (!doc) throw notFound("Document niet gevonden");
    const others = current.documentIds.filter((x) => x !== docId);
    if (!active && others.length === current.documentIds.length) throw notFound("Document niet actief in dit template");
    await store.saveVersion(
      templateId, current.snapshot, active ? [...others, docId] : others, `${label}: ${filename || doc.filename}`);
  }

  async function findTemplateDocument(templateId, docId) {
    return (await store.listDocuments(templateId)).find((d) => d.id === docId) || null;
  }

  return { notFound, getCurrentOr404, setTemplateDocument, findTemplateDocument };
}

module.exports = { createTemplateService };
