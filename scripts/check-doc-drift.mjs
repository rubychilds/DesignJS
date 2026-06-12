#!/usr/bin/env node
/**
 * check-doc-drift.mjs — assert that derived facts match across all docs
 * that reproduce them. Closes finding F.40 + F.98 from the 2026-05-24
 * architecture review.
 *
 * What we check today:
 *   1. README's MCP tool count matches Object.keys(TOOL_SCHEMAS).length
 *   2. README's tool table lists every tool in TOOL_SCHEMAS (no missing names)
 *   3. README's test-spec count claim matches the e2e directory
 *
 * What we DON'T check (yet):
 *   - designjs-docs/ MDX coverage of TOOL_SCHEMAS (separate repo;
 *     handled by F.95 Option C — generate MDX from tools.ts)
 *   - CHANGELOG.md vs package.json versions (scripts/check-changelog.mjs)
 *
 * Exits 0 on clean state; non-zero with per-violation message otherwise.
 */
import { readFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(new URL(".", import.meta.url).pathname, "..");
const violations = [];

// 1 + 2: MCP tool list — requires the bridge to be built
let TOOL_SCHEMAS;
try {
  const mod = await import(`${root}/packages/bridge/dist/tools.js`);
  TOOL_SCHEMAS = mod.TOOL_SCHEMAS;
} catch (err) {
  console.error("[doc-drift] couldn't import TOOL_SCHEMAS from packages/bridge/dist —");
  console.error("            run `pnpm --filter @designjs/bridge build` first.");
  console.error("           ", err.message);
  process.exit(1);
}

const tools = Object.keys(TOOL_SCHEMAS);
const toolCount = tools.length;

const readme = readFileSync(`${root}/README.md`, "utf8");

// Spell-out cardinal numbers (good enough for one-off prose drift)
const cardinals = {
  9: "Nine", 10: "Ten", 11: "Eleven", 12: "Twelve",
  20: "Twenty", 21: "Twenty-one", 22: "Twenty-two", 23: "Twenty-three",
  24: "Twenty-four", 25: "Twenty-five",
};
const expectedCardinal = cardinals[toolCount] ?? String(toolCount);

if (!readme.includes(`${expectedCardinal} bidirectional tools`) &&
    !readme.includes(`${toolCount} bidirectional tools`)) {
  violations.push(
    `README.md doesn't say "${expectedCardinal} bidirectional tools" or "${toolCount} bidirectional tools" — TOOL_SCHEMAS has ${toolCount} entries`,
  );
}

if (!readme.includes(`(${toolCount} tools, full list above`)) {
  violations.push(
    `README.md doesn't claim "${toolCount} tools, full list above" in the MCP tools roadmap section — TOOL_SCHEMAS has ${toolCount} entries`,
  );
}

// 2: every tool name must appear in the README's tool tables
const missingFromReadme = tools.filter((name) => !readme.includes(`\`${name}\``));
if (missingFromReadme.length > 0) {
  violations.push(
    `README.md doesn't reference these tools (in backtick form): ${missingFromReadme.join(", ")}`,
  );
}

// 3: test-spec count
const specFiles = readdirSync(`${root}/e2e`).filter((f) => f.endsWith(".spec.ts"));
const specCount = specFiles.length;
let testCount = 0;
for (const f of specFiles) {
  const content = readFileSync(`${root}/e2e/${f}`, "utf8");
  const matches = content.match(/^\s*test\(/gm) ?? [];
  testCount += matches.length;
}

const claimMatch = readme.match(/Playwright E2E \((\d+)\+? tests across (\d+) specs?\)/);
if (claimMatch) {
  const claimedTests = parseInt(claimMatch[1], 10);
  const claimedSpecs = parseInt(claimMatch[2], 10);
  if (claimedTests !== testCount) {
    violations.push(
      `README.md claims ${claimedTests} tests in Playwright but actual is ${testCount}`,
    );
  }
  if (claimedSpecs !== specCount) {
    violations.push(
      `README.md claims ${claimedSpecs} specs but actual is ${specCount}`,
    );
  }
}

if (violations.length > 0) {
  console.error(`[doc-drift] ${violations.length} drift violation(s):`);
  for (const v of violations) console.error("  -", v);
  process.exit(1);
}

console.log(
  `[doc-drift] ✓ no drift — TOOL_SCHEMAS=${toolCount} tools, e2e=${testCount} tests across ${specCount} specs, README matches`,
);
