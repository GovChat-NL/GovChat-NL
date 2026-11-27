'use strict';
// Selective, version-checked overlay for the pinned LibreChat upload handler.
// No file/context filter, no DB access, no changes to native text or media.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const origin = 'http://govchat-upload-extractor:8000';
const routeFile = fs.existsSync(path.join(__dirname, 'document-extractor-routes.json'))
  ? path.join(__dirname, 'document-extractor-routes.json')
  : path.join(__dirname, '../services/document-extractor/routes.json');
const mimes = new Set(Object.values(JSON.parse(fs.readFileSync(routeFile, 'utf8')))
  .flatMap(route => route.mimes));
const marker = `configuredText = await parseText({ req, file, file_id, allowNativeFallback: false });
      } catch (err) {`;

function rejectFallback(file) {
  if (mimes.has(file?.mimetype?.toLowerCase())) {
    const error = new Error('Document extraction failed. Please try again later or upload a readable, smaller document.');
    error.code = 'TIKA_EXTRACTION_FAILED';
    throw error;
  }
}

function patchUploadSource(source) {
  if (source.split(marker).length !== 2 || source.includes('.rejectFallback(file);')) {
    throw new Error('Unsupported LibreChat upload handler: Tika fallback guard requires revalidation');
  }
  return source.replace(marker, marker + `
        require(${JSON.stringify(__filename)}).rejectFallback(file);`);
}

function install() {
  if (process.env.GOVCHAT_TIKA_UPLOAD_ENABLED !== 'true') return;
  if (process.env.RAG_API_URL !== origin) {
    throw new Error('Tika upload guard requires the private Tika extraction origin');
  }
  const previous = Module._extensions['.js'];
  Module._extensions['.js'] = function load(module, filename) {
    if (filename.replace(/\\/g, '/').endsWith('/api/server/services/Files/process.js')) {
      return module._compile(patchUploadSource(fs.readFileSync(filename, 'utf8')), filename);
    }
    return previous(module, filename);
  };
}

module.exports = { rejectFallback, patchUploadSource, install };
install();
