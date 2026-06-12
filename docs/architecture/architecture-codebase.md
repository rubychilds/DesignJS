# Architecture review — Phase 2.1: Codebase deep dive

> Companion to [`architecture-recon-2026-05-24.md`](./architecture-recon-2026-05-24.md). Read-only analysis of monorepo organization, package boundaries, type-system posture, the GrapesJS coupling shape, and forward-looking architecture for the v0.2/v0.3 specs.
>
> Findings are flagged inline as `[F.NN]`. The Phase 3 synthesis will turn these into prioritized recommendations.

## 1. Monorepo organization

### 1.1 Workspace shape

```
pnpm-workspace.yaml      packages: [ packages/* ]
packageManager           pnpm@9.12.0 (pinned)
engines.node             >=20
```

Single workspace glob, six packages, no nested workspaces (no `e2e/*`, no `docs/*`, no apps split). Flat and explicit — appropriate for the current size. The implicit contract is *"everything publishable or runnable lives in `packages/`; everything else is config/docs/vendored."*

### 1.2 Build order is encoded everywhere

```
@designjs/bridge  → published first, depended on by app + mcp-server
@designjs/app     → depends on bridge (workspace:*) → consumes types + protocol constants
@designjs/mcp-server → depends on bridge (workspace:*) → consumes TOOL_SCHEMAS / DESCRIPTIONS
```

The root `package.json` scripts encode this ordering manually in every relevant command:

```jsonc
"dev":         "pnpm --filter @designjs/bridge build && pnpm --filter @designjs/app dev",
"build":       "pnpm --filter @designjs/bridge build && pnpm -r --filter '!@designjs/bridge' build",
"typecheck":   "pnpm --filter @designjs/bridge build && pnpm -r typecheck",
"mcp":         "pnpm --filter @designjs/bridge build && pnpm --filter @designjs/mcp-server start",
"smoke:bridge":"pnpm --filter @designjs/bridge build && node scripts/smoke-bridge.mjs",
"smoke:init":  "pnpm --filter @designjs/cli build && node scripts/smoke-init.mjs",
"smoke:create":"pnpm --filter create-designjs build && node scripts/smoke-create.mjs"
```

**[F.01] No build-graph automation (Turborepo / Nx / Moon).** Every consumer of `@designjs/bridge` manually prefixes `pnpm --filter @designjs/bridge build && …`. This pattern is fine for v0.1 but creates friction in two places: (a) CI runs the bridge build twice (once in the `verify` job, once in `e2e`); (b) any new script that consumes bridge types must also add the prefix or hit a stale `dist/`. Defensible at this size; revisit if a 3rd consumer package is added or CI minutes become a meaningful cost.

### 1.3 Build coupling beyond pnpm

The Vite dev server consumes the bridge package via TypeScript path resolution and the package's `dist/index.{js,d.ts}`. **There is no live-rebuild dev mode for the bridge package** — editing `packages/bridge/src/protocol.ts` requires a manual `pnpm --filter @designjs/bridge build` to propagate. The app's HMR will then pick up the new compiled output, but only because Vite watches `node_modules`.

This was visible in the alpha.1 CHANGELOG: *"Root `pnpm typecheck` script now builds `@designjs/bridge` first so downstream packages can resolve the import."* The script was added because not having it caused real failures. The underlying friction (no live-rebuild) remains.

**[F.02] No watch-rebuild for the bridge package.** A `tsc --watch` running alongside `vite` would close the loop. Trivial in `package.json`; defer if the bridge changes rarely (it does — 4 commits to bridge in the last 60 vs 15 to chrome-extension).

## 2. Package matrix

| Package | Type | TS config style | Build | Public surface | Volume signal |
|---|---|---|---|---|---|
| `bridge` | Library, ESM, published | extends base, `outDir`, `declaration`, `declarationMap`, excludes tests | `tsc` | single `./` export, dual `types` + `default` | 3 source files (`index.ts`, `protocol.ts`, `tools.ts`), 22 tool schemas |
| `mcp-server` | Node CLI, ESM, published | extends base + **overrides module/moduleResolution to NodeNext** | `tsc` | `bin: designjs-mcp` only | 2 source files (`index.ts`, `bridge-client.ts`), ~200 LOC total |
| `app` | Vite SPA, private | extends base + `jsx: react-jsx`, `vite/client` types | `tsc --noEmit && vite build` | none (`private: true`, never published) | 28 runtime deps, 13 top-level components + 10 inspector sections + 21 `canvas/*` modules |
| `chrome-extension` | MV3, private | **does NOT extend base** — own full config | (likely vite/esbuild — config not yet inspected) | `chrome.runtime` only | 21 source files incl. 16 test files for capture alone |
| `cli` | Node CLI, private (deferred) | extends base + NodeNext overrides + node types | `tsc` | `bin: designjs` (private) | empty source today (CLI deferred) |
| `create-designjs` | Node CLI, published | **does NOT extend base** — own full config | (own) | `bin: create-designjs` | scaffolder, drops `.mcp.json` + `CLAUDE.md` + `README.md` |

### 2.1 Package boundaries are clean

A core architectural strength: **`@designjs/bridge` is the protocol contract, and nothing else.** Three files, zero runtime side effects, only Zod as a dependency. Both `@designjs/app` (browser) and `@designjs/mcp-server` (Node) import it identically. Adding a new MCP tool is a 4-step process documented in `CONTRIBUTING.md`, and step 1 is "define schemas in `packages/bridge/src/tools.ts`." This shape is what makes the architecture work.

**The MCP server's `index.ts` is a pure forwarder** — 58 lines that auto-register every tool from `TOOL_SCHEMAS` and hand each call to `bridge.call(toolName, args)`. No tool logic. No state. The protocol package + the forwarder pattern means every new MCP tool only needs:

1. Schema in `packages/bridge/src/tools.ts` (Zod)
2. Description in the same file's `TOOL_DESCRIPTIONS`
3. Handler implementation in `packages/app/src/bridge/handlers.ts`

The server picks the new tool up automatically. **This is excellent design.** Keep it.

### 2.2 chrome-extension is a poor citizen of the TS posture

The chrome-extension package has its own full `tsconfig.json` instead of extending the base:

```jsonc
// packages/chrome-extension/tsconfig.json — own config, not extending base
{
  "target": "ES2020",                     // base says ES2022
  "lib": ["ES2020", "DOM", "DOM.Iterable"],
  "moduleResolution": "bundler",
  "strict": true,                          // good — keeps strict
  "noUncheckedIndexedAccess": true,        // good — keeps strict-er
  "noEmit": true,                          // extension bundles via something else
  "types": ["chrome", "vitest/globals"]    // appropriate for the runtime
}
```

The settings are *deliberate* — older `ES2020` target for Chrome MV3 compatibility, `noEmit` because the bundler emits, `chrome` types. But there's no `extends` clause linking it back to the base, so any change to `tsconfig.base.json` (e.g., a future `exactOptionalPropertyTypes: true`) won't propagate. **[F.03] Refactor candidate** — extend the base and override only what's actually different. Saves duplication; surfaces drift.

**create-designjs has the same problem and is worse:**

```jsonc
// packages/create-designjs/tsconfig.json — own config, drops noUncheckedIndexedAccess
{
  "target": "es2022",
  "module": "nodenext",
  "strict": true,
  // ← noUncheckedIndexedAccess MISSING
  "esModuleInterop": true,
  // ...
}
```

**[F.04] `create-designjs` drops `noUncheckedIndexedAccess`.** The base config enables it; this package's own config omits it. Likely accidental — there's no comment justifying the exception, and `create-designjs` is a scaffolder (lots of array indexing for IDE detection logic, exactly the place where `noUncheckedIndexedAccess` catches bugs). Fix is one line: `"noUncheckedIndexedAccess": true`.

### 2.3 mcp-server module-system override is justified

```jsonc
// packages/mcp-server/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "NodeNext",          // base: ESNext
    "moduleResolution": "NodeNext", // base: Bundler
    "types": ["node"],
    // ...
  }
}
```

The base sets `module: ESNext` + `moduleResolution: Bundler`, which is the right default for app code consumed by a bundler. The Node runtime needs `NodeNext` to honor the `.js` extension in relative imports and the package's `"type": "module"` declaration. **Override is correct.** The same override is in `cli/tsconfig.json` for the same reason. Worth documenting in a comment.

## 3. TypeScript posture

### 3.1 Root config is excellent

```jsonc
{
  "target": "ES2022",
  "lib": ["ES2022", "DOM", "DOM.Iterable"],
  "module": "ESNext",
  "moduleResolution": "Bundler",
  "esModuleInterop": true,
  "allowSyntheticDefaultImports": true,
  "resolveJsonModule": true,
  "isolatedModules": true,
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "noImplicitOverride": true,
  "skipLibCheck": true,
  "forceConsistentCasingInFileNames": true
}
```

This is the modern-TypeScript canonical config. `strict` + `noUncheckedIndexedAccess` + `noImplicitOverride` + `isolatedModules` + Bundler resolution is what Anthropic-style + Vercel-style + Linear-style projects converge on in 2026.

Missing-but-could-add:
- `exactOptionalPropertyTypes: true` — makes `foo?: string` strictly different from `foo: string | undefined`. Useful but noisy (many existing types break). Not urgent.
- `noPropertyAccessFromIndexSignature: true` — forces `.["foo"]` over `.foo` on index-signature types. Useful but tedious for the GrapesJS-typed code (lots of `(c.get('name') as ...)` patterns would need rework).
- `verbatimModuleSyntax: true` — forces explicit `import type` for type-only imports. Probably wanted long-term; defer until a build-time impact is visible.

**[F.05] TypeScript 6.0.3 is bleeding-edge.** TS6 shipped late 2025; v0.1 was published 2026-04-22. Many ecosystem deps don't yet ship TS6-compatible types. The project gets away with `skipLibCheck: true` (which is wise) but should be aware that any contributor on an older TS will mismatch — pin `typescript` in dev-deps to a known-working range, which the root `^6.0.3` already does.

### 3.2 The grapesjs typing problem

The bridge handlers file uses `as unknown as { ... }` casts in 6+ places to bypass GrapesJS's loose typing. Examples:

```ts
// findById, line ~99
for (const frame of editor.Canvas.getFrames()) {
  const wrapper = (frame as unknown as { get?: (k: string) => unknown }).get?.("component") as
    | Component
    | undefined;
  // ...
}

// classNamesOf, line ~69
const raw = component.getClasses() as unknown as Array<
  string | { get: (k: string) => unknown }
>;

// frameIds, line ~116-118
const get = (frame as unknown as { getId?: () => string }).getId;
```

These casts are honest workarounds for a real problem — `grapesjs@^0.22.16` exports `Component` and `Frame` types but the Backbone-backed runtime returns shapes those types don't capture. **The codebase pays the type-safety cost upfront in escape hatches rather than turning off strictness.** That's the right tradeoff.

**[F.06] No single grapesjs type-utility module.** The same `as unknown as { get?: (k: string) => unknown }` pattern is rewritten inline in many places. A small `src/canvas/grapesjs-types.ts` exporting typed helpers (`getComponentField<T>(c, key)`, `getFrameWrapper(f)`, `getFrameId(f)`) would localize the unsafety. Mid-priority refactor for the synthesis.

## 4. The bridge: where the architecture works well

The WebSocket bridge is the load-bearing seam between the MCP server (Node process spawned by the agent) and the canvas (browser tab). It's small, well-typed, and structurally sound.

### 4.1 Protocol contract

`packages/bridge/src/protocol.ts` is 43 lines:

```ts
export const BRIDGE_PORT = 29170;
export const BRIDGE_HOST = "127.0.0.1";
export const BRIDGE_PATH = "/designjs-bridge";

export const BridgeRole = z.enum(["mcp-server", "canvas", "browser-extension"]);

export const HelloMessage = z.object({
  type: z.literal("hello"),
  role: BridgeRole,
  sessionId: z.string().optional(),   // ← unused today
});

export const RequestMessage = z.object({
  type: z.literal("request"),
  id: z.string(),
  tool: z.string(),
  params: z.unknown(),
});

export const ResponseMessage = z.discriminatedUnion("ok", [
  z.object({ type: z.literal("response"), id, ok: z.literal(true),  result: z.unknown() }),
  z.object({ type: z.literal("response"), id, ok: z.literal(false), error: z.string() }),
]);
```

Discriminated union on `ok` is good — gives type narrowing on success vs error without ad-hoc casts. Three roles are reserved; `browser-extension` joins MCP and canvas. **`sessionId` is in the schema but unused** — the bridge's "multi-peer routing foundation" (per README) is real but not yet load-bearing on the wire. Important for SWARM and per-project repo connection.

### 4.2 BridgeClient on the browser side (101 lines)

`packages/app/src/bridge/client.ts`:

- Browser-native `WebSocket` (no `ws` package on the client side — keeps the app bundle lean)
- Constructor takes `handlers: Record<string, ToolHandler>` + optional `onStatus` event
- On open, sends `{ type: "hello", role: "canvas" }`
- Schema-validates every incoming message via `BridgeMessage.safeParse`
- Dispatches matched requests to `handlers[req.tool]`, errors back to the WS otherwise
- Exponential backoff reconnect (1s, 2s, 4s, ..., capped at 10s)

**The handler-map dispatcher is exactly the shape that the AI chat spec wants.** Adding the chat panel's tool calls is one line: register the same handlers under a second caller. The "single MCP dispatcher" concept from `DesignJS-Notes/ai-chat.md` is structurally already true — `handlers` is the dispatcher.

### 4.3 BridgeClient on the MCP-server side (145 lines)

`packages/mcp-server/src/bridge-client.ts`:

- `ws` package (Node, not browser native)
- `randomUUID()` for request correlation
- Pending map keyed by id with `{ resolve, reject, timer }`
- 10s default request timeout (configurable)
- `waitForOpen(maxWaitMs)` — polls for the socket to be `OPEN` before sending, with a deadline. Solves the race where the MCP server boots before the canvas is ready.
- `dispose()` rejects all pending with a clear error message

**The error messaging is well-written:**
```ts
reject(new Error("bridge not connected (is the canvas dev server running on port 29170?)"));
```

This is exactly the right level — clear actionable message for the agent context, not a stack trace.

### 4.4 What's missing in the bridge

- **No authentication / origin check.** `BRIDGE_HOST = "127.0.0.1"` is the only access control. Anything on localhost can connect — including malicious browser extensions or other apps. Deferred to the security deep dive (Phase 2.4).
- **No backpressure.** `ws.send()` is fire-and-forget; no flow control if the canvas can't keep up with rapid mutations (relevant for chrome-extension whole-page captures and SWARM).
- **No metrics.** Bridge round-trip latency, queue depth, reconnect count — all observable in principle but nothing surfaces them. Deferred to observability (Phase 2.6).
- **No protocol versioning.** The Hello message doesn't carry a protocol version. Forwards-compat is fragile if the schema evolves.

**[F.07] Bridge protocol has no version negotiation.** A `protocolVersion: "1"` field in `HelloMessage` would let the canvas reject an MCP server too old/new to understand it. Low-effort, future-proofs the wire. The roadmap implicitly assumes the protocol won't break, but the SWARM `origin` tagging and the chat panel's new caller patterns are both wire-level changes.

## 5. The GrapesJS coupling: where the architecture is fragile

### 5.1 Surface area

`grep` of GrapesJS API usage across `packages/app/src`:

```
17 files use GrapesJS APIs, 68 references total
```

The 17 files include:
- `App.tsx` — boot, frame management, primitive CSS injection
- `bridge/handlers.ts` (525 lines) — every MCP tool that mutates the canvas
- `canvas/artboards.ts` — frame creation, placement, fit-to-content
- `canvas/component-style.ts` — computed style reads
- `canvas/css-chunk.ts` — chunked CSS routing
- `canvas/paste-import.ts` — clipboard HTML parsing
- `canvas/persistence.ts` — save/load `.designjs.json`
- `canvas/primitives.ts` — Frame/Rectangle/Ellipse/Text/Image/Group mapping
- `canvas/variables.ts` — `:root` injection across frames
- `canvas/widen-stylable.ts` — type config to preserve captured CSS
- `components/LayersPanel.tsx`, `SelectionOverlay.tsx`, `Minimap.tsx`, `PanZoomWire.tsx`, `CommandPalette.tsx`, `ArtboardTitleBars.tsx`, `ZoomControl.tsx`

**Every load-bearing canvas feature touches GrapesJS internals.** This is unavoidable — GrapesJS *is* the canvas — but the coupling depth means any future canvas-engine migration (the roadmap flagged 500-component perf ceiling) is a multi-week refactor across 17 files. Not a critique; a fact to be aware of.

### 5.2 The multi-frame problem class

The alpha.1 CHANGELOG documents four regressions that all stem from the same root cause: **GrapesJS v0.22's multi-frame architecture broke single-frame assumptions that were baked throughout the codebase.**

| Symptom | Root cause | Fix |
|---|---|---|
| Variables never reached the iframe `:root` | `editor.Canvas.getDocument()` returns `undefined` under multi-frame | Iterate `editor.Canvas.getFrames()` and write each frame's `view.getWindow().document.documentElement` |
| `editor.addComponents(html)` created detached components with no iframe mount | The default branch didn't pick a frame to mount into | `addHtml` + bridge `add_components` default path append into the first frame's wrapper |
| `component.getEl()` returns `null` | The DOM element lives at `component.view.el` under v0.22 multi-frame | `SelectionOverlay.readRect` and `component-style.readComputedStyle` try `view.el` first, fall back to `getEl()` |
| `editor.Canvas.getFrameEl()` returns an empty wrapper iframe | Multi-frame: the wrapper iframe is hollow; frames have their own iframes | `get_screenshot` unscoped branch uses `frameIframe(getFrames()[0])` |

**This is a coupling smell.** Each fix is correct, but the fact that all four ran undetected from `0.1.0-alpha.0` to the verification of `0.1.0-alpha.1` says something about the test coverage of multi-frame paths. Phase 2.2 (testing deep dive) will look at this.

### 5.3 The triple-defensive iframe-CSS injection pattern

`App.tsx` lines 108-145 implement a particularly load-bearing workaround:

```ts
// Strategy A: listen on canvas:frame:load + :load:head + :load:body events
editor.on("canvas:frame:load canvas:frame:load:head canvas:frame:load:body", (ev) => {
  // ... inject PRIMITIVE_BASE_CSS into doc.head
});

// Strategy B: poll every 500ms for 5 sweeps (2.5s total)
sweepAllFrames();
let sweepCount = 0;
const sweepInterval = window.setInterval(() => {
  sweepAllFrames();
  sweepCount += 1;
  if (sweepCount >= 5) window.clearInterval(sweepInterval);
}, 500);

// Strategy C: listen for frame:add events
editor.on("frame:add", sweepAllFrames);
```

The comments explain it well: GrapesJS 0.22's multi-frame can fire `canvas:frame:load` *before* our React listener attaches, can re-mount iframes without re-firing the event, and post-boot captures create new frames after the React boot path is done. So the code uses three independent strategies to cover all the paths.

The injection itself is **idempotent** (guards on `doc.getElementById("oc-primitive-base")`), so triple coverage is cheap. But the existence of triple coverage is a sign that the upstream library doesn't give us a single reliable signal.

**[F.08] The multi-frame coverage is brittle.** Today's "belt-and-braces" pattern works. But the same class of bug (frame iframe re-mounts without event) could surface again for the chrome extension's `add_css_rules` route or the SWARM per-artboard concurrent edits. A small `useFrameLifecycle(editor, cb)` hook that centralizes the listener + poll + frame:add fallback would prevent re-implementing the pattern. Defer if no second instance needed; surface as a synthesis recommendation if Phase 2.2 finds related bugs.

### 5.4 Backbone is the elephant

GrapesJS is built on Backbone. The codebase shows this:
- `component.getId()` may return `cid` (Backbone's runtime ID, e.g., `"c69"`) or the model's `id` attribute depending on which collection the model lives in (`frameIds` handles both)
- `component.get("type")`, `component.get("tagName")`, `component.get("content")` — Backbone `Model#get` pattern, not direct property access
- `component.components()` returns a Backbone `Collection` whose `.toArray()` gives the real array
- `getClasses()` returns either `string[]` or an array of Backbone `Selector` models depending on whether you walk the live state or a serialized snapshot

The DesignJS code handles all these correctly. But Backbone is end-of-life — last major release in 2014, periodic maintenance only. The DesignJS roadmap already flags this as a long-term migration risk. The relevant fact for v0.2/v0.3 work: **none of the chat / repo / preview / SWARM specs add new GrapesJS API coupling.** The chat panel doesn't reach into the canvas; SWARM extends the bridge dispatcher; sandbox preview lives in a separate iframe. So the v0.2 work doesn't make the eventual canvas migration harder.

## 6. The canvas + component layer

### 6.1 Inventory

```
packages/app/src/
├── App.tsx                         (343 lines — boot, ready callback, window.__designjs exposure)
├── main.tsx                        (13 lines — createRoot)
├── bridge/
│   ├── client.ts                   (101 lines — browser WS client)
│   └── handlers.ts                 (525 lines — every MCP tool's canvas-side impl)
├── canvas/
│   ├── artboards.ts                frame creation, ensureDefaultArtboard, ensurePageRoot, healFrameDimensions
│   ├── blocks.ts                   25-block palette definitions
│   ├── component-style.ts          computed style reads (alpha.1 multi-frame fix lives here)
│   ├── css-chunk.ts                chunked CSS routing for add_css_rules
│   ├── editor-options.ts           grapesjs editorOptions + PRIMITIVE_BASE_CSS
│   ├── jsx-export.ts               htmlToJsx, mergeStylesIntoHtml
│   ├── paste-import.ts             clipboard HTML import
│   ├── persistence.ts              .designjs.json save/load
│   ├── primitives.ts               Frame/Rectangle/Ellipse/Text/Image/Group mapping
│   ├── tokens.ts + token-emit.ts + token-io.ts   DTCG tokens (ADR-0009 Phase 1)
│   ├── variables.ts                CSS variables (ADR-0009 migration target)
│   ├── widen-stylable.ts           grapesjs config override for captured CSS preservation
│   ├── color-conversion.ts         OKLCH-canonical color handling
│   ├── style-filters.ts + style-sectors.ts        inspector control plumbing
│   └── (icons: 3 files for the Phosphor/Lucide mixed stack)
└── components/
    ├── (13 top-level: ArtboardTitleBars, CanvasArea, CommandPalette, InsertRail,
    │    LayersPanel, LeftPanel, Minimap, PanZoomWire, RightPanel, SelectionOverlay,
    │    Shell, StylesPanel, Topbar, VariablesPopover, ZoomControl)
    ├── inspector/
    │   ├── SemanticInspector.tsx           (the orchestrator)
    │   ├── InspectorSection.tsx            (shared section shell)
    │   ├── FrameTypeSwitcher.tsx
    │   ├── PositionSection.tsx
    │   ├── LayoutSection.tsx
    │   ├── AppearanceSection.tsx
    │   ├── FillSection.tsx
    │   ├── StrokeSection.tsx
    │   ├── EffectsSection.tsx
    │   └── ExportsSection.tsx
    └── ui/                                  (shadcn primitives — copied in per ADR-0001)
```

### 6.2 Where things live

- **`canvas/`** = anything that talks to GrapesJS's runtime. Heavy on Backbone-shaped APIs, multi-frame quirks, computed-style reads.
- **`bridge/`** = wire protocol implementation. `handlers.ts` is the second-largest file in the codebase; consider splitting per category (inspect / mutate / artboards / selection) for review hygiene if it grows further.
- **`components/`** = React components for editor chrome. None touches GrapesJS directly except via passed `Editor` prop or by listening on global window events.
- **`components/inspector/`** = the ADR-0003 Penpot-shape inspector. 10 files, well-modularized.
- **`components/ui/`** = shadcn primitives, owned in-tree per ADR-0001.

### 6.3 The `window.__designjs` exposure

`App.tsx` line 212 sets a global handle:

```ts
(window as unknown as { __designjs?: unknown }).__designjs = {
  editor, addHtml, getHtml, getProjectData, save, load, clear, paste, getVariables, setVariables,
};
window.dispatchEvent(new CustomEvent("designjs:ready"));
```

Per `CONTRIBUTING.md`: *"E2E tests anchor on `window.__designjs` (an editor handle exposed at runtime in dev) to keep interactions deterministic."*

**This handle is set unconditionally** — not gated by `import.meta.env.DEV`. It will be present in production builds too. Implications:

- Any JS running in the canvas tab can drive the editor (set variables, clear the canvas, paste arbitrary HTML, save the project).
- The chat panel itself can use this handle (won't need to — it'll talk to MCP via the bridge), but in theory so can a third-party browser extension or a malicious iframe.
- Today the impact is limited because the canvas runs on `localhost:3000` and the only way to reach it is to already be on the user's machine — but that's exactly the deferred-security argument SECURITY.md already makes.

**[F.09] `window.__designjs` is exposed in production builds.** Gate behind `import.meta.env.DEV` for the production exposure; tests would still see it. One-line change in `App.tsx`. Flag for the security deep dive.

## 7. Forward-looking: v0.2/v0.3 specs against current architecture

### 7.1 AI chat panel (`feat/ai-chat-panel` scaffolded)

**Fits cleanly into the existing architecture.** The chat panel:

- Hosts its own model-provider transport (Vercel AI SDK + OpenRouter / etc.) entirely on the React side. No bridge changes needed.
- Issues MCP tool calls to drive the canvas — these go through the same `BridgeClient` dispatcher that external MCP clients use. The chat spec's "single MCP dispatcher" is structurally already true; the dispatcher in `bridge/client.ts` is the seam.
- Tags ops with `origin: 'chat'` — needs a new field in `RequestMessage` or a new `BridgeRole` (`canvas-chat`) so the WS server can attribute ops. Schema change is one line.
- Settings modal stores keys in `~/.designjs/secrets.json` — needs a new Vite plugin or extension of `persistenceMiddlewarePlugin` to handle the read/write over HTTP from the browser.

**Architectural risk: low.** The scaffolded directory layout (`components/sidebar/panels/agent/`) introduces a new `sidebar/` parent that doesn't exist in main yet. The actual implementation will need to integrate with the `Shell.tsx` left-panel slot. Trivial; flagged for the implementer.

### 7.2 Repo connection (`feat/repo-connection` planned)

**Adds significant runtime surface.** New dependencies:

- `isomorphic-git` + `@isomorphic-git/lightning-fs` OR `@zenfs/dom` (browser FS abstraction)
- `@octokit/rest` for GitHub API
- Self-hosted CORS proxy (~50 lines) — Vite plugin in dev, separate package in prod

**Architectural risk: medium.** The OAuth-PKCE flow needs a callback handler, which means extending the Vite dev server's HTTP middleware. The `persistenceMiddlewarePlugin` shows the pattern but the OAuth flow has nontrivial state to keep (`code_verifier` per session). The ZenFS / `lightning-fs` layer also lives entirely in the browser tab and adds ~200 KB to the bundle.

**The `get_project_context` MCP tool spec from the planning docs** introduces a new wire pattern: tool responses include a `projectContext` metadata field. This is *additive* to the existing schema but requires every existing tool's response shape to optionally carry it. Cleaner alternative: a separate `editor:project-context` event that the canvas emits when the project switches, consumed by anyone who cares.

### 7.3 Sandbox preview (`feat/sandbox-preview` planned)

**Loose coupling — fits without architecture changes.** The preview iframe is just another iframe alongside the GrapesJS canvas frames. `postMessage` RPC for `SET_URL` / `RELOAD` is independent of the bridge. WebContainers runs entirely on the browser side.

**The "Play button takes over the canvas viewport" UX** (from the planning doc) means the preview iframe needs to overlay or replace the GrapesJS canvas div temporarily. The `Shell.tsx` layout has a center slot for `CanvasArea`; swapping that for a preview iframe is a single boolean state.

**Architectural risk: low.** The only new bridge concern is forwarding HMR errors from the preview iframe into the chat panel as "fix this" suggestions — that's a new tool (`report_preview_error` or similar) or a custom event on the existing channel.

### 7.4 Projects + gallery (`feat/projects-gallery` scaffolded)

**Light, fits cleanly.** Reads/writes `~/.designjs/projects.json` over the same persistence middleware that handles `.designjs.json`. Thumbnails generated from the existing `get_screenshot` path. Project switching invokes `editor.loadProjectData(saved)` — already in `App.tsx`'s ready callback.

**The hello-handshake routing** the spec describes (canvas binds to `<projectRoot>/.designjs.json` on MCP hello) **changes the bridge protocol meaningfully**. Today's `HelloMessage` has `sessionId` (unused). Adding `projectRoot` lets the canvas:

1. Look up the project in `~/.designjs/projects.json`
2. Decide which `.designjs.json` to load
3. Possibly load a *different* project than what's currently displayed

Item 3 is the design tension — does an agent connection in `/tmp/my-app` switch the user's canvas to that project automatically? Or display a "switch project?" prompt? The spec doesn't say. Worth deciding before the protocol field lands.

**Architectural risk: medium** — not because of complexity, but because the multi-peer routing implications need a UX decision.

### 7.5 SWARM (`feat/swarm-mode` planned)

**Extends the bridge dispatcher meaningfully.** Today's bridge handlers run in a single in-process queue with no origin tagging. SWARM needs:

- `origin: 'agent:<agent-id>'` on every op-log entry
- Per-artboard locking (only one agent mutates an artboard at a time, with a "scoped" attribute the dispatcher checks)
- An op log with rewind / per-origin undo

The dispatcher's `Map<requestId, handler>` model is fine as the substrate. The op log is the new component. Locking is purely about a `Map<artboardId, agentId>` consulted before mutation tools run.

**Architectural risk: low-medium.** The locking primitive needs to be threadsafe against rapid concurrent requests — but JavaScript's single-threaded model gives this for free; the dispatcher's `await` boundaries are the only interleaving points.

The chat spec's "single MCP dispatcher" pattern is *exactly* the substrate SWARM needs. Land Track A first (which formalizes the dispatcher) and SWARM becomes a ~300-line extension rather than a refactor.

### 7.6 Component discovery (`component-discovery.md` deferred to v2+)

**Heaviest forward lift.** Needs Babel AST parsing in-browser (~300 KB), Storybook story discovery, sandbox rendering. None of this is in the current tree. Properly deferred.

## 8. Naming + conventions

### 8.1 File naming

| Layer | Convention | Example | Consistency |
|---|---|---|---|
| React components | `PascalCase.tsx` | `LayersPanel.tsx` | ✅ consistent |
| Inspector sections | `PascalCase.tsx` | `FillSection.tsx` | ✅ consistent |
| Canvas modules | `kebab-case.ts` | `paste-import.ts` | ✅ consistent |
| Bridge layer | `kebab-case.ts` | `handlers.ts` | ✅ consistent |
| Hooks | `useCamelCase.ts` (planned per ADR-0001 Phase D) | none yet | n/a (still planned) |
| `components/ui/` | shadcn-style `kebab-case.tsx` | (per ADR-0001) | ✅ matches shadcn |
| Tests | `kebab-case.test.ts` / `.spec.ts` | `style-serializer.dedup.test.ts` | ✅ |

**[F.10] The split between PascalCase tsx files at the top of `components/` and the inspector subfolder is consistent, but neither has a folder per component.** As components grow (chat panel, gallery), the flat `components/` directory will get crowded. CONTRIBUTING.md mentions a planned `components/editor/` subdirectory; the Track A scaffolding (in `feat/ai-chat-panel`) used `components/sidebar/panels/agent/` instead. Consolidate the convention before two more grouping schemes accumulate.

### 8.2 Per-package READMEs

Spot-checked: `packages/bridge/`, `packages/mcp-server/`, `packages/chrome-extension/`, `packages/cli/` lack their own README. `packages/app/` and `packages/create-designjs/` situation not yet verified. **[F.11]** Each published package should have a one-page README that npm shows on the package page. Today the npm page for `@designjs/bridge` etc. will show "no README found." Low priority but visible to users.

### 8.3 ADR consistency

Excellent. 12 ADRs, README documents the convention, every Accepted ADR has an Addendum reflecting reality, supersession is bidirectionally linked. **Keep this — it's a top-quartile signal for the project.**

## 9. Findings rollup

The numbered findings interleaved through this doc, recapped here for the synthesis to pick up:

| # | Finding | Severity | Effort |
|---|---|---|---|
| F.01 | No build-graph automation (Turborepo / Nx); bridge build is manually prefixed everywhere | Low | M (4-8h) |
| F.02 | No watch-rebuild for the bridge package; editing protocol.ts requires manual rebuild | Low | XS (~30min) |
| F.03 | `chrome-extension/tsconfig.json` doesn't extend `tsconfig.base.json` | Low | XS |
| F.04 | `create-designjs/tsconfig.json` drops `noUncheckedIndexedAccess` | Med | XS |
| F.05 | TypeScript 6.0.3 is bleeding-edge; ecosystem types lag | Low | n/a (monitor) |
| F.06 | No single grapesjs type-utility module; `as unknown as { ... }` rewritten inline | Low | S (2-4h) |
| F.07 | Bridge protocol has no version negotiation | Med | XS (1h) |
| F.08 | Multi-frame iframe-CSS injection uses triple-defensive pattern; could recur for other features | Med | S (centralize as a hook) |
| F.09 | `window.__designjs` is exposed in production builds | **High (Security)** | XS (1 line) |
| F.10 | Component directory structure inconsistent between current main and Track A scaffolding | Low | XS |
| F.11 | Per-package READMEs missing for most packages | Low | S (1h per package) |

Forward-looking observations (not findings, just context for synthesis):

- **The bridge + handler-map architecture is the right substrate for Track A (chat) and SWARM.** No refactor needed.
- **Track B (repo connection) adds significant new runtime surface** (ZenFS, isomorphic-git, OAuth) but doesn't aggravate the GrapesJS coupling.
- **The `HelloMessage.projectRoot` extension** for per-project file routing is a meaningful protocol change that needs a UX decision before landing (does an agent connection switch the user's view?).
- **The 17-file × 68-reference GrapesJS coupling is the long-term risk.** None of the v0.2/v0.3 specs aggravate it. A future canvas migration is a separate, multi-week refactor.

## 10. Risk tiers (for the synthesis)

**Tier 1 — fix-in-the-week:**
- F.09 — `window.__designjs` production exposure (1-line gate behind `import.meta.env.DEV`)
- F.04 — `create-designjs` missing `noUncheckedIndexedAccess` (1-line config fix)

**Tier 2 — fix-this-quarter:**
- F.07 — Bridge protocol version negotiation (1h, lands in next bridge release)
- F.03 — Refactor `chrome-extension` tsconfig to extend base (1h)
- F.06 — Centralize grapesjs type helpers in `canvas/grapesjs-types.ts` (2-4h)
- F.10 — Standardize component directory convention before Track A merges
- F.11 — Add per-package READMEs for the 3 published packages (priority order: `@designjs/mcp-server` first since it's what users `npx` directly)

**Tier 3 — keep an eye on:**
- F.01 — Build-graph automation if a 3rd consumer joins
- F.02 — Bridge watch-rebuild if the protocol churns
- F.05 — TypeScript ecosystem catching up
- F.08 — Multi-frame brittleness if Phase 2.2 finds related bugs

**Tier 4 — strategic:**
- The 17-file × 68-reference GrapesJS coupling shape — informs the long-term canvas-migration risk flagged in the roadmap. The synthesis will treat this as a watch-item rather than an action item.

---

**Next:** Phase 2.2 — Testing deep dive.
