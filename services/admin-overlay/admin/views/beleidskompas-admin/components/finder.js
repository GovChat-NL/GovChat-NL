import { h, icon } from "../dom.js";

// macOS Finder column view: folders and files on the left (the path), a wide preview on the right,
// and a path bar along the bottom.
export function finder({ folders, selectedFolder, onFolder, files, selectedFile, onFile, preview, path }) {
  const folderCol = h(
    "ul",
    { class: "finder-col finder-folders", role: "listbox", "aria-label": "Mappen" },
    folders.map((f) =>
      h(
        "li",
        {
          class: `finder-item${f.id === selectedFolder ? " is-selected" : ""}`,
          role: "option",
          tabindex: "0",
          "aria-selected": f.id === selectedFolder ? "true" : "false",
          onClick: () => onFolder(f.id),
          onKeydown: (e) => { if (e.key === "Enter") onFolder(f.id); },
        },
        icon("folder", 15),
        h("span", { class: "finder-name" }, f.label),
        h("span", { class: "finder-count" }, String(f.count)),
        icon("chevronRight", 12),
      ),
    ),
  );

  const fileCol = h(
    "ul",
    { class: "finder-col finder-files", role: "listbox", "aria-label": "Documenten" },
    files.length
      ? files.map((f) =>
          h(
            "li",
            {
              class: `finder-item${f.id === selectedFile ? " is-selected" : ""}${f.muted ? " is-muted" : ""}`,
              role: "option",
              tabindex: "0",
              "aria-selected": f.id === selectedFile ? "true" : "false",
              onClick: (e) => { if (!e.target.closest(".toggle")) onFile(f.id); },
              onKeydown: (e) => { if (e.key === "Enter") onFile(f.id); },
            },
            icon("file", 15),
            h("span", { class: "finder-name", title: f.name }, f.name),
            f.trailing || null,
          ),
        )
      : h("li", { class: "finder-empty" }, "Geen documenten in deze map"),
  );

  return h(
    "div",
    { class: "finder" },
    h("div", { class: "finder-columns" }, folderCol, fileCol, h("section", { class: "finder-preview", "aria-label": "Voorbeeld" }, preview)),
    h(
      "div",
      { class: "finder-pathbar" },
      path.map((p, i) => [i ? h("span", { class: "crumb-sep" }, "›") : null, h("span", {}, icon(i === path.length - 1 && selectedFile ? "file" : "folder", 12), p)]),
    ),
  );
}
