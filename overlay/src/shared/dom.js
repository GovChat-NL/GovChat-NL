// Looks up an element the page layout must have. A missing one is a mistake
// in the page's HTML, so fail right away instead of silently doing nothing
// every time the element is used.
export function requireElement(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element #${id} is missing from the page`);
  return el;
}
