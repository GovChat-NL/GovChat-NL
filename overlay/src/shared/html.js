// Helpers to put untrusted text into HTML without it being read as markup.

export function escapeHTML(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeAttr(str) {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
