# Beleidskompas Versioning on Postgres Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the admin server's single JSON state file with Postgres tables for templates, immutable versions and content-addressed documents, and wire the existing Beleidskompas admin UI to them without changing its behaviour.

**Architecture:** A new folder `services/admin-overlay/admin/beleidskompas/` holds `schema.sql`, `db.js` (pool, transaction, schema apply) and `store.js` (every read and write, plain SQL through `pg`). `server.js` keeps the flow normalisation, the publish step and the routes, but reads and writes through `store.js` and runs a one-time import of the old state file at startup. The UI's `api.js` is the only coupling layer; the pages get one-line edits where they need a template id.

**Tech Stack:** Node 20, Express 4, `pg` ^8, PostgreSQL 16 (pgvector image), `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-06-beleidskompas-versioning-db.md`

## Global Constraints

- Only new dependency: `pg`. No ORM, no migration tool: `schema.sql` with `CREATE TABLE IF NOT EXISTS`, applied at startup.
- Tables live in Postgres schema `beleidskompas` inside the existing pgvector database. Connection string from env `BELEIDSKOMPAS_DATABASE_URL`.
- The UI keeps its look and behaviour. Edits in `views/beleidskompas-admin/` are limited to `api.js`, deleting `mock-data.js`, and the single-line call sites listed in Task 5.
- Version rows are never updated. `saveVersion` is the only writer of versions.
- Response shapes the UI already reads stay: versions as `{ id, published_at, published_by, note, is_live, snapshot }`, documents as `{ id, filename, mime_type, size_bytes, uploaded_at, preview_text }`, settings unchanged.
- Dutch user-facing error strings, as in the existing routes.
- Commit messages: `feat(admin): …`, `test(admin): …`, `chore(admin): …`, each ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. Two admins save the same template at once: the second insert hits `UNIQUE (template_id, version)` and must return a 409-style error, not a 500 with a half-written transaction. Pinned in Task 2.
2. Uploading bytes that already exist under another name: the stored file is reused and the current version gains that document once, with the first filename. Pinned in Task 2.
3. Deactivating a document that is not in the current version, or removing one twice: 404, no new version. Pinned in Task 2.
4. Startup on a volume with an old `beleidskompas-state.json` whose `live_version_id` is an older version: the published config must be that older snapshot, not the newest. Pinned in Task 3.
5. Saving a template that is not live must not rewrite `beleidskompas-config.json` or the workflow files. Pinned in Task 2 (store returns `isLive`) and checked in the Task 6 sequence.

---

### Task 1: Database wiring

**Files:**
- Create: `services/admin-overlay/admin/beleidskompas/schema.sql`
- Create: `services/admin-overlay/admin/beleidskompas/db.js`
- Test: `services/admin-overlay/admin/beleidskompas/db.test.js`
- Modify: `services/admin-overlay/admin/package.json` (add `"pg": "^8.13.0"`, script `"test": "node --test"`)
- Modify: `services/admin-overlay/admin/Dockerfile` (add `COPY beleidskompas/ ./beleidskompas/`)
- Modify: `docker-compose.yml:759-778` (pgvector: add profile `admin-overlay`) and `:851-900` (govchat-overlay-admin: add env and `depends_on`)
- Modify: `.env.example:90` (document `BELEIDSKOMPAS_DATABASE_URL`)

**Interfaces:**
- Produces: `createDb({ connectionString, schema = "beleidskompas" })` returning `{ query(text, params), transaction(fn), applySchema(), end() }`. `transaction(fn)` calls `fn(q)` where `q(text, params)` runs on one client inside `BEGIN`/`COMMIT`, rolls back on throw. `applySchema()` runs `CREATE SCHEMA IF NOT EXISTS <schema>` then `schema.sql`. The pool sets `options: "-c search_path=<schema>"`.

- [ ] **Step 1: Write `schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS templates (
  id serial PRIMARY KEY,
  name text NOT NULL,
  live_version_id integer,
  created_from_version_id integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS template_versions (
  id serial PRIMARY KEY,
  template_id integer NOT NULL REFERENCES templates(id),
  version integer NOT NULL,
  note text NOT NULL DEFAULT '',
  created_by text NOT NULL DEFAULT 'System Administrator',
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);
CREATE TABLE IF NOT EXISTS documents (
  id serial PRIMARY KEY,
  sha256 text NOT NULL UNIQUE,
  filename text NOT NULL,
  content_type text NOT NULL,
  size integer NOT NULL,
  preview_text text NOT NULL DEFAULT '',
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS version_documents (
  version_id integer NOT NULL REFERENCES template_versions(id),
  document_id integer NOT NULL REFERENCES documents(id),
  PRIMARY KEY (version_id, document_id)
);
CREATE TABLE IF NOT EXISTS live (
  key text PRIMARY KEY DEFAULT 'live',
  template_id integer NOT NULL REFERENCES templates(id),
  version_id integer NOT NULL REFERENCES template_versions(id)
);
CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY DEFAULT 'settings',
  data jsonb NOT NULL
);
```

- [ ] **Step 2: Write the failing test `db.test.js`**

Tests skip (`test.skip`) when `BELEIDSKOMPAS_TEST_DATABASE_URL` is unset. Use schema `beleidskompas_test` and `DROP SCHEMA IF EXISTS beleidskompas_test CASCADE` in a `before` hook.

```js
test("applySchema is idempotent and sets the search_path", async () => {
  await db.applySchema();
  await db.applySchema();
  const { rows } = await db.query("SELECT current_schemas(false) AS s");
  assert.ok(rows[0].s.includes("beleidskompas_test"));
  const t = await db.query("SELECT count(*)::int AS n FROM templates");
  assert.equal(t.rows[0].n, 0);
});
test("transaction rolls back on throw", async () => {
  await assert.rejects(db.transaction(async (q) => {
    await q("INSERT INTO templates (name) VALUES ($1)", ["x"]);
    throw new Error("boom");
  }));
  const t = await db.query("SELECT count(*)::int AS n FROM templates");
  assert.equal(t.rows[0].n, 0);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd services/admin-overlay/admin && BELEIDSKOMPAS_TEST_DATABASE_URL=postgresql://… node --test beleidskompas/db.test.js`
Expected: FAIL, cannot find module `./db.js`.

- [ ] **Step 4: Implement `db.js`**

`createDb` wraps `new Pool({ connectionString, options })`. `applySchema` reads `schema.sql` with `fs.readFileSync(path.join(__dirname, "schema.sql"))` and runs it in one `query` after the `CREATE SCHEMA`. Export also `isUniqueViolation(err)` returning `err.code === "23505"`.

- [ ] **Step 5: Run the test to verify it passes**

Expected: 2 passing.

- [ ] **Step 6: Compose, Dockerfile, env**

In `docker-compose.yml`, pgvector `profiles` gains `- admin-overlay`. `govchat-overlay-admin` gains
`- BELEIDSKOMPAS_DATABASE_URL=${BELEIDSKOMPAS_DATABASE_URL:-postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@pgvector:5432/${POSTGRES_DB}}` and
```yaml
    depends_on:
      pgvector:
        condition: service_healthy
```
`.env.example` gets a commented `BELEIDSKOMPAS_DATABASE_URL` line under the Beleidskompas block. Dockerfile copies the folder.

Run: `docker compose --env-file .env.example config --quiet` Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add services/admin-overlay/admin/beleidskompas services/admin-overlay/admin/package.json services/admin-overlay/admin/package-lock.json services/admin-overlay/admin/Dockerfile docker-compose.yml .env.example
git commit -m "feat(admin): add Postgres schema and connection for Beleidskompas versioning"
```

---

### Task 2: The store

**Files:**
- Create: `services/admin-overlay/admin/beleidskompas/store.js`
- Test: `services/admin-overlay/admin/beleidskompas/store.test.js`

**Interfaces:**
- Consumes: `createDb` from Task 1.
- Produces: `createStore(db)` returning the functions below. All ids are integers. "Current" means `templates.live_version_id`.

```js
listTemplates()                 // → [{ id, name, live_version_id, versions: [{ id, published_at, published_by, note, is_live, snapshot }] }], versions newest first; is_live = (id === live_version_id)
getCurrent(templateId)          // → { versionId, snapshot, documentIds } or null
createTemplate({ name, snapshot, documentIds, createdFromVersionId, note }) // → { template, version }
saveVersion(templateId, snapshot, documentIds, note) // → { version, isLive }; throws Error with .status = 409 on unique violation
upsertDocument({ filename, contentType, bytes, previewText }) // → { id, reused }
listDocuments(templateId)       // → [{ id, filename, mime_type, size_bytes, uploaded_at, preview_text, active }], every document linked to any version of the template, active = in current version
getDocument(documentId)         // → { id, filename, mime_type, preview_text, content } or null
renameDocument(documentId, filename)
getLive()                       // → { template_id, version_id, snapshot, documents: [listDocuments shape without active] } or null
setLive(templateId, versionId)
getSettings() / saveSettings(data)
importLegacyState(state, name)  // → { templateId, versionIds: { [legacyId]: newId } }
```

- [ ] **Step 1: Write the failing tests `store.test.js`** (same skip rule and schema reset as Task 1)

```js
test("createTemplate writes version 1 and saveVersion numbers upward", async () => {
  const { template, version } = await store.createTemplate({ name: "A", snapshot: { title: "A", steps: [] }, documentIds: [], note: "init" });
  assert.equal(version.version, 1);
  const v2 = await store.saveVersion(template.id, { title: "A2", steps: [] }, [], "edit");
  assert.equal(v2.version.version, 2);
  assert.equal(v2.isLive, false);
  const [t] = await store.listTemplates();
  assert.equal(t.live_version_id, v2.version.id);
  assert.equal(t.versions[0].is_live, true);
  assert.equal(t.versions[1].is_live, false);
});
test("upload reuses bytes by hash and pins documents per version", async () => {
  const a = await store.upsertDocument({ filename: "a.txt", contentType: "text/plain", bytes: Buffer.from("same"), previewText: "same" });
  const b = await store.upsertDocument({ filename: "b.txt", contentType: "text/plain", bytes: Buffer.from("same"), previewText: "same" });
  assert.equal(a.id, b.id); assert.equal(a.reused, false); assert.equal(b.reused, true);
  assert.equal((await store.getDocument(a.id)).filename, "a.txt");
});
test("listDocuments shows history with active flag", async () => {
  // template with doc 1 and 2 in v1, then v2 without doc 1
  // expect doc 1 active:false, doc 2 active:true, both listed
});
test("saveVersion reports isLive when the template is live", async () => {
  // createTemplate, setLive(template.id, version.id), saveVersion → isLive === true
  // getLive().version_id is still the old version (pointer did not move)
});
test("createTemplate copies document links, not bytes", async () => {
  // source version with doc X; createTemplate({ createdFromVersionId, documentIds: [X] }) → getCurrent(new).documentIds deep equals [X]
});
test("concurrent saves: the second gets status 409", async () => {
  // run two saveVersion calls with Promise.allSettled on one template; exactly one rejected with err.status === 409
});
test("importLegacyState maps versions in date order and keeps the legacy live version", async () => {
  // legacy state: versions [{id:"v2",published_at: later},{id:"v1",published_at: earlier}], live_version_id:"v1", documents: [{content_base64 of "x"}]
  // → template has versions 1 and 2 in date order; result.versionIds.v1 is version 1; every version lists the document
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Expected: FAIL, cannot find module `./store.js`.

- [ ] **Step 3: Implement `store.js`**

Plain SQL, one statement per operation where possible. Points the signatures do not settle:
- `saveVersion`: one `db.transaction`: insert the version with `(SELECT coalesce(max(version), 0) + 1 … WHERE template_id = $1)`, insert links with one `INSERT … SELECT unnest($2::int[])`, update `templates.live_version_id`. Catch `isUniqueViolation` and rethrow `Object.assign(new Error("Gelijktijdige wijziging, probeer opnieuw"), { status: 409 })`. After commit, `isLive = (live.template_id === templateId)`.
- `upsertDocument`: `INSERT … ON CONFLICT (sha256) DO UPDATE SET sha256 = EXCLUDED.sha256 RETURNING id, (xmax <> 0) AS reused`.
- `listDocuments`: join `templates → template_versions → version_documents → documents`, `GROUP BY d.id, t.live_version_id`, `bool_or(tv.id = t.live_version_id) AS active`, order by `d.created_at DESC`. Dates as ISO strings (`to_char` or `.toISOString()` on the `Date` pg returns).
- `importLegacyState(state, name)`: upsert all legacy documents (bytes from `content_base64`), create the template from the oldest version, `saveVersion` the rest in `published_at` order with `published_by` as `created_by`, each with all document ids. Return the legacy-to-new id map. Does not call `setLive`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd services/admin-overlay/admin && BELEIDSKOMPAS_TEST_DATABASE_URL=… node --test`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add services/admin-overlay/admin/beleidskompas/store.js services/admin-overlay/admin/beleidskompas/store.test.js
git commit -m "feat(admin): Beleidskompas store with immutable versions and hashed documents"
```

---

### Task 3: Server startup, migration and publish

**Files:**
- Modify: `services/admin-overlay/admin/server.js:69-76` (constants), `:307-345` (`initDefaults`), `:636-760` (normalisation and state helpers), `:1003-1047` (`syncBeleidskompasWorkflowFiles`), `:3431-3479` (start)

**Interfaces:**
- Consumes: `createDb`, `createStore` (Tasks 1 and 2).
- Produces, module scope in `server.js`: `const db`, `const store`; `async function publishLive()`; `function normalizeBeleidskompasFlow(input)` now keeps `steps[].document_ids` (array of strings, default `[]`); `syncBeleidskompasWorkflowFiles(flow, documents)` with the new two-argument signature; `async function startBeleidskompas()` called before `server.listen`.

- [ ] **Step 1: Normalisation keeps step document ids**

In `normalizeBeleidskompasFlow`, add to each step: `document_ids: Array.isArray(step?.document_ids) ? step.document_ids.map(String) : []`.

- [ ] **Step 2: Delete the state-file model**

Remove `BELEIDSKOMPAS_STATE_FILE`, `defaultBeleidskompasState`, `normalizeBeleidskompasState`, `readBeleidskompasState`, `writeBeleidskompasState`, and the state-file block in `initDefaults` (lines 336-344). Keep `defaultBeleidskompasFlow`, `normalizeBeleidskompasFlow`, `normalizeBeleidskompasDocuments`, `publishBeleidskompasLiveConfig`. Change `syncBeleidskompasWorkflowFiles(flowInput)` to `syncBeleidskompasWorkflowFiles(flow, documents = [])` and drop its state-detection branch.

- [ ] **Step 3: Add `publishLive` and `startBeleidskompas`**

```js
async function publishLive() {
  const live = await store.getLive();
  if (!live) return null;
  publishBeleidskompasLiveConfig(live.snapshot);
  return syncBeleidskompasWorkflowFiles(normalizeBeleidskompasFlow(live.snapshot), live.documents);
}
```
`startBeleidskompas()`: `await db.applySchema()`; if `listTemplates()` is empty: when `DATA_DIR/beleidskompas-state.json` exists, `importLegacyState(json, "SiS 4.0")`, `setLive(templateId, versionIds[json.live_version_id] ?? newest)`, `saveSettings(json.settings)`, rename the file to `beleidskompas-state.json.migrated`; otherwise `createTemplate({ name: "SiS 4.0", snapshot: defaultBeleidskompasFlow(), documentIds: [], note: "Initiële versie" })` and `setLive` to it. Then `await publishLive()`. Log one line per branch with the `[init]` prefix used in the file.

- [ ] **Step 4: Start order**

Replace the bare `initDefaults();` at the start block with `startBeleidskompas().then(() => server.listen(...))`, keeping the other startup calls. Log and `process.exit(1)` on failure, so a missing database is visible instead of a half-started admin.

- [ ] **Step 5: Verify**

Run: `node --check services/admin-overlay/admin/server.js` Expected: no output.
Run with a database and an old state file whose `live_version_id` is not the newest version: `/publish/beleidskompas-config.json` equals that older snapshot's title and steps (Review Focus 4). Run again: the log says the import was skipped and the file is renamed only once.

- [ ] **Step 6: Commit**

```bash
git add services/admin-overlay/admin/server.js
git commit -m "feat(admin): start Beleidskompas from Postgres and import the old state file once"
```

---

### Task 4: Routes

**Files:**
- Modify: `services/admin-overlay/admin/server.js:2611-2641` (dashboard), `:2698-2702` (state), `:2746-2900` (export, import, draft, settings, publish, rollback, workflows), `:2897-2996` (documents), `:2998-3040` (rag query)

**Interfaces:**
- Consumes: `store`, `publishLive`, `normalizeBeleidskompasFlow` (Task 3).
- Produces the API the UI calls in Task 5. Every handler is `async` with the file's existing `try { … } catch (err) { return res.status(err.status || 400).json({ error: String(err?.message || err) }); }` shape.

| Method and path | Body | Response |
|---|---|---|
| GET `/api/beleidskompas/state` | | `{ ok, templates, settings, live: { template_id, version_id }, workflow_manifest }` |
| POST `/api/beleidskompas/templates` | `{ name, flow, from_template_id }` | `{ ok, template, version }`; documentIds = `getCurrent(from_template_id).documentIds`, `createdFromVersionId` = its versionId |
| POST `/api/beleidskompas/templates/:id/versions` | `{ flow, note }` | `{ ok, version, workflow_manifest }`; calls `publishLive()` when `isLive` |
| GET `/api/beleidskompas/templates/:id/documents` | | `{ ok, documents }` |
| POST `/api/beleidskompas/templates/:id/documents` | `{ filename, mime_type, content_base64 }` | 201 `{ ok, document, reused }`; preview text rule copied from the old route; then `saveVersion` with current ids plus the document, note `Document toegevoegd: <filename>` |
| PATCH `/api/beleidskompas/templates/:id/documents/:docId` | `{ filename? , active? }` | `{ ok, document }`; `filename` → `renameDocument`; `active: false` → `saveVersion` minus the id (404 when not in current); `active: true` → `saveVersion` plus the id |
| DELETE `/api/beleidskompas/templates/:id/documents/:docId` | | `{ ok, removed }`; same as `active: false` |
| GET `/api/beleidskompas/documents/:docId/preview` and `/download` | | as before, from `getDocument` |
| GET `/api/beleidskompas/templates/:id/export` | | legacy-shaped JSON `{ name, live, draft, live_version_id, versions, documents }` with `content_base64`, so `import` can read it |
| POST `/api/beleidskompas/import` | that JSON | `{ ok, template }` via `importLegacyState(json, json.name \|\| "Import")` |
| POST `/api/beleidskompas/settings` | unchanged | unchanged, backed by `getSettings`/`saveSettings` |
| GET `/api/beleidskompas/workflows/status`, POST `/workflows/sync` | | unchanged shape; both read `getLive()`; sync calls `publishLive()` |
| POST `/api/beleidskompas/rag/query` | unchanged | unchanged; `flow` and `documents` from `getLive()` |

Removed: `POST /draft`, `POST /publish`, `POST /rollback/:versionId`, `GET /documents` (global list). The dashboard counts come from `listTemplates()` and `getLive()`.

- [ ] **Step 1: Implement the routes as in the table**

- [ ] **Step 2: Verify with curl against a running admin** (session cookie from `/login`)

```bash
curl -s -b c.txt localhost:3002/api/beleidskompas/state | jq '.templates[0] | {id, name, versions: (.versions | length)}'
curl -s -b c.txt -X POST localhost:3002/api/beleidskompas/templates/1/versions -H 'content-type: application/json' -d '{"flow":{"title":"Edit","steps":[]},"note":"t"}' | jq .version.version
```
Expected: version count grows by one; second command prints the new number.

- [ ] **Step 3: Commit**

```bash
git add services/admin-overlay/admin/server.js
git commit -m "feat(admin): template and version routes for the Beleidskompas admin"
```

---

### Task 5: Wire the UI

**Files:**
- Modify: `services/admin-overlay/admin/views/beleidskompas-admin/api.js` (rewrite the MOCK functions, add template ids)
- Delete: `services/admin-overlay/admin/views/beleidskompas-admin/mock-data.js`
- Modify: `app.js:26` (`templateId: null`), `:43-47` (`liveFlowOf`), `:49-52` (`loadDocuments`), `:82-94` (`publish`), `:96-104` (`saveAsNewTemplate`)
- Modify: `pages/editor.js:79` (restore call), `:122` (export url)
- Modify: `pages/documents.js:29` (toggle), `:41`, `:87`, `:107` (template id in calls)
- Modify: `pages/flow.js:96` (`onChange`)

**Interfaces (new `api.js` exports):**

```js
listTemplates(state)                       // state.templates
publishVersion(templateId, flow, note)     // POST /templates/:id/versions
saveAsNewTemplate(templateId, name, flow)  // POST /templates → returns template; async now
listDocuments(templateId)
uploadDocument(templateId, file)
updateDocument(templateId, id, patch)      // { filename } or { active }
deleteDocument(templateId, id)
downloadUrl(id); exportUrl(templateId); importState(json)
isDocumentActive(doc)                      // doc.active
getStepDocumentIds(step)                   // new Set(step.document_ids || [])
setStepDocument(step, docId, checked)      // mutates step.document_ids
listFeedback(templates)                    // unchanged
```

- [ ] **Step 1: Rewrite `api.js`** per the list; remove the `mock-data.js` import and the MOCK comments; delete `mock-data.js`.

- [ ] **Step 2: Call-site edits**

- `app.js` `liveFlowOf(tpl)`: always the snapshot of `tpl.versions.find(v => v.id === tpl.live_version_id) || tpl.versions[0]`. `loadDocuments`: `api.listDocuments(template().id)`. `publish`: `api.publishVersion(tpl.id, store.flow, note)`. `saveAsNewTemplate`: `const t = await api.saveAsNewTemplate(tpl.id, name, store.flow); await reload(); await selectTemplate(t.id)`.
- `editor.js:79`: `api.publishVersion(tpl.id, v.snapshot, …)`; `:122`: `api.exportUrl(tpl.id)`.
- `documents.js:20`: `api.isDocumentActive(d)`; `:29`: `onChange: async (v) => { await api.updateDocument(tpl.id, d.id, { active: v }); await reloadDocs(); }`; `:41`, `:87`, `:107`: pass `tpl.id`; `:73`: `api.getStepDocumentIds(s)`.
- `flow.js:63`: `api.getStepDocumentIds(step)`; `:96`: `onChange: (v) => { api.setStepDocument(step, d.id, v); markDirty(); }`.
- The `tpl.mock` checks stay; they are now always false.

- [ ] **Step 3: Verify in the browser** (`make rebuild-admin`, open `/beleidskompas-editor`)

Expected: the template selector lists "SiS 4.0" only; "Opslaan als nieuw template" adds a second template that survives a page reload; ticking a step document, publishing, and reloading shows the tick again; the "Actief" toggle survives a reload and adds a version.

- [ ] **Step 4: Commit**

```bash
git add services/admin-overlay/admin/views/beleidskompas-admin
git commit -m "feat(admin): couple the Beleidskompas admin UI to templates and versions"
```

---

### Task 6: Test target, docs and end-to-end check

**Files:**
- Modify: `Makefile:7` (`.PHONY`) and after `test-beleidskompas` (new target)
- Modify: `services/admin-overlay/README.md` (one paragraph: database, env var, migration)
- Modify: `docs/retention-policy.md:38` (documents now in Postgres; versions keep links to removed documents)

- [ ] **Step 1: Makefile target**

```make
test-admin: ## Run the admin store tests against BELEIDSKOMPAS_TEST_DATABASE_URL (skips without it)
	cd services/admin-overlay/admin && node --test
```
Add `test-admin` to `.PHONY`.

- [ ] **Step 2: Docs** as listed. Mention that the old state file is renamed to `.migrated` and can be deleted after a check.

- [ ] **Step 3: End-to-end sequence through the UI and curl** (the spec's verification list, adapted)

1. Edit the title, publish: version count +1, `beleidskompas-config.json` has the new title.
2. Upload `a.txt`, then `b.txt`: two more versions, both documents active.
3. Upload the bytes of `a.txt` as `c.txt`: response `reused: true`, library still shows two documents.
4. Deactivate `a.txt`: new version, `a.txt` listed as inactive; the generated step workflow files list only `b.txt`.
5. Save as new template "Kopie": template 2 has version 1 with `b.txt`; saving in template 2 does not change `beleidskompas-config.json` (Review Focus 5).
6. Download `a.txt`: original bytes.
7. Restart the admin: nothing re-imported, state unchanged.

- [ ] **Step 4: Commit**

```bash
git add Makefile services/admin-overlay/README.md docs/retention-policy.md
git commit -m "chore(admin): test target and docs for Beleidskompas versioning on Postgres"
```
