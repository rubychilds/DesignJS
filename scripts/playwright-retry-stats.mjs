#!/usr/bin/env node
/**
 * Surface Playwright tests that passed only after a retry.
 *
 * Reads `playwright-report/results.json` (produced by the `json` reporter,
 * enabled in CI via `playwright.config.ts`). Walks the report tree and prints
 * any test whose final status is `passed` but `retry > 0` — i.e. flakes that
 * the green CI check would otherwise hide.
 *
 * Informational only — exits 0 always, even with retried passes. This is a
 * signal, not a gate. Pair with F.13 (drop retries to 1) once flakes stop
 * showing up here.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const reportPath = resolve("playwright-report/results.json");
if (!existsSync(reportPath)) {
  console.log("[retry-stats] no report at", reportPath, "— skipping");
  process.exit(0);
}

const report = JSON.parse(readFileSync(reportPath, "utf8"));
const retriedPasses = [];

function walk(suite, parentTitle = "") {
  const title = parentTitle ? `${parentTitle} › ${suite.title}` : suite.title;
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      for (const result of test.results ?? []) {
        if (result.status === "passed" && (result.retry ?? 0) > 0) {
          retriedPasses.push({
            title: `${title} › ${spec.title}`,
            retry: result.retry,
            duration_ms: result.duration,
          });
        }
      }
    }
  }
  for (const child of suite.suites ?? []) {
    walk(child, title);
  }
}

for (const suite of report.suites ?? []) walk(suite);

if (retriedPasses.length === 0) {
  console.log("[retry-stats] ✓ no retried-pass tests");
} else {
  console.log(`[retry-stats] ${retriedPasses.length} tests passed after retry:`);
  for (const r of retriedPasses) {
    console.log(`  - [retry ${r.retry}] ${r.title}  (${r.duration_ms}ms)`);
  }
}
