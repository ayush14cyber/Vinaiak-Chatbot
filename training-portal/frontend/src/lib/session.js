/**
 * The signed-in account as the pages show it: its email, name and picture from Google's ID
 * token. None of it is secret, so it's kept in `localStorage` for a week. The token itself is in
 * an httpOnly cookie the pages can't read; whether it still signs the account in is the
 * backend's to say, through `/me`.
 */

const KEY = "vinaiak.portal.profile";
/** How long the profile is kept. */
const KEEP_MS = 7 * 24 * 3600 * 1000;

/**
 * @typedef {{
 *   email: string;
 *   name?: string;
 *   picture?: string;
 *   // When the token in the cookie expires, in Unix seconds.
 *   exp: number;
 * }} Profile
 */

/** The claims of a JWT, unverified: the backend verifies it. */
export function profileOf(token) {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      atob(payload)
        .split("")
        .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join(""),
    );
    const claims = JSON.parse(json);
    if (typeof claims.email !== "string" || typeof claims.exp !== "number") return null;
    return { email: claims.email, name: claims.name, picture: claims.picture, exp: claims.exp };
  } catch {
    return null;
  }
}

const listeners = new Set();
/** The stored profile when `localStorage` is blocked. */
let memory = null;

function notify() {
  listeners.forEach((listener) => listener());
}

export const profile = {
  /** The stored profile as JSON, for `useSyncExternalStore`: a string compares by value. */
  snapshot() {
    let stored = memory;
    try {
      stored = localStorage.getItem(KEY);
    } catch {
      // Blocked storage: the in-memory copy stands.
    }
    return stored;
  },
  /** The stored profile, unless it's older than a week. */
  parse(snapshot) {
    try {
      const { saved, ...profile } = JSON.parse(snapshot ?? "null") ?? {};
      return typeof saved === "number" && Date.now() - saved < KEEP_MS ? profile : null;
    } catch {
      return null;
    }
  },
  set(next) {
    memory = next ? JSON.stringify({ ...next, saved: Date.now() }) : null;
    try {
      if (memory) localStorage.setItem(KEY, memory);
      else localStorage.removeItem(KEY);
    } catch {
      // Blocked storage: it lasts until the page is closed.
    }
    notify();
  },
  /** Calls `listener` when the profile changes, in this tab or another. */
  subscribe(listener) {
    listeners.add(listener);
    const onStorage = (e) => e.key === KEY && listener();
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener("storage", onStorage);
    };
  },
};

const signedOutListeners = new Set();

/** Calls get a 401 once the cookie has expired or was dropped: the account is signed out. */
export const signedOut = {
  notify() {
    signedOutListeners.forEach((listener) => listener());
  },
  subscribe(listener) {
    signedOutListeners.add(listener);
    return () => {
      signedOutListeners.delete(listener);
    };
  },
};
