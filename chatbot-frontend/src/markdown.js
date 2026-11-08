import DOMPurify from "dompurify";
import { Marked } from "marked";

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const VIDEO = /\.mp4$/i;

const marked = new Marked({
  // Models escape the underscores of URLs as if they were markdown.
  walkTokens(token) {
    if (token.type === "link" || token.type === "image") {
      token.href = token.href.replaceAll("\\_", "_");
    }
  },
  renderer: {
    // A link to an image or a video shows it.
    link({ href, title, text }) {
      const path = href.split(/[?#]/)[0];
      if (IMAGE.test(path)) return `<img src="${escape(href)}" alt="${escape(title || text)}">`;
      if (VIDEO.test(path)) {
        return `<video src="${escape(href)}" muted autoplay controls playsinline></video>`;
      }
      return false;
    },
  },
});

// The chat is in an iframe: a link that opened there would replace it.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/**
 * `markdown` as HTML, without anything that could run: replies come from a model that read the
 * org's documents, and what's in them isn't ours to trust.
 */
export function render(markdown) {
  return DOMPurify.sanitize(marked.parse(markdown, { async: false }));
}

function escape(text) {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
