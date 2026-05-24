# ADR-0011: Browser extension architecture — transport + style serialization

**Status:** Accepted (2026-04-24)
**Date:** April 22, 2026
**Owner:** Architecture
**Related:** [ADR-0001](./0001-frontend-ui-stack.md) (WebSocket bridge on `127.0.0.1:29170`); PRD Story 8.1 (element selection + capture), Story 8.2 (style serialization), Story 8.3 (send to DesignJS); **extended by [ADR-0012](./0012-capture-fidelity-evolution.md)** (v0.3.5 hybrid screenshot backplate + v0.4 CDP pivot + three-tool split + author/computed hybrid modes)

> **Post-implementation note (2026-04-23):** Several Open Questions below are resolved or superseded by ADR-0012. In particular: Q2/Q3 (cross-origin images / SVGs) become tractable via CDP's `Network.getResponseBody`; Q4 (Shadow DOM) becomes tractable via CDP's `DOM.getDocument` which pierces shadow roots natively. Status annotations inline below. The v0.3 decisions in this ADR (direct WS transport, content-script capture as the default, hybrid inline / inherited-diff serialization) continue to ship; ADR-0012 evolves the *capture* half of the design without reversing it.

---

## Context

PRD Epic 8 ships a Chrome extension that lets users capture any element from any webpage and drop it onto the DesignJS canvas. The PRD's Stories 8.1 / 8.2 / 8.3 already specify acceptance criteria concretely (keyboard-navigated hover overlay, computed-style inlining, WebSocket send to port 29170). Most of the work is mechanical: Chrome extension boilerplate, DOM walker UX, popup.

There's an existing `chrome-ext/` scaffold at the repo root — a stripped-down manifest-v3 / React / Tailwind extension copied from another product. We're reusing the infrastructure (manifest, webpack, icons, test harness) and writing DesignJS-specific `capture/` + `transport/` + `popup/` modules on top.

Only **two architectural choices** are genuinely undecided after the PRD AC. This ADR pins them; everything else is implementation.

---

## Decision

### 1. Transport — direct WebSocket from extension to the bridge

The extension opens its own connection to `ws://127.0.0.1:29170/designjs-bridge`, identifies as a `browser-extension` peer on the `hello` handshake, and sends capture payloads as `{ type: "add_components", html, target?: "default" }` messages. The bridge dispatches to the canvas peer using the existing multi-peer routing it already ships for MCP-server / canvas pairs.

**Alternatives considered:**

- **HTTP POST to the MCP server.** Rejected: the MCP server is stdio-only today and adding an HTTP listener is overhead we don't need. Also requires an MCP server to be running, which isn't guaranteed for users who haven't connected an agent.
- **Content-script DOM injection.** Rejected: only works when the user has the DesignJS canvas open in another tab of the same browser; cross-window DOM messaging has sandboxing friction.

**Why WebSocket wins:**
- Bridge already ships multi-peer routing; we add a new peer type, not a new transport.
- Extension works even with no agent connected — user can capture → see it on canvas → prompt an agent later.
- Matches the architecture Paper / Pencil use for external integrations.
- One failure mode to surface: "DesignJS canvas not running" (connection refused). Maps directly to Story 8.3 AC *"If DesignJS is not running, show message: Start DesignJS first"*.

**Bridge-side change:** the bridge's peer-type enum gains `browser-extension`. The extension is read/write like the MCP server — it can send `add_components` / `add_classes` / `update_styles` / `set_text` today via the same request/response plumbing. We don't expose the full tool surface to the extension for v0.3 — only the handful needed for capture — but the transport doesn't restrict it.

### 2. Style serialization — hybrid inline / inherited-diff

When the user captures a selected subtree, the serializer walks the tree from root and emits inline styles per element using a **hybrid strategy**:

- **Non-inherited properties** (layout, dimensions, background, border, shadow, transform, opacity, z-index, flex/grid, position): always inline the full computed value on every element.
- **Inherited properties** (font-family, font-size, line-height, color, letter-spacing, text-align, cursor, direction): only inline if the computed value **differs from the parent's computed value**. Otherwise the child inherits naturally via CSS cascade, keeping the payload tight.
- **Shorthand properties**: expand (`margin: 10px 20px` → `margin-top: 10px; margin-right: 20px; margin-bottom: 10px; margin-left: 20px`) so the canvas inspector can edit individual sides.
- **CSS custom properties** (`var(--color-primary)`): resolve to the computed concrete value at capture time. The origin variable name is not preserved (the user's page can have any random variables we shouldn't leak into the canvas's token system).

**Alternatives considered:**

- **Full inline, every property on every node.** Rejected: blows the 500KB Story 8.2 payload target. A 40-node hero section × ~300 computed CSS properties × ~20 chars per property ≈ 240KB on the pessimistic side, and real payloads routinely hit 500KB+ for pages with many elements.
- **Tree-diff with generated utility classes.** Rejected for v0.3: emit a `<style>` block with hoisted classes shared across siblings with identical styling, children reference the class. Smaller payload; correct CSS cascade; but significantly harder to get right (specificity edge cases, generated class-name collisions with the target page's stylesheet). Revisit in v0.4 if payloads become a problem.

The hybrid is the Goldilocks option — easier to implement than Option B but tighter than Option A on realistic pages where typography inheritance dominates. Estimated payload reduction vs. full inline: **30–50%** on typical marketing pages, enough to sit comfortably under 500KB.

**Size budget watchdog:** the serializer tracks cumulative payload size as it walks. The caps are configurable via `serialize(root, { hardLimit, softLimit })`:

- **Element selection** (default): soft 400KB, hard 500KB. At 400KB the serializer pushes a warning; at 500KB it aborts and returns `{ error: "too-large", nodeCount, byteCount }`. User sees "Selection too large — try capturing a smaller section."
- **Whole-page capture**: hard 2MB (soft auto-derived at 80%). Real pages routinely hit 800KB–1.5MB once fonts + hero imagery + inline SVG are inlined; the 500KB element cap is too strict for intentional whole-page captures. The 2MB ceiling protects the WebSocket/canvas from pathological pages while giving most marketing sites room.

**Whole-page capture:** the overlay exposes a "Capture page" button alongside element selection. It serializes `document.body` directly (skipping the hover walker) with the relaxed 2MB cap. The overlay is mounted at `document.documentElement` (not `<body>`) so it's not nested inside the capture root — it naturally stays out of the serialized payload without needing explicit filtering.

**Custom-property scope:** inherited-diff also skips `var(--…)` references — if parent resolves `--primary` to `#ff3366` and child inherits the same value, child doesn't need any declaration.

---

## Consequences

- **Bridge gains one peer type (`browser-extension`).** Small additive change to the bridge's hello-handshake enum. No breakage to the MCP-server / canvas peer contract.
- **Extension doesn't require an agent to be running.** Cleanest "capture now, prompt later" workflow.
- **Payload target (Story 8.2 AC: <500KB) is reachable** for typical hero sections with the hybrid serializer. Extreme cases (full-page captures) hit the watchdog and fail cleanly.
- **Custom-property resolution strips token provenance.** A user's page using `var(--color-primary: #ff3366)` shows up on canvas as `#ff3366`, not as a DesignJS token. This is the right default — we can't assume the user's design-system names map to DesignJS's. A stretch feature (v0.4+) could *prompt* the agent to convert hard-coded colors into DesignJS tokens after capture.
- **Extension tool surface is capped to what the canvas needs.** Even though the bridge doesn't restrict it, the extension only sends `add_components` in v0.3 (and optionally `set_text` for text selection tweaks). No `delete_nodes` or other write tools from the extension — keeps the blast radius small.
- **Scaffold delta.** Existing `chrome-ext/` scaffold strips ~95% of `src/` (Orbis-specific) and retains manifest-v3 skeleton + webpack config + icons + chrome-promise utility + test harness. New code: `src/capture/dom-walker.ts`, `src/capture/style-serializer.ts`, `src/transport/ws-client.ts`, minimal popup. Rehoming to `packages/chrome-extension/` so it participates in the pnpm workspace + CI.

---

## Open questions

1. **Capture scope — subtree or just the selected element?** Story 8.1 AC says "captures the selected element and its entire subtree" — that's the decision. But "subtree" can mean "DOM descendants" or "visual descendants" (some off-screen / `display:none` children skipped). v0.3 ships "DOM descendants, skip `display:none`." Users who want everything can capture the parent explicitly.

2. ~~**`<img>` handling.**~~ **Resolved 2026-04-23 (partial — option (a) shipped).** Media URLs (`img.src`, `img.srcset`, `<source>`, `<video src>` / `poster`, `<audio src>`, `<a href>`, `<SVGImage href>`) are now rewritten to absolute URLs via the DOM-property side (`img.src` returns the resolved absolute URL, unlike `getAttribute("src")` which returns the as-authored relative string). Computed-style URLs (`background-image`, `list-style-image`, `cursor`, etc.) already resolve to absolute via `getComputedStyle` and emit correctly through `buildInlineStyle`. `srcset` is parsed + each entry's URL resolved individually.

   **Remaining gap for v0.4:** cross-origin hotlink protection — sites that block `<img>` requests based on `Referer` will still show broken images on canvas. Option (b) (fetch + base64-encode at capture time) or option (c) (upload to `.designjs.json` assets) can close the gap but bloats payload. Deferred; docs currently say "some sites with hotlink protection may show broken images."

   **Resolved 2026-04-23 (direction only):** [ADR-0012 §2](./0012-capture-fidelity-evolution.md#2-v04--cdp-based-capture-via-chromedebugger) — v0.4 CDP pivot exposes `Network.getResponseBody` which can fetch authed / hotlink-protected assets in the user's browser session and base64-inline them at capture time. Closes the gap without needing a separate upload pipeline.

3. **SVG inline vs. external.** Inline `<svg>` captures cleanly. `<img src="*.svg">` or `background-image: url(*.svg)` hit the cross-origin problem above. Same resolution as images.

   **Resolved 2026-04-23 (direction only):** Same path as Q2 — CDP `Network.getResponseBody` via [ADR-0012 §2](./0012-capture-fidelity-evolution.md#2-v04--cdp-based-capture-via-chromedebugger).

4. **Shadow DOM.** Many modern sites use web components with shadow DOM. The capture walker has to choose: pierce shadow roots (heavier, more complete) or skip them (lighter, may miss critical styling). Leaning skip for v0.3; log a warning to the popup.

   **Resolved 2026-04-23 (direction only):** [ADR-0012 §2](./0012-capture-fidelity-evolution.md#2-v04--cdp-based-capture-via-chromedebugger) — CDP's `DOM.getDocument` / `DOM.resolveNode` traverse shadow roots natively. The v0.4 CDP capture path removes the lighter-vs-complete tradeoff; content-script fallback retains the v0.3 skip behavior.

5. **Position scoping on capture.** If the captured element uses `position: absolute` relative to an ancestor that's not captured, the positioning loses its anchor on the canvas. Safest: convert captured-root's `position: absolute` to `position: relative` or drop positioning entirely. Needs an ADR-level call once we've seen real captures — flagged for the implementation spike.

6. **Chrome Web Store review timeline.** Review is 1-2 weeks elapsed. Factor into v0.3 delivery gate — the marketplace listing happens AFTER the extension is feature-complete to avoid a bad first impression, not in parallel with development.

---

## References

- PRD Story 8.1 / 8.2 / 8.3 (all AC items)
- [ADR-0001](./0001-frontend-ui-stack.md) — WebSocket bridge + multi-peer routing foundation
- Existing scaffold: `chrome-ext/` (pre-strip) → `packages/chrome-extension/` (post-strip, post-rehome)
- Anima / Locofy / Penpot-exporter Figma plugins (Plugin API pattern; this is the *web* equivalent via Chrome extension)

---

## Addendum (2026-04-24) — implementation status

The v0.3 stories shipped in the early-Epic-8 chain (`3ad3214`, `36d2df2`,
`e1a38fd`, `341ee77`, `959331d`); status flipped to Accepted with two
v0.3 polish landings on top:

- `bb916ae` — v0.4 prep stubs from epic-8-followups §4.1 / §4.2.
  `serialize()` now stamps `data-dj-uid="<n>"` on every cloned element
  (reserved for ADR-0012 §3 snapshot UID addressing) and accepts an
  explicit `mode: "computed"` option, throwing on any other value so a
  forward call site asking for "author" or "hybrid" fails loud rather
  than silently returning computed-mode output mislabelled. Both
  content-script call sites updated to pass `mode: "computed"` through.
  Ships with a defensive jsdom-compat guard on the `SVGImageElement
  instanceof` check so the new vitest spec can exercise the serializer
  without a browser. No behaviour change in MV3 contexts.
- `b1e0d0b` — Google Fonts / external `@font-face` polish per
  followups §3.1. New `collectFontLinks(document.head)` helper walks the
  host page's head for `<link rel="stylesheet">` whose URL hostname
  matches a narrow allowlist (`fonts.googleapis.com`, `fonts.bunny.net`,
  `use.typekit.net`, `p.typekit.net`) and emits clean `<link rel="stylesheet"
  crossorigin>` tags. The result is spliced into the captured page right
  after the outer `<div>`'s opening tag (post body→div swap) so the
  canvas iframe loads them before text renders. Closes the system-
  fallback-font symptom that Inter / Geist / Satoshi pages were
  hitting. Allowlist deliberately narrow — only services that
  exclusively ship font CSS, so adding the helper doesn't re-open the
  security gap that the LINK strip closes.

The remaining followups items (§3.3 fit_artboard retry-window bump,
§3.4 wrapper flattening) and ADR-0012's larger v0.4 work (CDP pivot,
three-tool split, author/computed/hybrid modes) are tracked in their
respective documents.

Tier-1 follow-up landing (2026-04-24):

- `520d5b4` — epic-8-followups §3.3, fit_artboard retry deadline
  1500ms → 3000ms in `packages/app/src/bridge/handlers.ts`. Now that
  `b1e0d0b`'s Google Fonts hoist landed, `@font-face` loading delays
  text layout past the prior budget; large captures + screenshot
  backplate (ADR-0012 §1) settle slower too. The followups doc gated
  this bump on §3.1 shipping first; that's now done.
- `2725778` — epic-8-followups §3.4, conservative wrapper flattening.
  Post-process pass in `serialize()` unwraps pass-through `<div>`s
  whose class CSS is purely default-block declarations and which have
  exactly one element child + no text + no significant attributes.
  Allowlist-based — false negatives acceptable, zero false positives.
  9 vitest specs covering structural-safety negatives. Targets the
  Next.js / React framework-injected wrapper bloat (15-30% payload
  reduction expected on marketing pages).

---

## Addendum (2026-05-04) — v0.3.5 same-origin fidelity landings

Two content-script-only evolutions of the v0.3 capture path —
deliberately scoped to what the existing serializer can reach without
the manifest `"debugger"` permission or any of the ADR-0012 §2 CDP
plumbing. Both close *same-origin* halves of gaps that §2 was written
to address; the cross-origin halves remain §2's responsibility.

- `5226b68` — **Same-origin iframe inlining (A.1).** When the source
  iframe's `contentDocument` is reachable, `stripAndInline()` calls
  `serialize()` recursively on `contentDocument.body` and re-emits the
  result on the cloned iframe's `srcdoc` attribute. Each inlined
  iframe carries `data-designjs-inlined-iframe="<bytes>"` for
  inspector / future-tooling hooks. Inlined HTML counts against the
  parent's size budget; <4KB headroom = skip rather than abort.
  Cross-origin iframes (`SecurityError` on `contentDocument`) pass
  through unchanged with the absolute `src` `normalizeMediaAttrs`
  already wrote. 4 vitest specs.
- `debdc1d` — **Author-CSS supplement (A.2).** New exported
  `collectAuthorCss(doc)` walks `document.styleSheets`, extracts CSS
  from same-origin sheets (cross-origin throws on `.cssRules`), and
  rewrites relative `url(...)` against `sheet.href ?? doc.baseURI`.
  Emitted as a hoisted `<style data-designjs-author>` block *before*
  the existing `<style data-designjs-capture>` block so the computed
  layer (later in source order) wins on equal-specificity conflicts.
  Brings along what the computed walker can't see: `@keyframes`,
  `@font-face` (beyond the narrow font-CDN allowlist), `::before` /
  `::after` pseudo-element rules, `@supports` / `@layer` / `@page`.
  `@import` and `@charset` rules skipped. 11 vitest specs.

**Important non-shipped distinction:** A.2 is a *supplement*, not the
ADR-0012 §4 author/computed/hybrid `mode` system. There is still no
`mode: "author"` / `mode: "hybrid"`; the cascade ordering means
`@media` reflow does *not* take effect on the canvas (computed values
snapshotted at the host viewport override narrower-width media rules).
True `@media` reflow requires §4 — explicitly out of scope here. See
[ADR-0012's 2026-05-04 §§2/§4-scope addendum](./0012-capture-fidelity-evolution.md#addendum-2026-05-04--scope-clarification-after-v035-same-origin-landings).

Vitest suite at the time of landing: 28 → 39 specs across the
chrome-extension package; typecheck clean; webpack build clean.

---

## Addendum 2026-05-24 — CSS routing via the `add_css_rules` bridge tool

ADR-0011 originally specified style serialization as an in-band concern:
the extension serializes computed styles into HTML the canvas receives
via `add_components`, where GrapesJS' `parseHtml` is expected to register
`<style>` blocks via its CSS Manager during import. That contract held
for `mode: "computed"` (commit `959331d`'s class-hoist fix) but broke on
two fronts once the v0.3.5 fidelity work introduced new CSS sources.

### Failure mode observed

After dedup hoisting landed (commit `124c6f3`) and the author-CSS
supplement (A.2) was generating substantial CSS surface, captures of
Wikipedia "Love" showed dedup-classed elements rendering with UA defaults
(7 `<a>` elements with `display: flex` resolving to `inline`). Canvas
DevTools inspection confirmed **0 of 1,949 iframe stylesheets contained
any `_djh*` rule**. The same survey found 0 `.mw-parser-output` rules
from the author supplement. Both `<style>` blocks were silently being
stripped from the import HTML by GrapesJS, regardless of whether they
were placed as children of the captured wrapper or as top-level siblings
of it (verified post-commit `c4248f3`, which moved them outside).

### Decision: route captured CSS out-of-band via a new bridge tool

Add an `add_css_rules` tool to the bridge protocol that calls
`editor.Css.addRules(cssText)` directly on the canvas. This API
registers rules in the editor's CSS Manager without going through
`parseHtml` — the strip behavior doesn't apply, and rules render into
each frame's iframe stylesheet via the editor's normal rendering path.

The capture flow becomes a two-call dispatch (per artboard):

  1. `create_artboard` — new frame
  2. `add_css_rules` — register the captured CSS into the CSS Manager
     before any element references the classes
  3. `add_components` — import the structural HTML; classes resolve
     against rules already registered in step 2
  4. `fit_artboard` — best-effort height resize

Implementation:

- `9c99089` — bridge schema (`AddCssRulesInput / Output`) + canvas
  handler + extension-side extraction + relayCapture orchestration.
  Schema is `.strict()` per QA-2 conventions; 6 schema tests.
- `de26fbf` — chunk the cssText at rule boundaries before calling
  `addRules`. GrapesJS' CSS parser returns 0 rules for the entire batch
  if any rule in the input fails — verified at 549KB of Wikipedia CSS
  (head 5KB parsed 43 rules; full string yielded 0). 32KB chunks bound
  the blast radius of one bad rule to its chunk, brace-depth-tracked so
  at-rules never split. 5 chunkCss tests.
- Extension-side: new `extract-styles.ts` helper pulls the three style
  markers (`data-designjs-author / -dedup / -capture`) out of the
  serializer's output, returns the CSS body for the bridge call plus
  the styles-stripped HTML for `add_components`. 6 extract-styles tests.

### Measured outcome

Same Wikipedia capture, post-merge:

| | Before `add_css_rules` | After |
|---|---:|---:|
| `_djh*` rules in iframe stylesheets | 0 | 100 (full classCap reached) |
| `.mw-parser-output` rules | 0 | 233 |
| Total iframe stylesheets | ~870 | 2,813 |
| `<a class="_djh1">` computed `display` | `inline` | **`flex`** |
| `addRules` parse result on 549KB cssText | 0 rules | 2,395 rules |

### Consequences

- **Bridge surface grows by one tool.** `add_css_rules` is now part of the
  canvas-side contract any peer must implement. MCP server and any
  future bridge consumer (e.g. the planned GrapesJS plugin in
  ADR-0012's 2026-05-23 addendum) inherit this expectation. The tool
  is dispatched canvas-side as a WRITE_TOOL so persistence catches the
  state change.

- **Capture flow gained a step.** The extension's `relayCapture` now
  dispatches 3-4 sequential bridge calls per page capture (create →
  css → optional backplate → components → fit). The `add_css_rules`
  call is best-effort (try/catch) — a failure logs a warning but the
  structural capture still proceeds, matching the backplate's failure
  semantics.

- **In-band `<style>` blocks deprecated for captured content.** The
  extension content script now strips `<style data-designjs-*>` blocks
  from the import HTML and routes them through `add_css_rules`
  instead. The serializer still emits the blocks (other consumers may
  rely on the in-HTML form), but the page-capture path drops them.

- **Performance ceiling raised.** Chunking + canvas-side CSS Manager
  routing converted a hard-failure mode (0 rules) into a graceful path
  that handles Wikipedia-class CSS surfaces. `add_components` timeout
  bumped to 180s in the same patch series to absorb GrapesJS' larger
  component-tree builds (filed Q1 / Q2 / Q3 in epic-8-followups §9 as
  the next performance investments).

### Cross-references

- [epic-8-followups.md](../epic-8-followups.md) §9 — full Tier 1 status
  reflecting today's landings, plus Q1-Q3 perf follow-ups.
- [ADR-0012](./0012-capture-fidelity-evolution.md) — the v0.4 CDP path
  may eventually replace `add_css_rules` if `Network.getResponseBody`
  + a different ingestion shape becomes viable; until then the
  CSS-Manager route is canonical.

---

*End of ADR-0011.*
