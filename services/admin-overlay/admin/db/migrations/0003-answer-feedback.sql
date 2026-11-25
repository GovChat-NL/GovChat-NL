-- Answer feedback: an anonymous rating (up or down) with an optional comment
-- on one Beleidskompas answer. No user, e-mail or conversation id.

CREATE TABLE IF NOT EXISTS answer_feedback (
  id bigserial PRIMARY KEY,
  rating text NOT NULL CHECK (rating IN ('up', 'down')),
  comment text NOT NULL DEFAULT '',
  step_id text NOT NULL DEFAULT '',
  substep_id text NOT NULL DEFAULT '',
  version_id text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS answer_feedback_created_at_idx ON answer_feedback (created_at);
