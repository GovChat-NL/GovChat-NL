import { h } from "../dom.js";

// Flow builder list: the fixed steps shown vertically, connected, each expandable into its editor.
export function flowList({ steps, expandedId, onToggle, renderEditor }) {
  return h(
    "ol",
    { class: "flow-list" },
    steps.map((step, idx) => {
      const open = step.id === expandedId;
      return h(
        "li",
        { class: `flow-step${open ? " is-open" : ""}` },
        // Mouse shortcut for the title button, which stays the one keyboard/screen-reader toggle.
        h("span", { class: "flow-num", "aria-hidden": "true", onClick: () => onToggle(open ? null : step.id) }, String(idx + 1)),
        h(
          "div",
          { class: "flow-card" },
          h(
            "div",
            { class: "flow-card-head" },
            h(
              "button",
              { class: "flow-title", "aria-expanded": open ? "true" : "false", onClick: () => onToggle(open ? null : step.id) },
              h("strong", {}, step.title || `Stap ${idx + 1}`),
              h("span", { class: "flow-desc" }, step.description || ""),
            ),
          ),
          open ? h("div", { class: "flow-editor" }, renderEditor(step)) : null,
        ),
      );
    }),
  );
}
