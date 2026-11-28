"use strict";
// Small deterministic DOM double, using the existing parser dependency. Not a browser/a11y test.
const adminRequire = require("node:module").createRequire(require("node:path").resolve(__dirname, "../../services/admin-overlay/admin/package.json"));
const { parseDocument } = adminRequire("htmlparser2");
const escape = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
class Node {
  constructor(name, text) {
    this.localName = name; this.nodeType = name === "#text" ? 3 : 1;
    this.text = text || ""; this.childNodes = []; this.attributes = {}; this.listeners = {};
    this.value = ""; this.hidden = false; this.disabled = false; this.checked = false; this.dataset = {};
    if (name === "template") this.content = new Node("fragment");
    this.classList = { add: value => this.setAttribute("class", `${this.attributes.class || ""} ${value}`.trim()), toggle: (value, on) => {
      const all = new Set((this.attributes.class || "").split(/\s+/)); if (on) all.add(value); else all.delete(value); this.setAttribute("class", [...all].join(" "));
    } };
  }
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  get id() { return this.attributes.id; } set id(value) { this.attributes.id = value; }
  get className() { return this.attributes.class; } set className(value) { this.attributes.class = value; }
  get textContent() { return this.nodeType === 3 ? this.text : this.childNodes.map(n => n.textContent).join(""); }
  set textContent(value) { if (this.nodeType === 3) this.text = String(value); else this.replaceChildren(new Node("#text", String(value))); }
  append(...nodes) { for (let node of nodes) { if (typeof node === "string") node = new Node("#text", node); node.parentNode = this; this.childNodes.push(node); } }
  replaceChildren(...nodes) { this.childNodes = []; this.append(...nodes); }
  remove() { this.parentNode.childNodes = this.parentNode.childNodes.filter(n => n !== this); }
  setAttribute(key, value) { this.attributes[key] = String(value); if (key.startsWith("data-")) this.dataset[key.slice(5)] = value; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(event, listener) { (this.listeners[event] ||= []).push(listener); }
  dispatch(event, options = {}) { for (const listener of this.listeners[event] || []) listener({ target: this, preventDefault() {}, ...options }); }
  click() { if (!this.disabled) this.dispatch("click"); }
  focus() { this.focused = true; this.dispatch("focus"); }
  matches(selector) {
    if (selector.startsWith(".")) return (this.attributes.class || "").split(/\s+/).includes(selector.slice(1));
    if (selector.startsWith("[")) return this.getAttribute(selector.slice(1, -1)) !== null;
    if (selector === "input:checked") return this.localName === "input" && this.checked;
    return this.localName === selector;
  }
  querySelectorAll(selector) { return this.children.flatMap(n => [...(n.matches(selector) ? [n] : []), ...n.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector); }
  get innerHTML() { return (this.content || this).childNodes.map(n => n.serialize()).join(""); }
  set innerHTML(html) { (this.content || this).replaceChildren(...convert(parseDocument(html)).childNodes); }
  serialize() { return this.nodeType === 3 ? escape(this.text) : `<${this.localName}${Object.entries(this.attributes).map(([key, value]) => ` ${key}="${escape(value)}"`).join("")}>${this.innerHTML}${["br", "hr", "input", "meta", "link"].includes(this.localName) ? "" : `</${this.localName}>`}`; }
}
function convert(source) {
  const node = new Node(source.type === "text" ? "#text" : source.name || "document", source.data);
  for (const [key, value] of Object.entries(source.attribs || {})) { node.setAttribute(key, value); if (key === "hidden") node.hidden = true; if (key === "disabled") node.disabled = true; }
  for (const child of source.children || []) if (child.type !== "directive" && child.type !== "comment") node.append(convert(child));
  return node;
}
function dom(html) {
  const document = convert(parseDocument(html));
  document.body = document.querySelector("body");
  document.createElement = name => new Node(name);
  document.createTextNode = text => new Node("#text", text);
  document.getElementById = id => {
    function visit(node) { if (node.id === id) return node; for (const child of node.children) { const found = visit(child); if (found) return found; } return null; }
    return visit(document);
  };
  document.execCommand = () => true;
  return document;
}
class DOMParser {
  parseFromString(html) { const document = dom(html); if (!document.body) { document.body = new Node("body"); document.body.append(...document.childNodes); } return document; }
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
module.exports = { dom, DOMParser, settle };
