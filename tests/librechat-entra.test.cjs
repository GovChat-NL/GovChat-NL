'use strict';
// Run in the pinned LibreChat image, with networking disabled. Synthetic credentials only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const native = require('/app/packages/api/dist/index.cjs');
const yaml = require('/app/node_modules/js-yaml');
const config = yaml.load(fs.readFileSync('/workspace/librechat.yaml', 'utf8'));
process.env.N8N_OPENAI_BRIDGE_BEARER_TOKEN = 'synthetic-server-bearer';
const endpoint = native.getCustomEndpointConfig({ endpoint: 'govchat-orchestrator', appConfig: config });
const now = Math.floor(Date.now() / 1000);
const idToken = `e30.${Buffer.from(JSON.stringify({ sub: 'synthetic-openid', exp: now + 3600 })).toString('base64url')}.synthetic`;
const user = { id: 'synthetic-user', openidId: 'synthetic-openid', provider: 'openid', role: 'ADMIN', email: 'fixture@example.invalid',
  federatedTokens: { access_token: 'synthetic-access', id_token: idToken, expires_at: now + 3600 } };
function headers(identity) {
  const result = native.getOpenAIConfig(endpoint.apiKey, { reverseProxyUrl: endpoint.baseURL,
    headers: endpoint.headers, modelOptions: { model: 'govchat-orchestrator' } }, endpoint.name);
  const llmConfig = { ...result.llmConfig, configuration: result.configOptions };
  native.resolveConfigHeaders({ llmConfig, user: native.createSafeUser(identity),
    body: { conversationId: 'synthetic-chat', federatedTokens: { access_token: 'client-forgery' } } });
  return llmConfig.configuration.defaultHeaders;
}
test('native headers forward server access token, not ID token or body credentials', () => {
  const resolved = headers(user);
  assert.ok(resolved['X-Entra-Access-Token'] === user.federatedTokens.access_token);
  assert.ok(resolved['X-Entra-Access-Token'] !== user.federatedTokens.id_token);
  assert.equal(resolved['X-Chat-Id'], 'synthetic-chat');
});
test('local admin has no Entra credential header; expired access requires reauthentication', () => {
  const resolved = headers({ id: 'local-admin', role: 'ADMIN' });
  assert.ok(!resolved['X-Entra-Access-Token']);
  assert.throws(() => headers({ ...user, federatedTokens: { ...user.federatedTokens, expires_at: now - 1 } }),
    error => error instanceof native.OpenIDReauthRequiredError);
});
