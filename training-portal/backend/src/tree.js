// An org's topic tree, from its doc ids, the folders it keeps while empty, and its watchers, as an
// admin with some folders sees it.

import { covers } from "./paths.js";

/**
 * The tree named `root` of `docIds` (`|`-separated paths), `folders` (paths of folders to show
 * even when empty), `watchers` (`[path, kind]` of watched files and folders) and `made` (paths of
 * the pages directory watchers made), as the admin with `given` folders sees it: only what's in
 * them, under the path to them. `""` gives the whole org.
 *
 * A node: `{name, file, watcher?, by_watcher?, outside?, assigned?, children}`, children sorted
 * by name.
 */
export function build(root, docIds, folders, watchers, made, given) {
  const draft = () => ({ file: false, watcher: null, byWatcher: false, outside: false, assigned: false, children: new Map() });
  const at = (node, path) => {
    for (const name of path.split("|")) {
      if (!node.children.has(name)) node.children.set(name, draft());
      node = node.children.get(name);
    }
    return node;
  };
  const has = (node, path) => {
    for (const name of path.split("|")) {
      node = node.children.get(name);
      if (!node) return false;
    }
    return true;
  };
  const theirs = (path) => covers(given, path, false);

  const tree = draft();
  for (const id of docIds.filter(theirs)) at(tree, id).file = true;
  for (const folder of folders.filter(theirs)) at(tree, folder);
  for (const [path, kind] of watchers) if (theirs(path)) at(tree, path).watcher = kind;
  // Only pages there are: a link can outlive its page, if a removal failed halfway.
  const docs = new Set(docIds);
  for (const page of made.filter(theirs).filter((p) => docs.has(p))) at(tree, page).byWatcher = true;
  // Only folders there are: one deleted or renamed above them shows nothing.
  for (const folder of given.filter((f) => f.length > 0 && has(tree, f))) {
    at(tree, folder).assigned = true;
    let above = folder;
    while (above.includes("|")) {
      above = above.slice(0, above.lastIndexOf("|"));
      at(tree, above).outside = true;
    }
  }
  tree.outside = !given.some((f) => f.length === 0);

  const finish = (name, d) => {
    const node = { name, file: d.file };
    if (d.watcher) node.watcher = d.watcher;
    if (d.byWatcher) node.by_watcher = true;
    if (d.outside) node.outside = true;
    if (d.assigned) node.assigned = true;
    // By name, as a sorted map orders them.
    node.children = [...d.children.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((n) => finish(n, d.children.get(n)));
    return node;
  };
  return finish(root, tree);
}
