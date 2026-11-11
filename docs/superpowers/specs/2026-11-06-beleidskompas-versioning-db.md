# Beleidskompas versioning on Postgres: spec

## Goal
Store Beleidskompas templates, versions and documents in Postgres instead of `beleidskompas-state.json`, without changing how the admin UI looks or behaves.

## Model
- A **template** is a full configuration: title, steps with prompts, documents.
- Every save inserts a new **version** (`snapshot jsonb`). Versions are never updated.
- A **document** is stored once, keyed by the SHA-256 of its bytes. A version lists its documents in `version_documents`.
- Two pointers:
  - `templates.live_version_id`: the template's newest version. Every save moves it, and the editor opens it. The API does not report it as "live".
  - `live` (one row): the template and version end users get. The migration or seed sets it, and the Deploy page moves it (`POST /templates/:id/versions/:versionId/deploy`, which also runs the publish step). Saving a version never changes it, so a save does not go live until it is deployed. The API reports `live_version_id` and `is_live` from this row, and `null` for templates that are not live.

```sql
templates          (id, name, live_version_id, created_from_version_id, created_at)
template_versions  (id, template_id, version, note, created_by, snapshot jsonb, created_at)
documents          (id, sha256 UNIQUE, filename, content_type, size, preview_text, content bytea, created_at)
version_documents  (version_id, document_id)
live               (key, template_id, version_id)
settings           (key, data jsonb)
```

| Action | Result |
|---|---|
| Create template | New template, version 1 |
| Save / restore old version | New version with the edited or old snapshot |
| Upload / remove document | New version with the document list changed |
| Save as new template | New template whose version 1 copies the source version |

All version writes go through `saveVersion`, in one transaction.

## Decisions
1. Restoring an old version saves it as a new version.
2. No server-side drafts. Unsaved edits stay in the browser tab.
3. Step document ids are stored in the snapshot (`steps[].document_ids`).
4. Renaming a document is a plain update, not a new version.
5. Tables live in the `beleidskompas` schema of the existing pgvector database, created at startup.
6. `beleidskompas-state.json` is imported once as template "SiS 4.0". Export/import stay.
7. The existing publish step stays as it is.
8. Feedback is untouched. Settings move to a one-row table.

Code is plain SQL with `pg` and Express, no ORM, in `admin/beleidskompas/` (`api/` for routes, `db/` for schema and store).

## Demo data
`BELEIDSKOMPAS_DEV_SEED=true` loads `seed.sql` into an empty database. `make replenish-beleidskompas-db` wipes everything and reseeds, after a confirmation.

## Not yet
- Pushing workflows to n8n on publish.
- Feedback that records template and version ids.
- Export/import keep only the current documents, not earlier versions'.
