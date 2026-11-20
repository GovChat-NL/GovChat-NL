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

const { readSettings, createCompanyService, createCheckServer } = require('./company-service.cjs');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const NATIVE_VERIFIER_SHA256 = 'ad4265c44c02974e7611cb641d26cbf08cc255f00f5798725b6edc207ba9eeb7';

function stripPrivateFields(value, assertion) {
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    const alias = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (/topdesk|companyname|(?:access|refresh|id)token/.test(alias)) delete value[key];
    else if (typeof value[key] === 'string' && typeof assertion === 'string' && assertion) {
      value[key] = value[key].split(assertion).join('[redacted credential]');
    } else stripPrivateFields(value[key], assertion);
  }
}

function install(native, service) {
  const original = native.createEntraIdentity;
  native.createEntraIdentity = function (settings, ...dependencies) {
    if (!settings.enabled) throw new Error('TOPdesk requires enabled native Entra verifier');
    const verify = original(settings, ...dependencies);
    return async function (req, res, next) {
      const assertion = req.headers[settings.header];
      stripPrivateFields(req.body, assertion);
      // Express 5's query getter reconstructs from the URL on every access.
      // Snapshot the sanitized value so downstream request logging cannot reread
      // the unredacted query. Preserve all ordinary query values.
      const query = req.query;
      stripPrivateFields(query, assertion);
      if (query) Object.defineProperty(req, 'query', { value: query, configurable: true, enumerable: true });
      for (const key of Object.keys(req.headers)) {
        if (/topdesk|company|refresh|graph/i.test(key)) delete req.headers[key];
        else if (key !== settings.header && typeof req.headers[key] === 'string' && typeof assertion === 'string' && assertion) {
          req.headers[key] = req.headers[key].split(assertion).join('[redacted credential]');
        }
      }
      // Invalid identity denies restricted tools but does not disable ordinary chat.
      // The native verifier still performs every issuer/signature/audience/scope check.
      let verified = false;
      const rejection = { status() { return this; }, json() { return this; } };
      await verify(req, rejection, () => { verified = true; });
      const identity = verified ? req[native.identityContext] : native.deniedIdentity;
      if (!verified) Object.defineProperty(req, native.identityContext, { value: identity });
      service.trust(identity);
      const handle = service.issue(identity, assertion);
      // Preserve native immutable context (including JEMS groups); enrich only at
      // its server-owned payload boundary, not by writing authorization into JSON.
      const enhanced = Object.freeze({ ...identity, user_topdesk_handle: handle });
      // Native symbol is non-configurable. Route/userContext propagation reads it;
      // use a separate WeakMap and the native client's exact buildPayload hook.
      requestContexts.set(identity, enhanced);
      if (handle) {
        const revoke = () => service.revoke(handle);
        res.once('finish', revoke); res.once('close', revoke);
      }
      return next();
    };
  };
}

const requestContexts = new WeakMap();
function installPayload(N8nClient, native) {
  const original = N8nClient.prototype.buildPayload;
  N8nClient.prototype.buildPayload = function (messages, sessionId, userContext) {
    stripPrivateFields(messages);
    const payload = original.call(this, messages, sessionId, userContext);
    delete payload.user_topdesk_handle;
    const enhanced = requestContexts.get(userContext[native.identityContext]);
    return { ...payload, user_topdesk_handle: enhanced?.user_topdesk_handle ?? null };
  };
}

function start() {
  if (createHash('sha256').update(fs.readFileSync('/app/src/middleware/entraIdentity.js')).digest('hex') !== NATIVE_VERIFIER_SHA256) {
    throw new Error('Unsupported native Entra verifier revision; review and retest before upgrading');
  }
  const native = require('/app/src/middleware/entraIdentity.js');
  const N8nClient = require('/app/src/n8nClient.js');
  if (typeof native.createEntraIdentity !== 'function' || typeof native.identityContext !== 'symbol' ||
      typeof N8nClient.prototype.buildPayload !== 'function') throw new Error('Unsupported native bridge security contract');
  const settings = readSettings();
  const service = createCompanyService(settings);
  install(native, service); installPayload(N8nClient, native);
  const server = createCheckServer(service, settings.transportToken);
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  server.listen(3334, '0.0.0.0');
  server.unref();
}

if (process.env.TOPDESK_COMPANY_GRAPH_ENABLED === 'true') start();
else if (process.env.TOPDESK_COMPANY_GRAPH_ENABLED && process.env.TOPDESK_COMPANY_GRAPH_ENABLED !== 'false') {
  throw new Error('Invalid TOPDESK_COMPANY_GRAPH_ENABLED');
}

module.exports = { install, installPayload, stripPrivateFields };
