# chatbot-frontend

The chat a site embeds with one tag. `npm run build` bundles it, with its styles, images and
sounds, into `dist/inject.js`. The launcher's default image, `src/assets/opener.webp`, is too big to
bundle, so CI publishes it beside the script, as `https://chatbot.vinaiak.com/public/opener.webp`:

```html
<script
  src="https://chatbot.vinaiak.com/public/inject.js"
  async
  data-org-id="bit-mesra"
  data-title="BIT Admission Assistant"
  data-placeholder="Ask me about BIT Mesra"
  data-avatar="https://example.com/logo.png"
  data-greeting="Hi! How may I assist you with admission?"
></script>
```

It adds a round button at the bottom right of the page that opens the chat.

| Attribute | |
|---|---|
| `data-org-id` | The org whose chatbot it is. Required. |
| `data-title` | In the chat's header. "AI Assistant" by default. |
| `data-placeholder` | In the empty input. "Ask me anything" by default. |
| `data-avatar` | Image URL, in the header and beside replies. |
| `data-launcher-icon` | Image URL for the button that opens the chat. vinaiak's assistant by default. |
| `data-greeting` | The chatbot's first message, in markdown. Under it, always, even without one: "I may hallucinate, so verify from the sources before making decisions." |
| `data-watermark="false"` | Hides "Developed by vinaiak AI Pvt. Ltd." |
| `data-heading-color`, `data-user-box-color`, `data-bot-box-color`, `data-box-border-color`, `data-link-color`, `data-option-color` | CSS colours for the header, the visitor's messages, the replies, the replies' glow, links and the option buttons. |

The site's own CSS can move or resize `#vinaiak-chatbot-launcher` and `#vinaiak-chatbot-frame`,
e.g. `#vinaiak-chatbot-frame { bottom: 5dvh; }`.

A site works only once:

- the portal's admin has added its origin to the org's chatbot origins, and
- its domain is on the reCAPTCHA key's list of domains, in the Google Cloud console.

## How it works

- The script runs in the site's page and draws the chat in an iframe built from `srcdoc`, so
  nothing but reCAPTCHA is downloaded. Requests then come from the site's origin, which the
  chatbot checks against the org's.
- It talks to the API through `chatbot-client` (`../chatbot/client`), bundled from its sources.
- Replies are markdown, shown as they stream. They are rendered with `marked` and sanitised with
  DOMPurify, because the model writes them from the org's documents. A link to an image or an
  `.mp4` shows it.
- Visitors can attach up to 3 images to a message, with the paperclip or by pasting, e.g. a
  screenshot. Each is shrunk in the browser to a JPEG under 1 MB, which the chatbot passes to the
  model as it is: the model reads images itself.
- The conversation is kept in the site's `localStorage` (`vinaiak-chatbot:{org}`), with the
  sign-in's token, once each reply is done. On the visitor's next visit it shows again, as long as
  the chatbot still has it: signing in with the old token tells.
- While a reply is coming, the chat shows what the chatbot is doing: understanding the question,
  searching the org's documents (`retrieve`), then thinking once the documents answer.

## Development

```bash
npm install
npm run check   # type-checks
npm run build   # dist/inject.js
npm run dev     # rebuilds on change, and serves http://localhost:8000/demo.html
```

The build reads two environment variables:

- `CHATBOT_API_URL` is the chatbot API. It defaults to the deployed Function URL; use e.g.
  `http://localhost:3000` for a local server.
- `RECAPTCHA_SITE_KEY` is the reCAPTCHA Enterprise site key. It defaults to the one the backend's
  `GRECAPTCHA_KEY` secret belongs to.

`npm run dev` shows the launcher's image from `src/assets/opener.webp`; a build points at the
published one.

`demo.html` reaches the API only once `http://localhost:8000` is an allowed origin and
`localhost` is on the reCAPTCHA key's list of domains.
