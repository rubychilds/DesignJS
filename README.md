# DesignJS

**An open-source MCP design canvas that gives AI coding agents eyes.**

DesignJS is a local-first, HTML/CSS-native visual canvas that AI coding agents (Claude Code, Cursor, Codex) read and write through the [Model Context Protocol](https://modelcontextprotocol.io). Design and code converge into a single artifact — no translation gap between visual intent and production output.

> **Status:** v0.1 foundations + v0.3 Chrome-extension capture working end-to-end. The agent ↔ canvas loop is stable, and a separate side channel lets you **drop any live web page or DOM subtree onto the canvas as editable HTML** via the extension. v0.2 polish (paste-import, transform handles, component instances) is in flight per the [roadmap](#roadmap).

## Why

AI coding agents currently generate frontend UI **blind**. They produce React components from text prompts alone, with no ability to see a visual design, iterate spatially, or maintain layout relationships. Design engineers spend 2–4 hours a day in prompt → preview → re-prompt cycles getting agents to match their visual intent.

Two proprietary tools are closing this gap from different angles. **Paper.design** ships an HTML/CSS-native canvas — the design *is* the production code — but as a hosted SaaS product tied to its own backend. **Pencil.dev** ships a local-first, git-native canvas that any agent can drive over MCP — but the design file is a vector format in a closed renderer, not the HTML/CSS that ships to production. DesignJS combines both bets: **HTML/CSS-native like Paper, local-first and git-native like Pencil, MIT-licensed**, and built on open-source foundations (GrapesJS, the MCP TypeScript SDK, html-to-image).

## How it works

```
┌───────────────────┐     stdio      ┌─────────────────┐
│  Claude Code /    │──────────────▶│   MCP Server    │
│  Cursor / Codex   │     (JSON-RPC) │   (Node.js)     │
└───────────────────┘                └───────┬─────────┘
                                             │ WebSocket (127.0.0.1:29170)
                                             ▼
┌─────────────────────────────────────────────┐
│      Browser (Vite + React SPA)             │
│  ┌────────────┐  ┌───────────────────────┐  │
│  │ Editor UI  │  │  GrapesJS Canvas      │  │
│  │ (panels,   │  │  (iframe with         │  │
│  │  blocks,   │  │   real HTML/CSS       │  │
│  │  styles)   │  │   + Tailwind v4 CDN)  │  │
│  └────────────┘  └───────────────────────┘  │
└─────────────────────────────────────────────┘
                      │
              ┌───────┴───────┐
              │ .designjs   │
              │   .json       │
              └───────────────┘
```

Agent ↔ Canvas communication flows stdio → MCP server → WebSocket bridge → browser → GrapesJS API, with responses travelling back the same path. Both human edits and agent edits converge on the **same GrapesJS component model** — one source of truth.

## Quickstart

Requires **Node.js 20+**.

### 1. Start the canvas

The canvas app runs locally (it's not hosted). Two ways:

**From source** (recommended while v0.2 is in development — get all the latest):

```bash
git clone https://github.com/rubychilds/DesignJS.git
cd DesignJS
pnpm install
pnpm dev
```

Opens at <http://localhost:3000>. The WebSocket bridge listens on `127.0.0.1:29170`. Connection status is visible top-right in the editor shell.

### 2. Scaffold a project (or use one you already have)

```bash
npm create designjs@latest my-app
cd my-app
```

Drops a `.mcp.json`, `CLAUDE.md`, and `README.md` pointing at the published MCP server. If you already have a project directory and just want the MCP config, skip this step and use `npx @designjs/cli init` instead (writes `.mcp.json` / `.cursor/mcp.json` / `.vscode/mcp.json` based on which IDE config dirs it detects).

### 3. Connect your agent

With the canvas running and your project scaffolded:

```bash
claude          # Claude Code — reads .mcp.json automatically
# or
cursor .
# or
code .
```

On the first tool call, the agent runs `npx -y @designjs/mcp-server` and connects. The bridge dot in the canvas Topbar flips to green. Prompt:

> "Create a Desktop artboard, then add a pricing section with three tier cards."

### Manual MCP config

If you'd rather write the MCP config yourself, add this to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "designjs": {
      "command": "npx",
      "args": ["-y", "@designjs/mcp-server"]
    }
  }
}
```

## Capture web pages with the Chrome extension

The DesignJS Chrome extension lets you grab any element or full web page and drop it onto the canvas as editable HTML. The capture pipeline walks the DOM, serializes computed styles + author CSS, and routes everything into a fresh artboard on your running canvas — no copy-paste, no screenshot tracing.

### Install

The extension isn't on the Chrome Web Store yet (planned for v0.3 public). For now, load it locally from this repo:

```bash
pnpm install                                       # if you haven't already
pnpm --filter @designjs/chrome-extension build     # builds packages/chrome-extension/dist/
```

Then in Chrome:

1. Open `chrome://extensions`
2. Toggle **Developer mode** on (top-right)
3. Click **Load unpacked** and select `packages/chrome-extension/dist/`
4. Pin the DesignJS icon to the toolbar (puzzle-piece menu → pin)

When you next change extension source, rebuild and click the circular **reload** arrow on the DesignJS card in `chrome://extensions`.

### Use

With `pnpm dev` running (canvas reachable at `localhost:3000`):

1. Navigate to any web page in Chrome.
2. Click the **DesignJS** icon in the toolbar. An overlay drops into the page; the green dot top-left confirms it can reach the canvas.
3. Two capture modes:
   - **Start capture** — hover any element to highlight it. Use `↑ ↓ ← →` to traverse up/down the DOM tree, `Enter` to commit, `Esc` to cancel. The selection plus its descendants and computed styles land in the canvas as a new component.
   - **Capture page** — grabs the full `<html>` tree, scrolls + settles lazy-mounted sections, takes a full-page screenshot for an opacity-0.15 backplate, creates a fresh artboard sized to the source page, and ships everything to the canvas. Progress phases (Capturing → Sending → Rendering) display in the overlay during long captures.

Captured content lands as **real, editable HTML/CSS** — every element shows up in the layer tree, every property is inspectable + editable, classes survive intact for Tailwind round-trips, and the result saves to your `.designjs.json` like any other canvas state.

### What's captured today (v0.3)

- ✅ Element selection + whole-page capture
- ✅ Computed-style serialization (~150 CSS properties: layout, typography, color, flex/grid, multi-column, tables, lists, transforms, filters)
- ✅ Same-origin `<iframe>` content (inlined as `srcdoc`)
- ✅ Cross-origin image / media URL rewriting (absolute paths so canvas iframe loads them)
- ✅ Source page's author CSS (via `editor.Css.addRules` so dedup + author rules land in the canvas's CSS Manager rather than being stripped by GrapesJS' HTML parser — see [ADR-0011 2026-05-24 addendum](./docs/adr/0011-browser-extension-architecture.md))
- ✅ Allowlisted font-CDN `<link>` tags hoisted into the capture (Google Fonts / Bunny / TypeKit / fonts loaded via `<link>`)
- ✅ Style dedup hoist — repeated computed-style blocks share auto-generated `_djhN` classes to keep payload bounded
- ✅ Progress UX — granular phase events shown in-overlay during capture

### Known limitations (planned for v0.4)

- ❌ Shadow DOM — silently skipped today; needs CDP `DOM.getDocument` traversal
- ❌ Cross-origin iframes — pass through as `<iframe>` with absolute `src`, content not inlined
- ❌ Hotlink-protected images — render as broken-image placeholders
- ❌ Authed-only content — captured from the live session but the canvas can't re-auth
- ❌ Non-CDN-served fonts — `font-family` value preserved, but the font file doesn't follow (Phase 1 of font preservation is in [docs/font-preservation-plan.md](./docs/font-preservation-plan.md))
- ⚠️ Wikipedia-class long pages (~7k components) take 60-180s to land — `add_components` is the bottleneck; chunked dispatch is tracked as Q1 in [epic-8-followups.md §9](./docs/epic-8-followups.md)

### Diagnose a stuck or off-looking capture

The overlay shows a progress phase + an inline error if anything fails. For more detail:

- Inspect the **Wikipedia tab's** DevTools console — the content script logs `[designjs] page captured: N nodes, MKB, serialized in Tms` plus a `[designjs] extracted N <style> block(s)` line confirming the CSS extraction step.
- Inspect the **extension's service worker** (`chrome://extensions` → DesignJS card → blue "service worker" link) — the background logs `[designjs] dispatching add_css_rules: NKB` then the canvas response.
- Inspect the **canvas tab** (`localhost:3000`) — the bridge logs `[designjs:bridge] add_css_rules: NKB → N chunks → M rules parsed` confirming rules landed in the CSS Manager.

If `[designjs:bridge] add_css_rules` doesn't appear after a capture, the canvas isn't running an `add_css_rules`-aware build — restart `pnpm dev` from scratch (not just HMR).

## Known quirks in v0.1

### One `.designjs.json` per canvas session, not per project

The Vite dev server writes all canvas state to a single `.designjs.json` at the **root of the cloned DesignJS repo**, regardless of which user project an agent is operating in. A user who scaffolds `/tmp/my-app` via `create-designjs`, points Claude Code there, and starts designing will find the resulting `.designjs.json` inside the DesignJS clone — **not** inside `/tmp/my-app`.

For v0.1 this is a known limitation. The practical workaround if you're designing for multiple projects:

- Keep one `pnpm dev` session per project. Before switching projects, save (Cmd+S), copy `.designjs.json` out of the DesignJS clone into your project's directory, then `git restore .designjs.json` to reset the canvas.
- Or commit the per-project design files somewhere inside your own project structure and pull them back into the DesignJS clone when you want to resume.

A proper fix — per-project `.designjs.json` discovery via a `get_project_context` MCP handshake plus a Paper-style file switcher in the Topbar — is tracked as a v0.2 feature. It's the single biggest UX gap in v0.1.

### Agent picks a competing design MCP instead of DesignJS

If you have other design MCPs configured globally in `~/.claude.json` (`pencil`, `paper`, `figma`, etc.), Claude Code can pick any of them for a "design this" prompt. The `CLAUDE.md` that `create-designjs` drops tells agents to prefer DesignJS, but isn't foolproof — reinforce in-prompt ("use designjs, not pencil") or remove competing entries from your user config to isolate the test.

### Stale `opencanvas` entry in Claude Code config

Pre-rebrand users may have an `opencanvas` MCP server sitting in `~/.claude.json`'s `mcpServers` block pointing at `@opencanvas/mcp-server` (which doesn't exist on npm anymore). Claude Code retries the connection on every launch and reports `opencanvas · ✘ failed`. Open the file and delete that key — restart Claude Code and the error stops.

## Packages

| Package | npm name | Purpose |
|---------|----------|---------|
| [`packages/app`](./packages/app) | *(not published)* | Vite + React SPA hosting the GrapesJS canvas. Embeds a WebSocket hub (port 29170) that relays messages between the MCP server and the browser. |
| [`packages/mcp-server`](./packages/mcp-server) | `@designjs/mcp-server` | Standalone stdio MCP server. Registers all tools, forwards calls over WebSocket to the canvas. This is what `npx -y @designjs/mcp-server` runs. |
| [`packages/bridge`](./packages/bridge) | `@designjs/bridge` | Shared Zod schemas for the WS wire protocol and MCP tool I/O. Consumed by both halves. |
| [`packages/cli`](./packages/cli) | `@designjs/cli` | `designjs init` — detects the installed IDE(s) and writes the right MCP config. |
| [`packages/create-designjs`](./packages/create-designjs) | `create-designjs` | `npm create designjs@latest <dir>` scaffolder. Drops `.mcp.json` + `CLAUDE.md` into a fresh project. |
| [`packages/chrome-extension`](./packages/chrome-extension) | *(not published — load unpacked)* | Chrome MV3 extension that captures any web page or DOM subtree and drops it onto the running canvas. Loadable via `chrome://extensions → Load unpacked → packages/chrome-extension/dist/`. |

## MCP tools

Twenty-one bidirectional tools, grouped by area. Full input/output schemas in [`packages/bridge/src/tools.ts`](./packages/bridge/src/tools.ts).

**Inspect**
| Tool | Purpose |
|------|---------|
| `ping` | Health check — returns `{ pong: true, at: <timestamp> }`. |
| `get_tree` | Recursive JSON component tree (optional depth). |
| `get_html` | Clean HTML (optional `componentId` scope). |
| `get_css` | CSS stylesheet (optional `componentId` scope). |
| `get_jsx` | Convert canvas HTML to JSX. `mode="tailwind"` (default) preserves classNames; `mode="inline"` emits style objects. |
| `get_screenshot` | PNG/JPEG base64 screenshot (`scale=2` for high fidelity). |
| `get_selection` | Component IDs currently selected in the editor. |
| `get_variables` | Read CSS custom properties on the canvas `:root`. |

**Mutate**
| Tool | Purpose |
|------|---------|
| `add_components` | Insert raw HTML (Tailwind supported). `artboardId` lands content in a specific frame. |
| `add_css_rules` | Register raw CSS rules directly with the canvas's CSS Manager. Bypasses `add_components`' HTML parsing (which strips `<style>` elements) so author + dedup CSS from the Chrome extension actually lands. Chunked at rule boundaries for large payloads. |
| `update_styles` | Set CSS properties on a component by id. |
| `add_classes` / `remove_classes` | Tailwind class helpers without re-emitting full HTML. |
| `set_text` | Replace the text content of a text-bearing component. |
| `set_variables` | Write CSS custom properties (persisted to `.designjs.json`). |
| `delete_nodes` | Remove components and their children. |
| `select` / `deselect` | Drive the editor's selection from the agent side. |

**Artboards (multi-frame canvas)**
| Tool | Purpose |
|------|---------|
| `create_artboard` | Add a new artboard frame at given size + position. Replaces the empty scratch frame on a fresh canvas so `create_artboard({ name: "Desktop" })` yields one Desktop, not two. |
| `list_artboards` | Enumerate frames with `{ id, name, x, y, width, height }`. |
| `find_placement` | Suggest a non-overlapping `(x, y)` for a new artboard of given size. |
| `fit_artboard` | Shrink a frame's height to match content. Useful after `add_components` drops content into a fixed-preset artboard (e.g. Desktop 1440×900) and you want the artboard to hug instead of leaving blank space. |

## Comparison

| Tool | Canvas format | MCP | License |
|------|--------------|-----|---------|
| Paper.design | HTML/CSS + GPU shaders | Bidirectional (21 tools) | Proprietary |
| Pencil.dev | Vector (native) | Bidirectional (6 tools) | Proprietary |
| Figma | WASM vector engine | Read-only Dev Mode | Proprietary |
| Penpot | SVG | Community only | MPL-2.0 |
| GrapesJS | HTML/CSS iframe | None | BSD-3 |
| Onlook | Live React DOM | Own agent | Apache-2.0 |
| Webstudio | DOM (real CSS) | None | AGPL-3.0 |
| **DesignJS** | **HTML/CSS iframe (GrapesJS)** | **Open bidirectional** | **MIT** |

## Roadmap

### v0.1 — canvas + MCP foundation *(largely shipped; a few gaps remain)*

**Foundations**
- [x] Three-pane editor shell — resizable panels, layers tree, semantic inspector, all keyboard shortcuts
- [x] GrapesJS canvas with Tailwind v4 (CDN in iframe), light + dark themes
- [x] Save/load to `.designjs.json` — Cmd+S, 30s autosave, reload-restore, git-diffable
- [x] MCP server (stdio) + WebSocket bridge on `127.0.0.1:29170`, multi-peer routing
- [x] `designjs init` CLI — auto-detects Claude Code / Cursor / VS Code and writes the right MCP config
- [x] CI: typecheck, build, smoke tests (bridge round-trip, MCP stdio, init), Playwright E2E (160+ tests across 28 specs)
- [x] Repo: MIT, CONTRIBUTING, RELEASING (Changesets), ADR-driven design log

**Multi-frame spatial canvas** *(originally v0.2 — landed early)*
- [x] Infinite, pannable, zoomable canvas hosting multiple artboard frames at world coordinates
- [x] Frames as top-level layer-tree roots ([ADR-0004](./docs/adr/0004-frames-in-layer-tree.md))
- [x] Snap-to-edge frame movement, automatic placement of new artboards, resize via Breakpoint toolbar (Desktop / Tablet / Mobile / Custom)
- [x] Minimap with viewport indicator
- [x] Page-root model — first frame is "the page"; loose primitives land there ([ADR-0006](./docs/adr/0006-sizing-auto-layout-canvas-model.md))

**Primitive vocabulary** *([ADR-0005](./docs/adr/0005-html-primitives-mapping.md))*
- [x] Frame, Rectangle, Ellipse, Text, Image, Group as first-class concepts mapped to HTML/CSS storage
- [x] InsertRail for click-to-insert primitives (drag-to-canvas still pending)
- [x] Block palette — 25 ready-made HTML/Tailwind blocks across Layout / Typography / Form / Media
- [x] Per-frame counter naming (`Rectangle 1`, `Rectangle 2`, …)
- [x] Point-text behaviour for the Text primitive — sizes to content, edits cleanly under contenteditable

**Semantic inspector** *(panel reshape from sectioned style manager)*
- [x] Position — alignment, X/Y, rotation
- [x] Layout — W/H with Hug/Fill/Fixed sizing, auto-layout (flex + grid), padding, margin, clip-content checkbox
- [x] Appearance — opacity, radius (uniform + per-corner), Figma-style blend picker, cursor, z-index
- [x] Typography — family, weight, size, LH, LS, alignment, case, decoration; gated to text-bearing tags
- [x] Fill — multi-layer stack with reorder, hide, opacity, color picker
- [x] Stroke — color + width + style (solid/dashed/dotted/double)
- [x] Effects — shadow stack + filter functions (blur, brightness, contrast, saturate, grayscale, hue-rotate) + backdrop-blur
- [x] Export — JSX (Tailwind or inline mode), HTML, CSS — copy-to-clipboard
- [x] "Other CSS" Raw-CSS escape hatch — only appears when orphan properties are set
- [x] Applicability gating — controls grey out (radius on inline text) or hide entirely (auto-layout on text) when not meaningful for the selection
- [x] Lucide-only iconography, drag-to-scrub number inputs, color field with hex + alpha

**MCP tools** *(21 tools, full list above — all verified via Playwright specs + unit tests)*
- [x] Inspect: `ping`, `get_tree`, `get_html`, `get_css`, `get_jsx`, `get_screenshot`, `get_selection`, `get_variables`
- [x] Mutate: `add_components`, `add_css_rules`, `update_styles`, `add_classes`, `remove_classes`, `set_text`, `set_variables`, `delete_nodes`, `select`, `deselect`
- [x] Artboards: `create_artboard`, `list_artboards`, `find_placement`, `fit_artboard`

**Remaining for v0.1**
- [ ] HTML/Tailwind clipboard paste import (Epic 3 — partial: `paste-import.ts` exists for image paste)
- [x] `npm create designjs@latest` scaffolder *(shipped — `packages/create-designjs`)*
- [ ] Drag-to-canvas from the InsertRail (click-to-insert works today)
- [ ] User-extensible block config + custom Tailwind config loading
- [ ] Demo GIF, per-tool examples, troubleshooting docs (Epic 4)
- [ ] GitHub issue templates + Projects board

### v0.2 — collaboration & export polish *(weeks 5–8)*

- [ ] Figma copy-paste import (clipboard payload → primitive vocabulary)
- [ ] Selection-overlay polish + transform handles (resize/rotate by drag)
- [ ] Component instances and props (variants beyond ADR-0005's terminal primitives)
- [ ] Style sources panel — surface where each computed value comes from (component, class, instance)
- [ ] Export presets — single-file React component, multi-file with extracted CSS, plain HTML

### v0.3 — extension, multi-agent, IDE *(weeks 9–12)*

**Chrome extension for site capture** *(substantially shipped — load-unpacked today; Web Store submission pending)*

- [x] Content-script overlay (not a browser-action popup — see [ADR-0011](./docs/adr/0011-browser-extension-architecture.md))
- [x] Keyboard-driven DOM walker — hover highlights, `↑↓←→` traverses, Enter commits, Esc exits
- [x] Computed-style serializer (hybrid inline / inherited-diff, ~150 CSS properties: layout, type, color, flex/grid, multi-column, tables, lists, transforms, filters)
- [x] Whole-page capture — auto-scroll-and-settle for lazy-mounted sections, `<html>` capture with `<body>` → `<div>` swap, fresh artboard sized to source
- [x] Hybrid screenshot backplate ([ADR-0012 §1](./docs/adr/0012-capture-fidelity-evolution.md)) — full-page stitched screenshot composited under the HTML tree at opacity 0.15
- [x] Same-origin iframe inlining (via `srcdoc`)
- [x] Author-CSS supplement — extracts source page's `@font-face`, `@keyframes`, `::before` / `::after` rules
- [x] Style-dedup hoist — repeated computed-style blocks share `_djhN` classes; capped at 100 to keep GrapesJS' CSS Manager surface bounded
- [x] `add_css_rules` bridge tool routes captured CSS (~2,400 rules on Wikipedia-class pages) directly into the canvas's CSS Manager, bypassing `parseHtml` stripping
- [x] Granular capture progress (Serializing → Screenshotting → Sending → Rendering) with per-phase events
- [x] Font-CDN allowlist hoist — preserves Google Fonts / Bunny / TypeKit `<link>` tags
- [x] Capture-fidelity diff tool — `scripts/capture-diff.mjs` scores source vs captured per-element drift with ε-tolerance and walk-alignment invariants
- [ ] Chrome Web Store submission (gating public v0.3 availability)
- [ ] Shadow DOM / cross-origin iframes / authed content — deferred to v0.4 CDP per [ADR-0012 §2](./docs/adr/0012-capture-fidelity-evolution.md)
- [ ] Non-CDN font preservation (Phase 1 Google Fonts name fallback + Phase 2 binary inlining — see [docs/font-preservation-plan.md](./docs/font-preservation-plan.md))
- [ ] Chunked `add_components` — eliminates 180s timeout race on Wikipedia-class captures (Q1 in [epic-8-followups.md §9](./docs/epic-8-followups.md))

**Other v0.3 items**

- [ ] Concurrent MCP sessions with workspace isolation (foundation already in the bridge)
- [ ] VS Code custom editor for `.designjs.json`
- [ ] shadcn/ui block library

Detailed stories and acceptance criteria live in [`docs/epic-8-followups.md`](./docs/epic-8-followups.md) and the relevant ADRs.

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Releasing

Maintainer workflow for publishing releases: see [RELEASING.md](./RELEASING.md).

## License

MIT — see [LICENSE](./LICENSE).
