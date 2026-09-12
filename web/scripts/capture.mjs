#!/usr/bin/env node
/**
 * Capture real crawls, so the page can work with no engine behind it.
 *
 * The walk is one recursive CTE in Postgres and the sizes come from the npm registry, so
 * there is no honest way to run this in a browser. What there is an honest way to do is show
 * real answers and say plainly that they were computed ahead of time - which is what the page
 * does, in the one place a reader could otherwise assume they were computed just now.
 *
 * Run against a live API with the packages already crawled:
 *   docker compose up -d --wait
 *   (cd api && uv run uvicorn depgraph.app:app --port 8100)
 *   node web/scripts/capture.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";

const API = process.env.API ?? "http://127.0.0.1:8100";

/**
 * Four packages, chosen for what they disagree about rather than for being popular.
 *
 * express reaches 72 packages by 232 paths, which is the whole argument about deduplication.
 * eslint is bigger again. vite is small and modern. chalk reaches NOTHING, and a tool that
 * only ever shows sprawl has not shown you what a clean dependency looks like.
 */
const PACKAGES = [
  { name: "express", version: "4.21.2", why: ["ms", "debug", "mime"] },
  { name: "eslint", version: "9.15.0", why: ["ms", "debug"] },
  { name: "vite", version: "6.0.5", why: ["esbuild"] },
  { name: "chalk", version: "5.3.0", why: [] },
];

const get = async (path) => {
  const r = await fetch(`${API}/${path}`);
  const body = await r.json();
  if (!r.ok) throw new Error(`${path}: ${body.detail ?? r.status}`);
  return body;
};

const bundle = { captured: new Date().toISOString().slice(0, 10), api: API, packages: {} };

for (const p of PACKAGES) {
  const q = `${encodeURIComponent(p.name)}?version=${encodeURIComponent(p.version)}`;
  const [size, duplicates, licenses, tree, graph] = await Promise.all([
    get(`size/${q}`),
    get(`duplicates/${q}`),
    get(`licenses/${q}`),
    get(`tree/${q}`),
    get(`graph/${q}`),
  ]);

  const why = {};
  for (const target of p.why) {
    // A path that does not exist is an answer too, and the page has to be able to give it.
    why[target] = await get(`why/${q}&target=${encodeURIComponent(target)}`).catch((e) => ({
      error: String(e.message ?? e),
    }));
  }

  bundle.packages[`${p.name}@${p.version}`] = { size, duplicates, licenses, tree, graph, why };
  console.log(`${p.name}@${p.version}: ${size.unique_packages} packages, ${size.paths} paths`);
}

mkdirSync("web/src", { recursive: true });
writeFileSync("web/src/precomputed.json", JSON.stringify(bundle, null, 2) + "\n");
console.log(`wrote web/src/precomputed.json (${PACKAGES.length} packages)`);
