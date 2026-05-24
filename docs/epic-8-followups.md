# Epic 8 — browser extension followups

Operational working doc for the v0.3 Chrome extension. Strategic direction for v0.3.5 → v0.4 lives in [ADR-0012](./adr/0012-capture-fidelity-evolution.md); this doc is the checklist / reference.

---

## Status (as of 2026-05-23)

**v0.3 — shipped.** Three PRD stories (element selection, style serialization, send-to-canvas) functionally complete. See §1.

**v0.3.5 — shipped.** Same-origin iframe inlining (A.1), author-CSS supplement (A.2), capture `<html>` not `<body>` (Experiment A), `mode: "inline"` pre-inlined styles (Experiment C). Outcome on the Python-docs reference: sampled property mismatches **247 → 102 (-58%)**, full UID pairing **97% → 100%**, color/width/height drift dropped out of the top-5 mismatchers. Per-experiment numbers in [capture-fidelity-baseline.md](./capture-fidelity-baseline.md); architectural learnings + roadmap pivot in [ADR-0012 §2026-05-23 addendum](./adr/0012-capture-fidelity-evolution.md#addendum-2026-05-23--v035-research-outcome--roadmap-pivot).

**Resolved gaps** (previously listed in §3 / §4 below):

| Item | Shipped | Commit |
|------|---------|--------|
| §3.1 font-CDN allowlist for `@font-face` | 2026-04-25 | `b1e0d0b` |
| §3.3 `fit_artboard` retry 1500ms → 3000ms | 2026-04-25 | `520d5b4` |
| §3.4 conservative wrapper flattening | 2026-04-26 | `2725778` |
| §4.1 `data-dj-uid` per element | 2026-04-25 | `bb916ae` |
| §4.2 `mode` param on `serialize()` | 2026-04-25 | `bb916ae` |
| 8MB whole-page cap (was 2MB, hit on Wikipedia) | 2026-05-23 | `c23bcb8` |
| Granular capture progress events (serializing → screenshotting → sending → rendering) | 2026-05-23 | `c23bcb8`, `89279f3` |
| Per-call bridge timeout override (`add_components` → 90s) | 2026-05-23 | `4c2bbf4` |
| Style-dedup hoist for mode:"inline" (caps GrapesJS CSS Manager surface at 100 classes) | 2026-05-23 | `124c6f3` |
| CSS Multi-column Layout properties (fixes Wikipedia footer column collapse) | 2026-05-23 | `eacfb6d` |
| Inline bridge-rejection error text in console.error | 2026-05-23 | `d866fe9` |
| **D0** capture-diff walk-alignment + tagMatch invariant (revealed 78% of Wikipedia "drift" was diff-tool noise) | 2026-05-23 | `bbd7da3` |
| Style-dedup verified — 15,508 → 841 CSS rules, 18× reduction (DEDUP-VERIFY) | 2026-05-23 | measurement only |
| **T1** Table-layout properties (`border-collapse`, `border-spacing`, `table-layout`, `caption-side`, `empty-cells`) | 2026-05-23 | `8ad1c58` |
| **L1** List + counter properties (`list-style-*`, `counter-increment`, `counter-reset`, `counter-set`) | 2026-05-23 | `8ad1c58` |
| `vertical-align` non-inherited property | 2026-05-23 | `8ad1c58` |
| Initial-value skip for table/list/vertical-align defaults (fixes the 8MB overflow the bare T1+L1 caused) | 2026-05-23 | `af78be4` |
| **OBS** Reworded "Selection too large" error for whole-page captures | 2026-05-23 | `cb84a7e` |

**Still open — fidelity gaps surfaced by the Wikipedia Love multi-page baseline.** ROI-ranked in §9 below; this list groups by owner doc.

| ID | Item | Where tracked |
|----|------|---------|
| F1–F3 | Font preservation (Google Fonts fallback, binary inlining, local fonts) | [font-preservation-plan.md](./font-preservation-plan.md) |
| T1, L1, C1, D1, OBS | Table / list / clip-path properties; `display` drift; "smaller section" wording | §9 below |
| Q1 | `add_components` 90s flakiness — needs streaming + canvas profiling | §9 below |
| P1–P3 | Pseudo-elements, Shadow DOM, hotlinked images | Deferred to v0.4 CDP per ADR-0012 §2 |
| §3.2 | CSS custom properties verification | Open (no fix unless drift surfaces) |
| B1 | Multi-page baseline still missing MDN, Tailwind, Bootstrap, rubychilds.com | [capture-fidelity-baseline.md](./capture-fidelity-baseline.md) |
| I1 | Inspector unit tests (PositionSection, Layout, Fill/Stroke, Typography) | qa-followups (not yet filed) |
| O1 | Chrome Web Store review submission | ADR-0011 Open Q6 |

**Next architectural step:** GrapesJS plugin `@designjs/grapesjs-fidelity-import` using upstream PR [#6767](https://github.com/GrapesJS/grapesjs/pull/6767) `addParserCode` (merged 2026-05-22). Complements — does not replace — the §2 CDP pivot. Sequencing in [ADR-0012 addendum's revised phasing table](./adr/0012-capture-fidelity-evolution.md#addendum-2026-05-23--v035-research-outcome--roadmap-pivot).

---

## 1 — What shipped in v0.3

The three PRD stories (8.1 element selection, 8.2 style serialization, 8.3 send to canvas) are functionally complete. Summary:

- **Content-script overlay** — React UI injected into the host page (not a browser-action popup; rationale in [ADR-0011](./adr/0011-browser-extension-architecture.md))
- **Keyboard-driven DOM walker** — hover highlights, ↑↓←→ traverses the DOM tree, Enter commits, Esc exits. Matches Paper Snapshot's pattern.
- **Style serializer** — hybrid non-inherited / inherited-diff, shorthand expansion, computed-value resolution for `var(--*)`, per-element output as generated classes in a hoisted `<style data-designjs-capture>` block. The class-based hoist fix (commit `959331d`) was load-bearing — GrapesJS' `parseHtml` strips CSS properties not in each component type's `stylable` allowlist, so inline `style=""` attributes got discarded silently. Classes + a `<style>` block bypass the filter entirely.
- **Media URL resolution** — `<img src>` / `<img srcset>` / `<source>` / `<video src>` / `<video poster>` / `<audio src>` / `<a href>` / `<SVGImage href>` all rewritten from relative to absolute so cross-origin canvas loading works.
- **WebSocket bridge** — direct peer connection to `ws://127.0.0.1:29170/designjs-bridge` as a `browser-extension` peer. Reconnects with exponential backoff. Protocol matches the MCP-server / canvas peer contract.
- **Whole-page capture** — secondary path (element-walk is primary). Captures `document.body`, swaps the outer `<body>` → `<div>` so GrapesJS accepts it, creates a fresh artboard sized to the page, chains `create_artboard` → `add_components` → `fit_artboard` so the frame auto-sizes to measured content.
- **CSS isolation** — the overlay's own Tailwind imports skip preflight (`@import "tailwindcss/theme.css"; @import "tailwindcss/utilities.css"`) so we don't leak global resets (`* { box-sizing }`, `html { line-height: 1.5 }`, heading resets) onto host pages.

### Known v0.3 code paths

| File | Purpose |
|------|---------|
| [packages/chrome-extension/src/capture/dom-walker.ts](../packages/chrome-extension/src/capture/dom-walker.ts) | Keyboard + hover element selection |
| [packages/chrome-extension/src/capture/style-serializer.ts](../packages/chrome-extension/src/capture/style-serializer.ts) | DOM → HTML + class-based CSS hoist |
| [packages/chrome-extension/src/content/index.tsx](../packages/chrome-extension/src/content/index.tsx) | Content-script entry, overlay mount, capture flow |
| [packages/chrome-extension/src/background/index.ts](../packages/chrome-extension/src/background/index.ts) | Service worker, bridge relay, action click handler |
| [packages/chrome-extension/src/transport/ws-client.ts](../packages/chrome-extension/src/transport/ws-client.ts) | WebSocket client with reconnect + request/response correlation |
| [packages/chrome-extension/src/overlay/App.tsx](../packages/chrome-extension/src/overlay/App.tsx) | Overlay UI (start / stop / capture page / status) |

---

## 2 — Verification checklist

After any capture pipeline change, reload the extension (`chrome://extensions` → reload) and re-capture a reference page (rubychilds.com as the baseline).

### Styles landed on the canvas

```bash
python3 -c "
import json
d = json.load(open('/Users/rubychilds/Documents/2026-Projects/DesignJS/.designjs.json'))
print('styles[] count:', len(d['styles']))
def walk(c, counts):
    if any(cls.startswith('_dj') for cls in c.get('classes', []) or []):
        counts['with_dj'] += 1
    for ch in c.get('components', []) or []: walk(ch, counts)
counts = {'with_dj': 0}
for f in d['pages'][0]['frames']: walk(f['component'], counts)
print('components with _dj* class:', counts['with_dj'])
"
```

Pass criteria (post-`959331d`):
- `styles[]` has **hundreds** of entries (not 2 — if it's ≤ 5, GrapesJS didn't parse our hoisted `<style>` block; move it outside the outer `<div>` and retry)
- Hundreds of components carry `_dj*` classes
- Artboard grows past **6000px** after `fit_artboard` on a full-page capture of a typical marketing site
- Visual layout resembles the live page (not collapsed to default block flow)

### Target sites for regression testing

| Site | Tests |
|------|-------|
| `rubychilds.com` | Baseline fidelity — typography + flex/grid + hero image + testimonials |
| Stripe pricing page | **Shadow DOM** — only post-CDP (§[ADR-0012 §2](./adr/0012-capture-fidelity-evolution.md#2-v04--cdp-based-capture-via-chromedebugger)) |
| Chrome Web Store | **Shadow DOM** — web components pervasive |
| Any site with embedded YouTube | **Cross-origin iframes** — only post-CDP |
| `github.com/<authed-dashboard>` | **Authed content** — only post-CDP |
| `linear.app` | Complex typography + `@font-face` (B1) |

---

## 3 — Known gaps (v0.3.x)

Known gaps that the current pipeline cannot close without architectural work. Severity ordering by visual impact.

### 3.1 — Google Fonts / external `@font-face` missing (HIGH impact)

**Status:** ✅ Shipped (CDN allowlist only) — commit [`b1e0d0b`](../packages/chrome-extension/src/capture/style-serializer.ts) (2026-04-25) hoists allowlisted font-CDN `<link>` tags into the captured output. Allowlist: `fonts.googleapis.com`, `fonts.bunny.net`, `use.typekit.net`, `p.typekit.net`.

**Remaining gap:** Sites that bake Google Fonts into their own CSS (no `<link>` tag) or self-host fonts entirely. Multi-phase fix in [font-preservation-plan.md](./font-preservation-plan.md) — Phase 1 (Google Fonts name fallback, Onlook-style) and Phase 2 (font binary download + base64 embed, SingleFile-style).

**Symptom:** Captured text renders in system fallback font (usually `-apple-system` / `BlinkMacSystemFont`) instead of the source page's font (Inter, Geist, Satoshi, etc.).

**Cause:** The extension serializes `font-family: "Inter", sans-serif` correctly via computed style, but `@font-face` declarations live in the source page's `<link>`-loaded stylesheets, which we strip. The canvas iframe has no knowledge of how to load the font file.

**Fix:**
1. During capture, walk `document.head` for `<link rel="stylesheet">`
2. Allowlist hostnames known to serve font CSS: `fonts.googleapis.com`, `fonts.bunny.net`, `use.typekit.net`, `p.typekit.net`
3. Emit matching link tags in the captured HTML (inside the outer `<div>` so they survive the `<body>` → `<div>` swap)
4. GrapesJS iframe fetches them on parse; `@font-face` rules register; text falls into the right font

Expected fix size: ~30 LOC addition to `capture/style-serializer.ts`. No architectural change.

### 3.2 — CSS custom properties (LOW risk, mostly OK)

**Expected:** `getComputedStyle` resolves `var(--foo)` to concrete values before returning — no var references in our captured output. ADR-0011 notes this explicitly.

**Verify** post-fix: on the rendered canvas, colors that use brand tokens should match the live page. If they don't, dig in — there's an edge case somewhere.

### 3.3 — `fit_artboard` retry window (1500ms) may be too tight for heavy captures

**Status:** ✅ Shipped — commit `520d5b4` (2026-04-25) bumped the retry deadline 1500ms → 3000ms in [handlers.ts](../packages/app/src/bridge/handlers.ts). Proportional sizing (2ms per node) not implemented; flat 3000ms has held.

**Symptom:** After whole-page capture lands, the artboard frame is short (e.g. 2000px) on a page whose rendered content is ~8000px. Capture itself succeeded; the measurement raced the iframe layout.

**Fix:** Bump the retry deadline in [handlers.ts:367](../packages/app/src/bridge/handlers.ts#L367) from 1500ms → 3000ms (or make it proportional to the captured node count — 2ms per node, min 1500ms, max 5000ms).

Only ship if §3.1 lands first — once fonts load correctly, layout settles slower than the current budget allows.

### 3.4 — Pass-through wrapper / empty-node bloat (MEDIUM impact — size + parse speed)

**Status:** ✅ Shipped — commit `2725778` (2026-04-26) added a conservative wrapper-flattening pass. A more aggressive idempotent pass remains a future option if multi-page baselines show the conservative pass leaves too much wrapper bloat on heavy frameworks.

**Symptom:** Captured payload is bigger than it needs to be; GrapesJS parse takes hundreds of ms on mid-sized pages because the DOM has hundreds of semantically-empty `<div>` wrappers (framework artifacts — Next.js / React injects them for layout, accessibility, and data-attribute wiring).

**Learning:** `vorbei/figma-capture` + `ApacheAlpha/figma-capture` (both Figma capture.js post-processors) implement exactly this cleanup pipeline: flatten `<div>`s that add no styling, strip empty leaf elements, dedupe wrappers.

**Fix:** Post-process pass in `serialize()` that collapses `<div>` elements whose computed style is "pass-through" — no display change (still block), no background, no border, no padding, no margin, no transform, no opacity. Inline children into parent. Must be idempotent (re-run until no further collapses happen) because flattening reveals new candidates.

Expected: 15-30% payload reduction on typical marketing pages; faster GrapesJS parse; shallower component tree in the canvas inspector.

### 3.5 — Cross-origin hotlink-protected images / SVGs (deferred to v0.4)

Deferred per ADR-0011 Open Q2/Q3. Broken image placeholders for now. Post-v0.4 CDP pivot, `Network.getResponseBody` can fetch + base64-inline these.

### 3.6 — Shadow DOM (deferred to v0.4)

Deferred per ADR-0011 Open Q4. Silently skipped today. Post-CDP (ADR-0012 §2), `DOM.getDocument` traverses shadow roots natively.

---

## 4 — Non-breaking v0.3 stubs (enables v0.4 without refactor)

**Status:** ✅ Both shipped via commit `bb916ae` (2026-04-25).

Two one-line additions that make future v0.4 work additive rather than breaking:

### 4.1 — `data-dj-uid` attribute per captured element

In `capture/style-serializer.ts` `stripAndInline`, add a monotonic UID attribute alongside the class assignment:

```ts
const uid = counters.uidCounter.n++;
(clone as HTMLElement).setAttribute("data-dj-uid", String(uid));
```

This lays the foundation for the `take_snapshot` UID system (ADR-0012 §3) without changing any bridge surface.

### 4.2 — `mode` param on `serialize()`

Accept `mode: "computed"` (default, current behavior) with a `throw` for any other value. Call sites update from `serialize(root, { hardLimit: 2_000_000 })` to `serialize(root, { hardLimit: 2_000_000, mode: "computed" })`.

This reserves the namespace for ADR-0012 §4's author / hybrid modes. Existing behavior unchanged.

---

## 5 — License-hygienic vendoring

Sources we've evaluated for lifting code / algorithms / architectural patterns. License-clean unless noted.

| Source | License | Status | Use |
|--------|---------|--------|-----|
| `simov/screenshot-capture` | MIT | ✅ safe to vendor | Stitcher algorithm for ADR-0012 §1 (lift ~50 lines: scroll-tile-stitch + canvas composite) |
| `folletto/Blipshot` | BSD | ✅ safe to vendor | Alternative stitcher if §1 wants device-pixel-ratio handling different from simov's |
| `chrome-devtools-mcp` | Apache-2.0 | ✅ safe to borrow | Tool taxonomy + UID system (ADR-0012 §3) |
| Onlook | Apache-2.0 | ✅ safe to borrow | G2 reference (separate future ADR) |
| SingleFile | AGPL | ⚠️ study-only | Study architecture; commercial license available from author — **price-check before v0.4 commitment** |
| SnappySnippet | GPL-3.0 | ⚠️ study-only | Author-styles algorithm reference for ADR-0012 §4 |
| CSS_Plus_HTML | GPL-3.0 | ⚠️ study-only | Computed-style flattening trade-offs |
| site-cloner-extension | ❓ verify | ⚠️ check before borrowing | Read as reference |
| `vorbei/figma-capture` | ❓ verify | ⚠️ check before borrowing | Post-processing patterns (§3.4) — confirm license before lifting |
| `ApacheAlpha/figma-capture` | ❓ verify | ⚠️ check before borrowing | Same as above |
| Figma `capture.js` | hosted, no license | ❌ reference only | Cannot depend on — undocumented, subject to change |
| Paper Snapshot | closed-source | ❌ UX blueprint only | We cannot read the code; UX pattern inference only |

**Rule of thumb:** structural-capture tools are mostly copyleft; pixel-capture tools are mostly permissive. The canonical move is to study architectures, borrow taxonomies, and reimplement under MIT / Apache for anything we want in-tree.

---

## 6 — Reading list

Before committing code to ADR-0012 §§ 2-4, read:

1. **`indrajeet-tellis/site-cloner-extension`** — small MV3 capture extension that's legible in an afternoon. Maps directly onto the structural-capture problem. The cleanest "here's how the pieces fit" reference before diving into SingleFile's much larger codebase.
2. **SingleFile [integration API wiki](https://github.com/gildas-lormeau/SingleFile/wiki/How-to-integrate-the-API-of-SingleFile-into-an-extension)** — what a mature version of the same shape looks like. Returns `{ content, title, filename }`. Pruning options (`removeHiddenElements`, `removeUnusedStyles`, `removeUnusedFonts`, `compressHTML`) are the toggles we'd mirror for author-mode (ADR-0012 §4).
3. **`vorbei/figma-capture` + `ApacheAlpha/figma-capture`** — both small OSS post-processors on Figma's capture.js. Font remapping + pass-through-wrapper flattening + empty-node cleanup. Every one of these fixes is something we'll need (§3.4 in particular).
4. **`html.to.design` Chrome extension** (no source; product docs + public behavior) — reference for CDP-based capture UX. Understand their "Debugger attached" banner flow and how they frame the permission request to users before buying a similar experience.
5. **`chrome-devtools-mcp` source** (already cloned at `/chrome-devtools-mcp/`) — specifically `src/tools/take_snapshot.ts`, `src/tools/take_screenshot.ts`, `src/tools/evaluate_script.ts`, and whatever module owns the UID map. Read before designing our bridge-tool equivalents.
6. **`simov/screenshot-capture` source** (already cloned at `/screenshot-capture/`) — `content/index.js` (scroll-tile-capture loop) + `content/crop.js` (canvas composite). ~50 lines to lift.

---

## 7 — Price-check SingleFile commercial license

Before week 1 of ADR-0012 §2 / §4 implementation, get a concrete price + timeline from Gildas Lormeau. If the commercial license is materially cheaper than the CDP-path implementation, the calculus flips: we integrate SingleFile and skip the in-house author-mode capture entirely.

**Owner:** TBD
**Deadline:** Before v0.4 engineering sprint kicks off

Status: **resolved 2026-05-04 — not pursuing the commercial license at this
time.** Decision: build author-mode (ADR-0012 §4) in-house via the CDP path;
do not buy or vendor SingleFile. An AGPL working copy lives at `SingleFile/`
(gitignored, never committed — AGPL is study-only per §H) for architecture
reference only. Revisit the price-check only if the in-house CDP author-mode
path proves materially more expensive than expected.

---

## 9 — Fidelity roadmap (post-v0.3.5, ROI-ranked)

Gaps surfaced by the Wikipedia Love multi-page baseline + comparative read of
SingleFile / Onlook / Blipshot / screenshot-capture / chrome-devtools-mcp.

ROI = (fidelity / UX gain) ÷ (effort + risk). Effort estimates assume one
focused day = `S`, two-three days = `M`, week or more = `L`.

### Tier 1 — high-ROI, low effort

| ID | Gap | Why now | Effort | Status |
|----|-----|---------|-------:|--------|
| **T1** | Table-layout properties (`border-collapse`, `border-spacing`, `table-layout`, `caption-side`, `empty-cells`) | Same shape as the multi-column fix. Wikipedia / docs / Bootstrap rely on tables for layout. | S | ✅ Shipped `8ad1c58` + initial-value skip `af78be4` |
| **L1** | List-style properties (`list-style-type`, `-position`, `-image`, `counter-increment`, `counter-reset`, `counter-set`) | Every Wikipedia / MDN article has bullets and numbered lists. | S | ✅ Shipped `8ad1c58` |
| **OBS** | "Selection too large" error reworded for whole-page captures | Trivial UX correctness. | XS | ✅ Shipped `cb84a7e` |
| **D0** (NEW) | capture-diff walk alignment — source-side and captured-side walks diverged; 78% of Wikipedia "drift" was diff-tool noise | All future fidelity measurements depend on this | S | ✅ Shipped `bbd7da3` |
| **DEDUP-VERIFY** | Run `capture-diff` post-dedup on Wikipedia Love | Settle whether `124c6f3` is pulling weight. | XS | ✅ Verified — 15,508 → 841 CSS rules (18× reduction) |
| **F1** | Google Fonts name fallback ([font-preservation-plan.md](./font-preservation-plan.md) Phase 1) | Closes the font-family mismatches on non-CDN-served Google Fonts. Specced. | M | ⏳ In progress |
| **D1** | The 7 `<a>` `flex → inline` mismatches — clean signal post-D0 | Real fidelity bug, root cause unclear (cascade fight hypothesis) | S | ⏳ In progress |
| **GrapesJS doc PR** | Upstream PR documenting the wrapper-`stylable` workaround for HTML import | Easy goodwill, builds community presence before harder upstream PRs | S | ⏳ In progress (style guide collected) |

### Tier 2 — medium-ROI, medium effort

| ID | Gap | Why | Effort | Risk |
|----|-----|-----|-------:|-----:|
| **C1** | CSS clipping (`clip-path`, `clip-rule`, `mask`, `mask-image`, `mask-mode`, `mask-position`, `mask-size`) | Modern marketing sites with clipped UI; SingleFile / Onlook both ignore these. Capturing them is a competitive edge. | S-M | low |
| **D1** | Investigate `display` drift on Wikipedia (33 mismatches). Hypotheses: `display:contents`, `display:list-item`, `display:table-cell`. Diff the 33 mismatched elements to identify the pattern. | We don't know yet what's wrong. Investigation, not fix. | S (diff + write-up) | none |
| **Q1** | Chunked `add_components` — split large captures into N batches the canvas renders incrementally. Removes the 90s timeout race + gives real progress UX on canvas side. | The flaky "second-try lands" pattern on Wikipedia is the biggest current UX bruise. Bumping the timeout is a band-aid. | M-L | medium — bridge + content + canvas all touch |
| **F2** | Font binary download + base64-inline ([font-preservation-plan.md](./font-preservation-plan.md) Phase 2). | Closes the non-CDN font case (Wikipedia's `"GT Flexa Standard"`, `"NB International Pro"`). Needs new `host_permissions`. | M | medium — MV3 service-worker fetch, permission gate |
| **B1** | Capture MDN, Tailwind landing, Bootstrap demo, rubychilds.com → fill the 5-page fixture per the original plan. | Validates fidelity beyond Wikipedia. Cheap in code, costs user time per capture. | S (per page) | none |
| **I1** | Inspector unit tests (PositionSection, Layout, Fill/Stroke, Typography). | Test-coverage gap from Wave 1; unrelated to fidelity but flagged here for completeness. | M | low |
| **GRAPESJS-PROFILE** | Open canvas DevTools Performance tab during a Wikipedia capture; record the parse phase. Identifies whether `parseCss` or `parseHtml` is the bottleneck. | Without this we're guessing at Q1's shape. | S | none |
| **Q2** | Delete-artboard slowness on Wikipedia-class captures (~7k components, ~2.4k CSS rules). `deleteArtboard` calls `collection.remove(frame)` which cascades Backbone destructors per child component + fires per-component remove events that re-render LayersPanel + inspector. Captures of large pages take many seconds to remove and can hang the tab. | Workflow blocker for experimentation — every capture iteration leaves a stale artboard behind that's expensive to clean up. | M | medium — possible fixes: suspend events during deletion via `editor.UndoManager.skip`, batch-update LayersPanel/inspector subscribers, or use a lower-level Page API. Investigation needed first. |
| **Q3** | Body-height inflation on Wikipedia captures (33,041px vs source 23,108px, +43%). After author CSS now applies via `add_css_rules`, some elements gained padding/margin that wasn't there in the source-as-rendered state. Likely cause: body→div / html→div swap means selectors like `body > .container` no longer match in the canvas, so margin-collapse and inheritance compute differently. | Real but secondary to the structural-fidelity win the add_css_rules chunking just landed. | M | medium — needs per-element height-drift analysis on the audit-diff to identify which selectors are misfiring. |

### Tier 3 — high-impact but blocked on v0.4 (CDP)

Tracked in ADR-0012 §2; not actionable until the CDP pivot.

| ID | Gap | Blocker |
|----|-----|---------|
| **P1** | Pseudo-elements (`::before`, `::after`, `::first-letter`, list markers) — `content:` property + computed style for pseudos. Today works only via author CSS (cascade-equivalent, but `content:url(...)` and dynamic `attr()` are blind). | Needs `CSS.getMatchedStylesForNode` |
| **P2** | Shadow DOM (Stripe, Chrome Web Store, web-components-heavy sites) | Needs `DOM.getDocument` with shadow-root traversal |
| **P3** | Cross-origin hotlink-protected images | Needs `Network.getResponseBody` |
| **AUTH** | Authed content (GitHub dashboards, internal tools) | CDP attaches to the live session |
| **F3** | Local desktop fonts (Penpot/Figma path) — [font-preservation-plan.md](./font-preservation-plan.md) Phase 3 | Web side: needs font upload UI; native: needs Local Font Access API + companion app |

### Recommended sprint sequencing

If we're optimizing for **closing the Wikipedia drift**:
1. **DEDUP-VERIFY** (5 min) → either keep dedup or revert before further work
2. **T1 + L1** (one PR, ~half a day) — same shape as multi-column fix
3. **F1** (Google Fonts fallback, ~2 days) — biggest single-source-of-mismatches fix
4. **D1 investigation** → then a Tier 1 follow-up on whatever it surfaces

If we're optimizing for **shipping Chrome Web Store v0.3 public**:
1. **DEDUP-VERIFY** → revert if not helping
2. **OBS** (reword) — minor polish
3. **Q1** (chunked add_components) — eliminates the timeout flake that would burn first impressions
4. **O1** (submit to Web Store)

### Comparative tool learnings (where they informed this list)

Per a structured read of vendored sources (`SingleFile/`, `onlook/`, `Blipshot/`,
`screenshot-capture/`, `chrome-devtools-mcp/`):

- **Onlook** ([style.ts](../onlook/apps/web/preload/script/api/elements/style.ts)) reads `getComputedStyle` raw — no property allowlist, no inherited-diff. Our allowlist + diff is more correct for GrapesJS, which strips non-`stylable` properties. Conclusion: don't adopt their approach for capture; their layered output (defined-vs-computed) could be a future inspector feature.
- **SingleFile** (AGPL — study only) inlines `@font-face` binary data via `fetch + base64`. Pattern documented in [font-preservation-plan.md](./font-preservation-plan.md) Phase 2.
- **Blipshot** / **screenshot-capture** — pixel-only; algorithm already vendored for `captureFullPagePixels`.
- **chrome-devtools-mcp** — reference for the v0.4 CDP three-tool split (snapshot / screenshot / evaluate).
- **Penpot** — design tool, no capture surface. Their font library pattern informs F3.
- **Properties they capture that we don't:** `clip-path` / `mask*` (→ C1), `container-*` (low priority, modern feature), `text-underline-offset` / `text-decoration-thickness` (low priority).
- **Property categories we capture that they don't:** flex/grid longhand split, inherited-diff. Both are GrapesJS-shape-specific; keep them.
- **No tool we surveyed solves pseudo-element content from a content script.** Confirms P1 needs CDP.

License notes preserved in §5 above.
