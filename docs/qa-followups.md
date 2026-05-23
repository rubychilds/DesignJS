# QA-pass followups

Bounded bugs and gaps surfaced during the 2026-05-23 test-coverage and CI audit (commits `633b354`–`80b6366`, `044f0ac`–`d8057e8`).

Broader OSS-launch hygiene (lint, coverage thresholds, Tailwind v4 `@theme` E2E) and additional test-coverage gaps (inspector sections, CLI/create-designjs/mcp-server, Chrome extension build artifact) are **not** captured here — they're in the test-audit working notes and the relevant ADRs. This doc is for the four specific findings that came out of writing the Wave 1 unit tests and wiring CI.

---

## Status (as of 2026-05-23)

| ID    | Item                                                              | Severity                  | Status |
| ----- | ----------------------------------------------------------------- | ------------------------- | ------ |
| QA-1  | `jsx-export` merge regex doesn't track brace nesting              | Medium                    | Resolved (`42e63ac`) |
| QA-2  | Bridge schemas not `.strict()` — unknown fields silently accepted | Medium                    | Open   |
| QA-3  | No `EventMessage` schema in bridge protocol                       | Low (until events needed) | Open   |
| QA-4  | `chrome-ext-orbis` package is unrelated to DesignJS               | Low                       | Open   |

---

## QA-1 — `mergeStylesIntoHtml` regex doesn't track brace nesting

**File:** [packages/app/src/canvas/jsx-export.ts](../packages/app/src/canvas/jsx-export.ts)
**Discovered:** Wave 1 unit test pass, commit `48f9e34`.
**Existing test:** the `LIMITATION:` case in [packages/app/src/canvas/__tests__/jsx-export.test.ts](../packages/app/src/canvas/__tests__/jsx-export.test.ts) documents current behavior.

### Current behavior

`mergeStylesIntoHtml` walks top-level CSS rules with `/([^{}]+)\{([^{}]+)\}/g`. The pattern doesn't track brace nesting, so `#id` rules nested inside `@media (...) { ... }` (or `@supports`, `@container`, `@layer`) match as top-level rules and get inlined unconditionally into the matching element's `style` attribute. The doc comment claims `@media` rules are ignored — they aren't.

### Why it matters

The MCP `get_jsx` tool emits incorrect JSX for any source HTML with `@media`-scoped id rules: media-conditional styles are applied at all viewports. Silent correctness bug, not a crash.

### Proposed approach

Three options, least → most invasive:

1. **Brace-depth counter.** Track depth as the parser walks; only inline rules at depth 0, and skip any rule whose selector starts with `@`. Minimal change (~10–15 lines). Handles `@media`/`@supports`/`@container`/`@layer` uniformly.
2. **`CSSStyleSheet` parser.** `new CSSStyleSheet().replace(cssText)` in jsdom, walk the parsed rule list, only inline `CSSRule.STYLE_RULE` at top level. More correct around comments/escapes; ties correctness to jsdom's CSS parser at test time.
3. **postcss.** Already a transitive Tailwind dep. Most correct, biggest scope change.

**Recommended: option 1.** Flip the `LIMITATION:` test to a passing assertion as the acceptance criterion.

### Acceptance

- `LIMITATION:` test becomes a passing assertion (rename it accordingly).
- `@media` / `@supports` / `@container` / `@layer` nested id rules are not inlined.
- Existing 32-case `jsx-export.test.ts` suite still passes.

---

## QA-2 — Bridge schemas not `.strict()`

**Files:** [packages/bridge/src/protocol.ts](../packages/bridge/src/protocol.ts), [packages/bridge/src/tools.ts](../packages/bridge/src/tools.ts)
**Discovered:** Wave 1 bridge schema tests, commit `2af6fac`.

### Current behavior

`HelloMessage`, `RequestMessage`, every `ResponseMessage` success arm, every tool Output, and `ComponentNode` silently accept unknown fields. Only a subset of tool Inputs (e.g. `PingInput`, `GetTreeInput`) already use `.strict()`.

### Why it matters

The bridge is the contract boundary between three peers (MCP server, canvas, browser extension). Unknown fields slip through silently:

- When the canvas adds a field, the MCP server doesn't see it.
- When the MCP server sends a typo'd field, no peer notices.
- Schema drift between releases is undetectable.

For an OSS project where third parties may build their own MCP clients or canvas peers against the bridge, this is also a public-API hygiene issue.

### Proposed approach

1. Add `.strict()` to every top-level schema in `protocol.ts` and every Input + Output in `tools.ts`. Cross-check each arm of the `BridgeMessage` discriminated union.
2. **Before** adding `.strict()`, run `pnpm smoke:bridge` and the Playwright E2E suite with a temporary `.passthrough()` → log handler in the schemas to map the actual unknown-field surface. Fix any current senders that rely on extras, then strictify.
3. Extend each schema test (108 cases today) with a third assertion: unknown field rejected.

### Watch-outs

- `ComponentNode` is recursive — make sure `.strict()` applies through children, not just the root.
- `BridgeRole`-keyed routing inside the bridge may not care about extras even if peers do. Decide whether tightening at the schema level is the right layer or whether the bridge itself needs to reject as well.

### Acceptance

- Every message + tool Input + tool Output schema is `.strict()`.
- `pnpm smoke:bridge` + Playwright E2E green.
- Schema tests assert unknown-field rejection.

---

## QA-3 — No `EventMessage` schema in bridge protocol

**File:** [packages/bridge/src/protocol.ts](../packages/bridge/src/protocol.ts)
**Discovered:** Wave 1 bridge schema tests, commit `2af6fac`.

### Current behavior

`BridgeMessage = HelloMessage | RequestMessage | ResponseMessage`. There is no push-from-canvas event channel. The MCP server cannot observe canvas state changes (selection, frame add/delete, undo step, token edits) without polling.

### Why it matters

This is a **missing feature**, not a bug. Currently no flow needs server-side events; flagged because the right time to add the schema is **before** the first feature needs it — retrofitting senders and listeners on three peers is more expensive than designing the channel up front.

### Open questions to resolve before implementing

1. **Which events?** Plausible candidates: `selection:changed`, `artboards:changed`, `tokens:changed`, `undo:step`, `frame:loaded`. Don't add until a real driving use case exists.
2. **Fire-and-forget vs. RPC-style?** Events as broadcast pubs are simplest. If we want delivery guarantees or replay, that's a different design.
3. **Request correlation?** Should `EventMessage` carry an optional `causedBy: requestId` so a consumer can match an event back to the request that triggered it?
4. **Ordering?** Within one peer pair, events are TCP-ordered; across peers (canvas → bridge → many subscribers), do we need a sequence number?

### Proposed approach

Defer implementation. When the first event-driven feature is committed to the roadmap:

1. Write a short ADR (or addendum to whichever ADR owns the bridge protocol) covering the four open questions.
2. Add `EventMessage` to `protocol.ts` and widen `BridgeMessage`.
3. Add schema tests + a smoke test that exercises a publish/subscribe round-trip across two peers.

### Acceptance

- ADR exists answering the four questions, **before** any event-driven feature lands.

---

## QA-4 — `chrome-ext-orbis` package is unrelated to DesignJS

**Path:** [packages/chrome-ext-orbis/](../packages/chrome-ext-orbis/)
**Discovered:** Wave 2 CI wiring, commit `80b6366`.

### Current state

- Package name: `orbis-chrome-extension`, version 1.0.2.
- Description: *"Chrome extension for importing contacts from Luma events and other sources into Orbis."*
- 11.6k LOC source + 15.2k LOC tests (31 test files).
- 1 known-failing test (`TIMEOUTS.EXTRACT` expected 30_000, actual 600_000) — predates today.
- Not referenced by any `@designjs/*` package or doc (grep before deleting to confirm).
- Currently excluded from CI by the `@designjs/*` scope on the unit-test step (commit `80b6366`).

### Why it matters

- 11.6k+ LOC of unrelated, CI-excluded code in the public DesignJS repo at launch confuses contributors and bloats the open-source footprint.
- The stale failing test surprises anyone running `pnpm -r test` locally without the filter.
- Carrying unrelated product code complicates license attribution, SBOM, and dependency scanning.

### Proposed approach

1. Confirm `orbis-chrome-extension` has a canonical home elsewhere (separate repo or archived snapshot). If not, push to a separate repo first so history is preserved.
2. `grep -r 'orbis-chrome-extension\|chrome-ext-orbis' --include='*.{ts,tsx,js,mjs,json,yml,yaml,md}'` to confirm nothing references it.
3. Delete `packages/chrome-ext-orbis/` and any references in `pnpm-workspace.yaml`, root `package.json` scripts, and `.github/workflows/`.
4. `pnpm install` to update the lockfile.
5. Drop the `@designjs/*` filter from the CI test step in `.github/workflows/ci.yml` — `pnpm -r --if-present test` becomes correct without the scope filter once the unrelated package is gone.

### Acceptance

- `packages/chrome-ext-orbis/` removed.
- No `chrome-ext-orbis` or `orbis-chrome-extension` references in the repo.
- `pnpm -r --if-present test` green without the `@designjs/*` filter.
- CI workflow updated to drop the filter (still uses `--if-present` so `cli`/`create-designjs`/`mcp-server` are tolerated).

### Risk

Low. No `@designjs/*` package depends on it. Pre-delete grep is the safety net.
