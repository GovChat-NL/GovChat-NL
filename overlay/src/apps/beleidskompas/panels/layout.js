// The workspace layout: drag the border between two panels (or use the arrow
// keys on it) to resize them, fold the side panels in and out, and remember
// that in localStorage so the page opens the same way next time.

import { requireElement } from "../../../shared/dom.js";

const STORAGE_KEY = "gc_bk_layout";
const SIDES = ["left", "right"];
// The right minimum matches the stylesheet's minimum for the default
// (flexible) right column, so planning with it never overflows the grid.
const MIN_WIDTH = { left: 160, right: 320 };
const CHAT_MIN_WIDTH = 300;
const COLLAPSED_WIDTH = 44;
const KEY_STEP = 16;
const LABELS = { left: "de stappen", chat: "het gesprek", right: "de uitwerking" };

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
    chatCollapsed: data?.chatCollapsed === true,
  };
}

export function clampWidth(width, min, max) {
  return Math.max(min, Math.min(width, max));
}

// Fits the wanted side widths into `room` (the space beside the chat): the
// wider panel gives way first, and neither goes below its minimum.
export function fitWidths(wanted, min, room) {
  const fitted = { ...wanted };
  let excess = fitted.left + fitted.right - room;
  for (const side of wanted.left >= wanted.right ? ["left", "right"] : ["right", "left"]) {
    const cut = Math.min(Math.max(excess, 0), Math.max(fitted[side] - min[side], 0));
    fitted[side] -= cut;
    excess -= cut;
  }
  return fitted;
}

export function setupLayout() {
  const grid = requireElement("gc-bk-workspace");
  const panels = { left: requireElement("gc-bk-stepper"), chat: requireElement("gc-bk-chat"), right: requireElement("gc-bk-step-card") };
  const toggles = { left: requireElement("gc-bk-left-toggle"), chat: requireElement("gc-bk-chat-toggle"), right: requireElement("gc-bk-right-toggle") };
  // With the chat folded in, an open side panel (the right one first) takes its space.
  const fill = () => layout.chatCollapsed && (layout.rightCollapsed ? "left" : "right");
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

  // The room for both side panels while the chat keeps its minimum width.
  function room() {
    if (!grid.clientWidth) return Infinity; // hidden (overview open): nothing to measure yet
    const style = getComputedStyle(grid);
    const inner = grid.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return inner - resizers.left.offsetWidth - resizers.right.offsetWidth - CHAT_MIN_WIDTH;
  }

  // While dragging, the other panel is already at its final width.
  function maxWidth(side) {
    const other = side === "left" ? "right" : "left";
    return room() - (other === fill() ? MIN_WIDTH[other] : panels[other].offsetWidth);
  }

  function apply() {
    const collapsed = (side) => layout[`${side}Collapsed`];
    for (const side of SIDES) {
      if (collapsed(side)) grid.style.setProperty(`--gc-bk-${side}`, `${COLLAPSED_WIDTH}px`);
      else if (side === fill()) grid.style.setProperty(`--gc-bk-${side}`, "minmax(0, 1fr)");
      else if (!layout[side]) grid.style.removeProperty(`--gc-bk-${side}`);
    }
    // Planned from the wanted widths, not the ones on screen, so a panel that
    // is being unfolded counts at its full width. Without a saved width, the
    // left panel has the stylesheet's fixed width and the right one can
    // shrink to its minimum.
    const wanted = {
      left: collapsed("left") ? COLLAPSED_WIDTH : layout.left || panels.left.offsetWidth,
      right: collapsed("right") ? COLLAPSED_WIDTH : layout.right || MIN_WIDTH.right,
    };
    const min = { left: Math.min(MIN_WIDTH.left, wanted.left), right: Math.min(MIN_WIDTH.right, wanted.right) };
    const fitted = fitWidths(wanted, min, room());
    for (const side of SIDES) {
      if (!collapsed(side) && side !== fill() && layout[side]) grid.style.setProperty(`--gc-bk-${side}`, `${fitted[side]}px`);
    }
    if (layout.chatCollapsed) grid.style.setProperty("--gc-bk-chat", `${COLLAPSED_WIDTH}px`);
    else grid.style.removeProperty("--gc-bk-chat");
    for (const side of Object.keys(panels)) {
      const folded = collapsed(side);
      const label = `${folded ? "Toon" : "Verberg"} ${LABELS[side]}`;
      panels[side].classList.toggle("is-collapsed", folded);
      toggles[side].setAttribute("aria-expanded", String(!folded));
      toggles[side].setAttribute("aria-label", label);
      toggles[side].title = label;
      if (!resizers[side]) continue;
      resizers[side].classList.toggle("is-disabled", folded);
      resizers[side].tabIndex = folded ? -1 : 0;
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

  for (const side of Object.keys(toggles)) {
    toggles[side].addEventListener("click", () => {
      // At least one panel stays open: the last open one doesn't fold in.
      const open = Object.keys(toggles).filter((p) => !layout[`${p}Collapsed`]);
      if (open.length === 1 && open[0] === side) return;
      layout[`${side}Collapsed`] = !layout[`${side}Collapsed`];
      apply();
      save();
    });
  }

  for (const side of SIDES) {
    const handle = resizers[side];
    const sign = side === "left" ? 1 : -1;

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
