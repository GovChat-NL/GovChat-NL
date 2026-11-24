"use strict";

/**
 * Reads the text of an uploaded document.
 *
 * extractText returns the text as blocks in reading order. A block is a
 * heading or a piece of text: `{ heading, text, location }`. `location` is
 * the page of a PDF, the slide of a presentation or the sheet of a
 * spreadsheet. The other formats do not tell where a block stands, so
 * there it is empty.
 *
 * Text and markdown files are read here. The office formats and PDF go
 * through officeparser. A scanned PDF holds pictures of pages and no text,
 * so it fails with the code "no_text".
 */

const path = require("path");
const { parseOffice } = require("officeparser");

const OFFICE_FORMATS = new Set(["pdf", "docx", "pptx", "xlsx", "odt", "odp", "ods", "rtf"]);
const TEXT_FORMATS = new Set(["txt", "md"]);

class ExtractError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// --- Text and markdown ---

// One to six # at the start of the line, a space, and then the title.
const MARKDOWN_HEADING = /^#{1,6}\s+(.*)$/;

/** Goes through the text line by line. An empty line ends a paragraph, and
 *  in markdown a heading does too. */
function blocksFromText(text, markdown) {
  const blocks = [];
  let paragraph = [];

  const endParagraph = () => {
    if (paragraph.length) blocks.push({ heading: false, text: paragraph.join("\n"), location: "" });
    paragraph = [];
  };

  for (const line of text.split("\n")) {
    const title = markdown ? MARKDOWN_HEADING.exec(line.trim()) : null;
    if (title) {
      endParagraph();
      blocks.push({ heading: true, text: title[1].trim(), location: "" });
    } else if (line.trim() === "") {
      endParagraph();
    } else {
      paragraph.push(line.trimEnd());
    }
  }
  endParagraph();

  return blocks;
}

// --- The tree officeparser returns ---

const CONTAINERS = ["page", "slide", "sheet", "table"];
const PICTURES = ["image", "chart", "drawing"];

/** The text of a node: its own, or that of its children. */
function nodeText(node, separator = " ") {
  if (typeof node.text === "string" && node.text.trim()) return node.text.trim();
  return (node.children || []).map((child) => nodeText(child, separator)).filter(Boolean).join(separator);
}

function locationOf(node, current) {
  const meta = node.metadata || {};
  if (node.type === "page" && meta.pageNumber) return `pagina ${meta.pageNumber}`;
  if (node.type === "slide" && meta.slideNumber) return `dia ${meta.slideNumber}`;
  if (node.type === "sheet" && meta.sheetName) return `werkblad ${meta.sheetName}`;
  return current;
}

/** A block per node. The row of a table is one block, so a spreadsheet
 *  keeps one block per row. */
function blocksFromNodes(nodes, location = "", blocks = []) {
  for (const node of nodes || []) {
    if (CONTAINERS.includes(node.type)) {
      blocksFromNodes(node.children, locationOf(node, location), blocks);
    } else if (!PICTURES.includes(node.type)) {
      const text = nodeText(node, node.type === "row" ? " | " : " ");
      if (text) blocks.push({ heading: node.type === "heading", text, location });
    }
  }
  return blocks;
}

// --- PDF ---
//
// A PDF stores where every character stands on the page, not words or
// paragraphs. officeparser therefore returns one block per line, and the
// text shows how the page was typeset.

/** Joins the lines that follow each other on a page into one block, a
 *  heading of several lines too. The line ends stay in the text. */
function joinLines(lines) {
  const blocks = [];
  for (const line of lines) {
    const last = blocks[blocks.length - 1];
    if (last && last.heading === line.heading && last.location === line.location) last.text += "\n" + line.text;
    else blocks.push({ ...line });
  }
  return blocks;
}

/** Puts words back together that the typesetting took apart. */
function repairWords(text) {
  return (
    text
      // "e ff ect": the font draws ff, fi and fl as one character, which comes back as a word of its own.
      .replace(/(\p{L}) (ffi|ffl|ff|fi|fl) (\p{Ll})/gu, "$1$2$3")
      // "gedetail-" at the end of a line. Before "en" or "of" the hyphen is meant: "rol- en instrumentkeuze".
      .replace(/(\p{Ll})-\n(?!(?:en|of)\b)(\p{Ll})/gu, "$1$2")
  );
}

function blocksFromPdfLines(lines) {
  return joinLines(lines).map((block) => {
    const text = repairWords(block.text);
    return { ...block, text: block.heading ? text.replace(/\n/g, " ") : text };
  });
}

// --- Any document ---

/** `document` is a row of the documents table: `{ filename, content }`,
 *  with the file in `content` as a Buffer. `deps.parseOffice` replaces
 *  officeparser in the tests. */
async function extractText(document, deps = {}) {
  const format = path.extname(String(document.filename || "")).slice(1).toLowerCase();
  let blocks;

  if (TEXT_FORMATS.has(format)) {
    const text = document.content.toString("utf8").replace(/\r\n?/g, "\n");
    blocks = blocksFromText(text, format === "md");
  } else if (OFFICE_FORMATS.has(format)) {
    const parse = deps.parseOffice || parseOffice;
    let parsed;
    try {
      parsed = await parse(document.content);
    } catch (err) {
      throw new ExtractError("unreadable", `The file could not be read: ${err.message}`);
    }
    blocks = blocksFromNodes(parsed.content);
    if (format === "pdf") blocks = blocksFromPdfLines(blocks);
  } else {
    throw new ExtractError("unsupported", `Files of type .${format || "?"} are not supported`);
  }

  if (!blocks.length) throw new ExtractError("no_text", "No text found in this document");
  return blocks;
}

module.exports = { ExtractError, extractText };
