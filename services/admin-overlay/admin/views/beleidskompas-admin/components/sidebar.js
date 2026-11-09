import { h, icon } from "../dom.js";

// Left pane: sidebar with the Beleidskompas admin pages and a way back to the GovChat dashboard.
const PAGES = [
  { route: "general", label: "Algemeen", icon: "gear" },
  { route: "editor", label: "Editor", icon: "pencil" },
  { route: "editor/documents", label: "Documentenbibliotheek", icon: "folder", child: true, gated: true },
  { route: "editor/flow", label: "Flow builder", icon: "flow", child: true, gated: true },
  { route: "editor/deploy", label: "Deploy", icon: "upload", child: true },
  { route: "feedback", label: "Feedback", icon: "chat" },
];

// locked: no template selected yet, so the gated pages are shown but not clickable.
export function sidebar(currentRoute, { locked = false } = {}) {
  const item = (p) =>
    p.gated && locked
      ? h("span", { class: "side-item is-child is-disabled", "aria-disabled": "true", title: "Kies eerst een template in de Editor" }, icon(p.icon), h("span", {}, p.label))
      : h(
      "a",
      {
        href: `#/${p.route}`,
        class: `side-item${p.child ? " is-child" : ""}${p.route === currentRoute ? " is-active" : ""}`,
        "aria-current": p.route === currentRoute ? "page" : undefined,
      },
      icon(p.icon),
      h("span", {}, p.label),
    );

  return [
    h("div", { class: "side-title" }, "Beleidskompas"),
    h("nav", { class: "side-group", "aria-label": "Beleidskompas" }, PAGES.map(item)),
    h("hr", { class: "side-sep" }),
    h("a", { href: "/dashboard", class: "side-item" }, icon("home"), h("span", {}, "Terug naar dashboard")),
  ];
}
