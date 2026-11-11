-- Empties the Beleidskompas admin tables: templates, versions, documents, the live
-- pointer and the settings. DESTRUCTIVE: deletes all of them and restarts their ids.
-- The case tables (cases, case_texts, reports, conversation_turns) are left alone.
--
-- RUNS IN ONE, COLLECTIVE TRANSACTION: scripts/replenish-beleidskompas-db.sh runs this with
-- seed.sql. The tables are created by the migrations, which the admin applies at startup.

TRUNCATE live, version_documents, documents, template_versions, templates, settings RESTART IDENTITY;
