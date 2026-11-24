// Unit tests for the saved layout in panels/layout.js. Run with `node --test`
// in this folder (or `make test-beleidskompas` from the repository root).

import test from "node:test";
import assert from "node:assert/strict";

import { clampWidth, fitWidths, parseLayout } from "../panels/layout.js";

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

test("widths that don't fit: the wider panel gives way first, neither goes below its minimum", () => {
  const min = { left: 160, right: 320 };
  assert.deepEqual(fitWidths({ left: 300, right: 400 }, min, 1000), { left: 300, right: 400 });
  // Unfolding the left panel next to a wide right one: the right one shrinks.
  assert.deepEqual(fitWidths({ left: 300, right: 900 }, min, 1092), { left: 300, right: 792 });
  assert.deepEqual(fitWidths({ left: 500, right: 330 }, min, 700), { left: 370, right: 330 });
  assert.deepEqual(fitWidths({ left: 300, right: 900 }, min, 400), { left: 160, right: 320 });
  // A folded panel keeps its strip width.
  assert.deepEqual(fitWidths({ left: 44, right: 900 }, { left: 44, right: 320 }, 500), { left: 44, right: 456 });
});
