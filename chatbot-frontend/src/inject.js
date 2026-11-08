import { readConfig } from "./config.js";
import { loadRecaptcha } from "./recaptcha.js";
import { mount } from "./widget.js";

// `currentScript` is the tag that loaded this only while it first runs.
const script = document.currentScript;
const config = script instanceof HTMLScriptElement ? readConfig(script) : null;
if (config) {
  // reCAPTCHA v3 scores the visitor by how they use the page, so it loads with it.
  loadRecaptcha().catch(() => {});
  if (document.body) void mount(config);
  else document.addEventListener("DOMContentLoaded", () => void mount(config));
}
