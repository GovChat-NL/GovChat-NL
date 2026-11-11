-- The Beleidskompas admin: templates and their versions, the reference
-- documents, which version is live, and the settings. A template is edited
-- as a new version (a full snapshot of the flow plus the documents it uses);
-- `live` holds the one version that end users get.
--
-- Separate from the case tables in 0001-init.sql: these are shared admin
-- configuration, not the state of a user's case.

CREATE TABLE templates (
  id serial PRIMARY KEY,
  name text NOT NULL,
  live_version_id integer,
  created_from_version_id integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE template_versions (
  id serial PRIMARY KEY,
  template_id integer NOT NULL REFERENCES templates(id),
  version integer NOT NULL,
  note text NOT NULL DEFAULT '',
  created_by text NOT NULL DEFAULT 'System Administrator',
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);
CREATE TABLE documents (
  id serial PRIMARY KEY,
  sha256 text NOT NULL UNIQUE,
  filename text NOT NULL,
  content_type text NOT NULL,
  size integer NOT NULL,
  preview_text text NOT NULL DEFAULT '',
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE version_documents (
  version_id integer NOT NULL REFERENCES template_versions(id),
  document_id integer NOT NULL REFERENCES documents(id),
  PRIMARY KEY (version_id, document_id)
);
CREATE TABLE live (
  key text PRIMARY KEY DEFAULT 'live',
  template_id integer NOT NULL REFERENCES templates(id),
  version_id integer NOT NULL REFERENCES template_versions(id)
);
CREATE TABLE settings (
  key text PRIMARY KEY DEFAULT 'settings',
  data jsonb NOT NULL
);
