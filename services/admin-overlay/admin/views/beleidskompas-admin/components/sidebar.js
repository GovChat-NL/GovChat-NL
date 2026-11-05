import { h, icon } from "../dom.js";

// Left pane: macOS sidebar with the admin pages and links to the other GovChat editors.
const PAGES = [
  { route: "general", label: "Algemeen", icon: "gear" },
  { route: "editor", label: "Editor", icon: "pencil" },
  { route: "editor/documents", label: "Documentenbibliotheek", icon: "folder", child: true },
  { route: "editor/flow", label: "Flow builder", icon: "flow", child: true },
  { route: "feedback", label: "Feedback", icon: "chat" },
];

const OTHER_EDITORS = [
  { href: "/dashboard", label: "Dashboard", icon: "home" },
  { href: "/help-editor", label: "Handleiding", icon: "book" },
  { href: "/apps-editor", label: "Apps", icon: "grid" },
  { href: "/crawler-editor", label: "Crawler", icon: "globe" },
  { href: "/orchestrator-editor", label: "Orchestrator", icon: "cpu" },
];

export function sidebar(currentRoute) {
  const item = (p) =>
    h(
      "a",
      {
        href: `#/${p.route}`,
        class: `side-item${p.child ? " is-child" : ""}${p.route === currentRoute ? " is-active" : ""}`,
        "aria-current": p.route === currentRoute ? "page" : undefined,
      },
      icon(p.icon),
      h("span", {}, p.label),
    );
  const link = (l) => h("a", { href: l.href, class: "side-item" }, icon(l.icon), h("span", {}, l.label));

  return [
    h("div", { class: "traffic", "aria-hidden": "true" }, h("span"), h("span"), h("span")),
    h("div", { class: "side-title" }, "Beleidskompas"),
    h("nav", { class: "side-group", "aria-label": "Beleidskompas" }, PAGES.map(item)),
    h("div", { class: "side-heading" }, "GovChat-beheer"),
    h("nav", { class: "side-group", "aria-label": "GovChat-beheer" }, OTHER_EDITORS.map(link)),
    h("div", { class: "side-spacer" }),
    h("a", { href: "/logout", class: "side-item" }, icon("logout"), h("span", {}, "Uitloggen")),
  ];
}
