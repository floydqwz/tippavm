// Spara, läsa och dela tippningar.
// Tippstate: { name, group: { num: [h,a] }, ko: { num: [h,a] }, pen: { num: 'TEAMCODE' } }
// Lagras i localStorage per namn, kan kodas till en URL för delning.

const STORAGE_PREFIX = 'vm2026:';
const ACTIVE_KEY = STORAGE_PREFIX + '_active';

export function emptyState(name = '') {
  return { name, group: {}, ko: {}, pen: {} };
}

export function getActive() {
  return localStorage.getItem(ACTIVE_KEY);
}

export function setActive(name) {
  if (name) localStorage.setItem(ACTIVE_KEY, name);
  else localStorage.removeItem(ACTIVE_KEY);
}

export function loadLocal(name) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + name);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return normalize(obj);
  } catch { return null; }
}

export function saveLocal(state) {
  if (!state.name) return;
  try {
    localStorage.setItem(STORAGE_PREFIX + state.name, JSON.stringify(state));
    setActive(state.name);
  } catch (e) {
    console.warn('Kunde inte spara lokalt:', e);
  }
}

export function listLocal() {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(STORAGE_PREFIX) && key !== ACTIVE_KEY) {
      out.push(key.slice(STORAGE_PREFIX.length));
    }
  }
  return out;
}

export function existsLocal(name) {
  return localStorage.getItem(STORAGE_PREFIX + name) != null;
}

export function removeLocal(name) {
  localStorage.removeItem(STORAGE_PREFIX + name);
  if (getActive() === name) setActive(null);
}

export function renameLocal(oldName, newName) {
  const s = loadLocal(oldName);
  if (!s) return false;
  s.name = newName;
  saveLocal(s);
  if (oldName !== newName) removeLocal(oldName);
  return true;
}

export function copyLocal(srcName, newName) {
  const s = loadLocal(srcName);
  if (!s) return false;
  saveLocal({ ...s, name: newName });
  return true;
}

function normalize(obj) {
  return {
    name: obj.name || '',
    group: obj.group || {},
    ko: obj.ko || {},
    pen: obj.pen || {},
  };
}

// Kompakt JSON-form: ersätt nyckelnamn för att få kortare URL.
function toCompact(state) {
  return {
    n: state.name,
    g: state.group,
    k: state.ko,
    p: state.pen,
  };
}
function fromCompact(c) {
  return normalize({ name: c.n, group: c.g, ko: c.k, pen: c.p });
}

export function encodeShare(state) {
  const c = toCompact(state);
  const json = JSON.stringify(c);
  return LZString.compressToEncodedURIComponent(json);
}

export function decodeShare(token) {
  try {
    const json = LZString.decompressFromEncodedURIComponent(token);
    if (!json) return null;
    const c = JSON.parse(json);
    return fromCompact(c);
  } catch { return null; }
}

export function shareUrl(state) {
  const tok = encodeShare(state);
  const base = location.origin + location.pathname;
  return base + '#share=' + tok;
}

export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
    return ok;
  }
}
