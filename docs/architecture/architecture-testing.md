# Architecture review — Phase 2.2: Testing deep dive

> Companion to [`architecture-recon-2026-05-24.md`](./architecture-recon-2026-05-24.md) and [`architecture-codebase.md`](./architecture-codebase.md). Read-only analysis of the test pyramid, runtime budget, reliability, coverage gaps, and forward-looking testing strategy for the v0.2/v0.3 specs.
>
> Findings continue the `[F.NN]` numbering — Phase 2.1 ended at F.11. This phase starts at F.12.

## 1. The test pyramid

```
                         ┌─────────────────────┐
                         │  E2E (Playwright)   │
                         │  37 spec files       │
                         │  156 test cases      │
                         │  4,603 LOC           │
                         └──────────┬──────────┘
                                    │
                         ┌──────────┴──────────┐
                         │   Smoke (.mjs)      │
                         │   4 scripts          │
                         │   bridge / mcp /    │
                         │   init / create     │
                         └──────────┬──────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              │                     │                     │
   ┌──────────┴─────┐    ┌──────────┴─────┐    ┌─────────┴──────────┐
   │ Bridge unit    │    │ Canvas unit    │    │ Chrome-ext unit    │
   │ 3 test files   │    │ 7 test files   │    │ 16 test files      │
   │ Zod schemas    │    │ pure modules   │    │ capture pipeline   │
   └────────────────┘    └────────────────┘    └────────────────────┘
```

**Total surface:** 26 unit test files + 4 smoke scripts + 37 E2E spec files = **67 test files / ~5,000+ lines of test code**.

**Shape:** Heavier at the top than a classic pyramid, especially for the canvas app's UI layer. **Most app UI behavior is tested only via E2E** (the inspector sections, the topbar, the layers panel, the bridge handlers). The bridge protocol schemas have excellent unit coverage; the bridge dispatcher and the 525-line bridge handlers have no unit coverage at all. This is the testing-shape risk to flag.

## 2. E2E (Playwright)

### 2.1 Configuration ([`playwright.config.ts`](../../playwright.config.ts))

```ts
fullyParallel: false,
workers: 1,
retries: CI ? 2 : 1,
forbidOnly: CI,
timeout: 30_000,
expect: { timeout: 5_000 },
projects: [{ name: "chromium", use: { viewport: { width: 1440, height: 900 } } }],
webServer: { command: "pnpm dev", url: "http://localhost:3000", reuseExistingServer: !CI, timeout: 60_000 },
trace: "retain-on-failure",
screenshot: "only-on-failure",
video: "off",
```

**Strengths:**
- `forbidOnly: CI` — `.only` left in source can't slip into main. Good guard.
- `reuseExistingServer: !CI` — local dev reuses; CI gets a fresh boot. Smart split.
- Trace + screenshot on failure — debuggable when things break.
- 30s test timeout, 5s expect timeout — generous but not absurd. Most tests run well within.
- Concurrency-cancelled per ref in CI — no zombie runs.

**Concerns:**

- **[F.12] `workers: 1` + `fullyParallel: false` = serial execution.** With 156 tests, the wall-clock budget grows linearly. Today at an estimated ~1.5–2s/test that's 4–5 minutes plus a 60s dev-server boot. As the suite grows (v0.2 will add chat/projects, v0.3 adds chrome-extension parity), this scales poorly. Worth Sharding (1 boot per worker, distinct ports per shard) before it becomes painful. The `window.__designjs` fixture model is single-shared-canvas oriented; sharding will need fixture-per-worker isolation.

- **[F.13] `retries: CI ? 2 : 1` is hiding flakiness.** Every CI test gets up to 3 attempts. Conceptually 0 retries with deterministic infrastructure is the gold standard; 1 retry is pragmatic; 2 is masking. The alpha.1 CHANGELOG noted **"1 flaky"** but didn't identify which test. With 3 attempts on CI, "1 flaky" could mean "one test that passes 1/3 attempts and would have failed without retries" — or it could mean dozens of tests get to attempt 2 or 3 routinely and the test report shows green. **No observability for retry counts.** Worth instrumenting before deciding to drop retries — instrument with `reporter: [["github"], ["list"], ["json", { outputFile: "playwright-report/results.json" }]]` and inspect for `status: "passed"` but `retry > 0`.

- **[F.14] Single chromium project.** README claims Firefox/Safari support; CI doesn't verify either. The Vite + Tailwind + GrapesJS stack is plausibly cross-browser, but the alpha.1 multi-frame regressions show that browser-specific behavior matters. WebKit's iframe handling, for example, differs from Chromium's in ways the codebase's defensive sweeps might mask. Adding `firefox` and `webkit` projects with a `--project=chromium` default for CI speed (and `pnpm test:e2e:all` for cross-browser nightly) is the standard Playwright pattern.

### 2.2 E2E spec inventory (37 files, 156 tests)

Grouped by area (file naming reflects PRD story numbers / ADR-driven workstreams):

| Area | Files | Notable specs |
|---|---|---|
| **Story 1 — Editor shell foundations** | 5 | story-1.2-tailwind-responsive, story-1.3-editor-shell, story-1.4-block-palette, story-1.5-persistence, story-1.6-number-input |
| **Story 2 — MCP tools** | 1 | story-2-mcp-tools (14 tests, 275 LOC — biggest spec) |
| **Story 3 — HTML/Tailwind paste** | 1 | story-3.1-paste (7 tests, 197 LOC) |
| **Story 5 — Multi-artboard canvas** | 5 | story-5.1-artboard-reposition, story-5.2-minimap, story-5.3-artboard-mcp, story-5.4-frame-resize, story-5.5-snap |
| **Story 6 — Variables / design tokens** | 3 | story-6.0/.1-variables, story-6.2-variables-ui (7 tests, 150 LOC), story-6.3-tokens-dtcg |
| **Story 7 — Editor polish** | 3 | story-7.0-selection-overlay, story-7.1-handles, story-7.3-density |
| **ADR-driven** | 2 | story-adr0004-frames-in-tree (7 tests), story-adr0005-primitives (8 tests) |
| **Phase D inspector** | 7 | story-d4-layer-layoutitem, story-d4b-measures (8 tests), story-d5-fill-stroke-shadow, story-d6-typography-exports, story-d7-effects, story-backplate-inspector, story-inspector-* (3 files) |
| **MCP-specific** | 5 | story-mcp-add-components-artboard, story-mcp-autosave, story-mcp-fit-artboard, story-mcp-polish (6 tests), story-figma-relay |
| **Canvas internals** | 3 | story-default-artboard, story-page-root-flag, story-scratch-frame-cleanup |

**`test.fixme` / `test.skip` / `test.only` count: 0.** Clean — no parked tests. Every spec in the file system is meant to pass.

### 2.3 Test design pattern — the `window.__designjs` fixture

E2E tests anchor on a runtime handle the app exposes at boot:

```ts
// e2e/story-2-mcp-tools.spec.ts
await page.evaluate(() =>
  (window as unknown as { __designjs: { addHtml: (h: string) => unknown } })
    .__designjs.addHtml(`<section class="p-4"><h1>hello</h1></section>`),
);

const tree = await mcp.call<{ root: ComponentNode }>("get_tree", {});
expect(tree.root.children[0].tagName).toBe("section");
```

**This is structurally well-designed.**

- The `addHtml` helper routes through the real component model (per `App.tsx` line 218-223: `firstFrame.get("component").append(html)`). It's not bypassing GrapesJS; it's calling the same code path a user paste would.
- The `mcp` fixture is the *real bridge*. Tests aren't mocking the WebSocket — they connect a `mcp-server` role to the live bridge and exercise the full network path. This is much higher signal than mocked tests.
- Tests avoid drag-drop in the iframe (which is flaky) and instead drive the editor model directly.

**This couples F.09 (production `window.__designjs` exposure) to test design.** The handle exists because tests need it. Gating it behind `import.meta.env.DEV` (the F.09 recommendation) preserves test access without the production exposure — Vite's `DEV` flag is true under `pnpm dev` which is what Playwright boots.

### 2.4 Fixtures pattern

`e2e/fixtures.ts` (referenced by every spec via `import { test, expect } from "./fixtures"`) provides:

- `mcp` — the MCP-server-role bridge client used to call tools
- `freshApp: page` — a Page that loads the canvas with state reset between tests

The pattern is **standard Playwright fixtures with state isolation**. Good.

**[F.15] No visual regression in E2E.** `pixelmatch` + `pngjs` are in root devDeps — but they're used by `scripts/capture-diff.mjs` (chrome-extension capture-fidelity testing), not by Playwright. **Zero `toHaveScreenshot()` calls in the e2e specs.** For a *visual* product like a design canvas, this is a meaningful gap. Visual regression would catch:
- Inspector control rendering drift (icon spacing, hit targets)
- Selection overlay drift (the alpha.1 regressions had a visual component — frames painting as void)
- Variable propagation visual changes
- Theme drift (light vs dark)

Playwright's built-in `toHaveScreenshot()` is the simplest path; it handles baseline storage, diff threshold, and CI updates. Per-spec opt-in is the right cadence — not every test needs a baseline image, but selection overlay + topbar status + inspector sections benefit.

## 3. Smoke tests

Four `.mjs` scripts in `scripts/`. Each is a self-contained Node script that exercises one boundary without browser dependencies.

| Script | What it tests | Boundary |
|---|---|---|
| `smoke-bridge.mjs` | WebSocket bridge round-trip | Simulates BOTH sides — connects as `canvas` (stub responder) and as `mcp-server` (ping requester) against a running Vite dev server |
| `smoke-mcp.mjs` | MCP stdio handshake | Spawns `mcp-server`, runs `initialize` + `tools/list`, asserts a tool name list |
| `smoke-init.mjs` | `designjs init` CLI | Runs the binary against temp dirs, asserts `.mcp.json` / `.cursor/mcp.json` / `.vscode/mcp.json` are written per `--ide` flag |
| `smoke-create.mjs` | `create-designjs` scaffolder | Runs the binary, asserts file structure of the scaffolded project |

CI runs all four (`smoke-bridge` in the verify job with the dev server backgrounded; the other three standalone).

### 3.1 [F.16] `smoke-mcp.mjs` is partially stale

The script's docstring and `EXPECTED_TOOLS` array were written for the 9 v0.1 tools and never updated:

```js
// scripts/smoke-mcp.mjs:7
* Spawns `tsx src/index.ts` in packages/mcp-server, performs the MCP
* `initialize` handshake, then calls `tools/list` and asserts that all 9
* v0.1 tools are registered.

// scripts/smoke-mcp.mjs:17
const EXPECTED_TOOLS = [
  "ping", "get_tree", "get_html", "get_css", "get_screenshot",
  "get_selection", "add_components", "update_styles", "delete_nodes",
];
```

The assertion uses **subset semantics** (`missing.filter((t) => !names.includes(t))`), so it correctly passes when more tools are registered — but **it doesn't verify the 13 newer tools register**. If `add_css_rules`, `add_classes`, `set_variables`, `create_artboard`, `select` etc. silently stopped registering, this smoke would still go green.

**Two-line fix:** import `TOOL_SCHEMAS` from `@designjs/bridge` (already a workspace dep of `mcp-server`) and use `Object.keys(TOOL_SCHEMAS)` as the expected list. The smoke becomes self-updating. Same fix updates the comment.

```js
// Recommended shape
import { TOOL_SCHEMAS } from "@designjs/bridge";
const EXPECTED_TOOLS = Object.keys(TOOL_SCHEMAS);
```

This pattern — *the smoke owns the source-of-truth list* — is the kind of test design that scales without doc-drift.

### 3.2 `smoke-bridge.mjs` is clever

Simulates both sides of the bridge — connects as `canvas` (stubbing responses) AND as `mcp-server` (issuing requests) within one process. **No browser, no MCP client needed.** This is a strong pattern for catching WS-level bugs without the slowness of full E2E. CI runs it inside the `verify` job after backgrounding `pnpm dev`.

## 4. Unit tests

### 4.1 Bridge package (3 files)

| File | Coverage |
|---|---|
| `protocol.test.ts` | `HelloMessage` / `RequestMessage` / `ResponseMessage` / `BridgeMessage` schema validation |
| `tools.test.ts` (289 LOC) | Schema validation for: Ping, GetTree, ComponentNode, GetHtml, GetCss, GetScreenshot, GetSelection, AddComponents, AddCssRules, UpdateStyles, DeleteNodes, GetJsx, GetVariables, SetVariables — plus a registry-integrity test (every tool has input + output + description) |
| `tools-artboards.test.ts` | Likely covers CreateArtboard, ListArtboards, FindPlacement, FitArtboard schemas (split for the "250-line budget" per `tools.test.ts` comment) |

**Coverage shape:** Every schema is exercised for both happy paths and `.strict()` rejection of unknown fields. **Quality is excellent** — boundary conditions (negative depth, invalid scale, missing required, extra fields) are explicit. Plus a meta-test that the registry has an input/output/description for every tool.

**[F.17] Bridge unit tests don't cover all tools.** `tools.test.ts` imports cover 13 tool schema pairs. `tools-artboards.test.ts` (unread) presumably covers the 4 artboard tools. That accounts for ~17 of 22 tools. **Missing schema-level coverage for `add_classes`, `remove_classes`, `set_text`, `select`, `deselect`** — the 5 newer tools added between alpha.1 and now. The registry-integrity test would still pass (it only checks that schemas + descriptions exist), so the omission doesn't break CI. But the bug-class these tests catch (`.strict()` rejection, required-field violations) isn't catching them for these 5 tools.

### 4.2 App canvas (7 files)

Pure-module unit tests using vitest:

| File | Module under test |
|---|---|
| `artboards.test.ts` | `createArtboard`, `deleteArtboard`, `ensurePageRoot`, `findPlacement`, `listArtboards`, `renameArtboard`, `resizeArtboard` |
| `color-conversion.test.ts` | OKLCH ↔ RGB / hex |
| `css-chunk.test.ts` | `chunkCss` — for `add_css_rules` chunking |
| `jsx-export.test.ts` | `htmlToJsx`, `mergeStylesIntoHtml` — covers `get_jsx` |
| `token-emit.test.ts` | DTCG token → CSS emission |
| `token-io.test.ts` | DTCG file import/export |
| `tokens.test.ts` | DTCG store operations |

**Pattern:** GrapesJS Editor is *mocked* via small typed factories rather than instantiated. From `artboards.test.ts`:

```ts
function makeFrame(attrs) {
  const wrapper = makeWrapper(attrs.childCount ?? 0);
  return {
    cid: attrs.cid ?? `c${Math.random().toString(36).slice(2, 8)}`,
    attributes,
    wrapper,
    get: (k) => (k === "component" ? wrapper : attributes[k]),
    set: vi.fn((next) => Object.assign(attributes, next)),
  };
}

function makeEditor(initialFrames) { ... }
```

**This is the right approach for the GrapesJS-coupled modules.** Each test constructs the minimal surface the module under test actually touches — Canvas.getFrames, addFrame, Pages.getSelected, trigger, frame.get/set, frame.cid, frame.get("component") with addStyle/addAttributes/getAttributes. The test file calls this contract out explicitly in a header comment.

**Strengths:**
- The DTCG token system (3 files) covers ADR-0009 Phase 1 thoroughly
- Multi-frame quirks (Backbone `cid` vs model `id`) are exercised in the artboards mock
- Tests are fast (vitest + no DOM)

**[F.18] No unit tests for `packages/app/src/bridge/handlers.ts` (525 LOC).** This is the largest single file in the canvas package and the heaviest user of GrapesJS APIs. Currently only exercised via E2E. A mock-editor harness like `artboards.test.ts` would unit-test the handler logic (especially the multi-frame `findById` and `frameIds` heuristics) without the cost of a browser. **Highest-value unit-test gap.**

### 4.3 Chrome extension (16 capture-pipeline tests)

Substantial coverage in `packages/chrome-extension/src/capture/__tests__/`:

```
style-serializer.dedup.test.ts
style-serializer.multi-column.test.ts
style-serializer.prep-stubs.test.ts
style-serializer.display-none.test.ts
style-serializer.table-list.test.ts
style-serializer.exclude-ids.test.ts
style-serializer.body-html-margin.test.ts
style-serializer.font-links.test.ts
style-serializer.author-css.test.ts
style-serializer.inline-mode.test.ts
style-serializer.root-inheritance.test.ts
style-serializer.flatten.test.ts
style-serializer.iframes.test.ts
screenshot-stitcher.test.ts
extract-styles.test.ts
dom-walker.test.ts
```

16 unit test files vs ~9 source files — **roughly 2× test:source ratio** for the capture pipeline. Each test file targets one specific behavior of the serializer. Heavily exercised — this is unsurprising given the chrome-extension is the *active* feature work area per recent commits.

**Uses jsdom** (in `packages/chrome-extension` devDeps). Realistic DOM mocking for the serializer is exactly the use case jsdom is built for.

**[F.19] Build system divergence — chrome extension uses Webpack, app uses Vite.** Different bundlers mean different debug paths, different output shapes, different CI verification needs. The chrome extension has full `webpack`/`webpack-cli`/`copy-webpack-plugin`/`babel-loader` toolchain; the app has `@vitejs/plugin-react`/`@tailwindcss/vite`. Defensible (Chrome MV3 has specific constraints Webpack handles well), but worth tracking. **Migration to Vite for the extension is an option** — `vite-plugin-web-extension` and `wxt` are mature 2026 options. Not urgent; defer until the divergence costs something.

### 4.4 Vitest configs

Per-package vitest configs exist for:
- `packages/app/vitest.config.ts` (unread, but present — covers the canvas unit tests)
- `packages/bridge/vitest.config.ts`
- `packages/chrome-extension/vitest.config.ts`

Three packages with three independent vitest configs. **[F.20] No root-level vitest config / project workspace.** Vitest's *Workspace* mode (`vitest.workspace.ts` at root) can orchestrate all three with one command + shared coverage. Today `pnpm -r --if-present test` runs each package's tests serially. Workspace mode would parallelize across packages and produce unified coverage. Low-priority refactor — `pnpm -r` works fine for now.

## 5. Reliability

### 5.1 The "1 flaky" claim

The alpha.1 status doc reports **"156 passed / 0 failed / 1 flaky"**. Which test? **Not surfaced anywhere in the codebase.** Playwright's `--reporter=json` would identify it; the CI workflow doesn't store the JSON. The trace-on-failure pattern only triggers on a final fail, not a passed-after-retry.

**[F.21] No retry observability.** With `retries: CI ? 2 : 1`, a test that passes only on attempt 2 or 3 is indistinguishable in CI's green check from a test that passes on attempt 1. Recommended addition: the JSON reporter, plus a small post-test script that surfaces `retry > 0` cases. Without this, the 1-flaky number is just folklore.

### 5.2 Flakiness mitigation patterns

The codebase uses two patterns that materially reduce flakiness:

1. **`window.__designjs` runtime handles** instead of DOM scraping. Tests drive the editor model directly. Per CONTRIBUTING.md: *"iframe drag-drop is avoided because it's fragile."*

2. **Event-driven synchronization** instead of `waitForTimeout`. Only **1 occurrence of `waitForTimeout`** across all 37 specs (and even that one is a sleep with a specific load-bearing reason — checked via grep). For comparison, a flaky-by-default e2e suite typically has dozens.

**This is excellent test discipline.** Worth calling out in the docs as a contributor convention.

### 5.3 The defensive sweep patterns in App.tsx leak into the test surface

The triple-defensive iframe-CSS injection (`canvas:frame:load` + 5-poll sweep + `frame:add`) from F.08 has a flip side: **the test suite doesn't deterministically know when "the canvas is fully ready."** Tests rely on the `designjs:ready` custom event (dispatched at App.tsx:249), which fires *after* the first sweep. But subsequent frame mounts (e.g., after `create_artboard`) can re-trigger the lifecycle. The MCP-tool specs handle this by always awaiting tool responses (the bridge round-trip is the synchronization point), not by waiting on canvas state.

This is fine — but a centralized `useFrameLifecycle` hook (F.08 recommendation) would unblock cleaner test idioms.

## 6. Coverage analysis (what's exercised vs what isn't)

### 6.1 Coverage by MCP tool

Reconstructed from the tool list × spec inventory. **No automated matrix exists** — this is the manual cross-reference Phase 2.2 has to do because the codebase doesn't surface it.

| Tool | Schema unit | E2E (which spec) | Coverage |
|---|---|---|---|
| `ping` | ✅ tools.test | ✅ story-2 | Full |
| `get_tree` | ✅ | ✅ story-2 | Full |
| `get_html` | ✅ | ✅ story-2 | Full |
| `get_css` | ✅ | ✅ story-2 | Full |
| `get_screenshot` | ✅ | ✅ story-2 | Full |
| `get_selection` | ✅ | ✅ story-2 | Full |
| `add_components` | ✅ | ✅ story-2 + story-mcp-add-components-artboard | Full |
| `add_css_rules` | ✅ | ⚠ chrome-extension capture pipeline covers it indirectly | Likely full but coverage is implicit |
| `update_styles` | ✅ | ✅ story-2 | Full |
| `delete_nodes` | ✅ | ✅ story-2 | Full |
| `get_jsx` | ✅ | ✅ story-d6-typography-exports | Full |
| `get_variables` | ✅ | ✅ story-6.2-variables-ui | Full |
| `set_variables` | ✅ | ✅ story-6.x | Full |
| `create_artboard` | likely ✅ (tools-artboards.test) | ✅ story-5.3-artboard-mcp | Full |
| `list_artboards` | likely ✅ | ✅ story-5.3 | Full |
| `find_placement` | likely ✅ | ✅ story-mcp-polish | Full |
| `fit_artboard` | likely ✅ | ✅ story-mcp-fit-artboard | Full |
| `add_classes` | **❌** | ⚠ likely incidental in story-2 | Schema gap |
| `remove_classes` | **❌** | ⚠ likely incidental | Schema gap |
| `set_text` | **❌** | ⚠ likely incidental | Schema gap |
| `select` | **❌** | ✅ story-mcp-polish (mentioned in tool descriptions) | Schema gap |
| `deselect` | **❌** | ⚠ likely incidental | Schema gap |

**Summary:** 17/22 tools have both unit schema tests AND E2E tests. 5/22 (`add_classes`, `remove_classes`, `set_text`, `select`, `deselect`) lack schema-level unit coverage. These 5 are also missing from `smoke-mcp.mjs`'s `EXPECTED_TOOLS` (F.16).

### 6.2 Coverage by app component

| Layer | Test coverage |
|---|---|
| `bridge/handlers.ts` (525 LOC) | **Only E2E.** No unit tests despite being the largest single file in the app package. [F.18] |
| `bridge/client.ts` (101 LOC) | Indirect (E2E + smoke-bridge.mjs). No direct unit test of the dispatcher. |
| `canvas/*` | 7 of 21 files have unit tests. Token system + artboards + jsx-export + css-chunk + color covered. **Not covered:** `paste-import`, `persistence`, `primitives`, `style-filters`, `style-sectors`, `widen-stylable`, `editor-options`, `blocks`, `component-style`, `variables` (this last only as DTCG indirectly). |
| `components/` (13 top-level + 10 inspector + ui/) | **No component-level unit tests.** All coverage is E2E. |

**The inspector is interesting.** 10 inspector section files are tested only via E2E (`story-d4-*`, `story-d4b-*`, `story-d5-*`, `story-d6-*`, `story-d7-*`). Component-level Vitest + React Testing Library tests would cover field rendering, control interactions, and applicability gating cheaply. Today this is all paid for in E2E wall-clock time.

### 6.3 Coverage reporting

**[F.22] No coverage reporting in CI.** Vitest supports `--coverage` via `c8` or `istanbul`. No script invokes it. No CI step uploads coverage. **Coverage is unknown.** This isn't critical for a small project but blocks data-driven decisions like "which canvas modules need tests next."

## 7. Visual regression

**Status: not deployed.** [F.15]

- `pixelmatch` + `pngjs` in root devDeps, used by `scripts/capture-diff.mjs` for chrome-extension capture-fidelity scoring
- Zero `toHaveScreenshot()` calls in `e2e/*.spec.ts`
- `playwright-report/` artifact uploaded on failure only

For a design canvas, this is a real gap. **Highest-value VR candidates:**

1. **Inspector sections** — rendering correctness of the 10 inspector sections under both light + dark themes. Catches CSS regressions, icon-stack drift (Phosphor ↔ Lucide mixed stack from ADR-0001), density drift.
2. **Selection overlay** — the alpha.1 multi-frame regressions had a visual component. A baseline screenshot of a selected component's overlay would have caught the `component.getEl() returns null` regression visually before the test asserting on rect dimensions failed.
3. **Topbar** — connection dot, save status, theme toggle, variables popover. Small but visible drift.
4. **Variables popover** — the alpha.1 click-swallowing bug had a visual signal.
5. **Block palette** — Tailwind utility class regressions are often visual-only.

**Suggested cadence:** Per-spec opt-in via `expect(page.locator(...)).toHaveScreenshot()`. Start with 5-10 baseline screenshots; expand as drift is caught. Diff threshold should start at 0.5% (Playwright default) and tighten over time.

## 8. Runtime budget

### 8.1 E2E job

CI workflow `e2e` job, 15-minute timeout:

```
checkout                 ~10s
corepack + setup-node    ~30s
pnpm install (cached)    ~30s (cold ~3min)
build @designjs/bridge   ~10s
build all packages       ~30s
playwright install       ~30s
pnpm test:e2e            156 tests × ~1.5s avg = ~4 minutes
                         + 60s dev server boot
                         + retry overhead (2 retries on CI per F.13)
                         ≈ 5-7 minutes typical
TOTAL                    ≈ 7-9 minutes (cached install path)
```

**Headroom today:** ~6 minutes. Scales linearly with test count under `workers: 1`. At ~250 tests the job will start to push the 15-minute limit.

### 8.2 Verify job

```
checkout + setup         ~70s
pnpm install             ~30s cached
bridge build             ~10s
typecheck all            ~60s (TS6 + monorepo cold typecheck)
unit tests (--if-present) ~30s (3 packages × small vitest suites)
build all packages       ~30s
bridge round-trip smoke  ~10s (after waiting on dev server up to 20s)
mcp stdio smoke          ~5s
init smoke               ~5s
TOTAL                    ≈ 4-5 minutes
```

**Verify is comfortable.** The 10-minute timeout has 5 minutes of headroom.

### 8.3 Local

`pnpm test:e2e` locally with `reuseExistingServer: true` skips the 60s dev-server boot. ~4 minutes for the suite. Quick enough for the inner loop on most days.

## 9. Forward-looking: testing the v0.2/v0.3 specs

### 9.1 AI chat panel (Track A)

- **Unit:** The provider abstraction (`packages/app/src/chat/providers/`) is pure logic — modelForId switch, message-part formatting. Vitest target. Mock-fetch tests for OpenRouter / Anthropic / OpenAI SDK calls.
- **Integration:** Settings modal's "Test connection" button is a real-network call. Use msw (mock service worker) or a fixture-mode test harness.
- **E2E:** Full happy path — open chat, send message, watch tool calls modify canvas, verify canvas state. Mock the LLM response via OpenRouter API stubbing.
- **Key risk:** The streaming response path is intrinsically harder to test than request/response. Use the AI SDK's testing utilities (`@ai-sdk/test`) for deterministic stream replay.

### 9.2 SWARM mode

- **Unit:** Per-artboard locking. Tests for the dispatcher's `agentScope` enforcement under simulated concurrent calls. The dispatcher's lock primitive is exactly the kind of code that benefits from property-based testing (e.g., fast-check) — assert no two agents ever interleave on the same artboard.
- **E2E:** Full variations spawn (3 agents in 3 artboards, simulated). Cursor 2.0's UX is the visual reference; assert each agent's status display in the right-sidebar agent list.

### 9.3 Repo connection + sandbox preview (Track B)

- **Unit:** `isomorphic-git` operations against an in-memory ZenFS volume — deterministic, fast.
- **Integration:** OAuth-PKCE callback handling against a mock GitHub OAuth server (use msw or a small fixture HTTP server).
- **E2E:** Full happy path — connect repo, make canvas change, see commit on branch, see PR draft. Mock the GitHub API entirely; don't hit real GitHub from CI.
- **Sandbox preview:** WebContainers in CI is finicky. Likely needs nightly-only e2e tests for the sandbox path; on PR, only test the canvas → sandbox iframe RPC layer (mock the WebContainer).

### 9.4 Projects gallery

- **Unit:** `~/.designjs/projects.json` read/write — atomic semantics, mode 0o600, multi-process safety. fs-level fixtures.
- **E2E:** Gallery navigation, project switching restores last canvas state, "+ New Project" modal flow.

### 9.5 Cross-cutting recommendation

**Add component-level Vitest + RTL coverage for the inspector sections in v0.2.** This is the cheapest win for unit coverage and pays dividends as the chat panel UI grows. Today an inspector control bug requires an E2E test to catch; with RTL it's a 5-line test that runs in 50ms.

## 10. Findings rollup

| # | Finding | Severity | Effort |
|---|---|---|---|
| F.12 | `workers: 1` + `fullyParallel: false` — serial only, scales poorly | Low (today) → Med (v0.3 size) | M (sharding setup ~half day) |
| F.13 | `retries: CI ? 2 : 1` is hiding flakiness; no retry observability | Med | XS (add JSON reporter, 30 min) |
| F.14 | Single chromium project; Firefox/WebKit untested | Med | S (~1h to add projects + per-CI selection) |
| F.15 | No visual regression in E2E despite visual product | Med-High | M (5-10 baselines + threshold tuning, ~1 day) |
| F.16 | `smoke-mcp.mjs` `EXPECTED_TOOLS` is stale (covers 9 of 22) | Med | XS (~10 min) |
| F.17 | Bridge unit tests miss `add_classes`/`remove_classes`/`set_text`/`select`/`deselect` schemas | Med | XS (~30 min, copy pattern from existing tests) |
| F.18 | `bridge/handlers.ts` (525 LOC) has no unit tests | High | M-L (~1-2 days for full mock-editor harness) |
| F.19 | Build system divergence — chrome-ext Webpack vs app Vite | Low | n/a (track) |
| F.20 | No root-level vitest workspace config | Low | XS (~30 min) |
| F.21 | No retry / flaky-test observability | Med | XS (~30 min, JSON reporter + grep script) |
| F.22 | No coverage reporting in CI | Med | S (~1h to wire vitest + playwright coverage to Codecov / artifact) |

## 11. Risk tiers

**Tier 1 — fix-in-the-week:**
- F.16 — Self-updating `smoke-mcp.mjs` (import `TOOL_SCHEMAS`, 10-min change)
- F.17 — Add schema unit tests for the 5 newer tools (~30 min)
- F.21 — Add JSON reporter + retry-observability script (~30 min)

**Tier 2 — fix-this-quarter:**
- F.18 — Unit-test `bridge/handlers.ts` with a mock-editor harness (highest-value gap)
- F.13 — Drop CI retries to 1 once F.21 confirms the suite is stable, then track regressions
- F.14 — Add Firefox + WebKit Playwright projects, nightly cadence
- F.15 — Deploy visual regression on 5-10 surfaces (inspector, selection overlay, topbar, variables popover, block palette)

**Tier 3 — keep an eye on:**
- F.12 — Sharding strategy when test count exceeds ~200
- F.19 — Bundler convergence (Webpack → Vite for chrome-ext) when divergence cost shows up
- F.20 — Vitest workspace mode for unified coverage

**Tier 4 — strategic:**
- Component-level RTL coverage for the inspector sections in v0.2 (highest-leverage future-test investment)
- Property-based tests for the SWARM dispatcher lock primitive

---

**Next:** Phase 2.3 — CI / DX deep dive.
