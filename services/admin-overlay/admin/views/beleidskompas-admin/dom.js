// Tiny DOM helpers: h() builds elements, icon() returns an inline SVG.

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "value") el.value = value;
    else if (key === "checked") el.checked = Boolean(value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

const ICONS = {
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z",
  pencil: "M12 20h9 M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
  flow: "M6 3v12 M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M18 9a9 9 0 0 1-9 9",
  chat: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z",
  home: "M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z M14 2v6h6",
  chevronDown: "M6 9l6 6 6-6",
  check: "M20 6 9 17l-5-5",
  plus: "M12 5v14 M5 12h14",
  trash: "M3 6h18 M8 6V4h8v2 M19 6l-1 14H6L5 6",
  up: "M12 19V5 M5 12l7-7 7 7",
  down: "M12 5v14 M19 12l-7 7-7-7",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3",
  upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M17 8l-5-5-5 5 M12 3v12",
  thumbUp: "M7 10v12 M15 5.9 14 10h5.8a2 2 0 0 1 2 2.3l-1.4 8A2 2 0 0 1 18.4 22H7V10l4-8a3 3 0 0 1 4 3.9Z",
  thumbDown: "M17 14V2 M9 18.1 10 14H4.2a2 2 0 0 1-2-2.3l1.4-8A2 2 0 0 1 5.6 2H17v12l-4 8a3 3 0 0 1-4-3.9Z",
  branch: "M6 3v12 M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M15 6H9a3 3 0 0 0-3 3",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z M12 16v-4 M12 8h.01",
};

export function icon(name, size = 16) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", ICONS[name] || "");
  svg.append(path);
  return svg;
}

// Reveal rule: after a click shows new content, scroll the content pane just enough to show it,
// but never past its top, so its header (with the button that was clicked) stays visible.
// Nothing moves when it is already in view. Honours the OS "reduce motion" setting.
export function reveal(el, margin = 12) {
  const pane = document.getElementById("body");
  if (!el || !pane) return;
  const p = pane.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const toTop = r.top - p.top - margin;
  const by = toTop < 0 ? toTop : Math.max(0, Math.min(r.bottom - p.bottom + margin, toTop));
  if (!by) return;
  const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  pane.scrollBy({ top: by, behavior: smooth ? "smooth" : "auto" });
}

export function formatDate(iso, withTime = true) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const opts = withTime
    ? { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }
    : { day: "numeric", month: "short", year: "numeric" };
  return d.toLocaleString("nl-NL", opts);
}

export function formatBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

export const card = (title, ...children) =>
  h("section", { class: "card" }, title ? h("h2", { class: "card-title" }, title) : null, ...children);

// A div, not a <label>: some controls (chip lists) contain buttons a label would trigger.
export function field(label, control, hint) {
  if (control.matches?.("input, textarea, select") && !control.hasAttribute("aria-label")) control.setAttribute("aria-label", label);
  return h("div", { class: "field" }, h("span", { class: "field-label" }, label), control, hint ? h("span", { class: "field-hint" }, hint) : null);
}

// Text input or textarea bound to obj[key]; calls onInput after each change.
export function bound(obj, key, { multiline = false, rows = 3, type = "text", onInput } = {}) {
  const el = multiline
    ? h("textarea", { class: "input", rows })
    : h("input", { class: "input", type, step: type === "number" ? "any" : undefined });
  el.value = obj[key] ?? "";
  el.addEventListener("input", () => {
    obj[key] = type === "number" ? Number(el.value) : el.value;
    onInput?.();
  });
  return el;
}

// Small modal asking for one line of text. Resolves to the text, or null when cancelled.
// value prefills the input, with the cursor at the start.
export function askText({ title, label, placeholder = "", value = "", confirm = "OK", required = false }) {
  return new Promise((resolve) => {
    const input = h("input", { class: "input", type: "text", placeholder, "aria-label": label, required });
    input.value = value;
    const dialog = h(
      "dialog",
      { class: "dialog" },
      h(
        "form",
        { method: "dialog" },
        h("h2", {}, title),
        h("label", { class: "field" }, h("span", { class: "field-label" }, label), input),
        h(
          "div",
          { class: "dialog-actions" },
          // type "button": Enter submits with the first submit button, which must be the confirm button.
          h("button", { class: "btn btn-secondary", type: "button", onClick: () => dialog.close("cancel") }, "Annuleren"),
          h("button", { class: "btn btn-primary", value: "ok" }, confirm),
        ),
      ),
    );
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "ok" ? input.value.trim() : null);
      dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
    input.setSelectionRange(0, 0);
  });
}

export function toast(message, kind = "info") {
  const box = document.getElementById("toasts");
  const el = h("div", { class: `toast toast-${kind}`, role: "status" }, message);
  box.append(el);
  setTimeout(() => el.remove(), 4000);
}
