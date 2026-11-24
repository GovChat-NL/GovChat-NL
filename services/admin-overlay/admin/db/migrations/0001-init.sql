CREATE EXTENSION IF NOT EXISTS vector;

-- The state of a Beleidskompas case. A case is a LibreChat conversation
-- (its id is the conversationId) that belongs to one user. Case texts and
-- reports are versioned: a change is a new version and the newest counts;
-- older versions stay, so a previous one can be put back as a new version.

CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cases_user_id_idx ON cases (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS case_texts (
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, version)
);

-- text is the report as the page shows it.
CREATE TABLE IF NOT EXISTS reports (
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  substep_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  text TEXT NOT NULL,
  citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  retrieval_trace JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, substep_id, version)
);

-- One row per turn: what the user typed (role user) or what a step answered
-- (role assistant, with the step in step_id). asked_from is the substep the
-- user was in.
CREATE TABLE IF NOT EXISTS conversation_turns (
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  step_id TEXT,
  asked_from TEXT,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, seq)
);

-- The Beleidskompas admin config: templates and their versions, the reference
-- documents, which version is live, and the settings. A template is edited
-- as a new version (a full snapshot of the flow plus the documents it uses);
-- `live` holds the one version that end users get.

CREATE TABLE IF NOT EXISTS templates (
  id serial PRIMARY KEY,
  name text NOT NULL,
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
  index_status text NOT NULL DEFAULT 'pending' CHECK (index_status IN ('pending', 'indexing', 'ready', 'failed')),
  index_error text NOT NULL DEFAULT '',
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

-- halfvec, because an index on a vector column holds at most 2000 dimensions and the embedding has 3072.
CREATE TABLE IF NOT EXISTS document_chunks (
  id bigserial PRIMARY KEY,
  document_id integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_number integer NOT NULL,
  text text NOT NULL,
  location text NOT NULL DEFAULT '',
  page integer,
  heading text NOT NULL DEFAULT '',
  embedding halfvec(3072) NOT NULL,
  embedding_model text NOT NULL,
  search_words tsvector GENERATED ALWAYS AS (to_tsvector('dutch', text)) STORED,
  UNIQUE (document_id, chunk_number)
);
CREATE INDEX IF NOT EXISTS document_chunks_embedding_idx ON document_chunks USING hnsw (embedding halfvec_cosine_ops);
CREATE INDEX IF NOT EXISTS document_chunks_search_words_idx ON document_chunks USING gin (search_words);
