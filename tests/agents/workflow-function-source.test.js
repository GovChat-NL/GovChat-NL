'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { workflowFunctionSource } = require('../../scripts/workflow-function-source');
const root = path.resolve(__dirname, '../..');

function moduleWithEol(relative, eol) {
  const filename = path.join(root, relative);
  const fixture = new Module(filename, module);
  fixture.filename = filename;
  fixture.paths = Module._nodeModulePaths(path.dirname(filename));
  const source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n').replace(/\n/g, eol);
  fixture._compile(source, filename);
  return fixture.exports;
}

test('physical source line endings normalize while escaped literals remain exact', () => {
  const source = 'return function sample() {\n  return "\\r\\n";\n}';
  const lf = new Function(source)();
  const crlf = new Function(source.replace(/\n/g, '\r\n'))();
  assert.equal(workflowFunctionSource(lf), workflowFunctionSource(crlf));
  assert.ok(workflowFunctionSource(crlf).includes('"\\r\\n"'));
  assert.equal(lf(), '\r\n');
  assert.equal(crlf(), '\r\n');
  assert.throws(() => workflowFunctionSource('not a function'), TypeError);
});

test('statistics builders are byte-identical under LF and CRLF checkout sources', () => {
  const lf = moduleWithEol('scripts/openbesluitvorming-statistics-workflow.js', '\n');
  const crlf = moduleWithEol('scripts/openbesluitvorming-statistics-workflow.js', '\r\n');
  assert.deepEqual(lf.statisticsWorkflow(), crlf.statisticsWorkflow());
  assert.ok(!lf.statisticsWorkflow().nodes[1].parameters.jsCode.includes('\r\n'));
});

test('image identity builders keep exact authorization behavior across checkout line endings', () => {
  const lf = moduleWithEol('scripts/orchestrator-image-workflow.js', '\n');
  const crlf = moduleWithEol('scripts/orchestrator-image-workflow.js', '\r\n');
  assert.equal(lf.trustedUserExpression, crlf.trustedUserExpression);
  assert.ok(!lf.trustedUserExpression.includes('\r\n'));
  const request = { headers: { authorization: 'Bearer synthetic-token' }, body: { userId: 'synthetic-owner' } };
  assert.equal(lf.trustedImageUserId(request, 'synthetic-token'), 'synthetic-owner');
  assert.equal(crlf.trustedImageUserId(request, 'synthetic-token'), 'synthetic-owner');
  assert.throws(() => crlf.trustedImageUserId(request, 'wrong-token'));
});

test('document context builder embeds canonical code without changing workflow structure', () => {
  const doc = require('../../scripts/orchestrator-document-workflow');
  const workflow = JSON.parse(fs.readFileSync(path.join(root, 'agents/n8n/workflows/algemeen/orchestrator-litellm.json'), 'utf8'))[0];
  const actual = doc.applyDocumentContext(structuredClone(workflow));
  assert.deepEqual(actual, workflow);
  assert.ok(!actual.nodes.find(node => node.id === 'ExtractDocumentContext').parameters.jsCode.includes('\r\n'));
});
