/** Separates the names in an id: `UG|BTECH|CSE`. */
export const SEP = "|";
/** Marks a part of a file too long to index as one: `Fees~1`. */
export const PART = "~";

export const idOf = (path) => path.join(SEP);

/** The node at `path` below `root`, if there is one. */
export function nodeAt(root, path) {
  let node = root;
  for (const name of path) {
    node = node?.children.find((child) => child.name === name);
  }
  return node;
}

/** The longest prefix of `path` that still exists below `root`. */
export function existing(root, path) {
  const kept = [];
  let node = root;
  for (const name of path) {
    const child = node.children.find((c) => c.name === name);
    if (!child) break;
    kept.push(name);
    node = child;
  }
  return kept;
}

export function counts(node) {
  let files = 0;
  let folders = 0;
  for (const child of node.children) {
    if (child.file) files++;
    if (child.children.length > 0) folders++;
    const below = counts(child);
    files += below.files;
    folders += below.folders;
  }
  return { files, folders };
}

export const isPart = (name) => name.includes(PART);

/** Why `name` can't name a new file or folder, if it can't. */
export function invalidName(name) {
  if (!name.trim()) return "Give it a name.";
  if (name !== name.trim()) return "Remove the spaces around the name.";
  if (name.includes(SEP)) return "A name can't contain “|”.";
  if (name.includes(PART)) return "A name can't contain “~”.";
  if (name.includes("#")) return "A name can't contain “#”.";
  return null;
}

/** A name for the part `name`, suggested in its place: `Fees~1`, the second part, → `Fees 2`. */
export const partName = (name) => name.replace(/~(\d+)$/, (_, n) => ` ${Number(n) + 1}`);
