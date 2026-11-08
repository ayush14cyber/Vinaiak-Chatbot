"use client";

import Script from "next/script";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { toast } from "sonner";
import { api, ApiError, message } from "@/lib/api";
import { GOOGLE_CLIENT_ID } from "@/lib/config";
import { profile as stored, profileOf, signedOut } from "@/lib/session";

/**
 * @typedef {{
 *   // False while the page is still the prerendered HTML, before the browser's state is read.
 *   hydrated: boolean;
 *   // Whether the session cookie signs an account in: `undefined` until `/me` says.
 *   signedIn: boolean | undefined;
 *   profile: Profile | null;
 *   // The account's registration, `undefined` while it loads.
 *   me: Me | undefined;
 *   meError: string | undefined;
 *   refreshMe(): Promise<void>;
 *   // Whether Google's sign-in script is ready to render its button.
 *   gisReady: boolean;
 *   signOut(): void;
 * }} SessionState
 */

/**
 * What `/me` last said: the account, that none is signed in, or why it couldn't be asked.
 * @typedef {{ me: Me } | { signedOut: true } | { error: string }} Account
 */

const SessionContext = createContext(null);

const never = () => () => {};

export function SessionProvider({ children }) {
  const hydrated = useSyncExternalStore(
    never,
    () => true,
    () => false,
  );
  const snapshot = useSyncExternalStore(stored.subscribe, stored.snapshot, () => null);
  const profile = useMemo(() => stored.parse(snapshot), [snapshot]);
  /** `null` while `/me` loads, or while signing in. */
  const [account, setAccount] = useState(null);
  const [gisReady, setGisReady] = useState(false);
  const signedIn = account === null || "error" in account ? undefined : "me" in account;

  const fetchMe = useCallback(
    () =>
      api.me().then(
        (me) => setAccount({ me }),
        (error) =>
          setAccount(
            error instanceof ApiError && error.status === 401
              ? { signedOut: true }
              : { error: message(error) },
          ),
      ),
    [],
  );

  useEffect(() => {
    void fetchMe();
  }, [fetchMe]);

  // A call answered 401: the cookie expired or was dropped.
  useEffect(() => signedOut.subscribe(() => setAccount({ signedOut: true })), []);

  // Google's ID tokens last an hour. Ask Google again just before the cookie's one expires, which
  // signs a returning account straight back in.
  useEffect(() => {
    if (!signedIn || !profile) return;
    const ms = (profile.exp - 60) * 1000 - Date.now();
    const timer = setTimeout(() => window.google?.accounts.id.prompt(), Math.max(ms, 0));
    return () => clearTimeout(timer);
  }, [signedIn, profile]);

  /** Hands Google's token to the backend, which keeps it in the cookie. */
  const signIn = useCallback(
    (credential) => {
      // Signing in from the landing page: show the splash, not the landing, meanwhile.
      setAccount((current) => (current && "me" in current ? current : null));
      return api.signIn(credential).then(
        () => {
          stored.set(profileOf(credential));
          return fetchMe();
        },
        (error) => {
          setAccount((current) => current ?? { signedOut: true });
          toast.error("Couldn't sign in", { description: message(error) });
        },
      );
    },
    [fetchMe],
  );

  const signOut = useCallback(() => {
    api.signOut().then(
      () => {
        window.google?.accounts.id.disableAutoSelect();
        stored.set(null);
        setAccount({ signedOut: true });
      },
      (error) => toast.error("Couldn't sign out", { description: message(error) }),
    );
  }, []);

  const initGis = useCallback(() => {
    if (!window.google || !GOOGLE_CLIENT_ID) return;
    window.google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: ({ credential }) => void signIn(credential),
      auto_select: true,
      cancel_on_tap_outside: true,
      use_fedcm_for_prompt: true,
    });
    setGisReady(true);
  }, [signIn]);

  const value = useMemo(
    () => ({
      hydrated,
      signedIn,
      profile,
      me: account && "me" in account ? account.me : undefined,
      meError: account && "error" in account ? account.error : undefined,
      refreshMe: fetchMe,
      gisReady,
      signOut,
    }),
    [hydrated, signedIn, profile, account, fetchMe, gisReady, signOut],
  );

  return (
    <SessionContext.Provider value={value}>
      <Script
        src="https://accounts.google.com/gsi/client"
        strategy="afterInteractive"
        onReady={initGis}
      />
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession needs a SessionProvider");
  return value;
}

/** The API. The session cookie decides whose account it acts as. */
export function useApi() {
  return api;
}
