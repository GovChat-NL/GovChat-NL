"use strict";

/**
 * What a template does together with its documents: exporting a template
 * with the documents of its steps, and importing such an export.
 *
 * `templates` and `documents` are the two repositories, `pool` is the pg
 * pool of the Beleidskompas database.
 */

const { HttpError } = require("../shared/errors");
const { inTransaction } = require("../shared/transaction");

function documentIdsOf(flow) {
  return [...new Set((flow.steps || []).flatMap((step) => step.document_ids || []))];
}

function createTemplateService({ pool, templates, documents }) {
  /** The newest version of a template, with the files of its documents. */
  async function exportTemplate(templateId) {
    const template = await templates.getTemplate(templateId);
    const flow = template.versions[0].snapshot;
    const files = await Promise.all(documentIdsOf(flow).map(async (documentId) => {
      const { content, ...document } = await documents.getDocument(documentId);
      return { ...document, content_base64: content.toString("base64") };
    }));
    return { name: template.name, flow, documents: files };
  }

  /** Stores the documents of an export and a new template that points to
   *  them, in one transaction. */
  async function importTemplate({ name, flow, documents: files = [] }) {
    if (!Array.isArray(files)) throw new HttpError(400, "Documents must be an array");
    const templateId = await inTransaction(pool, async (db) => {
      const storedIds = new Map();
      for (const file of files) storedIds.set(String(file.id), (await documents.uploadDocument(file, db)).id);
      const snapshot = structuredClone(flow);
      for (const step of snapshot.steps || []) {
        step.document_ids = (step.document_ids || []).map((documentId) => storedIds.get(String(documentId)) || String(documentId));
      }
      return templates.insertTemplate(db, name, snapshot);
    });
    return templates.getTemplate(templateId);
  }

  return { exportTemplate, importTemplate };
}

module.exports = { createTemplateService };
