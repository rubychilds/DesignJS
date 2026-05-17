# Epic 8 — browser extension followups

Operational working doc for the v0.3 Chrome extension. Strategic direction for v0.3.5 → v0.4 lives in [ADR-0012](./adr/0012-capture-fidelity-evolution.md); this doc is the checklist / reference.

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

**Symptom:** After whole-page capture lands, the artboard frame is short (e.g. 2000px) on a page whose rendered content is ~8000px. Capture itself succeeded; the measurement raced the iframe layout.

**Fix:** Bump the retry deadline in [handlers.ts:367](../packages/app/src/bridge/handlers.ts#L367) from 1500ms → 3000ms (or make it proportional to the captured node count — 2ms per node, min 1500ms, max 5000ms).

Only ship if §3.1 lands first — once fonts load correctly, layout settles slower than the current budget allows.

### 3.4 — Pass-through wrapper / empty-node bloat (MEDIUM impact — size + parse speed)

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
