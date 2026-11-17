// Talking to LibreChat's API from the browser.
//
// Auth is a short-lived bearer token, never a cookie - only the
// (httpOnly) refresh-token cookie is ambient, so a fresh access token is
// minted on demand via POST /api/auth/refresh, which the browser sends
// automatically since we run same-origin inside the logged-in page.

let librechatAuthToken = null;
let librechatAuthTokenExpiresAt = 0;

export function newClientMessageId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export async function getLibreChatAuthToken(forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && librechatAuthToken && now < librechatAuthTokenExpiresAt) {
    return librechatAuthToken;
  }
  const resp = await fetch("/api/auth/refresh", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
  });
  if (!resp.ok) throw new Error(`Kon geen LibreChat-sessie ophalen (HTTP ${resp.status}). Log opnieuw in.`);
  const data = await resp.json().catch(() => ({}));
  const token = String(data?.token || "").trim();
  if (!token) throw new Error("LibreChat gaf geen geldig sessietoken terug.");
  librechatAuthToken = token;
  // Conservative fixed TTL assumption (short-lived access tokens); a 401
  // on the next call also triggers a forced refresh, so this is just to
  // avoid refreshing on every single request.
  librechatAuthTokenExpiresAt = now + 5 * 60 * 1000;
  return token;
}

export async function librechatFetch(path, options = {}, retry = true) {
  const token = await getLibreChatAuthToken(false);
  const resp = await fetch(path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
  if (resp.status === 401 && retry) {
    await getLibreChatAuthToken(true);
    return librechatFetch(path, options, false);
  }
  return resp;
}
