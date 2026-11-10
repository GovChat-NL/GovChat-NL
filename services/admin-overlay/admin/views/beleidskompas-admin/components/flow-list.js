import { h, icon } from "../dom.js";

// Flow builder list: the steps shown vertically, connected, each expandable into its editor.
export function flowList({ steps, expandedId, onToggle, renderEditor, onMove, onRemove, onAdd, readOnly }) {
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
            readOnly
              ? null
              : h(
                  "div",
                  { class: "flow-tools" },
                  h("button", { class: "icon-btn", title: "Omhoog", "aria-label": "Stap omhoog", disabled: idx === 0, onClick: () => onMove(idx, -1) }, icon("up", 18)),
                  h("button", { class: "icon-btn", title: "Omlaag", "aria-label": "Stap omlaag", disabled: idx === steps.length - 1, onClick: () => onMove(idx, 1) }, icon("down", 18)),
                  h("button", { class: "icon-btn is-danger", title: "Verwijderen", "aria-label": "Stap verwijderen", onClick: () => onRemove(idx) }, icon("trash", 18)),
                ),
          ),
          open ? h("div", { class: "flow-editor" }, renderEditor(step, idx)) : null,
        ),
      );
    }),
    readOnly
      ? null
      : h("li", { class: "flow-step flow-add" }, h("span", { class: "flow-num is-add", "aria-hidden": "true" }, icon("plus", 14)), h("button", { class: "btn btn-secondary", onClick: onAdd }, icon("plus", 14), "Stap toevoegen")),
  );
}
