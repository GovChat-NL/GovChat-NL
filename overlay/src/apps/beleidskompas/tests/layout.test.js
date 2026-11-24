// Unit tests for the saved layout in panels/layout.js. Run with `node --test`
// in this folder (or `make test-beleidskompas` from the repository root).

import test from "node:test";
import assert from "node:assert/strict";

import { clampWidth, parseLayout } from "../panels/layout.js";

const DEFAULT = { left: null, right: null, leftCollapsed: false, rightCollapsed: false };

test("nothing or something broken saved gives the default layout", () => {
  assert.deepEqual(parseLayout(null), DEFAULT);
  assert.deepEqual(parseLayout("{not json"), DEFAULT);
  assert.deepEqual(parseLayout('{"left":"wide","right":-5,"leftCollapsed":"yes"}'), DEFAULT);
});

test("a saved layout comes back as saved", () => {
  const saved = { left: 240, right: 410, leftCollapsed: true, rightCollapsed: false };
  assert.deepEqual(parseLayout(JSON.stringify(saved)), saved);
});

test("a width stays between the minimum and the room left for the chat", () => {
  assert.equal(clampWidth(100, 160, 500), 160);
  assert.equal(clampWidth(900, 160, 500), 500);
  assert.equal(clampWidth(300, 160, 500), 300);
  // A window too small for both: the minimum wins.
  assert.equal(clampWidth(300, 160, 50), 160);
});
