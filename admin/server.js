// Local admin panel for the settings in this repo. It reads and writes the YAML files
// in deploy/ and apps/ in place, comments included, and shows what to do in the cluster.
// Every save is a Git commit. It never pushes, never talks to the cluster and never sees
// a secret.
//
//   cd admin && npm install && npm start      then open http://localhost:4000
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const YAML = require('yaml');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 4000;

const FLEET = 'deploy/fleet.yaml';
const CORE = 'deploy/values.yaml';
const ORG = 'deploy/values-gemeente.yaml';
const ENV = ['librechat', 'configEnv'];
const ENV_SECRET = 'librechat-credentials-env';

// ---- files --------------------------------------------------------------------------

const abs = (file) => path.join(ROOT, file);
const read = (file) => YAML.parseDocument(fs.readFileSync(abs(file), 'utf8'));
const write = (file, doc) => fs.writeFileSync(abs(file), doc.toString({ lineWidth: 0 }));

// Sets a text value. A new key is written with quotes, like the keys around it.
function setText(doc, at, value) {
  const node = doc.getIn(at, true);
  if (YAML.isScalar(node)) node.value = value;
  else doc.setIn(at, Object.assign(new YAML.Scalar(value), { type: 'QUOTE_DOUBLE' }));
}

class Invalid extends Error {}
const check = (ok, message) => { if (!ok) throw new Invalid(message); };

// ---- organisation -------------------------------------------------------------------

// `env` fields are a key under librechat.configEnv; the others have their own place.
const ORG_FIELDS = [
  { key: 'address', label: 'Web address', hint: 'Where employees open GovChat. Also sets the host of the ingress.' },
  { key: 'ingressClass', label: 'Ingress class', hint: 'For example nginx or haproxy. Empty uses the cluster default.', optional: true },
  { key: 'tlsSecret', label: 'TLS Secret', hint: 'The Secret with the certificate, made by cert-manager or by you.' },
  { key: 'OPENID_ISSUER', env: true, label: 'OpenID issuer', hint: 'For Entra ID: https://login.microsoftonline.com/<tenant ID>/v2.0/' },
  { key: 'OPENID_CLIENT_ID', env: true, label: 'OpenID client ID', hint: 'The application (client) ID of the app registration.' },
  { key: 'AZURE_INSTANCE_NAME', env: true, label: 'Azure resource name', hint: 'The name of the Azure AI Foundry / Azure OpenAI resource.' },
  { key: 'AZURE_DEPLOYMENT_NAME', env: true, label: 'Azure deployment name', hint: 'The name of the model deployment.' },
  { key: 'AZURE_API_VERSION', env: true, label: 'Azure API version', hint: 'For example 2024-10-21.' },
  { key: 'AZURE_BASE_URL', env: true, label: 'Azure base URL', hint: 'Ends in /openai/deployments/<deployment name>.' },
];
const ORG_PATHS = {
  address: [...ENV, 'DOMAIN_CLIENT'],
  ingressClass: ['ingress', 'className'],
  tlsSecret: ['ingress', 'tls', 0, 'secretName'],
};
const orgPath = (field) => (field.env ? [...ENV, field.key] : ORG_PATHS[field.key]);
const isExample = (value) => /example|00000000-0000/.test(value);

function getOrg(org) {
  return ORG_FIELDS.map((field) => {
    const value = String(org.getIn(orgPath(field)) ?? '');
    return { ...field, value, todo: field.optional ? false : !value || isExample(value) };
  });
}

function saveOrg(input) {
  const org = read(ORG);
  for (const field of ORG_FIELDS) {
    const value = String(input[field.key] ?? '').trim();
    check(value || field.optional, `${field.label} is empty.`);
    setText(org, orgPath(field), value);
  }
  let url;
  try { url = new URL(input.address.trim()); } catch { throw new Invalid('Web address is not a URL, for example https://govchat.example.nl'); }
  check(/^https?:$/.test(url.protocol) && url.pathname === '/', 'Web address must look like https://govchat.example.nl, without a path.');
  for (const key of ['DOMAIN_CLIENT', 'DOMAIN_SERVER']) setText(org, [...ENV, key], url.origin);
  // The ingress block is optional; only keep in step what is there.
  for (const hostPath of [['ingress', 'hosts', 0, 'host'], ['ingress', 'tls', 0, 'hosts', 0]]) {
    if (org.hasIn(hostPath)) setText(org, hostPath, url.hostname);
  }
  write(ORG, org);
  return [ORG];
}

// ---- branding -----------------------------------------------------------------------

const BRAND_DIR = 'deploy/branding';
const BRAND_MAX = 250000; // the same limit as scripts/make-branding.sh
const BRAND_FILES = [
  { name: 'logo.svg', label: 'Logo', type: 'image/svg+xml' },
  { name: 'favicon-16x16.png', label: 'Favicon 16 px', type: 'image/png', px: 16 },
  { name: 'favicon-32x32.png', label: 'Favicon 32 px', type: 'image/png', px: 32 },
  { name: 'apple-touch-icon-180x180.png', label: 'Apple touch icon', type: 'image/png', px: 180 },
];
const TEXTS = [
  { key: 'APP_TITLE', label: 'Name', hint: 'Shown in the browser tab and on the login page.' },
  { key: 'CUSTOM_FOOTER', label: 'Footer', hint: 'The line under the chat box.' },
  { key: 'OPENID_BUTTON_LABEL', label: 'Login button', hint: 'The text on the login button.' },
];
const brandPath = (name) => abs(path.join(BRAND_DIR, name));

function getBranding(core, org) {
  const files = BRAND_FILES.map((file) => ({ ...file, bytes: fs.statSync(brandPath(file.name)).size }));
  return {
    texts: TEXTS.map((text) => ({ ...text, value: org.getIn([...ENV, text.key]) ?? core.getIn([...ENV, text.key]) ?? '' })),
    files,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    max: BRAND_MAX,
  };
}

// The texts go into the organisation's file, and only when they differ from the core.
function saveTexts(input) {
  const core = read(CORE);
  const org = read(ORG);
  for (const { key, label } of TEXTS) {
    const value = String(input[key] ?? '').trim();
    check(value, `${label} is empty.`);
    if (value === core.getIn([...ENV, key])) org.deleteIn([...ENV, key]);
    else setText(org, [...ENV, key], value);
  }
  write(ORG, org);
  return [ORG];
}

function saveBrandFile({ name, data }) {
  const file = BRAND_FILES.find((f) => f.name === name);
  check(file, 'Unknown file.');
  const bytes = Buffer.from(String(data), 'base64');
  if (file.px) {
    const isPng = bytes.length > 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    check(isPng, `${file.label} must be a PNG file.`);
    const [width, height] = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
    check(width === file.px && height === file.px, `${file.label} must be ${file.px} × ${file.px} px; this file is ${width} × ${height}.`);
  } else {
    check(bytes.includes('<svg'), `${file.label} must be an SVG file.`);
  }
  const others = BRAND_FILES.filter((f) => f !== file).reduce((sum, f) => sum + fs.statSync(brandPath(f.name)).size, 0);
  check(others + bytes.length <= BRAND_MAX,
    `Too large: the four files would be ${Math.ceil((others + bytes.length) / 1000)} kB together; the limit is ${BRAND_MAX / 1000} kB.`);
  fs.writeFileSync(brandPath(name), bytes);
  execFileSync('sh', ['scripts/make-branding.sh'], { cwd: ROOT, stdio: 'pipe' });
  return [`${BRAND_DIR}/${name}`, 'deploy/values-branding.yaml'];
}

// ---- apps ---------------------------------------------------------------------------

// An app is a folder apps/<name>/ with app.yaml (read here) and deploy/ (rolled out).
// Switching it on or off changes librechat.yaml, which lives inside deploy/values.yaml.
function catalog() {
  if (!fs.existsSync(abs('apps'))) return [];
  return fs.readdirSync(abs('apps')).sort()
    .filter((name) => fs.existsSync(abs(`apps/${name}/app.yaml`)))
    .map((name) => {
      const app = YAML.parse(fs.readFileSync(abs(`apps/${name}/app.yaml`), 'utf8'));
      const dir = `apps/${name}/deploy`;
      const manifests = fs.readdirSync(abs(dir)).filter((f) => /\.ya?ml$/.test(f) && f !== 'fleet.yaml').sort().map((f) => `${dir}/${f}`);
      return { name, dir, manifests, title: app.title, description: app.description, url: app.mcp.url, token: app.mcp.token };
    });
}

const librechatYaml = (core) => YAML.parseDocument(core.getIn(['librechat', 'configYamlContent']));
const items = (doc, at) => doc.getIn(at)?.items ?? [];

function getApps(core) {
  const config = librechatYaml(core);
  return catalog().map((app) => {
    const server = config.getIn(['mcpServers', app.name]);
    return {
      ...app,
      enabled: Boolean(server),
      title: server?.get('title') ?? app.title,
      pinned: server ? server.get('chatMenu') === false : true,
    };
  });
}

function addTo(doc, at, value) {
  const list = doc.getIn(at);
  if (list) list.add(doc.createNode(value));
  else doc.setIn(at, doc.createNode([value]));
}

function removeFrom(doc, at, value) {
  const list = doc.getIn(at);
  if (!list) return;
  list.items = list.items.filter((item) => item.value !== value);
  if (!list.items.length) doc.deleteIn(at);
}

function saveApp({ name, enabled, title, pinned }) {
  const app = catalog().find((a) => a.name === name);
  check(app, 'Unknown app.');
  title = String(title ?? '').trim() || app.title;
  const core = read(CORE);
  const config = librechatYaml(core);
  const address = new URL(app.url).host; // LibreChat refuses private addresses unless listed
  const specs = items(config, ['modelSpecs', 'list']).map((_, i) => ['modelSpecs', 'list', i, 'mcpServers']);

  // Take the app out completely, then put it back the way it is wanted.
  if (config.hasIn(['mcpServers', name])) config.deleteIn(['mcpServers', name]);
  removeFrom(config, ['mcpSettings', 'allowedAddresses'], address);
  for (const spec of specs) removeFrom(config, spec, name);

  if (enabled) {
    for (const key of ['mcpSettings', 'mcpServers']) {
      if (config.has(key)) continue;
      const pair = config.createPair(key, {});
      pair.key.spaceBefore = key === 'mcpSettings';
      config.contents.add(pair);
    }
    config.setIn(['mcpServers', name], config.createNode({
      type: 'streamable-http',
      url: app.url,
      title,
      ...(pinned && { chatMenu: false }), // pinned to every assistant; users see no menu
      ...(app.token && { headers: { Authorization: `Bearer \${${app.token}}` } }),
    }));
    addTo(config, ['mcpSettings', 'allowedAddresses'], address);
    if (pinned) for (const spec of specs) addTo(config, spec, name);
  }

  const anyServer = items(config, ['mcpServers']).length > 0;
  if (!anyServer) config.delete('mcpServers');
  if (!items(config, ['mcpSettings']).length) config.delete('mcpSettings');
  // Needed for a pinned server too. `create` stays false: users cannot add servers.
  config.setIn(['interface', 'mcpServers', 'use'], anyServer);

  core.getIn(['librechat', 'configYamlContent'], true).value = config.toString({ lineWidth: 0 });
  write(CORE, core);
  return [CORE];
}

// ---- roll-out -----------------------------------------------------------------------

function saveDeploy({ namespace, version }) {
  namespace = String(namespace ?? '').trim();
  version = String(version ?? '').trim();
  check(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(namespace), 'Namespace: lower-case letters, digits and dashes only.');
  check(/^\d+\.\d+\.\d+$/.test(version), 'Chart version must look like 3.2.1.');
  const changed = [];
  const set = (file, at, value) => {
    const doc = read(file);
    if (doc.getIn(at) === value) return;
    doc.setIn(at, value);
    write(file, doc);
    changed.push(file);
  };
  set(FLEET, ['helm', 'version'], version);
  for (const file of [FLEET, ...catalog().map((app) => `${app.dir}/fleet.yaml`)]) set(file, ['defaultNamespace'], namespace);
  return [...new Set(changed)];
}

function getRollout(fleet, org, apps) {
  const namespace = fleet.get('defaultNamespace');
  const { releaseName, chart, version, valuesFiles } = fleet.get('helm').toJSON();
  const enabled = apps.filter((app) => app.enabled);
  const tokens = enabled.filter((app) => app.token);
  const tlsSecret = org.getIn(ORG_PATHS.tlsSecret);
  const generated = 'made by scripts/create-secrets.sh';

  const secrets = [
    { secret: ENV_SECRET, key: 'AZURE_MODEL_KEY', from: 'you: the key of the model in Azure' },
    { secret: ENV_SECRET, key: 'OPENID_CLIENT_SECRET', from: 'you: a client secret of the app registration' },
    ...tokens.map((app) => ({ secret: ENV_SECRET, key: app.token, from: `you: the token of the app ${app.name}` })),
    ...['CREDS_KEY', 'CREDS_IV', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'OPENID_SESSION_SECRET'].map((key) => ({ secret: ENV_SECRET, key, from: generated })),
    { secret: 'librechat-mongodb-auth', key: 'mongodb-root-password', from: generated },
    ...(tlsSecret ? [{ secret: tlsSecret, key: 'tls.crt, tls.key', from: 'cert-manager, or you' }] : []),
  ];

  const kubectl = `kubectl -n ${namespace}`;
  const steps = [
    {
      title: 'Create the Secrets',
      note: 'Type the two values in your own terminal. A Secret that already exists is left alone.',
      command: `AZURE_MODEL_KEY=... OPENID_CLIENT_SECRET=... scripts/create-secrets.sh ${namespace}`,
    },
    ...tokens.map((app) => ({
      title: `Add the token of ${app.name}`,
      note: 'LibreChat reads a changed Secret only after a restart.',
      command: `${kubectl} patch secret ${ENV_SECRET} --type merge -p '{"stringData":{"${app.token}":"..."}}'\n${kubectl} rollout restart deployment/${releaseName}-librechat`,
    })),
    ...(enabled.length ? [{
      title: 'Start the apps',
      note: 'Not needed with Rancher Fleet.',
      command: enabled.flatMap((app) => app.manifests).map((file) => `${kubectl} apply -f ${file}`).join('\n'),
    }] : []),
    {
      title: 'Install or update',
      note: 'Not needed with Rancher Fleet: push instead.',
      command: [`helm upgrade --install ${releaseName} ${chart} \\`, `  --version ${version} --namespace ${namespace} \\`,
        `  ${valuesFiles.map((file) => `-f deploy/${file}`).join(' ')}`].join('\n'),
    },
  ];

  const gitRepo = ['apiVersion: fleet.cattle.io/v1alpha1', 'kind: GitRepo', 'metadata:', '  name: govchat', '  namespace: fleet-local',
    'spec:', '  repo: https://gitea.example.nl/<org>/govchat.git', '  branch: main', '  paths:',
    ...['deploy', ...enabled.map((app) => app.dir)].map((dir) => `    - ${dir}`)].join('\n');

  const address = org.getIn(ORG_PATHS.address);
  return { namespace, version, secrets, steps, gitRepo, redirectUri: `${address}/oauth/openid/callback`, roles: ['govchat-user', 'govchat-admin'] };
}

// ---- git ----------------------------------------------------------------------------

// Every save is one commit, so each change has an author and a date and can be undone
// with `git revert`. The panel commits; it never pushes.
const TRACKED = ['deploy', 'apps'];
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const lines = (text) => text.split('\n').filter(Boolean);
const uncommitted = () => lines(git('status', '--porcelain', '--', ...TRACKED)).map((line) => line.slice(3));

function commit(message, save) {
  const pending = uncommitted();
  check(!pending.length, `Not saved. Commit or discard these changes first: ${pending.join(', ')}`);
  try {
    const files = save();
    if (!uncommitted().length) return null;
    git('commit', '--quiet', '-m', message, '--', ...files);
    return git('log', '-1', '--format=%h %s').trim();
  } catch (error) {
    git('checkout', 'HEAD', '--', ...TRACKED); // the tree was clean, so this only undoes the save
    throw error;
  }
}

function getGit() {
  const attempt = (...args) => { try { return git(...args).trim(); } catch { return ''; } };
  return {
    uncommitted: uncommitted(),
    branch: attempt('branch', '--show-current'),
    unpushed: attempt('rev-list', '--count', '@{upstream}..HEAD'), // empty without an upstream
    history: lines(attempt('log', '-10', '--date=format:%Y-%m-%d %H:%M', '--format=%h\t%ad\t%an\t%s', '--', ...TRACKED))
      .map((line) => line.split('\t')).map(([hash, date, author, subject]) => ({ hash, date, author, subject })),
  };
}

function state() {
  const [fleet, core, org] = [FLEET, CORE, ORG].map(read);
  const apps = getApps(core);
  return { org: getOrg(org), branding: getBranding(core, org), apps, rollout: getRollout(fleet, org, apps), git: getGit() };
}

// ---- http ---------------------------------------------------------------------------

// Per address: what to save, and the commit message for it.
const SAVE = {
  '/api/org': [saveOrg, () => 'organisation settings'],
  '/api/texts': [saveTexts, () => 'name and texts'],
  '/api/brand-file': [saveBrandFile, (body) => `replace ${body.name}`],
  '/api/app': [saveApp, (body) => `app ${body.name} ${body.enabled ? 'on' : 'off'}`],
  '/api/deploy': [saveDeploy, (body) => `namespace ${body.namespace}, chart ${body.version}`],
};

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (part) => {
      size += part.length;
      if (size > 2e6) { reject(new Invalid('The file is too large.')); req.destroy(); } else parts.push(part);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(parts).toString() || '{}')); } catch { reject(new Invalid('Not JSON.')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    // Only this machine's browser, on this page: no other website may read or write here.
    const self = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];
    const origin = req.headers.origin;
    if (!self.includes(req.headers.host) || (origin && !self.includes(origin.replace(/^http:\/\//, '')))) return send(res, 403, { error: 'Forbidden.' });

    const url = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && url === '/') return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html')), 'text/html; charset=utf-8');
    if (req.method === 'GET' && url === '/api/state') return send(res, 200, state());
    const image = BRAND_FILES.find((file) => url === `/branding/${file.name}`);
    if (req.method === 'GET' && image) return send(res, 200, fs.readFileSync(brandPath(image.name)), image.type);
    if (req.method === 'POST' && SAVE[url]) {
      if (!/^application\/json/.test(req.headers['content-type'] ?? '')) return send(res, 415, { error: 'Send JSON.' });
      const [save, describe] = SAVE[url];
      const body = await readBody(req);
      const committed = commit(`Admin panel: ${describe(body)}`, () => save(body));
      return send(res, 200, { committed, ...state() });
    }
    send(res, 404, { error: 'Not found.' });
  } catch (error) {
    if (!(error instanceof Invalid)) console.error(error);
    send(res, error instanceof Invalid ? 400 : 500, { error: error.stderr?.toString().trim() || error.message });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`GovChat admin panel: http://localhost:${PORT}`));
