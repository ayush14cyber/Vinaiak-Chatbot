// What the tests share: the real corpus in `tests/data`, and its labelled queries.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DocumentInput } from "../src/index.js";

export const DATA = join(dirname(fileURLToPath(import.meta.url)), "data");

/** The labelled queries of `golden.json`. */
export function goldenSet() {
  const { queries } = JSON.parse(readFileSync(join(DATA, "golden.json"), "utf8"));
  return queries.map(({ query, relevant }) => ({ query, relevant: new Set(relevant) }));
}

/** The 21 real pages, as documents with their institute's breadcrumb. */
export function corpus() {
  const docs = [];
  for (const [folder, institute] of [
    ["bitmesra", "BIT Mesra"],
    ["iitism", "IIT ISM Dhanbad"],
  ]) {
    const names = readdirSync(join(DATA, folder))
      .filter((name) => name.endsWith(".txt"))
      .sort();
    for (const name of names) {
      const text = readFileSync(join(DATA, folder, name), "utf8");
      docs.push(new DocumentInput(`${folder}/${name}`, text).withBreadcrumb([institute, "website"]));
    }
  }
  return docs;
}
