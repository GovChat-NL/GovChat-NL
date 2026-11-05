import { h, icon } from "../dom.js";

// Navigation in the right pane: back/forward buttons, a clickable breadcrumb and page actions.
export function toolbar({ crumbs, canBack, canForward, onBack, onForward, actions = [] }) {
  const trail = [];
  crumbs.forEach((c, i) => {
    if (i) trail.push(h("span", { class: "crumb-sep", "aria-hidden": "true" }, "›"));
    const last = i === crumbs.length - 1;
    trail.push(
      c.route && !last
        ? h("a", { class: "crumb", href: `#/${c.route}` }, c.label)
        : h("span", { class: `crumb${last ? " is-current" : ""}` }, c.label),
    );
  });
  return [
    h(
      "div",
      { class: "nav-buttons" },
      h("button", { class: "tb-btn", disabled: !canBack, onClick: onBack, "aria-label": "Terug", title: "Terug" }, icon("chevronLeft")),
      h("button", { class: "tb-btn", disabled: !canForward, onClick: onForward, "aria-label": "Vooruit", title: "Vooruit" }, icon("chevronRight")),
    ),
    h("nav", { class: "breadcrumb", "aria-label": "Kruimelpad" }, trail),
    h("div", { class: "tb-actions" }, actions),
  ];
}
