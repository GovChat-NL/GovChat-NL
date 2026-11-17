'use strict';

// Function.toString() retains checkout line endings. Canonicalize physical
// source line breaks before embedding code in JSON; escaped literals remain
// untouched. Tests still compare the complete workflow structure strictly.
function workflowFunctionSource(fn) {
  if (typeof fn !== 'function') throw new TypeError('Expected workflow function');
  return fn.toString().replace(/\r\n/g, '\n');
}

module.exports = { workflowFunctionSource };
