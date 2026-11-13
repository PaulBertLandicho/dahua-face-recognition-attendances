// Shared frontend session and token helpers for Supabase-compatible MySQL client & Dahua API

export const SESSION_STORAGE_KEY = "sb-session";
export const AUTH_EXPIRED_EVENT = "sb-auth-expired";

const authListeners = new Set();
let activeFaceToken = null;

export function getApiBase() {
  return typeof process !== "undefined" &&
    process.env &&
    process.env.REACT_APP_BACKEND_URL
    ? String(process.env.REACT_APP_BACKEND_URL).trim().replace(/\/$/, "")
    : "";
}

export function getStoredSession() {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

export function getStoredAccessToken() {
  const session = getStoredSession();
  const token = session?.access_token;
  return typeof token === "string" && token.trim() ? token.trim() : null;
}

export function saveStoredSession(session) {
  try {
    if (typeof localStorage === "undefined") return;
    if (session) {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    } else {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  } catch (err) {}
}

export function clearStoredSession() {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  } catch (err) {}
}

export function updateStoredSession({ user, access_token } = {}) {
  const current = getStoredSession();
  if (!current && !user && !access_token) return null;
  const next = {
    ...(current || {}),
    ...(access_token ? { access_token } : {}),
    ...(user ? { user: { ...(current?.user || {}), ...user } } : {}),
  };
  saveStoredSession(next);
  emitAuthStateChange("USER_UPDATED", next);
  return next;
}

export function subscribeAuthStateChange(callback) {
  authListeners.add(callback);
  return () => authListeners.delete(callback);
}

export function emitAuthStateChange(event, session) {
  authListeners.forEach((cb) => {
    try {
      cb(event, session);
    } catch (e) {}
  });
}

export function notifyAuthExpired(reason = "Session expired") {
  const hadSession = Boolean(getStoredSession());
  clearStoredSession();
  emitAuthStateChange("SIGNED_OUT", null);
  if (hadSession && typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    try {
      window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT, { detail: { reason } }));
    } catch (e) {}
  }
}

export function setActiveFaceToken(token) {
  if (typeof token === "string" && token.trim() && !token.trim().startsWith("offline_token_")) {
    activeFaceToken = token.trim();
  } else {
    activeFaceToken = null;
  }
}

export function getActiveFaceToken() {
  return activeFaceToken;
}
