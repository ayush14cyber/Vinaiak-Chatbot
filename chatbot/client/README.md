# chatbot-client

Talks to an org's chatbot from the site it is embedded on. It signs in with an invisible
reCAPTCHA v3 token and streams each reply as it is written, with the tools the assistant calls on
the way.

```ts
import { Chatbot, ChatbotError } from "chatbot-client";

const chatbot = new Chatbot({
  apiUrl: "https://<chatbot-function-url>",
  orgId: "bit-mesra",
  captcha: () => grecaptcha.execute(SITE_KEY, { action: "login" }),
  // Optional: continue the visitor's conversation on their next visit.
  token: localStorage.getItem("chatbot-token"),
  onLogin: (token, resumed) => localStorage.setItem("chatbot-token", token),
});

try {
  const reply = await chatbot.chat("What is the B.Tech fee?", {
    onText: (text) => render(text), // the next piece of the markdown reply
    onFunctionCall: (name) => name === "retrieve" && showSearching(),
    onFunctionResponse: (name) => name === "retrieve" && hideSearching(),
    onOptions: (options) => showButtons(options), // send the one picked as the next query
  });
  // Images go as `data:` URLs, which the model reads itself:
  await chatbot.chat({ text: "Which form is this?", images: ["data:image/jpeg;base64,…"] });
  // A new conversation; if the token was dropped instead, forget the kept one too.
  if (!(await chatbot.reset())) localStorage.removeItem("chatbot-token");
} catch (error) {
  if (error instanceof ChatbotError && error.code === "CaptchaFailed") {
    // reCAPTCHA didn't take the visitor for a human.
  }
}
```

- The site must be one of the org's chatbot origins, set by the portal's admin. reCAPTCHA must
  have been solved on that same site.
- `chat()` signs in when it has to: on the first message, once the hour a sign-in lasts is nearly
  over, and when the chatbot refuses a message because the sign-in ran out by its clock or used its
  50 messages, sending it again after. A sign-in with an earlier token continues its conversation
  while the chatbot keeps it, at least a day after its last message, and allows it 50 more
  messages; `onLogin` says whether it did. Otherwise a new conversation starts.
- The tools' arguments and results never reach the browser, only their names: `retrieve` (searching
  the org's documents), `offer_options` and `data_not_found`.

## Development

```bash
npm install
npm test        # runs the tests on Node's own runner
```

The package is plain JavaScript (ES modules), with JSDoc types: there's no build step, so
`src/index.js` is what's imported.

```bash
```
