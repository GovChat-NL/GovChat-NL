# Beleidskompas admin: integration TODO

What the admin UI saves that nothing reads yet, and what the backend merged with #32 (agents, orchestrator, case store) still needs from the admin. Each item names the UI place, the backend piece and what done means. Checked 2026-11-12 on `feature/beleidskompas` (4ea044f, with #20 and #32 merged).

Paths are relative to `services/admin-overlay/admin/views/beleidskompas-admin/` unless stated.

## 1. The agent reads the template

Today the agent (`agents/beleidskompas/`) reads its prompts from `prompts/stepN/*.md`, the rules from `prompts/rules.md`, the answer structure from the headings in those files, the model from `BELEIDSKOMPAS_MODEL` and its sources from `fixtures/source-passages.json`. Nothing of the template reaches it.

- [ ] Step "Instructies" and substep "Instructies" / "Vereiste antwoordstructuur" (`pages/flow.js`): the agent takes them from the live template instead of the prompt files. Decide where: the orchestrator reads the template at request time, or `make generate-workflows` bakes the live template into the workflows.
- [ ] "Opmaakregels" (`pages/flow.js`, `flow.rules`): same, replaces `{{rules}}` from `rules.md`.
- [ ] "Zoekmethode" and the documents ticked per step (`step.rag.algorithm`, `step.document_ids`): retrieval uses the admin documents instead of `fixtures/source-passages.json` (the agent README names them as the future source). Then remove the "Mock" badge and hint on the Documenten card (`pages/flow.js`) and "Gebruikt in" (`pages/documents.js`) means used by the assistant.
- [ ] "Standaardmodel" (`pages/general.js`, `settings.default_model`): the agent takes its model from the settings instead of `BELEIDSKOMPAS_MODEL`, or the field goes.
- [ ] Flow builder notice (`pages/flow.js`): the sentence "…maar de pagina en de assistent lezen het nog niet" goes with the items above.
- [ ] "Geavanceerd" on the Editor (`pages/editor.js`: orchestrator workflow-id, webhook-pad, webhook-token): read by nothing at runtime; the workflows check `$env.BELEIDSKOMPAS_N8N_WEBHOOK_TOKEN`. `defaultBeleidskompasFlow` in `server.js` copies that token into the flow, so the secret sits in every version and in the export. Remove the three fields and stop copying the token.

## 2. Steps and substeps have one source

The page builds its steps and substeps from `overlay/src/apps/beleidskompas/steps.json`, generated from the agent code. The template has its own copy with the same 13 substep ids, and from it the page reads only the step description.

- [ ] Decide the source: the admin template generates `steps.json` (and the step workflows), or the Flow builder stops editing step and substep titles and stops adding, removing and reordering them. Until then none of those changes reach the page.
- [ ] Step id is not editable in the Flow builder; editing it needs a fixed internal id first.
- [ ] The admin still writes n8n workflow files that nothing imports: `syncBeleidskompasWorkflowFiles` in `server.js` runs at startup and after every save, publish, rollback, import and document change, and copies document text into `DATA_DIR/beleidskompas-workflows/`. The runtime workflows come from `make generate-workflows`. Remove the generator, `workflow_manifest` in `GET /api/beleidskompas/state` and the step `workflow_id`/`webhook_path`; #34 should not bring back `/workflows/status` and `/workflows/sync`.

## 3. Case store (Postgres, `services/admin-overlay/admin/lib/beleidskompas/`)

Tables `cases`, `case_texts`, `reports`, `conversation_turns` (`services/admin-overlay/admin/db/migrations/0001-init.sql`). The orchestrator writes through `agents/beleidskompas/store-client.js`; the page reads its own cases through `/govchat-api/beleidskompas/`.

- [ ] "Bewaartermijn casussen (dagen)" (`pages/general.js`, `settings.retention_days`): nothing deletes cases. A retention job that reads the setting, or hide the field.
- [ ] "Bronvermelding verplicht" and "Menselijke validatie verplicht" (`pages/general.js`): read by nothing. Wire them or hide them.
- [ ] An admin view of cases, if wanted: `GET /api/beleidskompas/cases` exists, internal token only.

## 4. Feedback

The page posts `{ rating, comment, step_id }` to `/api/beleidskompas-feedback`; `step_id` is the step open when the user rates (`panels/chat.js`, `store.activeStep()`), not the step of the rated answer, while the agent works per substep.

- [ ] Version per item (`api.js`, `listFeedback`): guessed as the newest saved version before the item. The page sends the live version (and template) with the POST; the Version filter on the Feedback page depends on it.
- [ ] Per substep: send the rated message's own step and substep instead of the active step, if the admin should group by substep (`pages/feedback.js` groups by `step_id`).
- [ ] "Antwoord waarop gereageerd is" (`components/feedback-row.js`, `mockAnswerText` in `mock-data.js`): sample text. Storing the answer, or the case id and turn, needs a privacy decision first.

## 5. Several templates (MOCK #1)

The server stores one template, named "SiS 4.0" in `mock-data.js`. The sample "Omgevingsvisie (voorbeeld)" and "Opslaan als nieuw template" exist in the browser tab only and carry the badge "Voorbeeld".

- [ ] Templates stored on the server with a name. Then `MOCK_TEMPLATES`, `saveAsNewTemplate` and every `tpl.mock` branch go (`app.js`, `api.js`, `pages/editor.js`, `pages/documents.js`, `pages/deploy.js`, `components/template-selector.js`).
- [ ] Documentenbibliotheek per template: the library is one shared list today; the breadcrumb suggests it belongs to the selected template.
- [ ] Versioning backend (#34, `feature/beleidskompas-versioning`, checked at bd85ddc): templates and versions in Postgres, `/templates/:id/versions/:versionId/deploy` (one live row), `/templates/:id/export` and `/templates/:id/documents`; `/publish`, `/rollback` and `/import` are gone. Its `api.js` already uses these routes; `importState` still posts to `/import`. When #34 lands: keep `publicBeleidskompasConfig` and the `module.exports` block at the end of `server.js`, and delete the `live: false` test in `tests/beleidskompas-flow.test.js` (#34's `tests/beleidskompas-admin-routes.test.js` covers it).

## 6. Who did what

- [ ] "Door" in Versies (`pages/editor.js`) is always "System Administrator" until sign-in with an admin role stores the user.

## Done

- #20: Flow builder notice says what reaches the page; default substeps follow `steps.json` (a saved step with the old defaults migrates on load); hoofdagent renamed to orchestrator; the public `beleidskompas-config.json` holds only title, disclaimer, specialist team and the steps' id, title and description; the Workflows card and its routes are gone (the generator still runs, see §2); sample templates are marked "Voorbeeld".
