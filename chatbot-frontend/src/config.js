/** The colours a site can change: `data-heading-color` sets the chat's `--heading`, and so on. */
export const COLORS = ["heading", "user-box", "bot-box", "box-border", "link", "option"];

/**
 * How a site sets up its chat, with attributes of the script tag that loads it.
 * @typedef {{
 *   // `data-org-id`: the org whose chatbot this is. Required.
 *   orgId: string;
 *   // `data-title`, in the chat's header.
 *   title: string;
 *   // `data-placeholder`, in the empty input.
 *   placeholder: string;
 *   // `data-avatar`: an image URL, in the header and beside replies.
 *   avatar?: string;
 *   // `data-launcher-icon`: an image URL for the button that opens the chat. vinaiak's assistant by default.
 *   launcherIcon?: string;
 *   // `data-greeting`: the chatbot's first message, in markdown.
 *   greeting?: string;
 *   // `data-watermark="false"` hides "Developed by vinaiak AI" in the header.
 *   watermark: boolean;
 *   colors: Partial<Record<(typeof COLORS)[number], string>>;
 * }} Config
 */

/** What `script` sets up, or null when it names no org. */
export function readConfig(script) {
  const read = (name) => script.getAttribute(`data-${name}`)?.trim() || undefined;
  const orgId = read("org-id");
  if (!orgId) {
    console.error('The chatbot needs its org: <script src=".../inject.js" data-org-id="...">');
    return null;
  }
  const colors = {};
  for (const color of COLORS) {
    const value = read(`${color}-color`);
    if (value) colors[color] = value;
  }
  return {
    orgId,
    title: read("title") ?? "AI Assistant",
    placeholder: read("placeholder") ?? "Ask me anything",
    avatar: read("avatar"),
    launcherIcon: read("launcher-icon"),
    greeting: read("greeting"),
    watermark: read("watermark") !== "false",
    colors,
  };
}
