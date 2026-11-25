"use strict";

/**
 * The check of the store token (BELEIDSKOMPAS_STORE_TOKEN). n8n sends the
 * token with every request, as a bearer token or in the header
 * x-govchat-token, the same two ways the other internal endpoints of this
 * service take a token.
 */

function suppliedToken(headers) {
  const auth = String((headers && headers.authorization) || "").trim();
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return String((headers && headers["x-govchat-token"]) || "").trim();
}

/** Returns a function that takes the headers of a request and gives the
 *  answer when they carry no valid token, or null when the token is right. */
function createTokenCheck(internalToken) {
  const token = String(internalToken || "").trim();

  return function refuseToken(headers) {
    if (!token) return { status: 503, body: { error: "Server misconfiguratie: BELEIDSKOMPAS_STORE_TOKEN ontbreekt" } };
    if (suppliedToken(headers) !== token) return { status: 401, body: { error: "Unauthorized" } };
    return null;
  };
}

/** The same check as express middleware. */
function requireToken(internalToken) {
  const refuseToken = createTokenCheck(internalToken);

  return (req, res, next) => {
    const refused = refuseToken(req.headers);
    if (refused) return res.status(refused.status).json(refused.body);
    next();
  };
}

module.exports = { createTokenCheck, requireToken };
