-- Drops and recreates the beleidskompas schema, leaving it empty and selected.
-- DESTRUCTIVE: deletes all templates, versions and documents.
--
-- RUNS IN ONE, COLLECTIVE TRANSACTION: scripts/replenish-beleidskompas-db.sh runs this with
-- schema.sql and seed.sql.

DROP SCHEMA IF EXISTS beleidskompas CASCADE;
CREATE SCHEMA beleidskompas;
SET search_path TO beleidskompas;
