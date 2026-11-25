-- General feedback: free text about Beleidskompas as a whole, with the
-- sender's e-mail address so an admin can reply. Kept for 365 days.

CREATE TABLE IF NOT EXISTS general_feedback (
  id bigserial PRIMARY KEY,
  email text NOT NULL,
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS general_feedback_created_at_idx ON general_feedback (created_at);
