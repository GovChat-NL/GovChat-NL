# Beleidskompas admin UI: future work

The admin UI (US 11296) is built in `services/admin-overlay/admin/views/beleidskompas-admin/`. All of its data access is in `api.js`. Each function there is marked `WIRED` (it calls `server.js`) or `MOCK #n`, where `n` refers to a section below.

## 1. Several templates

- **Mocked:** the template list, the template name ("SiS 4.0") and "Opslaan als nieuw template". A new template exists only in the browser tab.
- **Today:** `beleidskompas-state.json` holds one unnamed template: `draft`, `live` and `versions`.
- **Needed:**
  - Store templates side by side, each with an id, a name, its versions and its live version.
  - Make "Opslaan als nieuw template" copy the current template into a new one.
  - Give publish, rollback and export a template id.
  - Decide which template the Beleidskompas page uses: one live template for the whole app, or a choice per case.
- **Related ADO:** 11030 (Versioning plan: "major version is like bucket"), 9085 (D.5 publication and version history). Storing several templates side by side is not yet a work item.

## 2. Step documents (checkboxes per step)

- **Mocked:** the document checkboxes in the Flow builder are kept in the browser tab only. The first selection is every document that shares a tag with the step.
- **Today:** a step selects its documents by tag (`doc_tags`, `rag.required_tags`). `normalizeBeleidskompasFlow` would drop any extra field.
- **Needed (moving from tags to an explicit list):**
  - Add `document_ids` to the step and keep it in `normalizeBeleidskompasFlow`, so it is saved in the draft, live and version snapshots.
  - Migrate once: fill `document_ids` from the documents that match the current `doc_tags`, then stop editing `doc_tags`.
  - On publish, reject or report ids that no longer exist in the library.
  - Once retrieval reads `document_ids`, remove `doc_tags` and `rag.required_tags`. Keep tags only for organising the library (the Finder folders).
- **Related ADO:** 9373 ("link a document to one or more process steps", stored as metadata), 9084 (D.4 document library and knowledge-base linking).

## 3. A document library per template and version

- **Mocked:** the library is shown under the selected template, and the "Actief in dit template" toggle is kept in the browser tab only.
- **Today:** one library is shared by everything. Documents are not part of a version snapshot, so a rollback does not restore the documents.
- **Needed:**
  - Each template version points to the documents it uses.
  - A document update can be published as a new version.
  - "Actief" is stored per template.
- **Related ADO:** 11030, 9364 (version history for the knowledge base), 9515 (replace a document with a new version), 9084.

## 4. Feedback linked to a template and version

- **Mocked:** real feedback is attributed to the one real template, and its version is guessed as the one published last before the feedback.
- **Needed:**
  - When a case starts, the Beleidskompas page records the live template id and version id.
  - It keeps them with the conversation, so they survive a reload.
  - It sends them with every feedback POST.
  - `server.js` stores them on the feedback item.
- **Related ADO:** 9597 (store feedback anonymously, linked to the case), 9087 (D.7 feedback facility).

## 5. The answer a user reacted to

- **Mocked:** the "Antwoord waarop gereageerd is" text is a sample.
- **Needed:** a decision first. `server.js` keeps feedback deliberately anonymous: no user and no conversation, "so the feedback cannot be traced back to a person or a case". Storing the answer text, or a message id, changes that, so the privacy owner must agree first. After that, the page sends the text (capped) with the feedback.
- **Related ADO:** 9597, 9087, 9586 (administrator visibility of ratings).

## 6. The live assistant reads the published template

- **Not mocked, but not used yet:** prompts, search settings (`rag.*`) and step documents are saved and published, but the n8n workflows in `agents/n8n/workflows/beleidskompas/` do not read them. The Beleidskompas page does use the step titles, descriptions, substeps, disclaimer and sources.
- **Needed:** the step workflows load the published template (prompt, RAG settings, step documents) at runtime, so no workflow re-import is needed.
- **Related ADO:** 9373 ("saved prompts are read by the n8n workflow at runtime").

## 7. Document preview and ingestion

- **Today:** the preview shows the first 4,000 characters of text and Markdown files only. PDF and Word files show "Preview niet beschikbaar".
- **Needed:** a preview for PDF and Word files, and the ingestion status per document.
- **Related ADO:** 9514 (document preview), 9510 (ingest status per document).

## 8. Who did what

- **Today:** every version says "System Administrator", and everyone shares one admin password.
- **Needed:** sign-in with the admin role, and the real user stored on publish and rollback.
- **Related ADO:** 9474 (restrict to admin role), 9085 (audit trail), 9526 (version number, date and user).
