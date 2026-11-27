// No content, token, email or conversation is stored. The scope is an opaque
// installation/user digest from a verified /api/user response, never URL claims.
export async function preferenceScope(userId, origin) {
  if (!userId || !globalThis.crypto?.subtle) return null;
  const bytes = new TextEncoder().encode(`${origin}\n${userId}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `gc_manual_v1_${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')}`;
}

export function createManualPreferences(scope, local, session) {
  let available = !!scope;
  let memory = {};
  try {
    if (available) {
      const parsed = JSON.parse(local.getItem(scope) || '{}');
      memory = { seen: parsed.seen === true, revision: typeof parsed.revision === 'string' ? parsed.revision.slice(0, 100) : '', optOut: parsed.optOut === true };
      // Probe both storages. A denied store means no automatic popup at all.
      local.setItem(scope, JSON.stringify(memory));
      session.setItem(`${scope}_probe`, '1'); session.removeItem(`${scope}_probe`);
    }
  } catch { available = false; }
  let attempted = false;
  const save = () => { try { if (available) local.setItem(scope, JSON.stringify(memory)); } catch { available = false; } };
  return {
    get optOut() { return memory.optOut === true; },
    get available() { return available; },
    shouldOpen(policy, revision) {
      if (!available || attempted || memory.optOut || policy === 'never') return false;
      try {
        if (session.getItem(`${scope}_opened`) === '1') return false;
        return policy === 'every-session' || (policy === 'first-use' && !memory.seen) || (policy === 'new-revision' && memory.revision !== revision);
      } catch { available = false; return false; }
    },
    opened(revision) {
      attempted = true;
      memory.seen = true; memory.revision = revision; save();
      try { if (available) session.setItem(`${scope}_opened`, '1'); } catch { available = false; }
    },
    suppress(value) { memory.optOut = value === true; save(); },
    restore() { memory.optOut = false; save(); },
    cancelAuto() { attempted = true; },
  };
}
