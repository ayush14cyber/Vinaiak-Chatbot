/**
 * A message of the conversation, as the chat shows it: the chatbot's are markdown, and the
 * visitor's may have the thumbnails of images they sent.
 * @typedef {{ speaker: "user" | "bot"; text: string; images?: string[] }} Turn
 */

/**
 * What the site keeps of the visitor's conversation, to show it again when they come back: the
 * last sign-in's token, the messages and the buttons under the last reply. It lives in the site's
 * `localStorage`, as the chat runs in the site's page.
 * @typedef {{ token: string | null; turns: Turn[]; options: string[] }} Saved
 */

const key = (orgId) => `vinaiak-chatbot:${orgId}`;

const isStrings = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isTurn = (value) => {
  const turn = value;
  return (
    (turn?.speaker === "user" || turn?.speaker === "bot") &&
    typeof turn.text === "string" &&
    (turn.images === undefined || isStrings(turn.images))
  );
};

/** The conversation kept for `orgId`, or an empty one. */
export function load(orgId) {
  const empty = { token: null, turns: [], options: [] };
  try {
    const saved = JSON.parse(localStorage.getItem(key(orgId)) ?? "null");
    if (
      typeof saved?.token !== "string" ||
      !Array.isArray(saved.turns) ||
      !saved.turns.every(isTurn) ||
      !isStrings(saved.options)
    ) {
      return empty;
    }
    return { token: saved.token, turns: saved.turns, options: saved.options };
  } catch {
    // Storage is blocked, e.g. in a private window: the chat works without.
    return empty;
  }
}

/** Changes the conversation kept for `orgId`, as stored now: another tab may have changed it. */
export function update(orgId, change) {
  const saved = load(orgId);
  change(saved);
  try {
    localStorage.setItem(key(orgId), JSON.stringify(saved));
  } catch {
    // Full or blocked: the visitor just won't see this conversation again.
  }
}
