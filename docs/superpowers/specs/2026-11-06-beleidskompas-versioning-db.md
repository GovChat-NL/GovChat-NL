# Beleidskompas template versioning on Postgres: spec

Source: the "Template versioning with versioned documents" guide (reference test environment,
PostgreSQL 17 + Express + `pg`, verified 2026-11-06) plus the decisions below taken for this
repository on 2026-11-06.

## The model (from the guide)

A template is a complete configuration set: a title, steps with prompts, and a list of documents.
Each save inside a template inserts a new version row; nothing updates a version row afterwards.
A version holds a full copy of the configuration (`snapshot jsonb`), so rolling back means pointing
at an older row.

Two pointers say which version is in use:

- `templates.live_version_id`: the template's current (newest) version. Each save moves it.
- `live`: one row that says which template and version users get. Moving it publishes.

A document is stored once, identified by the SHA-256 of its bytes. A version lists its documents in
`version_documents`, so each version pins an exact set. Copying a version into a new template copies
the links, not the bytes.

```sql
templates          (id, name, live_version_id, created_from_version_id, created_at)
template_versions  (id, template_id, version, note, snapshot jsonb, created_at,
                    UNIQUE (template_id, version))
documents          (id, sha256 UNIQUE, filename, content_type, size, content bytea, created_at)
version_documents  (version_id, document_id, PRIMARY KEY (version_id, document_id))
live               (key PRIMARY KEY DEFAULT 'live', template_id, version_id)
```

| Operation | What it writes |
|---|---|
| Create template | A `templates` row, then version 1 through `saveVersion`. |
| Save | A new version with the edited snapshot and the current version's document list. |
| Upload document | The file row if its hash is new, then a new version with the current list plus that document. |
| Remove document | A new version with the current list minus that document. The file row stays. |
| Select live | Moves both pointers to an existing version and publishes. No new version. |
| Save as new template | A new template whose version 1 copies the source version's snapshot and document links. `created_from_version_id` records the source. |

`saveVersion` is the only function that writes versions: one transaction inserts the version row,
its document links and the pointer update. If the saved template is the live one, the new version
is published at once. Uploads hash the body and let `ON CONFLICT (sha256)` handle duplicates.
`publishLive` is where the real publish step lives (page config and n8n workflow files).

## Decisions for this repository (2026-11-06)

Scope is a coupling job: give the existing admin UI (branch `feature/beleidskompas-versioning`,
`services/admin-overlay/admin/views/beleidskompas-admin/`) a versioning-safe Postgres backend.
Do not change how the UI looks or behaves. Later work: a dedicated deploy view that picks the live
template + version, pushing workflows into n8n, feedback carrying template and version ids.

1. Rollback: no UI change. "Herstellen als nieuwe versie" saves the old snapshot as a new version.
   The `live` pointer move ("Select live") gets no UI yet; the migration sets it once.
2. Draft: unsaved edits live in the browser tab only. No draft rows. The server-side draft is dropped.
3. Documents: a library per template. The "Actief in dit template" toggle is membership in the
   template's current version. Each step selects documents from the library: the step's document
   ids are stored inside the step in the snapshot (`steps[].document_ids`), the one field the UI
   does not have yet.
4. Rename: a plain update of `documents.filename`, no versioning of names.
5. Database: a `beleidskompas` schema inside the existing pgvector Postgres (`pgvector` compose
   service, database `${POSTGRES_DB}`). No new container.
6. Existing data: the current `beleidskompas-state.json` is imported once at first start as the
   template "SiS 4.0". Export/import stay: export dumps one template in that same JSON shape,
   import creates a template from such a file.
7. n8n push: later. The existing publish step (write `beleidskompas-config.json`, regenerate the
   workflow files and manifest) stays as it is and runs when the live template gets a new version.
8. Feedback and settings: untouched. Settings move to a one-row table so the state file can go.

Mindset: minimal effective code. Standard packages (`pg`, Express), plain SQL, schema applied with
`CREATE TABLE IF NOT EXISTS` at startup, no ORM. Every line is maintenance.
