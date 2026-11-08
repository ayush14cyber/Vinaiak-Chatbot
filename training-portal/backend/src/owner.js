// An admin of an approved org, as a request acts for: its org, who they are, their folders, and
// the org's own provider keys.

import { ApiError } from "./http.js";
import { covers, names, newNames } from "./paths.js";

export class Owner {
  constructor({ org, orgName, email = "", folders, byKey = false, keys }) {
    this.org = org;
    this.orgName = orgName;
    /** Who: the creator of the API keys they make. Empty for the watcher Lambda. */
    this.email = email;
    /** The folders they may change, and what's under them: `""` is the whole org. */
    this.folders = folders;
    /** Whether it called with an API key. */
    this.byKey = byKey;
    /** The org's own OpenRouter, Firecrawl and MongoDB keys. */
    this.keys = keys;
  }

  /** `names` of an id the caller may change: in one of their folders, or one itself. */
  names(id) {
    return this.allowed(names(id), id, false);
  }

  /** `newNames` of an id the caller may change. */
  newNames(id) {
    return this.allowed(newNames(id), id, false);
  }

  /** `names` of a folder the caller may delete or move: in one of their folders, not one itself. */
  innerNames(id) {
    return this.allowed(names(id), id, true);
  }

  allowed(parts, id, strictly) {
    if (covers(this.folders, id, strictly)) return parts;
    if (covers(this.folders, id, false)) {
      throw ApiError.forbidden("this folder was given to you, so you can't delete or move it");
    }
    throw ApiError.forbidden("this is outside the folders given to you");
  }
}
