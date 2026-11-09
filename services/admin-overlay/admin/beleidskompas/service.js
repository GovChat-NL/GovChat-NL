// Business logic shared by the Beleidskompas routes. No Express here: everything
// that needs the store or the live-publish step is injected, so it can be tested
// with fakes.

function createService({ store, publishLive }) {
  const notFound = (message) => Object.assign(new Error(message), { status: 404 });

  async function getCurrentOr404(templateId) {
    const current = await store.getCurrent(templateId);
    if (!current) throw notFound("Template niet gevonden");
    return current;
  }

  // Saves a new version of the template with the document added or removed; returns the workflow manifest when live.
  async function setTemplateDocument(templateId, docId, active, label, filename) {
    const current = await getCurrentOr404(templateId);
    const doc = await store.getDocument(docId);
    if (!doc) throw notFound("Document niet gevonden");
    const others = current.documentIds.filter((x) => x !== docId);
    if (!active && others.length === current.documentIds.length) throw notFound("Document niet actief in dit template");
    const { isLive } = await store.saveVersion(
      templateId, current.snapshot, active ? [...others, docId] : others, `${label}: ${filename || doc.filename}`);
    return isLive ? publishLive() : null;
  }

  async function findTemplateDocument(templateId, docId) {
    return (await store.listDocuments(templateId)).find((d) => d.id === docId) || null;
  }

  return { notFound, getCurrentOr404, setTemplateDocument, findTemplateDocument };
}

module.exports = { createService };
