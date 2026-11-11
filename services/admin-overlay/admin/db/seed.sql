-- Beleidskompas sample data for local development.
--
-- Recreates the example template that used to live in the UI's mock-data.js:
-- "Omgevingsvisie (voorbeeld)" with two versions (v2 is live) and three documents.
--
-- The admin loads this file by itself on startup when BELEIDSKOMPAS_DEV_SEED=true and the
-- database has no templates. To wipe the templates and load it again: make replenish-beleidskompas-db
--
-- Plain SQL: run it in any client (VS Code query window, psql -f, ...) against the
-- database used by the admin service.
--
-- Prerequisite: the tables from migration 0002-templates.sql must exist. The admin
-- service creates them on startup, in the beleidskompas-postgres database.
--
-- Safe to run more than once: it does nothing if the template already exists.
-- Not for production: it makes the example template the live one when no
-- template is live yet, and it never touches an existing live row.

DO $seed$
DECLARE
  v_template_id integer;
  v1_id integer;
  v2_id integer;
  doc_ids integer[];
  flow jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM templates WHERE name = 'Omgevingsvisie (voorbeeld)') THEN
    RAISE NOTICE 'Seed data already present, nothing to do.';
    RETURN;
  END IF;

  flow := $json$
  {
    "title": "Beleidskompas Omgevingsvisie",
    "orchestrator_workflow_id": "govchat-beleidskompas-hoofdagent",
    "orchestrator_webhook_path": "beleidskompas-hoofdagent",
    "webhook_token": "",
    "disclaimer": "Voorbeeldtemplate met testdata.",
    "specialist_team": "Betrek de omgevingsjurist bij ruimtelijke besluiten.",
    "sources": ["Omgevingsvisie Limburg", "Omgevingsverordening", "Provinciale Instrumentenkoffer"],
    "steps": [
      {
        "id": "ov1",
        "title": "Opgave en belang",
        "description": "Welke ruimtelijke opgave speelt er, en waarom is de provincie aan zet?",
        "prompt": "Bepaal de ruimtelijke opgave en het provinciaal belang volgens de Omgevingsvisie.",
        "doc_tags": ["Omgevingsvisie"],
        "rag": {"algorithm": "hybrid", "top_k": 3, "min_score": 0.1, "tag_filter_mode": "any", "required_tags": []},
        "substeps": [{"id": "1.1", "title": "Gebied", "description": "Afbakening van het gebied."}]
      },
      {
        "id": "ov2",
        "title": "Rol en instrument",
        "description": "Welke rol neemt de provincie en welk instrument past?",
        "prompt": "Kies rol en instrument; verwijs naar de Omgevingsverordening.",
        "doc_tags": ["Verordening", "Instrumenten"],
        "rag": {"algorithm": "needle", "top_k": 4, "min_score": 0.12, "tag_filter_mode": "any", "required_tags": []},
        "substeps": []
      },
      {
        "id": "ov3",
        "title": "Governance",
        "description": "Wie beslist, wie voert uit en hoe wordt gemonitord?",
        "prompt": "Beschrijf governance, besluitvorming en monitoring.",
        "doc_tags": [],
        "rag": {"algorithm": "hybrid", "top_k": 3, "min_score": 0.08, "tag_filter_mode": "any", "required_tags": []},
        "substeps": []
      }
    ]
  }
  $json$::jsonb;

  -- Documents: plain-text bodies, so preview and download both work.
  WITH src(filename, content_type, body, age) AS (VALUES
    ('Omgevingsvisie Limburg 2024 (voorbeeld).md', 'text/markdown',
     E'# Omgevingsvisie Limburg (voorbeeld)\n\nDe Omgevingsvisie beschrijft de ruimtelijke ambities van de provincie tot 2040.', interval '40 days'),
    ('Omgevingsverordening (voorbeeld).md', 'text/markdown',
     E'# Omgevingsverordening (voorbeeld)\n\nRegels voor de fysieke leefomgeving in Limburg.', interval '35 days'),
    ('Instrumentenkoffer (voorbeeld).md', 'text/markdown',
     E'# Instrumenten (voorbeeld)\n\n- Subsidie\n- Regelgeving\n- Kennis en netwerk', interval '12 days')
  ), ins AS (
    INSERT INTO documents (sha256, filename, content_type, size, preview_text, content, created_at)
    SELECT encode(sha256(convert_to(body, 'UTF8')), 'hex'), filename, content_type,
           octet_length(convert_to(body, 'UTF8')), body, convert_to(body, 'UTF8'), now() - age
    FROM src
    ON CONFLICT (sha256) DO UPDATE SET filename = documents.filename  -- no-op, so RETURNING also yields existing rows
    RETURNING id
  )
  SELECT array_agg(id ORDER BY id) INTO doc_ids FROM ins;

  INSERT INTO templates (name) VALUES ('Omgevingsvisie (voorbeeld)') RETURNING id INTO v_template_id;

  INSERT INTO template_versions (template_id, version, note, created_by, snapshot, created_at)
  VALUES (v_template_id, 1, 'Eerste versie', 'Seed',
          jsonb_set(flow, '{steps}', (flow->'steps') - 2), now() - interval '60 days')
  RETURNING id INTO v1_id;

  INSERT INTO template_versions (template_id, version, note, created_by, snapshot, created_at)
  VALUES (v_template_id, 2, 'Verordening en governance toegevoegd', 'Seed', flow, now() - interval '7 days')
  RETURNING id INTO v2_id;

  -- v1 only knew the first document, v2 has all three.
  INSERT INTO version_documents (version_id, document_id) VALUES (v1_id, doc_ids[1]);
  INSERT INTO version_documents (version_id, document_id) SELECT v2_id, unnest(doc_ids);

  UPDATE templates SET live_version_id = v2_id WHERE id = v_template_id;

  INSERT INTO live (template_id, version_id) VALUES (v_template_id, v2_id)
  ON CONFLICT (key) DO NOTHING;
END
$seed$;
