# Beleidskompas admin: integration TODO

What the admin UI saves that nothing reads yet, what the backend (agents, orchestrator, case store) still needs from the admin, and how #34 (versioning) fits in. Each item names the UI place, the backend piece and what done means. Checked 2026-11-12 on `feature/admin-ui-integration` (the wiring commits on top of `feature/beleidskompas` 4ea044f).

Paths are relative to `services/admin-overlay/admin/views/beleidskompas-admin/` unless stated.

## How the wiring works now

- The admin's **live template** is the runtime source of truth. `GET /api/beleidskompas/live` (store token, `lib/beleidskompas/routes.js`) returns `{ version_id, flow, settings }`. The orchestrator (`agents/beleidskompas/orchestrator.js`) fetches it once per message and passes the step its definition, rules, prompts, report disclaimer and model in the step request (`template`); `runStep` (`shared.js`) uses that and falls back to the baked definition.
- **Defaults** live in one generated file, `services/admin-overlay/admin/defaults/beleidskompas-template.json`, written by `make generate-workflows` from `agents/beleidskompas/prompts/**` and `steps/*.js` (`agents/beleidskompas/template.js`). `defaultBeleidskompasFlow()` in `server.js` reads it; an empty prompt-like field in a saved template means "use the seed", so older states get the prompts on load. The compose file bind-mounts that file into the admin container.
- The **four steps are fixed** (SiS 4.0): the normaliser keeps `stap1..stap4` in order and drops other ids; substeps are free. The page builds steps, substeps and `version_id` from the public `beleidskompas-config.json`; `steps.json` is only the fallback.
- **Feedback** records the rated message's own `step_id`, `substep_id` and `version_id`; `POST /api/beleidskompas-feedback` needs a logged-in LibreChat user (presence only, nothing stored).
- **Retention**: `lib/beleidskompas/index.js` deletes cases older than `settings.retention_days` at start and every 6 hours.
- Gone: the admin's own n8n workflow generator, `workflow_manifest`, step `workflow_id`/`webhook_path`, the "Geavanceerd" fields and the webhook token in the template; the admin no longer reads `BELEIDSKOMPAS_N8N_*`.

## 1. Still open on the agent side

- [ ] "Zoekmethode" and the documents ticked per step (`step.rag`, `step.document_ids`): retrieval still uses `fixtures/source-passages.json`. Needs text extraction at upload and a store-token route that serves the documents (or passages) to the step; then remove the "Mock" badge on the Documenten card (`pages/flow.js`) and "Gebruikt in" (`pages/documents.js`) means used by the assistant.
- [ ] "Standaardmodel" (`pages/general.js`): now sent to the agents, but free text. Validate against LiteLLM's chat models (`litellm/config.yaml`: `govchat-default`, `govchat-versimpelaar`) or render a select.
- [ ] "Bronvermelding verplicht" and "Menselijke validatie verplicht" (`pages/general.js`): read by nothing. Wire them into the prompt or hide them.
- [ ] Page texts an admin cannot edit: the check/deep questions per step (`overlay/src/apps/beleidskompas/config.js` `DEFAULT_STEP_TEXTS`), welcome and overview texts. Candidate template fields: `steps[].help[]`, `steps[].deep[]`, `flow.texts`.
- [ ] The page parses the report by convention (`### ` headings, `**Oordeel:**`, `Redenering`/`Aannames`, `---` footer; `overlay/src/apps/beleidskompas/format.js`). An admin who edits "Vereiste antwoordstructuur" can break badges and collapsing silently. Validate the answer formats on publish, or move the fixed headings into the template.
- [ ] Reports re-enter the model as findings with the `### Bronnen` list and the disclaimer included (`orchestrator.js` `contextFromState`). Strip them, or store the raw reply.

## 2. Case store (Postgres, `services/admin-overlay/admin/lib/beleidskompas/`)

- [ ] Reports and turns do not record the template version they were made with. If the Feedback page must show "written with an older version", add `template_version` columns (migration `0002-*.sql`) and pass `template.version_id` from the orchestrator.
- [ ] An admin view of cases, if wanted: `GET /api/beleidskompas/cases` exists, internal token only.
- [ ] The orchestrator accepts the bridge's fallback user `anonymous` as a case owner (`orchestrator.js`). Refuse it.

## 3. Feedback

- [ ] "Antwoord waarop gereageerd is" (`components/feedback-row.js`, `mockAnswerText` in `mock-data.js`) is sample text. Storing the answer, or the case id and turn, breaks the anonymity promise in `overlay/defaults/help-content.json`; decide the wording first.
- [ ] The Feedback page groups by `step_id`; items now carry `substep_id` too.

## 4. Several templates (MOCK #1) and #34

The server stores one template. `MOCK_TEMPLATES`, `saveAsNewTemplate` and every `tpl.mock` branch (`app.js`, `api.js`, `pages/editor.js`, `pages/documents.js`, `pages/deploy.js`, `components/template-selector.js`) go when #34 lands.

### Merge strategy for #34 (`feature/beleidskompas-versioning`, checked at bd85ddc)

Facts: #34 carries 75 commits of pre-squash history (merge-base with `feature/beleidskompas` is b7a583a, before the #20 and #32 squashes); its true delta is 39 files. Merged as is it would revert the last #20 commits (public-config allowlist, `OLD_DEFAULT_SUBSTEPS`, removed `/workflows/*`, `/rag/query`, preview routes) and PR 35's server guard and tests. Known breakages at bd85ddc: Feedback page `ui.split is not a function`, upload toast `uploaded is not defined`, Import posts to a removed route, `/dashboard` 500 while the DB starts, the public config leaks `webhook_token`, and `/workflows/status|sync` plus the Workflows card are back. A simulated merge onto this branch conflicts in 7 files: `server.js`, `lib/beleidskompas/index.js`, `tests/beleidskompas-start.test.js`, `api.js`, `app.js`, `pages/flow.js`, `mock-data.js` (deleted there).

Order: 1) retarget and merge this PR into `feature/beleidskompas`; 2) rebuild #34 on top of it; 3) delete `feature/admin-ui`.

Rebuild #34 (recommended over merging): branch from `feature/beleidskompas`, apply `git diff origin/feature/beleidskompas origin/feature/beleidskompas-versioning` for the 39 files, then:

- Keep from this branch: `normalizeBeleidskompasFlow` (empty-means-default, fixed steps), `defaultBeleidskompasFlow` from the generated defaults file, `publicBeleidskompasConfig(flow, versionId)`, the `live` handler and `start(app, { resolveUser, getLive, getRetentionDays })` with the retention sweep, `module.exports` + the `require.main` guard, `tests/beleidskompas-flow.test.js` tests 1–2 (delete the `live: false` test; #34's route test covers it).
- Take from #34: the template store (`0002-templates.sql`, `template-store.js`, `template-service.js`, `routes/admin-routes.js`), the per-template `api.js`/pages, deletion of `mock-data.js`. In `api.js` keep `listFeedback` reading `item.version_id`.
- Wire #34's store into the new seams: `getLive` reads the `live` row and normalises the snapshot through `normalizeBeleidskompasFlow`; `getRetentionDays` reads the `settings` table; `publishLive` calls `publicBeleidskompasConfig(flow, live.version_id)`; `start()` merges #34's `{ pool, requireAuth, flow, init }` with the three callbacks (one Pool, one `schema_migrations`).
- Do not bring back: `syncBeleidskompasWorkflowFiles`, `workflow_manifest`, `/workflows/status`, `/workflows/sync`, `/rag/query` (its scorer no longer exists), `webhook_token` in the snapshot, the Workflows card in `pages/general.js`.
- Fix in the same rebuild: `pages/feedback.js` filter (`matchesTemplate`/`subtitleFor` get a string), `pages/documents.js` `uploaded` array, Import (add `POST /templates/import` on `importLegacyState` or drop the button), `/dashboard` shows `—` on a 503 `StoreError`, `db/seed.sql` must use `stap1..stap4` (the normaliser drops other ids), `.env.example` `BELEIDSKOMPAS_DEV_SEED` should default to `false`.
- Decide with the author: one `live` row for the whole app (as #34 and 10ffde5 assume) is fine; port the Deploy-page half of 10ffde5 (`feature/admin-ui-single-live`) so "Nu live" shows the app-wide live version.

## 5. Who did what

- [ ] "Door" in Versies (`pages/editor.js`) is always "System Administrator" until sign-in with an admin role stores the user.

## Done

- #20: Flow builder notice; default substeps follow `steps.json`; hoofdagent renamed to orchestrator; public config allowlisted; Workflows card removed; sample templates marked "Voorbeeld".
- This branch: the agent reads the live template (instructions, answer structure, rules, report/conversation/orchestrator prompts, report disclaimer, messages, model); one generated defaults file; steps fixed, substeps and `version_id` published to the page; feedback with substep and version; retention sweep; the dead workflow generator, Geavanceerd fields and token copy removed.
