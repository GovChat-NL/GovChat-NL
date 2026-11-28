export function node(tag, text, attributes = {}) {
  const element = document.createElement(tag);
  if (text !== null && text !== undefined) element.textContent = text;
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

const TAGS = new Set('P BR STRONG EM B I UL OL LI H3 H4 BLOCKQUOTE CODE PRE A HR'.split(' '));
function safeLink(href) {
  if (!href || /[\\\u0000-\u0020]/.test(href) || href.startsWith('//')) return false;
  if (href.startsWith('/') || href.startsWith('#')) return true;
  try { const url = new URL(href); return ['https:', 'http:', 'mailto:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}

// Defence in depth: even the authenticated compiler HTML is copied through an
// inert allowlist. No bootstrap/string title or snippet is inserted as HTML.
export function compiledHTML(html) {
  const template = document.createElement('template');
  template.innerHTML = String(html || '');
  const copy = source => {
    if (source.nodeType === 3) return document.createTextNode(source.textContent);
    if (source.nodeType !== 1) return document.createDocumentFragment();
    if (!TAGS.has(source.tagName)) return document.createDocumentFragment();
    const target = node(source.tagName);
    if (source.tagName === 'A' && safeLink(source.getAttribute('href'))) {
      target.setAttribute('href', source.getAttribute('href'));
      target.setAttribute('rel', 'noopener noreferrer');
    }
    for (const child of source.childNodes) target.appendChild(copy(child));
    return target;
  };
  const fragment = document.createDocumentFragment();
  for (const child of template.content.childNodes) fragment.appendChild(copy(child));
  return fragment;
}

export function articleNode(passage, heading = 'h2') {
  const article = node('article', null, { class: 'gc-manual-article', 'data-manual-passage': passage.id });
  article.append(node(heading, passage.title), compiledHTML(passage.html));
  return article;
}

export function loadManualStyles() {
  if (document.getElementById('gc-manual-style')) return;
  document.head.appendChild(node('link', null, { id: 'gc-manual-style', rel: 'stylesheet', href: new URL('./manual.css', import.meta.url).href }));
}
