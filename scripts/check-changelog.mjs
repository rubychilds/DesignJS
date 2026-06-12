#!/usr/bin/env node
/**
 * check-changelog.mjs — verify that every non-dev version in the three
 * publishable packages has a corresponding `## [<version>]` heading in
 * CHANGELOG.md. Exits 0 on match, non-zero on miss.
 *
 * Run in CI's verify job; lets manual releases catch missing CHANGELOG
 * entries before npm publish.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL(".", import.meta.url).pathname, "..");
const packages = [
  "packages/bridge/package.json",
  "packages/mcp-server/package.json",
  "packages/create-designjs/package.json",
];

const changelog = readFileSync(`${root}/CHANGELOG.md`, "utf8");
const missing = [];

for (const pkg of packages) {
  const j = JSON.parse(readFileSync(`${root}/${pkg}`, "utf8"));
  // Skip the dev marker version
  if (j.version.endsWith("-dev")) continue;
  const heading = `## [${j.version}]`;
  if (!changelog.includes(heading)) {
    missing.push(`${j.name}@${j.version} — missing "${heading}" in CHANGELOG.md`);
  }
}

if (missing.length > 0) {
  console.error("CHANGELOG.md is missing entries:");
  for (const m of missing) console.error("  -", m);
  process.exit(1);
}

console.log("✓ CHANGELOG.md has entries for all published-package versions");
