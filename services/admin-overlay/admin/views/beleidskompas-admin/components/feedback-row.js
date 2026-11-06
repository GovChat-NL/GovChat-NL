import { h, icon, formatDate } from "../dom.js";

// One step's feedback: a header with the counters (👍, 👎, comments) and a row per reaction.
export function feedbackGroup({ title, items, describeVersion }) {
  const up = items.filter((i) => i.rating === "up").length;
  const comments = items.filter((i) => i.comment).length;
  return h(
    "details",
    { class: "fb-group", open: true },
    h(
      "summary",
      { class: "fb-group-head" },
      h("span", { class: "fb-group-title" }, title),
      counter("thumbUp", up, "positief"),
      counter("thumbDown", items.length - up, "negatief"),
      counter("chat", comments, "opmerkingen"),
    ),
    items.map((item) => feedbackRow(item, describeVersion(item))),
  );
}

function counter(iconName, n, label) {
  return h("span", { class: `fb-counter fb-${iconName}`, title: `${n} ${label}` }, icon(iconName, 14), String(n));
}

function feedbackRow(item, versionLabel) {
  const up = item.rating === "up";
  return h(
    "article",
    { class: "fb-row" },
    h("span", { class: `fb-reaction ${up ? "is-up" : "is-down"}`, title: up ? "Positief" : "Negatief" }, icon(up ? "thumbUp" : "thumbDown", 16)),
    h(
      "div",
      { class: "fb-main" },
      h("div", { class: "fb-meta" }, h("time", { datetime: item.created_at }, formatDate(item.created_at)), h("span", { class: "fb-version" }, versionLabel)),
      item.comment ? h("p", { class: "fb-comment" }, item.comment) : h("p", { class: "fb-comment is-empty" }, "Geen opmerking"),
      h("details", { class: "fb-answer" }, h("summary", {}, "Antwoord waarop gereageerd is"), h("p", {}, item.answer_text || "—")),
    ),
  );
}
