"use strict";

// Runs the search against a real Postgres, like beleidskompas-db.test.js:
// `make test-beleidskompas-db`. Without the settings the test is skipped.

const test = require("node:test");
const assert = require("node:assert/strict");

const { connectionSettings, applyMigrations } = require("../db/connection");
const { createDocumentRepository } = require("../lib/beleidskompas/documents/document-repository");
const { INDEX_VERSION } = require("../lib/beleidskompas/documents/index-documents");

const enabled = String(process.env.BELEIDSKOMPAS_DB_TEST || "").toLowerCase() === "true" && connectionSettings().host;

const DIMENSIONS = 3072;

/** An embedding that points along `axis`. Two embeddings along the same
 *  axis mean the same, two along different axes have nothing in common.
 *  `aside` turns it a little away from its axis. */
function embeddingAlong(axis, aside = 0) {
  const embedding = new Array(DIMENSIONS).fill(0);
  embedding[axis] = 1;
  embedding[DIMENSIONS - 1] = aside;
  return embedding;
}

function chunk(number, text, embedding) {
  return { number, heading: "", text, location: "", page: number, embedding, embeddingModel: "test" };
}

test("searchChunks ranks by meaning and by words, within the given documents", { skip: !enabled && "set BELEIDSKOMPAS_DB_TEST=true and the BELEIDSKOMPAS_DB_* settings" }, async (t) => {
  const { Pool } = require("pg");
  const schema = `search_test_${process.pid}_${Date.now()}`;
  const admin = new Pool(connectionSettings());
  await admin.query(`CREATE SCHEMA ${schema}`);
  // public stays on the path for the pgvector types.
  const pool = new Pool({ ...connectionSettings(), options: `-c search_path=${schema},public` });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  await applyMigrations((sql, params) => pool.query(sql, params));

  const repository = createDocumentRepository(pool);
  const upload = (filename) => repository.uploadDocument({ filename, content_base64: Buffer.from(filename).toString("base64") });
  const kader = await upload("kader.txt");
  const other = await upload("other.txt");

  await repository.saveChunks(kader.id, [
    chunk(1, "De provincie verleent een subsidie aan gemeenten.", embeddingAlong(0)),
    chunk(2, "Een verordening regelt het toezicht.", embeddingAlong(0, 0.5)),
    chunk(3, "Subsidie is een financieel instrument.", embeddingAlong(1)),
    chunk(4, "Het weer in Limburg is wisselend.", embeddingAlong(2)),
  ], INDEX_VERSION);
  await repository.saveChunks(other.id, [chunk(1, "Subsidie voor laadpalen.", embeddingAlong(0))], INDEX_VERSION);

  const search = (documentIds) => repository.searchChunks({ question: "Welke subsidie past hierbij?", embedding: embeddingAlong(0), documentIds, limit: 3 });
  const found = await search([kader.id]);

  // Chunk 1 is the closest in meaning and holds the word. Chunk 2 is only
  // close in meaning, chunk 3 only holds the word, chunk 4 neither.
  assert.equal(found[0].chunk_number, 1);
  assert.deepEqual(found.slice(1).map((c) => c.chunk_number).sort(), [2, 3]);
  assert.ok(found[0].score > found[1].score);
  assert.ok(found.every((c) => c.document_id === kader.id && c.filename === "kader.txt"));
  assert.ok(found[0].similarity > 0.99);
  assert.equal(found[0].page, 1);

  assert.deepEqual(await search([]), []);
});
