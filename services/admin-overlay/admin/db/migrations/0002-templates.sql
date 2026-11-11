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
