"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createBeleidskompasHandlers } = require("../lib/beleidskompas/routes");
const { StoreError } = require("../lib/beleidskompas/store");
const { readChatDocument } = require("../lib/beleidskompas/chat-documents");
const adminRoutes = require("../lib/beleidskompas/admin-routes");

/** A store that records what it was asked and answers what the test says. */
function fakeStore(answers = {}) {
  const calls = [];
  const make = (name) => async (args) => {
    calls.push({ name, args });
    const answer = answers[name];
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer(args) : answer;
  };
  return { calls, listCases: make("listCases"), getState: make("getState"), setCaseText: make("setCaseText"), setTitle: make("setTitle"), addReport: make("addReport"), addTurn: make("addTurn"), addDocument: make("addDocument"), removeDocument: make("removeDocument") };
}

const TOKEN = "store-secret";
const withToken = (req) => ({ headers: { authorization: `Bearer ${TOKEN}` }, params: {}, query: {}, body: {}, ...req });

test("every endpoint needs the store token, as bearer or in x-govchat-token", async () => {
  const handlers = createBeleidskompasHandlers({ store: fakeStore({ listCases: [] }), internalToken: TOKEN });
  assert.equal((await handlers.listCases({ headers: {}, query: { user_id: "u" } })).status, 401);
  assert.equal((await handlers.listCases({ headers: { authorization: "Bearer wrong" }, query: { user_id: "u" } })).status, 401);
  assert.equal((await handlers.listCases({ headers: { "x-govchat-token": TOKEN }, query: { user_id: "u" } })).status, 200);
  assert.equal((await handlers.listCases(withToken({ query: { user_id: "u" } }))).status, 200);
});

test("without a store or a token the endpoints answer 503, not 401", async () => {
  const noStore = createBeleidskompasHandlers({ store: null, internalToken: TOKEN });
  assert.equal((await noStore.listCases(withToken({}))).status, 503);
  const noToken = createBeleidskompasHandlers({ store: fakeStore(), internalToken: "" });
  assert.equal((await noToken.listCases(withToken({}))).status, 503);
});

test("the live template needs the token but no store", async () => {
  const getLive = async () => ({ version_id: "1", flow: { title: "T" }, settings: { default_model: "m" } });
  const handlers = createBeleidskompasHandlers({ store: null, internalToken: TOKEN, getLive });
  assert.equal((await handlers.live({ headers: {} })).status, 401);
  assert.deepEqual(await handlers.live(withToken({})), { status: 200, body: await getLive() });
  assert.equal((await createBeleidskompasHandlers({ store: null, internalToken: "", getLive }).live(withToken({}))).status, 503);
});

test("getCase passes the case, the user from the query and the turn limit to the store, and answers an empty state for an unknown case", async () => {
  const store = fakeStore({ getState: (args) => (args.caseId === "conv-1" ? { id: "conv-1", reports: {} } : null) });
  const handlers = createBeleidskompasHandlers({ store, internalToken: TOKEN });
  const found = await handlers.getCase(withToken({ params: { id: "conv-1" }, query: { user_id: "user-a", max_turns: "20" } }));
  assert.deepEqual(found, { status: 200, body: { id: "conv-1", reports: {} } });
  assert.deepEqual(store.calls[0], { name: "getState", args: { caseId: "conv-1", userId: "user-a", maxTurns: "20" } });
  const missing = await handlers.getCase(withToken({ params: { id: "conv-9" }, query: { user_id: "user-a" } }));
  assert.deepEqual(missing, { status: 200, body: { id: "conv-9", case_text: null, reports: {}, turns: [] } });
});

test("the writes take the user and the fields from the body", async () => {
  const store = fakeStore({ setCaseText: { version: 1, unchanged: false }, addReport: { version: 2 }, addTurn: { seq: 3 }, setTitle: undefined });
  const handlers = createBeleidskompasHandlers({ store, internalToken: TOKEN });

  assert.deepEqual(await handlers.setText(withToken({ params: { id: "conv-1" }, body: { user_id: "user-a", text: "De casus." } })), { status: 200, body: { version: 1, unchanged: false } });
  assert.deepEqual(store.calls[0].args, { caseId: "conv-1", userId: "user-a", text: "De casus." });

  const report = await handlers.addReport(withToken({ params: { id: "conv-1" }, body: { user_id: "user-a", substep_id: "1.1", text: "Rapport", citations: [{ id: "d" }], retrieval_trace: { x: 1 } } }));
  assert.deepEqual(report, { status: 200, body: { version: 2 } });
  assert.deepEqual(store.calls[1].args, { caseId: "conv-1", userId: "user-a", substepId: "1.1", text: "Rapport", citations: [{ id: "d" }], retrievalTrace: { x: 1 } });

  const turn = await handlers.addTurn(withToken({ params: { id: "conv-1" }, body: { user_id: "user-a", role: "assistant", step_id: "stap3", asked_from: "1.1", text: "Antwoord" } }));
  assert.deepEqual(turn, { status: 200, body: { seq: 3 } });
  assert.deepEqual(store.calls[2].args, { caseId: "conv-1", userId: "user-a", role: "assistant", stepId: "stap3", askedFrom: "1.1", text: "Antwoord" });

  assert.deepEqual(await handlers.setTitle(withToken({ params: { id: "conv-1" }, body: { user_id: "user-a", title: "Laadpalen" } })), { status: 200, body: { ok: true } });
});

test("a StoreError becomes its status, any other error a 500 without details", async () => {
  const handlers = createBeleidskompasHandlers({
    store: fakeStore({ addReport: new StoreError(400, "report text is required"), addTurn: new Error("connection refused: secret host") }),
    internalToken: TOKEN,
  });
  assert.deepEqual(await handlers.addReport(withToken({ params: { id: "conv-1" }, body: { user_id: "u" } })), { status: 400, body: { error: "report text is required" } });
  const original = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await handlers.addTurn(withToken({ params: { id: "conv-1" }, body: { user_id: "u", role: "user", text: "x" } })), { status: 500, body: { error: "Beleidskompas store error" } });
  } finally {
    console.error = original;
  }
});

test("the page's endpoints take the user from the LibreChat login, never from the request", async () => {
  const store = fakeStore({ listCases: [{ id: "conv-1" }], getState: (args) => (args.userId === "user-a" && args.caseId === "conv-1" ? { id: "conv-1" } : null) });
  const resolveUser = (req) => (req.cookies && req.cookies.refreshToken === "good" ? { id: "user-a" } : null);
  const handlers = createBeleidskompasHandlers({ store, internalToken: TOKEN, resolveUser });

  // Not logged in: 401, also with a user_id in the query and a store token.
  assert.equal((await handlers.myCases({ headers: { authorization: `Bearer ${TOKEN}` }, query: { user_id: "user-a" }, cookies: {} })).status, 401);

  const logged = { headers: {}, cookies: { refreshToken: "good" }, query: { user_id: "user-b" }, params: {} };
  assert.deepEqual(await handlers.myCases(logged), { status: 200, body: [{ id: "conv-1" }] });
  assert.equal(store.calls[0].args.userId, "user-a", "the user comes from the login, not from the query");

  assert.deepEqual(await handlers.myCase({ ...logged, params: { id: "conv-1" } }), { status: 200, body: { id: "conv-1", documents: [] } });
  assert.deepEqual(await handlers.myCase({ ...logged, params: { id: "conv-9" } }), { status: 404, body: { error: "Unknown case" } });
});

test("the page's endpoints answer 503 without a store", async () => {
  const handlers = createBeleidskompasHandlers({ store: null, internalToken: TOKEN, resolveUser: () => ({ id: "user-a" }) });
  assert.equal((await handlers.myCases({ headers: {}, cookies: {} })).status, 503);
});

test("an upload is checked against the settings, read and stored for the logged-in user; the page gets the documents without their text", async () => {
  const store = fakeStore({ addDocument: (args) => ({ id: "8", filename: args.filename }), removeDocument: { ok: true }, getState: { id: "conv-1", documents: [{ id: "8", filename: "nota.txt", size: 4, text: "Kort" }] } });
  const getLive = async () => ({ settings: { upload_max_mb: 1, upload_allowed_types: ["txt", "md"] } });
  const resolveUser = (req) => (req.cookies && req.cookies.refreshToken === "good" ? { id: "user-a" } : null);
  const handlers = createBeleidskompasHandlers({ store, internalToken: TOKEN, resolveUser, getLive });
  const upload = (body, cookies = { refreshToken: "good" }) => handlers.addMyDocument({ headers: {}, cookies, params: { id: "conv-1" }, query: {}, body });
  const base64 = (text) => Buffer.from(text).toString("base64");

  assert.deepEqual(await upload({ filename: "nota.txt", mime: "text/plain", content_base64: base64("Eerste alinea.\n\nTweede.") }), { status: 200, body: { id: "8", filename: "nota.txt" } });
  assert.deepEqual(store.calls[0].args, { caseId: "conv-1", userId: "user-a", mime: "text/plain", filename: "nota.txt", size: 23, text: "Eerste alinea.\n\nTweede." });

  assert.equal((await upload({ filename: "nota.txt", content_base64: base64("x") }, {})).status, 401);
  assert.equal((await upload({ filename: "nota.pdf", content_base64: base64("x") })).status, 415, "pdf is supported but not allowed here");
  assert.equal((await upload({ filename: "groot.txt", content_base64: Buffer.alloc(1024 * 1024 + 1, 97).toString("base64") })).status, 413);
  const empty = await upload({ filename: "leeg.md", content_base64: base64("\n\n") });
  assert.equal(empty.status, 422);
  assert.match(empty.body.error, /geen leesbare tekst/);
  assert.equal(store.calls.length, 1, "a refused file is not stored");

  assert.deepEqual((await handlers.myCase({ headers: {}, cookies: { refreshToken: "good" }, params: { id: "conv-1" }, query: {} })).body.documents, [{ id: "8", filename: "nota.txt", size: 4 }]);
  assert.equal((await handlers.removeMyDocument({ headers: {}, cookies: { refreshToken: "good" }, params: { id: "conv-1", documentId: "8" } })).status, 200);
  assert.deepEqual(store.calls.at(-1), { name: "removeDocument", args: { caseId: "conv-1", userId: "user-a", documentId: "8" } });
});

test("a file the parser cannot read is a 422, and NUL characters never reach the database", async () => {
  const pdf = { filename: "kapot.pdf", content_base64: Buffer.from("x").toString("base64") };
  const failing = { parseOffice: async () => { throw new Error("bad xref"); } };
  await assert.rejects(readChatDocument(pdf, {}, failing), (err) => err.status === 422 && err.message === "Dit document kan niet worden gelezen.");
  const doc = await readChatDocument({ filename: "utf16.txt", content_base64: Buffer.from("H\u0000o\u0000i\u0000", "utf8").toString("base64") });
  assert.equal(doc.text, "Hoi");
});

test("the upload settings are checked before they are saved, and saving them republishes the public config", async () => {
  const routes = {};
  const app = { get() {}, patch() {}, delete() {}, post: (path, _auth, handler) => (routes[path] = handler) };
  const saved = [];
  let republished = 0;
  const store = { saveSettings: async (s) => (saved.push(s), s) };
  adminRoutes.mount(app, { requireAuth: null, getStore: () => store, normalizeFlow: (f) => f, defaultFlow: () => ({}), publishLive: null, republish: async () => republished++ });
  const save = async (body) => {
    let status = 200;
    let json = null;
    const res = { status: (code) => ((status = code), res), json: (data) => ((json = data), res) };
    await routes["/api/beleidskompas/settings"]({ body }, res);
    return { status, json };
  };

  assert.equal((await save({ upload_max_mb: 5, upload_allowed_types: " PDF, .docx,pdf " })).status, 200);
  assert.deepEqual(saved[0], { upload_max_mb: 5, upload_allowed_types: ["pdf", "docx"] });
  assert.equal(republished, 1);
  for (const body of [{ upload_max_mb: 15 }, { upload_max_mb: 2.5 }, { upload_allowed_types: "exe" }, { upload_allowed_types: [] }]) {
    assert.equal((await save(body)).status, 400, JSON.stringify(body));
  }
  assert.equal(saved.length, 1, "a refused setting is not saved");
});
