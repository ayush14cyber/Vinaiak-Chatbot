/**
 * The portal API, on the pages' own origin: Vercel, and `next dev`, proxy it to the backend. So
 * the session cookie the backend sets is first-party.
 */
export const API_URL = "/api";

/** The Google OAuth web client whose ID tokens the backend accepts. */
export const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
