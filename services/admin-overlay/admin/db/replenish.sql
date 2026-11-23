-- Drop only the versioning tables; user cases and migration history are kept.
-- The Makefile asks for confirmation. The scripts run this, 0001-init.sql and
-- seed.sql in one transaction, so a failure restores the previous tables and data.

DROP TABLE IF EXISTS live, version_documents, document_chunks, documents, template_versions, templates, settings;
