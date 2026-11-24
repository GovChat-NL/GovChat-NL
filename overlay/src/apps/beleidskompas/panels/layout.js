// The workspace layout: drag the border between two panels (or use the arrow
// keys on it) to resize them, fold the side panels in and out, and remember
// that in localStorage so the page opens the same way next time.

import { requireElement } from "../../../shared/dom.js";

const STORAGE_KEY = "gc_bk_layout";
const SIDES = ["left", "right"];
const MIN_WIDTH = { left: 160, right: 280 };
const CHAT_MIN_WIDTH = 300;
const COLLAPSED_WIDTH = 44;
const KEY_STEP = 16;
const LABELS = { left: "de stappen", right: "de uitwerking" };

// A saved layout as stored; anything missing or broken falls back to the
// default (no width = the width from the stylesheet).
export function parseLayout(raw) {
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    // Nothing or something broken saved: start from the default.
  }
  const width = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : null);
  return {
    left: width(data?.left),
    right: width(data?.right),
    leftCollapsed: data?.leftCollapsed === true,
    rightCollapsed: data?.rightCollapsed === true,
  };
}

export function clampWidth(width, min, max) {
  return Math.max(min, Math.min(width, max));
}

export function setupLayout() {
  const grid = requireElement("gc-bk-workspace");
  const panels = { left: requireElement("gc-bk-stepper"), right: requireElement("gc-bk-step-card") };
  const toggles = { left: requireElement("gc-bk-left-toggle"), right: requireElement("gc-bk-right-toggle") };
  const resizers = { left: requireElement("gc-bk-left-resizer"), right: requireElement("gc-bk-right-resizer") };

  let saved = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage blocked: the layout works, it just isn't remembered.
  }
  const layout = parseLayout(saved);
  // On a phone without a saved layout, the steps start folded in so the chat comes first.
  if (saved === null && window.matchMedia("(max-width: 768px)").matches) layout.leftCollapsed = true;

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // See above.
    }
  }

  // The widest a side panel can be while the chat keeps its minimum width.
  function maxWidth(side) {
    if (!grid.clientWidth) return Infinity; // hidden (overview open): nothing to measure yet
    const other = side === "left" ? "right" : "left";
    const style = getComputedStyle(grid);
    const inner = grid.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return inner - panels[other].offsetWidth - resizers.left.offsetWidth - resizers.right.offsetWidth - CHAT_MIN_WIDTH;
  }

  function apply() {
    // The wider panel is fitted first, so it is the one that gives way when
    // the window is too small for both saved widths.
    for (const side of [...SIDES].sort((a, b) => (layout[b] || 0) - (layout[a] || 0))) {
      const prop = `--gc-bk-${side}`;
      if (layout[`${side}Collapsed`]) grid.style.setProperty(prop, `${COLLAPSED_WIDTH}px`);
      else if (layout[side]) grid.style.setProperty(prop, `${clampWidth(layout[side], MIN_WIDTH[side], maxWidth(side))}px`);
      else grid.style.removeProperty(prop);
    }
    for (const side of SIDES) {
      const collapsed = layout[`${side}Collapsed`];
      const label = `${collapsed ? "Toon" : "Verberg"} ${LABELS[side]}`;
      panels[side].classList.toggle("is-collapsed", collapsed);
      toggles[side].setAttribute("aria-expanded", String(!collapsed));
      toggles[side].setAttribute("aria-label", label);
      toggles[side].title = label;
      resizers[side].classList.toggle("is-disabled", collapsed);
      resizers[side].tabIndex = collapsed ? -1 : 0;
      if (grid.clientWidth) {
        resizers[side].setAttribute("aria-valuenow", String(Math.round((100 * panels[side].offsetWidth) / grid.clientWidth)));
      }
    }
  }

  // Dragging the right border to the right makes the right panel narrower.
  function resize(side, width) {
    layout[side] = Math.round(clampWidth(width, MIN_WIDTH[side], maxWidth(side)));
    apply();
  }

  for (const side of SIDES) {
    const handle = resizers[side];
    const sign = side === "left" ? 1 : -1;

    toggles[side].addEventListener("click", () => {
      layout[`${side}Collapsed`] = !layout[`${side}Collapsed`];
      apply();
      save();
    });

    handle.addEventListener("pointerdown", (e) => {
      if (layout[`${side}Collapsed`] || e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = panels[side].offsetWidth;
      const move = (ev) => resize(side, startWidth + sign * (ev.clientX - startX));
      const end = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
        grid.classList.remove("is-resizing");
        save();
      };
      handle.setPointerCapture(e.pointerId);
      grid.classList.add("is-resizing");
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
    });

    handle.addEventListener("keydown", (e) => {
      const delta = { ArrowLeft: -KEY_STEP, ArrowRight: KEY_STEP }[e.key];
      if (!delta || layout[`${side}Collapsed`]) return;
      e.preventDefault();
      resize(side, panels[side].offsetWidth + sign * delta);
      save();
    });

    // A double-click puts the panel back to its default width.
    handle.addEventListener("dblclick", () => {
      layout[side] = null;
      apply();
      save();
    });
  }

  // Re-fit saved widths when the window (or the workspace, shown after the
  // overview) changes size, so the chat never gets squeezed out.
  new ResizeObserver(() => apply()).observe(grid);
  apply();
}
