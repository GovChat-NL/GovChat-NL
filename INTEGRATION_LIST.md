# Beleidskompas admin: integration TODO

What the admin UI saves that nothing reads yet, and what the backend merged with #32 (agents, orchestrator, case store) still needs from the admin. Each item names the UI place, the backend piece and what done means. Checked 2026-11-11 on `feature/admin-ui` (8089d17).

Paths are relative to `services/admin-overlay/admin/views/beleidskompas-admin/` unless stated.

## 1. The agent reads the template

Today the agent (`agents/beleidskompas/`) reads its prompts from `prompts/stepN/*.md`, the rules from `prompts/rules.md`, the answer structure from the headings in those files, the model from `BELEIDSKOMPAS_MODEL` and its sources from `fixtures/source-passages.json`. Nothing of the template reaches it.

- [ ] Step "Instructies" and substep "Instructies" / "Vereiste antwoordstructuur" (`pages/flow.js`): the agent takes them from the live template instead of the prompt files. Decide where: the orchestrator reads the template at request time, or `make generate-workflows` bakes the live template into the workflows.
- [ ] "Opmaakregels" (`pages/flow.js`, `flow.rules`): same, replaces `{{rules}}` from `rules.md`.
- [ ] "Zoekmethode" and the documents ticked per step (`step.rag.algorithm`, `step.document_ids`): retrieval uses the admin documents instead of `fixtures/source-passages.json` (the agent README names them as the future source). Then remove the "Mock" badge and hint on the Documenten card (`pages/flow.js`) and "Gebruikt in" (`pages/documents.js`) means used by the assistant.
- [ ] "Standaardmodel" (`pages/general.js`, `settings.default_model`): the agent takes its model from the settings instead of `BELEIDSKOMPAS_MODEL`, or the field goes.
- [ ] Flow builder notice (`pages/flow.js`): the sentence "…maar de pagina en de assistent lezen het nog niet" goes with the items above.

## 2. Steps and substeps have one source

The page builds its steps and substeps from `overlay/src/apps/beleidskompas/steps.json`, generated from the agent code. The template has its own copy with the same 13 substep ids, and from it the page reads only the step description.

- [ ] Decide the source: the admin template generates `steps.json` (and the step workflows), or the Flow builder stops editing step and substep titles. Until then a title changed in the admin does not reach the page.
- [ ] Step id, workflow id and webhook path are not editable in the Flow builder; editing them needs a fixed internal id first.

## 3. Case store (Postgres, `lib/beleidskompas/`)

Tables `cases`, `case_texts`, `reports`, `conversation_turns`. The orchestrator writes through `store-client.js`; the page reads its own cases through `/govchat-api/beleidskompas/`.

- [ ] "Bewaartermijn casussen (dagen)" (`pages/general.js`, `settings.retention_days`): nothing deletes cases. A retention job that reads the setting, or hide the field.
- [ ] "Bronvermelding verplicht" and "Menselijke validatie verplicht" (`pages/general.js`): read by nothing. Wire them or hide them.
- [ ] An admin view of cases, if wanted: `GET /api/beleidskompas/cases` exists, internal token only.

## 4. Feedback

The page posts `{ rating, comment, step_id }` to `/api/beleidskompas-feedback`; `step_id` is the step, while the agent works per substep.

- [ ] Version per item (`api.js`, `listFeedback`): guessed as the newest saved version before the item. The page sends the live version (and template) with the POST; the Version filter on the Feedback page depends on it.
- [ ] Per substep: add `substep_id` to the POST if the admin should group by substep (`pages/feedback.js` groups by `step_id`).
- [ ] "Antwoord waarop gereageerd is" (`components/feedback-row.js`, `mockAnswerText` in `mock-data.js`): sample text. Storing the answer, or the case id and turn, needs a privacy decision first.

## 5. Several templates (MOCK #1)

The server stores one template, named "SiS 4.0" in `mock-data.js`. The sample "Omgevingsvisie (voorbeeld)" and "Opslaan als nieuw template" exist in the browser tab only and carry the badge "Voorbeeld".

- [ ] Templates stored on the server with a name. Then `MOCK_TEMPLATES`, `saveAsNewTemplate` and every `tpl.mock` branch go (`app.js`, `api.js`, `pages/editor.js`, `pages/documents.js`, `pages/deploy.js`, `components/template-selector.js`).
- [ ] Documentenbibliotheek per template: the library is one shared list today; the breadcrumb suggests it belongs to the selected template.
- [ ] Versioning backend (`feature/beleidskompas-versioning`, checked at d0cfd88): it has `/templates`, `/templates/:id/versions` and `/templates/:id/documents`, no `/publish`, `/rollback` or `/documents`, and no deploy route. `saveVersion`, `deployVersion` and the document functions in `api.js` move to those routes; a deploy route (one live pointer) is still needed.

## 6. Who did what

- [ ] "Door" in Versies (`pages/editor.js`) is always "System Administrator" until sign-in with an admin role stores the user.

## Done

- #20: Flow builder notice says what reaches the page; default substeps follow `steps.json` (a saved step with the old defaults migrates on load); hoofdagent renamed to orchestrator.
- `fix/admin-ui-review`: the public `beleidskompas-config.json` holds only title, disclaimer, specialist team and the steps' id, title and description; the Workflows card and its routes are gone (the files never reached n8n); sample templates are marked "Voorbeeld".
