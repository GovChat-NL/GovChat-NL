"use strict";

// Fixed lifetime: authentication never renews the server-side creation time.
const ADMIN_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
function isAdminSessionValid(sessions, id, now = Date.now()) {
  if (typeof id !== "string" || !id) return false;
  const session = sessions.get(id);
  if (!session) return false;
  if (!Number.isFinite(session.created) || !Number.isFinite(now) || now < session.created || now - session.created >= ADMIN_SESSION_TTL_MS) {
    sessions.delete(id);
    return false;
  }
  return true;
}

module.exports = { ADMIN_SESSION_TTL_MS, isAdminSessionValid };
