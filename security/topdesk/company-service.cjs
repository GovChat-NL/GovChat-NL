/*
 * n8n OpenAI Bridge
 * Copyright (C) 2025 Sven Eisenschmidt
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
'use strict';

const { randomBytes, timingSafeEqual } = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');

function readSettings(env = process.env) {
  const company = env.TOPDESK_ALLOWED_COMPANY_NAME ?? 'Provincie Limburg';
  if (typeof company !== 'string' || !company.length || company.length > 256) {
    throw new Error('Invalid TOPDESK_ALLOWED_COMPANY_NAME');
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (env.ENTRA_JWT_ENABLED !== 'true' || !uuid.test(env.ENTRA_TENANT_ID || '') ||
      !uuid.test(env.ENTRA_EXPECTED_AUDIENCE || '') ||
      !env.N8N_WEBHOOK_BEARER_TOKEN || env.N8N_WEBHOOK_BEARER_TOKEN.length < 32 ||
      env.N8N_WEBHOOK_BEARER_TOKEN === env.BEARER_TOKEN) {
    throw new Error('TOPdesk requires strict Entra verification and distinct private transport credentials');
  }
  const secret = fs.readFileSync(env.TOPDESK_OBO_CLIENT_SECRET_FILE, 'utf8').replace(/\r?\n$/, '');
  if (!secret || secret.length > 8192) throw new Error('Invalid private OBO credential');
  return Object.freeze({ company, tenant: env.ENTRA_TENANT_ID.toLowerCase(),
    client: env.ENTRA_EXPECTED_AUDIENCE.toLowerCase(), secret,
    transportToken: env.N8N_WEBHOOK_BEARER_TOKEN, timeoutMs: 5000, ttlMs: 300000, maxHandles: 10000 });
}

/** Tokens and identity stay in this server-owned closure, never in workflow payloads. */
function createCompanyService(settings, { fetch = globalThis.fetch, now = Date.now } = {}) {
  const handles = new Map();
  const trusted = new WeakSet();
  function trust(identity) {
    // Called only after the native verifier; JSON flags alone cannot establish trust.
    if (identity?.user_authorization_verified === true &&
        identity.user_authorization_mode === 'entra_delegated' &&
        identity.user_tid === settings.tenant && typeof identity.user_oid === 'string' &&
        Number.isSafeInteger(identity.user_token_expires_at)) trusted.add(identity);
  }
  function prune() {
    for (const [handle, record] of handles) if (record.until <= now()) handles.delete(handle);
  }
  function issue(identity, assertion) {
    prune();
    if (!trusted.has(identity) || typeof assertion !== 'string' || !assertion ||
        identity.user_token_expires_at * 1000 <= now() || handles.size >= settings.maxHandles) return null;
    const handle = randomBytes(32).toString('base64url');
    handles.set(handle, { identity, assertion,
      until: Math.min(now() + settings.ttlMs, identity.user_token_expires_at * 1000) });
    return handle;
  }
  async function readJson(response) {
    if (!response.ok) throw new Error('upstream_denied');
    const text = await response.text();
    if (text.length > 65536) throw new Error('upstream_invalid');
    return JSON.parse(text);
  }
  async function check(handle) {
    prune();
    const record = typeof handle === 'string' && /^[A-Za-z0-9_-]{43}$/.test(handle) ? handles.get(handle) : null;
    if (!record || !trusted.has(record.identity) || record.until <= now()) return false;
    try {
      const signal = AbortSignal.timeout(settings.timeoutMs);
      const grant = await readJson(await fetch(`https://login.microsoftonline.com/${settings.tenant}/oauth2/v2.0/token`, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: settings.client, client_secret: settings.secret,
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', requested_token_use: 'on_behalf_of',
          assertion: record.assertion, scope: 'https://graph.microsoft.com/User.Read' }),
      }));
      if (typeof grant.access_token !== 'string' || !grant.access_token || grant.token_type?.toLowerCase() !== 'bearer' ||
          !Number.isFinite(grant.expires_in) || grant.expires_in <= 0) return false;
      const user = await readJson(await fetch('https://graph.microsoft.com/v1.0/me?$select=id,companyName', {
        redirect: 'error', signal, headers: { Authorization: `Bearer ${grant.access_token}`, 'Cache-Control': 'no-cache' },
      }));
      return handles.get(handle) === record && record.until > now() &&
        typeof user.id === 'string' && user.id.toLowerCase() === record.identity.user_oid.toLowerCase() &&
        typeof user.companyName === 'string' && user.companyName === settings.company;
    } catch {
      // Never log upstream errors, headers, token responses, company or identity.
      return false;
    }
  }
  function revoke(handle) { handles.delete(handle); }
  return { trust, issue, check, revoke };
}

function equalCredential(value, expected) {
  if (typeof value !== 'string') return false;
  const left = Buffer.from(value); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Private listener; no mint/check-by-user endpoint and no caller-selected Graph URL. */
function createCheckServer(service, transportToken) {
  return http.createServer(async (req, res) => {
    const finish = (allowed, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ allowed: allowed === true }));
    };
    if (req.method !== 'POST' || req.url !== '/internal/topdesk/check' ||
        !equalCredential(req.headers.authorization, `Bearer ${transportToken}`)) return finish(false, 403);
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 2048) return finish(false, 400);
      }
      const input = JSON.parse(body);
      if (!input || !['availability', 'retrieval'].includes(input.purpose) ||
          Object.keys(input).some(key => !['handle', 'purpose'].includes(key))) return finish(false, 400);
      finish(await service.check(input.handle));
    } catch { finish(false); }
  });
}

module.exports = { readSettings, createCompanyService, createCheckServer };
