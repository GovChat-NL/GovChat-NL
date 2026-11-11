import { h, icon } from "../dom.js";

// GitHub-style selector (like the branch picker): a button that opens a filterable list.
export function templateSelector({ templates, currentId, meta, onSelect, onNew }) {
  const current = templates.find((t) => t.id === currentId) || null;
  const wrap = h("div", { class: "tpl-select" });
  const button = h(
    "button",
    { class: "tpl-button", "aria-haspopup": "listbox", "aria-expanded": "false" },
    icon("branch", 14),
    h("span", { class: "tpl-button-label" }, current ? ["Template: ", h("strong", {}, current.name), meta ? ` · ${meta}` : null] : h("strong", {}, "Kies een template")),
    icon("chevronDown", 12),
  );
  const filter = h("input", { class: "tpl-filter", type: "search", placeholder: "Zoek een template…", "aria-label": "Zoek een template" });
  const list = h("ul", { class: "tpl-list", role: "listbox" });
  const popover = h(
    "div",
    { class: "tpl-popover", hidden: true },
    h("div", { class: "tpl-popover-title" }, "Kies een template"),
    filter,
    list,
    onNew
      ? h("button", { class: "tpl-new", onClick: () => { close(); onNew(); } }, icon("plus", 14), "Nieuw template op basis van huidige…")
      : null,
  );

  const renderList = () => {
    const q = filter.value.trim().toLowerCase();
    list.replaceChildren(
      ...templates
        .filter((t) => !q || t.name.toLowerCase().includes(q))
        .map((t) =>
          h(
            "li",
            {
              role: "option",
              "aria-selected": t.id === current?.id ? "true" : "false",
              class: "tpl-option",
              tabindex: "0",
              onClick: () => { close(); if (t.id !== current?.id) onSelect?.(t.id); },
              onKeydown: (e) => { if (e.key === "Enter") e.currentTarget.click(); },
            },
            h("span", { class: "tpl-check" }, t.id === current?.id ? icon("check", 14) : null),
            h("span", { class: "tpl-name" }, t.name),
            h("span", { class: "tpl-meta" }, `${t.versions.length} versie${t.versions.length === 1 ? "" : "s"}`),
          ),
        ),
    );
  };

  const onOutside = (e) => { if (!wrap.contains(e.target)) close(); };
  function open() {
    popover.hidden = false;
    button.setAttribute("aria-expanded", "true");
    renderList();
    filter.focus();
    document.addEventListener("mousedown", onOutside);
  }
  function close() {
    popover.hidden = true;
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", onOutside);
  }
  button.addEventListener("click", () => (popover.hidden ? open() : close()));
  filter.addEventListener("input", renderList);
  popover.addEventListener("keydown", (e) => { if (e.key === "Escape") { close(); button.focus(); } });

  wrap.append(button, popover);
  return wrap;
}
