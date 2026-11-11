-- The state of a Beleidskompas case. A case is a LibreChat conversation
-- (its id is the conversationId) that belongs to one user. Case texts and
-- reports are versioned: a change is a new version and the newest counts;
-- older versions stay, so a previous one can be put back as a new version.

CREATE TABLE cases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX cases_user_id_idx ON cases (user_id, updated_at DESC);

CREATE TABLE case_texts (
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, version)
);

-- text is the report as the page shows it.
CREATE TABLE reports (
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
CREATE TABLE conversation_turns (
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  step_id TEXT,
  asked_from TEXT,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, seq)
);
