"use strict";

/**
 * Cuts the text of a document into chunks: the pieces that are searched
 * and that an agent gets to read.
 *
 * chunkBlocks takes the blocks of extract.js and returns chunks:
 * `{ number, heading, text, location, page }`. A heading starts a new chunk
 * and stays with the text below it. Text below the same heading is put
 * together until a chunk is full. `location` and `page` say where the chunk
 * starts.
 */

// About 250 words. A longer chunk is about more than one thing, a shorter
// one says too little on its own.
const MAX_CHUNK_LENGTH = 1500;

// Where a piece of text may be cut, the best place first: the end of a
// sentence, the end of a line (a list or a table has no sentences), a space.
const CUT_AFTER = [/[.!?]\s/g, /\n/g, /\s/g];

/** The place to cut `text` so the first part is at most `maxLength` long. */
function cutPlace(text, maxLength) {
  const start = text.slice(0, maxLength);
  for (const boundary of CUT_AFTER) {
    const ends = [...start.matchAll(boundary)].map((match) => match.index + match[0].length);
    if (ends.length) return ends[ends.length - 1];
  }
  return maxLength;
}

/** `text` in parts of at most `maxLength`. */
function splitText(text, maxLength) {
  const parts = [];
  let rest = text;
  while (rest.length > maxLength) {
    const place = cutPlace(rest, maxLength);
    parts.push(rest.slice(0, place).trimEnd());
    rest = rest.slice(place).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

function chunkBlocks(blocks, maxLength = MAX_CHUNK_LENGTH) {
  const chunks = [];
  let heading = "";
  let chunk = null;

  const endChunk = () => {
    if (chunk) chunks.push({ number: chunks.length + 1, ...chunk });
    chunk = null;
  };

  for (const block of blocks) {
    if (block.heading) {
      endChunk();
      heading = block.text;
      continue;
    }
    for (const part of splitText(block.text, maxLength)) {
      const fits = chunk && chunk.text.length + 1 + part.length <= maxLength;
      if (fits) {
        chunk.text += "\n" + part;
      } else {
        endChunk();
        chunk = { heading, text: part, location: block.location, page: block.page };
      }
    }
  }
  endChunk();

  return chunks;
}

module.exports = { MAX_CHUNK_LENGTH, chunkBlocks };
