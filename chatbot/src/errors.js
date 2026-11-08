// Why a call failed. Its `message` is the detail its log line gets; the caller is told less, as
// `{code, message}`.

const STATUS = {
  CaptchaFailed: 401,
  InternalError: 500,
  NotFound: 404,
  Unauthorized: 401,
  TooManyRequests: 429,
  BadRequest: 400,
};

export class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = STATUS[code];
  }

  /** Why reCAPTCHA didn't take the visitor for a human: its score, or where it was solved. */
  static captchaFailed(why) {
    return new ApiError("CaptchaFailed", `captcha failed: ${why}`);
  }

  static internal(why) {
    return new ApiError("InternalError", typeof why === "string" ? why : described(why));
  }

  static notFound(message) {
    return new ApiError("NotFound", message);
  }

  /** Why the call isn't signed in, e.g. its token expired. */
  static unauthorized(why) {
    return new ApiError("Unauthorized", why);
  }

  static tooManyRequests(message) {
    return new ApiError("TooManyRequests", message);
  }

  static badRequest(message) {
    return new ApiError("BadRequest", message);
  }

  /** What the caller is told. */
  public() {
    if (this.code === "CaptchaFailed") return "You failed to qualify as a human before our machine.";
    if (this.code === "InternalError") return "Internal server error";
    if (this.code === "Unauthorized") return "Unauthorized";
    return this.message;
  }

  body() {
    return { code: this.code, message: this.public() };
  }
}

/** `e` with what caused it, e.g. a failed request with the connection error under it. */
export function described(e) {
  let description = e?.message ?? String(e);
  let cause = e?.cause;
  while (cause) {
    description = `${description}: ${cause.message ?? String(cause)}`;
    cause = cause.cause;
  }
  return description;
}

/** `error` as an `ApiError`: an unexpected one is internal. */
export const asApiError = (error) => (error instanceof ApiError ? error : ApiError.internal(error));
