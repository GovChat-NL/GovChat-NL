import { h } from "../dom.js";

// Page header (current page) with a subheader (current template), plus optional controls on the right.
export function header({ title, subtitle, controls }) {
  return h(
    "header",
    { class: "page-header" },
    h("div", {}, h("h1", {}, title), subtitle ? h("div", { class: "subheader" }, subtitle) : null),
    controls ? h("div", { class: "header-controls" }, controls) : null,
  );
}
