import { h, icon } from "../dom.js";

// macOS Finder column view: files on the left, a wide preview on the right, and a path bar along the bottom.
export function finder({ files, selectedFile, onFile, preview, path }) {
  const fileCol = h(
    "ul",
    { class: "finder-col finder-files", role: "listbox", "aria-label": "Documenten" },
    files.length
      ? files.map((f) =>
          h(
            "li",
            {
              class: `finder-item${f.id === selectedFile ? " is-selected" : ""}`,
              role: "option",
              tabindex: "0",
              "aria-selected": f.id === selectedFile ? "true" : "false",
              onClick: () => onFile(f.id),
              onKeydown: (e) => { if (e.key === "Enter") onFile(f.id); },
            },
            icon("file", 15),
            h("span", { class: "finder-name", title: f.name }, f.name),
          ),
        )
      : h("li", { class: "finder-empty" }, "Nog geen documenten"),
  );

  return h(
    "div",
    { class: "finder" },
    h("div", { class: "finder-columns" }, fileCol, h("section", { class: "finder-preview", "aria-label": "Voorbeeld" }, preview)),
    h(
      "div",
      { class: "finder-pathbar" },
      path.map((p, i) => [i ? h("span", { class: "crumb-sep" }, "›") : null, h("span", {}, icon(i === path.length - 1 && selectedFile ? "file" : "folder", 12), p)]),
    ),
  );
}
