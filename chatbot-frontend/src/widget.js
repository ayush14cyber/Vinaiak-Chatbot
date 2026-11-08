import { Chatbot, ChatbotError } from "chatbot-client";
import askSound from "./assets/ask.mp3";
import closeSound from "./assets/close.mp3";
import openSound from "./assets/open.mp3";
import replySound from "./assets/reply.mp3";

import frameCss from "./frame.css";
import frameHtml from "./frame.html";
import hostCss from "./host.css";
import { MAX_IMAGES, attach } from "./images.js";
import { render } from "./markdown.js";
import { captcha } from "./recaptcha.js";
import { load, update } from "./saved.js";

/**
 * What the chatbot is doing while the visitor waits for its reply.
 * @typedef {"understanding" | "searching" | "thinking"} Status
 */

const LABELS = {
  understanding: "Understanding",
  searching: "Searching",
  thinking: "Thinking",
};

/** Under the greeting, in every chat, as replies come from a model. */
const DISCLAIMER = "I may hallucinate, so verify from the sources before making decisions.";

const sounds = {
  open: new Audio(openSound),
  close: new Audio(closeSound),
  ask: new Audio(askSound),
  reply: new Audio(replySound),
};

function play(sound) {
  sound.currentTime = 0;
  // The browser refuses until the visitor has used the page; the chat works without.
  sound.play().catch(() => {});
}

/** `ms`, or none for visitors who asked for less motion. */
function motion(ms) {
  return matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : ms;
}

/** Adds the chat to the page: closed, behind a button that opens it. */
export async function mount(config) {
  const style = document.createElement("style");
  style.textContent = hostCss;
  // First, so the site's own styles can move or resize the chat.
  document.head.prepend(style);

  const frame = document.createElement("iframe");
  frame.id = "vinaiak-chatbot-frame";
  frame.title = config.title;
  frame.srcdoc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${frameCss}</style></head><body>${frameHtml}</body></html>`;
  const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
  document.body.append(frame);
  await loaded;
  return new Widget(config, frame);
}

/**
 * The chat. It runs in the page and only draws in its iframe, so the chatbot sees the site's own
 * origin, which the org allowed, and reCAPTCHA scores the visitor on the site itself.
 */
class Widget {
  #config;
  #chatbot;
  #frame;
  #launcher;
  #doc;
  #chat;
  #input;
  #send;
  #reset;
  /** The reCAPTCHA notice atop the chat, which stays when it starts over. */
  #notice;
  /** Shows the images attached to the next message. */
  #tray;
  /** Says why an image wasn't attached. */
  #note;
  /** Shows the `Status` until the reply starts. */
  #status;
  #open = false;
  #greeted = false;
  #replying = false;
  /** Who wrote the last message, so the avatar heads each run of the chatbot's. */
  #lastSpeaker = null;
  /** Whether to keep the reply in view: not once the visitor scrolls themselves. */
  #following = true;
  /** The buttons under the last reply. */
  #options = null;
  /** The images going with the next message. */
  #attached = [];
  /** Images still being read, which the next message waits for. */
  #reading = 0;

  constructor(config, frame) {
    this.#config = config;
    const { orgId } = config;
    this.#chatbot = new Chatbot({
      apiUrl: CHATBOT_API_URL,
      orgId,
      captcha,
      token: load(orgId).token,
      onLogin: (token, resumed) =>
        update(orgId, (saved) => {
          saved.token = token;
          // The chatbot no longer has that conversation, so it shouldn't show again either.
          if (!resumed) {
            saved.turns = [];
            saved.options = [];
          }
        }),
    });
    this.#frame = frame;
    const doc = frame.contentDocument;
    const $ = (selector) => doc.querySelector(selector);
    this.#doc = doc;
    this.#chat = $("#chat-area");
    this.#input = $("#text-input");
    this.#send = $("#send");
    this.#reset = $("#reset");
    this.#notice = $("#chat-area .notice");
    this.#tray = $("#attachments");
    this.#note = $("#attachments .note");
    const status = doc.importNode($("#status").content, true);
    this.#status = status.firstElementChild;

    for (const [name, value] of Object.entries(config.colors)) {
      doc.documentElement.style.setProperty(`--${name}`, value);
    }
    $(".title").textContent = config.title;
    this.#input.placeholder = config.placeholder;
    const avatar = $("#heading .avatar");
    if (config.avatar) avatar.src = config.avatar;
    else avatar.remove();
    if (!config.watermark) $(".credit").remove();

    this.#launcher = document.createElement("button");
    this.#launcher.id = "vinaiak-chatbot-launcher";
    this.#launcher.type = "button";
    this.#launcher.setAttribute("aria-label", `Open ${config.title}`);
    const icon = document.createElement("img");
    icon.alt = "";
    icon.src = config.launcherIcon ?? OPENER_URL;
    this.#launcher.append(icon);
    document.body.append(this.#launcher);

    this.#launcher.addEventListener("click", () => this.#show());
    // A click from the keyboard has no `detail`, the number of mouse clicks.
    $("#close").addEventListener("click", (event) => void this.#hide(event.detail === 0));
    doc.addEventListener("keydown", (event) => {
      if (event.key === "Escape") void this.#hide(true);
    });
    this.#reset.addEventListener("click", () => void this.#startOver());
    const composer = $("#composer");
    composer.addEventListener("submit", (event) => {
      event.preventDefault();
      const query = this.#input.value.trim();
      const attached = this.#attached;
      if ((!query && !attached.length) || this.#replying || this.#reading) return;
      this.#input.value = "";
      this.#attached = [];
      this.#note.textContent = "";
      this.#showAttached();
      this.#ask(query, attached);
    });
    const files = $("#file-input");
    $("#attach").addEventListener("click", () => files.click());
    files.addEventListener("change", () => {
      void this.#attach([...(files.files ?? [])]);
      // So the same file can be picked again.
      files.value = "";
    });
    doc.addEventListener("paste", (event) => {
      const data = event.clipboardData;
      // Copied text pastes as text, even when a picture of it comes along, e.g. from a spreadsheet.
      if (!data || data.types.includes("text/plain")) return;
      const images = [...data.files].filter((file) => file.type.startsWith("image/"));
      if (!images.length) return;
      event.preventDefault();
      void this.#attach(images);
    });
    this.#input.addEventListener("keydown", (event) => {
      // Enter sends, Shift+Enter starts a new line.
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        composer.requestSubmit();
      }
    });
    this.#input.addEventListener("input", () => this.#updateComposer());
    this.#chat.addEventListener("click", (event) => {
      // An image in a reply opens full size, unless it's a link of its own.
      const image = event.target.closest(".box.bot img");
      if (image && !image.closest("a")) window.open(image.src, "_blank", "noopener");
    });
    for (const scrolling of ["wheel", "touchmove"]) {
      this.#chat.addEventListener(scrolling, () => (this.#following = false), { passive: true });
    }
  }

  #show() {
    this.#open = true;
    this.#launcher.hidden = true;
    this.#frame.classList.add("open");
    this.#frame.animate({ opacity: [0, 1] }, { duration: motion(500), easing: "ease-out" });
    play(sounds.open);
    if (!this.#greeted) {
      this.#greet();
      void this.#restore();
    }
    this.#greeted = true;
    this.#input.focus();
  }

  #greet() {
    const box = this.#bubble("bot");
    if (this.#config.greeting) box.innerHTML = render(this.#config.greeting);
    const disclaimer = this.#doc.createElement("p");
    disclaimer.className = "disclaimer";
    disclaimer.textContent = DISCLAIMER;
    box.append(disclaimer);
  }

  /**
   * Shows the conversation the visitor had here before, if the chatbot still has it. Once its
   * sign-in expired, that's only known by signing in again, which continues it if it can.
   */
  async #restore() {
    const { turns, options } = load(this.#config.orgId);
    if (!turns.length) return;
    if (!this.#chatbot.signedIn) {
      this.#replying = true;
      this.#updateComposer();
      try {
        if (!(await this.#chatbot.login())) return;
      } catch {
        // Unknown: the next message signs in again, and says.
        return;
      } finally {
        this.#replying = false;
        this.#updateComposer();
      }
    }
    for (const turn of turns) {
      const box = this.#bubble(turn.speaker);
      if (turn.speaker === "user") this.#showAsked(box, turn.text, turn.images ?? []);
      else box.innerHTML = render(turn.text);
    }
    if (options.length) this.#offer(options, (option) => this.#ask(option));
    this.#chat.scrollTop = this.#chat.scrollHeight;
  }

  /**
   * Closes the chat. Closed from the keyboard, the launcher gets the focus back, ringed as focus
   * is for keyboard users; a mouse user needs neither.
   */
  async #hide(fromKeyboard) {
    if (!this.#open) return;
    this.#open = false;
    play(sounds.close);
    const sliding = this.#frame.animate(
      { transform: ["none", "translateX(calc(100% + 1px))"] },
      { duration: motion(300), easing: "ease-out", fill: "forwards" },
    );
    await sliding.finished;
    this.#frame.classList.remove("open");
    sliding.cancel();
    this.#launcher.hidden = false;
    if (fromKeyboard) this.#launcher.focus();
  }

  /** Starts a new conversation: the chatbot forgets this one, and the chat shows it no more. */
  async #startOver() {
    if (this.#replying) return;
    const { orgId } = this.#config;
    const { token } = load(orgId);
    // The token is kept again once the chatbot forgot the conversation too: if the page closes
    // first, the next visit starts a new one rather than continue what the chat no longer shows.
    update(orgId, (saved) => {
      saved.token = null;
      saved.turns = [];
      saved.options = [];
    });
    this.#chat.replaceChildren(this.#notice);
    this.#lastSpeaker = null;
    this.#options = null;
    this.#following = true;
    this.#greet();
    this.#replying = true;
    this.#updateComposer();
    if (await this.#chatbot.reset()) {
      update(orgId, (saved) => {
        saved.token = token;
      });
    }
    this.#replying = false;
    this.#updateComposer();
    this.#input.focus();
  }

  /** Attaches `files` to the next message, as many as it may still take. */
  async #attach(files) {
    const room = MAX_IMAGES - this.#attached.length - this.#reading;
    const taken = files.slice(0, Math.max(0, room));
    this.#note.textContent =
      files.length > taken.length ? `You can send up to ${MAX_IMAGES} images at once.` : "";
    this.#reading += taken.length;
    this.#updateComposer();
    const read = await Promise.all(taken.map((file) => attach(file).catch(() => null)));
    this.#reading -= taken.length;
    for (const attachment of read) {
      if (attachment) this.#attached.push(attachment);
      else this.#note.textContent = "That file isn't an image we can read.";
    }
    this.#showAttached();
    this.#updateComposer();
  }

  /** Shows the images attached to the next message, each with a button that takes it off. */
  #showAttached() {
    const items = this.#attached.map((attachment, index) => {
      const item = this.#doc.createElement("div");
      item.className = "attachment";
      const image = this.#doc.createElement("img");
      image.src = attachment.thumbnail;
      image.alt = `Image ${index + 1}`;
      const remove = this.#doc.createElement("button");
      remove.type = "button";
      remove.className = "remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove image ${index + 1}`);
      remove.addEventListener("click", () => {
        this.#attached = this.#attached.filter((other) => other !== attachment);
        this.#note.textContent = "";
        this.#showAttached();
        this.#updateComposer();
        this.#input.focus();
      });
      item.append(image, remove);
      return item;
    });
    this.#tray.replaceChildren(...items, this.#note);
    this.#tray.hidden = !items.length && !this.#note.textContent;
  }

  /** Sends `query`, with the images `attached`, as the visitor's next message. */
  #ask(query, attached = []) {
    this.#options?.remove();
    const asked = this.#bubble("user");
    this.#showAsked(
      asked,
      query,
      attached.map((attachment) => attachment.thumbnail),
    );
    play(sounds.ask);
    void this.#reply(query, attached, asked);
  }

  /** Fills `box` with what the visitor sent: the `images`, then the `text`. */
  #showAsked(box, text, images) {
    box.textContent = text;
    if (!images.length) return;
    const row = this.#doc.createElement("div");
    row.className = "images";
    for (const src of images) {
      const image = this.#doc.createElement("img");
      image.src = src;
      image.alt = "Sent image";
      row.append(image);
    }
    box.prepend(row);
  }

  /** Shows the chatbot's reply to `query` and the images `attached`, which `asked` shows. */
  async #reply(query, attached, asked) {
    this.#replying = true;
    this.#updateComposer();
    this.#following = true;
    this.#setStatus("understanding");
    this.#scroll(asked, "smooth");
    let box = null;
    let text = "";
    // In each round the model writes and calls tools, then the tools answer. rag asks it again
    // after a search, or when it called tools before writing anything: it's thinking until then.
    let wrote = false;
    let searched = false;
    let answered = false;
    const nextRound = () => {
      if (!answered) return;
      wrote = searched = answered = false;
      text += "\n\n";
    };
    try {
      const images = attached.map((attachment) => attachment.image);
      const { options } = await this.#chatbot.chat(
        { text: query, images },
        {
          onText: (piece) => {
            nextRound();
            wrote = true;
            this.#setStatus(null);
            if (!box) {
              box = this.#bubble("bot");
              box.setAttribute("aria-busy", "true");
              play(sounds.reply);
            }
            text += piece;
            box.innerHTML = render(text);
            this.#scroll(asked);
          },
          onFunctionCall: (name) => {
            nextRound();
            if (name !== "retrieve") return;
            searched = true;
            this.#setStatus("searching");
            this.#scroll(asked);
          },
          onFunctionResponse: () => {
            if (!answered && (searched || !wrote)) this.#setStatus("thinking");
            answered = true;
          },
        },
      );
      this.#setStatus(null);
      box?.removeAttribute("aria-busy");
      if (options.length) this.#offer(options, (option) => this.#ask(option));
      // The chatbot saved the exchange before it said it was done, so this matches what it has.
      update(this.#config.orgId, (saved) => {
        const images = attached.map((attachment) => attachment.thumbnail);
        saved.turns.push({ speaker: "user", text: query, ...(images.length && { images }) });
        if (text) saved.turns.push({ speaker: "bot", text });
        saved.options = options;
      });
    } catch (error) {
      this.#setStatus(null);
      box?.removeAttribute("aria-busy");
      const failed = this.#bubble("bot");
      failed.classList.add("error");
      failed.textContent = explain(error);
      if (!(error instanceof ChatbotError && error.code === "TooManyRequests")) {
        this.#offer(["Try again"], () => {
          box?.remove();
          failed.remove();
          void this.#reply(query, attached, asked);
        });
      }
    } finally {
      this.#replying = false;
      this.#updateComposer();
      this.#scroll(asked);
    }
  }

  /** A new message, under the avatar when it's the first of the chatbot's in a row. */
  #bubble(speaker) {
    this.#turn(speaker);
    const box = this.#doc.createElement("div");
    box.className = `box ${speaker}`;
    this.#chat.append(box);
    return box;
  }

  #turn(speaker) {
    if (speaker === "bot" && this.#lastSpeaker !== "bot" && this.#config.avatar) {
      const avatar = this.#doc.createElement("img");
      avatar.className = "avatar bot";
      avatar.alt = "";
      avatar.src = this.#config.avatar;
      this.#chat.append(avatar);
    }
    this.#lastSpeaker = speaker;
  }

  /** Shows what the chatbot is doing, below the newest message, or stops showing it. */
  #setStatus(status) {
    const shown = this.#status;
    if (!status) {
      shown.remove();
      return;
    }
    if (shown.dataset.status !== status) {
      shown.dataset.status = status;
      shown.querySelector(".label").textContent = LABELS[status];
    }
    if (this.#chat.lastElementChild !== shown) {
      this.#turn("bot");
      this.#chat.append(shown);
    }
  }

  /** Buttons with `options`, which call `pick` with the one clicked. */
  #offer(options, pick) {
    const list = this.#doc.createElement("div");
    list.className = "options";
    for (const option of options) {
      const button = this.#doc.createElement("button");
      button.type = "button";
      button.className = "option";
      button.textContent = option;
      button.addEventListener("click", () => {
        if (this.#replying) return;
        list.remove();
        pick(option);
      });
      list.append(button);
    }
    this.#chat.append(list);
    this.#options = list;
  }

  /**
   * Scrolls to the newest message, but only until `asked` reaches the top: a long reply is read
   * from its start, below the question.
   */
  #scroll(asked, behavior = "auto") {
    if (!this.#following) return;
    const chat = this.#chat;
    const end = chat.scrollHeight - chat.clientHeight;
    chat.scrollTo({ top: Math.min(end, asked.offsetTop - 8), behavior });
  }

  /**
   * Fits the input to what's typed, and lets it be sent, or the chat start over, unless a reply is
   * coming.
   */
  #updateComposer() {
    const input = this.#input;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
    const empty = !input.value.trim() && !this.#attached.length;
    this.#send.disabled = this.#replying || this.#reading > 0 || empty;
    this.#reset.disabled = this.#replying;
  }
}

/** What to tell the visitor when `error` stopped a reply. */
function explain(error) {
  if (!(error instanceof ChatbotError)) return "Can't reach the chatbot. Check your connection.";
  switch (error.code) {
    case "CaptchaFailed":
    case "Unauthorized":
      return "We couldn't verify this chat. Please try again.";
    case "InternalError":
    case "HttpError":
      return "Something went wrong. Please try again.";
    default:
      return error.message;
  }
}
