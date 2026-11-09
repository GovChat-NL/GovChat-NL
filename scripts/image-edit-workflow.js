'use strict';

// Self-contained functions are serialized into Code nodes, not imported at runtime.
function validatedImageSource(source, owner, publicBase, fs, path) {
  const maxBytes = 10 * 1024 * 1024;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(owner)) throw new Error('Authenticated user context is missing');
  if (typeof source !== 'string' || source.length > Math.ceil(maxBytes / 3) * 4 + 64) throw new Error('Invalid source image size');
  let bytes;
  let declared;
  if (source.startsWith('data:')) {
    const match = source.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match) throw new Error('Invalid source image encoding');
    declared = match[1];
    bytes = Buffer.from(match[2], 'base64');
    if (bytes.toString('base64') !== match[2]) throw new Error('Invalid source image encoding');
  } else {
    let imagePath = source;
    if (!source.startsWith('/images/')) {
      // Exact configured public origin and prefix only; NEVER fetch a URL.
      if (!publicBase || !/^https?:\/\//.test(publicBase)) throw new Error('External source images are not permitted');
      const base = publicBase.replace(/\/$/, '');
      if (!source.startsWith(base + '/images/')) throw new Error('External source images are not permitted');
      imagePath = source.slice(base.length);
    }
    const match = imagePath.match(/^\/images\/([A-Za-z0-9_-]{8,64})\/(generated-[A-Za-z0-9-]+\.(?:png|jpg|webp))$/);
    if (!match || match[1] !== owner) throw new Error('Source image owner or path is invalid');
    const root = '/shared-images';
    const directory = path.join(root, owner);
    for (const part of [root, directory]) {
      const stat = fs.lstatSync(part);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Source image directory is unsafe');
    }
    const file = path.join(directory, match[2]);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Source image symlink is not permitted');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size < 8 || stat.size > maxBytes) throw new Error('Invalid source image size');
      // Bounded read even if a file grows after fstat.
      bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!count) throw new Error('Source image changed during read');
        offset += count;
      }
    } finally { fs.closeSync(fd); }
  }
  if (bytes.length < 8 || bytes.length > maxBytes) throw new Error('Invalid source image size');
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  const mimeType = png ? 'image/png' : jpeg ? 'image/jpeg' : webp ? 'image/webp' : '';
  if (!mimeType || (declared && declared !== mimeType)) throw new Error('Source image format is not permitted');
  return { bytes, mimeType, extension: png ? 'png' : jpeg ? 'jpg' : 'webp' };
}

function prepareImageEdit(input, env, fs, path) {
  const operation = input.operation || 'generate';
  if (!['edit', 'generate'].includes(operation)) throw new Error('Invalid image operation');
  if (operation === 'generate') {
    if (input.sourceImage) throw new Error('Unexpected source for image generation');
    return { json: { ...input, operation } };
  }
  const model = String(input.model || '').toLowerCase();
  const gpt = /^gpt-image-/.test(model);
  const dalle2 = model === 'dall-e-2';
  if (!gpt && !dalle2) throw new Error('Configured model does not support image edits');
  const source = validatedImageSource(input.sourceImage, input.userId, String(env.PUBLIC_BASE_URL || ''), fs, path);
  if (dalle2 && source.mimeType !== 'image/png') throw new Error('DALL-E 2 edits require PNG');
  const requestBody = { ...input.requestBody };
  const editUrl = input.generateUrl.replace('/images/generations', '/images/edits');
  const { sourceImage, ...safeInput } = input;
  return {
    json: { ...safeInput, operation, editUrl, editRequestKind: (input.isAzure ? 'azure-' : '') + (gpt ? 'gpt' : 'dalle2'), editFields: Object.entries(requestBody).map(([name, value]) => ({ name, value: String(value) })) },
    binary: { source: { data: source.bytes.toString('base64'), mimeType: source.mimeType, fileName: 'source.' + source.extension } },
  };
}

function applyImageEditWorkflow(workflow) {
  const prepare = workflow.nodes.find(n => n.name === 'Prepare Image Request');
  const generate = workflow.nodes.find(n => n.name === 'Call Images API');
  const response = workflow.nodes.find(n => n.name === 'Build Image Response');
  if (!prepare || !generate || !response || !prepare.parameters.jsCode.includes('reserveUserGeneration(userId)')) throw new Error('Hardened image workflow required');
  const prepareEdges = workflow.connections[prepare.name]?.main;
  if (!Array.isArray(prepareEdges) || prepareEdges.length !== 1 || prepareEdges[0].length !== 1 ||
      !['Call Images API', 'Prepare Image Edit'].includes(prepareEdges[0][0].node)) {
    throw new Error('Unknown image prepare connections; review custom integrations before patching');
  }
  // Preserve existing output checks and modes; reject owner-directory symlinks too.
  if (!response.parameters.jsCode.includes('Image storage directory is unsafe')) {
    const marker = 'fs.chmodSync(userDirectory, 0o700);';
    if (!response.parameters.jsCode.includes(marker)) throw new Error('Unknown image response layout');
    response.parameters.jsCode = response.parameters.jsCode.replace(marker,
      "for (const directory of [root, userDirectory]) { const stat = fs.lstatSync(directory); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Image storage directory is unsafe'); }\n" + marker);
  }
  let code = prepare.parameters.jsCode;
  if (!code.includes('operation: asString(body.operation)')) {
    const marker = 'requestBody } }];';
    if (!code.includes(marker)) throw new Error('Unknown image prepare layout');
    code = code.replace(marker, 'requestBody, operation: asString(body.operation), sourceImage: asString(body.sourceImage) } }];');
    prepare.parameters.jsCode = code;
  }
  const editPrepare = { id: 'PrepareImageEdit', name: 'Prepare Image Edit', type: 'n8n-nodes-base.code', typeVersion: 2, position: [-640, 220],
    parameters: { jsCode: `${validatedImageSource.toString()}\n${prepareImageEdit.toString()}\nreturn [prepareImageEdit($json, $env, require('fs'), require('path'))];` } };
  const route = { id: 'RouteImageOperation', name: 'Route Image Operation', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [-440, 220],
    parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [
      { id: 'is-edit', leftValue: '={{ $json.operation }}', rightValue: 'edit', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, options: {} } };
  const edit = { ...structuredClone(generate), id: 'CallImageEditApi', name: 'Call Image Edits API', position: [0, 0], parameters: {
    method: 'POST', url: '={{ $json.editUrl }}', sendHeaders: true,
    headerParameters: { parameters: [
      { name: 'Authorization', value: "={{ $json.isAzureDeploymentPath ? '' : ('Bearer ' + $json.apiKey) }}" },
      { name: 'api-key', value: "={{ $json.isAzureDeploymentPath ? $json.apiKey : '' }}" } ] },
    sendBody: true, contentType: 'multipart-form-data', bodyParameters: { parameters: [
      { parameterType: 'formBinaryData', name: 'image', inputDataFieldName: 'source' },
    ] }, options: { timeout: 180000 } } };
  // Fixed collections cannot safely contain an expression-backed array in n8n.
  // Static request variants omit unsupported parameters instead of sending blanks.
  const variants = ['gpt', 'azure-gpt', 'dalle2', 'azure-dalle2'];
  const edits = variants.map((kind, index) => {
    const node = structuredClone(edit);
    if (index) { node.id += index; node.name += ' (' + kind + ')'; }
    node.position = [0, index * 160];
    const names = ['prompt', 'size', ...(kind.startsWith('azure-') ? [] : ['model']), ...(kind.endsWith('gpt') ? ['quality'] : ['response_format'])];
    node.parameters.bodyParameters.parameters.push(...names.map(name => ({ parameterType: 'formData', name, value: '={{ $json.requestBody.' + name + ' }}' })));
    return node;
  });
  const editRoute = { id: 'RouteImageEditModel', name: 'Route Image Edit Model', type: 'n8n-nodes-base.switch', typeVersion: 3.2, position: [-220, 80],
    parameters: { rules: { values: variants.map(kind => ({ conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{ id: kind, leftValue: '={{ $json.editRequestKind }}', rightValue: kind, operator: { type: 'string', operation: 'equals' } }], combinator: 'and' } })) }, options: {} } };
  for (const node of [editPrepare, route, editRoute, ...edits]) {
    const index = workflow.nodes.findIndex(n => n.name === node.name);
    if (index < 0) workflow.nodes.push(node); else workflow.nodes[index] = node;
  }
  const edge = name => ({ node: name, type: 'main', index: 0 });
  workflow.connections['Prepare Image Request'] = { main: [[edge(editPrepare.name)]] };
  workflow.connections[editPrepare.name] = { main: [[edge(route.name)]] };
  workflow.connections[route.name] = { main: [[edge(editRoute.name)], [edge(generate.name)]] };
  workflow.connections[editRoute.name] = { main: edits.map(node => [edge(node.name)]) };
  for (const node of edits) workflow.connections[node.name] = { main: [[edge(response.name)]] };
  workflow.settings = { ...workflow.settings, saveDataSuccessExecution: 'none', saveDataErrorExecution: 'none', saveManualExecutions: false, saveExecutionProgress: false };
  return workflow;
}

module.exports = { validatedImageSource, prepareImageEdit, applyImageEditWorkflow };
