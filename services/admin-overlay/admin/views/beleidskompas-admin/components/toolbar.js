import { h } from "../dom.js";

// Top of the right pane: a clickable breadcrumb and page actions.
export function toolbar({ crumbs, actions = [] }) {
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
    h("nav", { class: "breadcrumb", "aria-label": "Kruimelpad" }, trail),
    h("div", { class: "tb-actions" }, actions),
  ];
}
