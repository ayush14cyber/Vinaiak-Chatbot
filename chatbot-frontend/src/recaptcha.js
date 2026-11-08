/**
 * @typedef {{
 *   ready(callback: () => void): void;
 *   execute(siteKey: string, options: { action: string }): Promise<string>;
 * }} Recaptcha
 */

let loading;

/** Loads reCAPTCHA once, or again after it failed to. */
export function loadRecaptcha() {
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://www.google.com/recaptcha/enterprise.js?render=${RECAPTCHA_SITE_KEY}`;
    script.async = true;
    script.onload = () => {
      const recaptcha = window.grecaptcha.enterprise;
      recaptcha.ready(() => resolve(recaptcha));
    };
    script.onerror = () => {
      script.remove();
      loading = undefined;
      reject(new Error("reCAPTCHA didn't load"));
    };
    document.head.append(script);
  });
  return loading;
}

/** A token that the visitor is human, for the chatbot's login. */
export async function captcha() {
  const recaptcha = await loadRecaptcha();
  return recaptcha.execute(RECAPTCHA_SITE_KEY, { action: "LOGIN" });
}
