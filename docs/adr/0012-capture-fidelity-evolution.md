# ADR-0012: Capture fidelity evolution — hybrid screenshot backplate, CDP pivot, three-tool split

**Status:** §1 Accepted (2026-04-24); §§2–4 remain Proposed
**Date:** 2026-04-23
**Owner:** Architecture
**Related:** [ADR-0011](./0011-browser-extension-architecture.md) (Epic 8 browser extension; superseded in part — see Consequences), PRD Story 8.1 / 8.2 / 8.3, Ruby's research notes ([website-capture-research.md](https://github.com/anthropics/meta-docs) / [capture-tool-comparison.md](https://github.com/anthropics/meta-docs) — working copies in the Obsidian vault)

---

## Context

ADR-0011 shipped the v0.3 extension as a content-script-only capture → WebSocket bridge → canvas pipeline. The initial dog-fooding on real marketing sites (rubychilds.com as the reference case) surfaced three distinct classes of fidelity gap that the v0.3 architecture cannot close on its own:

1. **GrapesJS iframe renders differently from the source browser** regardless of how perfect the DOM serialisation is — no source-page viewport units, no hydrated React state, no scroll-triggered animations, potentially different fonts. Even a byte-accurate capture will look "off" in the canvas because the rendering context is different. No amount of serialisation tuning fixes this; the user needs a ground-truth reference *on the artboard*.
2. **Content-script capture has a hard ceiling**. It cannot reach inside shadow DOM reliably, cannot traverse cross-origin iframes, has weaker access to the full style cascade, and cannot capture pages behind authentication. Modern sites hit all four constantly (web components, embedded YouTube/Stripe, logged-in dashboards). Every serious capture tool in the ecosystem — `html.to.design`, `chrome-devtools-mcp` (Google's own) — uses the **Chrome DevTools Protocol** via `chrome.debugger` to cross these boundaries.
3. **The tool surface is collapsing onto a standard shape**. `chrome-devtools-mcp` and `tldraw-Agent-Starter-Kit` have converged on `take_snapshot` / `take_screenshot` / `evaluate_script` with a persistent element-UID system. Our current single `capture:send` entry point will need to split along these lines when we integrate agent-driven page reasoning; designing for that shape now avoids a rewrite later.

Plus two smaller findings from Ruby's research that inform v0.4:

- **Author styles vs computed styles.** Current v0.3 inlines computed styles for every element (hoisted to classes per ADR-0011 plus the post-0011 fix in commit `959331d`). That's right for agent consumption (self-contained, no cascade ambiguity). It's wrong for the GrapesJS import path, which wants *author* CSS (smaller, edit-friendly, preserves hover/`@media`/`var(--*)` provenance). The research recommends a hybrid where `take_snapshot` takes a `mode` param.
- **Two capture stories are not one.** "Import external site" (Paper-Snapshot-style) and "render/instrument a project I own" (Onlook-style) share a visual editor but not a capture mechanism. Conflating them in a single ADR muddles the architecture; G2 (owned-project capture) belongs in its own future ADR.

This ADR pins the v0.3.5 → v0.4 evolution of G1 (external-site capture). Operational follow-ups (verification, known v0.3 gaps, v0.3 non-breaking stubs, vendoring licenses) live in [`docs/epic-8-followups.md`](../epic-8-followups.md) — this ADR stays focused on the architectural decisions.

---

## Decision

### 1. v0.3.5 — Hybrid screenshot backplate

When the user triggers a whole-page capture, the extension captures **both**:

- Structural HTML (current pipeline — DOM clone + computed styles → hoisted `<style>` block + generated classes)
- A full-page pixel screenshot (scroll-tile-stitch, `chrome.tabs.captureVisibleTab()` per tile, composited via `canvas.drawImage()`)

The canvas receives both in a chained bridge call: `create_artboard` → `add_components` (screenshot as `<img>` at artboard size, `z-index: 0`, `opacity: 0.15`) → `add_components` (HTML tree, `z-index: 1`) → `fit_artboard`. The inspector exposes a "Source screenshot backplate" toggle where the user drags opacity from 0 (edit mode) to 1 (pure pixel reference).

**Why this shape:**

- **Doesn't replace the HTML path.** User still gets editable DOM on top — the screenshot is purely reference.
- **Unambiguous ground truth.** No "what was the site supposed to look like?" — the answer is *literally on the artboard*.
- **Cheap to ship.** The stitcher is ~50 lines lifted from `simov/screenshot-capture` (MIT); the artboard stacking is two `add_components` calls. No new bridge primitives.
- **Unblocks future per-element visual-diff correction** (v1+): you cannot diff against a reference you don't have on the canvas.

**Alternatives considered:**

- **Screenshot-only import.** Rejected — loses editability, which is our core value prop over Figma.
- **Per-element visual-diff with automatic screenshot fallback** (*Option B* in the original planning dialogue). Deferred to post-v0.3.5; needs the backplate landing first to produce the reference image, and needs a render→screenshot→diff loop we haven't built.
- **Agent-driven correction** (*Option C*). Long-horizon (v1+); only makes sense once A+B are solid.

### 2. v0.4 — CDP-based capture via `chrome.debugger`

A new capture path runs over the Chrome DevTools Protocol attached via the `chrome.debugger` extension API. Content-script capture is retained as the fallback for pages where CDP attach is refused or the user has DevTools open (CDP allows only one client per tab).

**What CDP unlocks:**

- `DOM.getDocument` + `DOM.resolveNode` — traverses shadow DOM, cross-origin iframes
- `CSS.getMatchedStylesForNode` — author rules + pseudo-elements (`::before` / `::after`) + keyframes
- `CSS.getComputedStyleForNode` — cascade-resolved (matches today's content-script path)
- `Network.getResponseBody` — authed / cookie-protected assets
- `Page.captureScreenshot({ fullPage: true })` — replaces the scroll-tile-stitch from §1 on pages where CDP is available

**Cost:**

- New manifest permission: `debugger`
- Yellow "Debugger attached" banner during capture (UX cost; brief, only while capture runs)
- MV3 service worker + CDP lifecycle — attach/detach discipline, handle lost-connection cases
- One-debugger-per-tab constraint — must fall back gracefully when DevTools is open

**Alternatives considered:**

- **Pure content-script forever.** Rejected — capability ceiling too low. Shadow DOM, iframes, and authed pages are all commonplace on real captures; users hit them routinely.
- **Vendor SingleFile (AGPL + commercial license available).** Rejected as the primary path because the AGPL implication pulls onto our project and the commercial price isn't scoped. Remains an option if the v0.4 CDP path proves more expensive than expected — see [§6 of the followups doc](../epic-8-followups.md#6--reading-list) for price-check commitment.
- **CDP via a native messaging host + Puppeteer** (like `chrome-devtools-mcp` itself). Rejected — requires a separate native install on the user's machine, much higher friction than a single Chrome extension.

### 3. v0.4 — Three-tool surface split with persistent element UIDs

The single `capture:send` message type is decomposed into three bridge-level tools that mirror the emerging de facto standard:

- **`take_snapshot`** — returns a structural representation (DOM tree + accessibility tree) with a stable **UID per element**. The UID format `${snapshotId}_${idCounter}` plus a backing `uniqueBackendNodeIdToMcpId` map survives across snapshots in the same session, so agents can snapshot → act → snapshot again without UIDs reshuffling.
- **`take_screenshot`** — returns pixels at one of three scopes: `viewport` (default), `fullPage: true`, or `uid: "<elementUid>"`. `fullPage` and `uid` are mutually exclusive by schema.
- **`evaluate_script`** — executes a JS function string in the page context, with element UIDs as typed arguments (resolved to `ElementHandle`s inside, disposed in a `finally`).

The UID system is the load-bearing piece: it's what makes the three tools *composable* rather than three parallel silos. Without persistent UIDs, every downstream call has to re-snapshot.

**v0.3 non-breaking stub** (captured in [followups §4](../epic-8-followups.md#4--non-breaking-v03-stubs)): the current `serialize()` output gets `data-dj-uid="<n>"` attributes per element. One-line change; lays the UID foundation without touching the bridge surface.

### 4. v0.4 — Author / computed / hybrid style modes

`take_snapshot` takes a `mode` parameter:

- **`computed`** (default; current v0.3 behavior) — `getComputedStyle` per element, hoisted to auto-generated classes in a `<style>` block. Self-contained, bigger, best for agent consumption.
- **`author`** — source `<link rel="stylesheet">` URLs preserved, source `<style>` blocks inlined verbatim, `var(--*)` references kept unresolved, class-based structure retained. Smaller, GrapesJS-native, preserves hover/`@media`/theme-token provenance.
- **`hybrid`** — author-first; computed per-element fallback only when cascade resolution is ambiguous (conflicting source rules, missing stylesheets, etc). Best default for visual-design use.

**v0.3 non-breaking stub** (captured in [followups §4](../epic-8-followups.md#4--non-breaking-v03-stubs)): `serialize(root, { mode: "computed" })` accepts the param with current as default, rejects unknown values.

### 5. Two capture stories kept distinct

- **G1 — External-site capture** (this ADR, ADR-0011, Epic 8). Paper-Snapshot pattern: element-scoped with keyboard tree-walk as primary; whole-page as secondary. Extension + `add_components` pipeline.
- **G2 — Render/instrument an owned project** (future, separate ADR). Onlook pattern: load user's source into a WebContainer, render it in an iframe, `data-oid`-instrument the DOM, write visual edits back to JSX source via AST patching.

These are different features solving different user problems with different mechanisms. They share a visual editor (the canvas) but not a capture path. Writing them up together will muddle the architecture; when G2 is planned it gets its own ADR.

---

## Consequences

- **ADR-0011 is not superseded, but is extended.** The v0.3 design (direct WS transport, hybrid inline / inherited-diff serialization) is load-bearing and continues to ship; this ADR evolves the *capture* half of that design. ADR-0011 gets a cross-reference at the top and has several Open Questions (shadow DOM §Q4, cross-origin images §Q2, iframe scoping §Q3) resolved by §2 of this ADR.
- **New Chrome permission request for v0.4.** The `debugger` permission is a meaningful install-friction increase. Users need a clear in-UI explanation of "why" before the consent prompt fires. Copy lives in the popup's first-run flow.
- **The extension remains a thin client.** Even with the CDP pivot, all heavy lifting (DOM serialization, stitching, style mode selection) lives in the extension; the canvas' bridge tools (`add_components`, `create_artboard`, `fit_artboard`) stay stable. Agent and extension share the same ingestion path. Paper's pattern; we keep following it.
- **v0.3 ships with UID + mode stubs.** One-line additions; the invariant is "v0.4 work does not require breaking v0.3 callers."
- **Hybrid screenshot backplate becomes the first artifact visible to the user on every whole-page capture.** Expect a follow-up design pass on opacity defaults + inspector UI once we've seen real captures through the ghost-layer.
- **Vendoring plan is license-hygienic.** §H of the followups doc enumerates each source and its license; the load-bearing code lifts (`simov/screenshot-capture` for stitching, `chrome-devtools-mcp` architecture for §3) are MIT / Apache-2.0. AGPL / GPL sources (SingleFile, SnappySnippet) are study-only unless we buy a commercial license.

---

## Open questions

1. **CDP fallback behavior when DevTools is open.** One-client-per-tab is a hard CDP constraint. The clean UX is "temporarily close DevTools to capture" but that's a worse experience than silently falling back to the content-script path. Leaning toward auto-fallback with a toast, but the error surface is subtle — needs a test pass once §2 is implemented.

2. **Screenshot backplate size budget.** A 1920×6000 PNG can hit 2–4 MB. Our v0.3 `hardLimit: 2 MB` for whole-page captures was for structural payload; pixel backplates will push that up. Do we (a) ship as JPEG with quality tuning, (b) separate the size budgets (structural + pixel add to a combined cap), or (c) stitch at a reduced resolution and let the canvas upscale? Leaning toward (a) + (b) but flagged for the v0.3.5 implementation spike.

3. **UID stability across style mode changes.** If the user re-captures with `mode: "hybrid"` after originally capturing `mode: "computed"`, the DOM tree is the same but rules resolve differently. Should UIDs be stable across modes (same element = same UID regardless of mode) or per-snapshot (every snapshot is a fresh UID space)? chrome-devtools-mcp does the latter. Leaning toward matching the standard but the implication for agent reasoning needs a short design note.

4. **When does author-mode capture preserve `@import` chains?** Source pages chain `@import "fonts.css"; @import "tokens.css"; @import "utilities.css";` and each chained sheet has its own cross-origin / auth constraints. Do we (a) follow the full chain, (b) stop at the first cross-origin boundary, (c) let the canvas iframe request the chain itself? This is a v0.4 question but worth pinning before we build.

5. **Price-check SingleFile commercial license before committing engineering budget to §2 and §4.** Not a technical question but the explicit action item: get a concrete price and timeline from the author before week 1 of v0.4 planning. If the license cost is materially less than the CDP implementation, the calculus flips.

6. **Hybrid screenshot backplate vs agent-driven correction** — v0.3.5 ships backplate, v1+ is agent-driven "regenerate this DOM subtree to match the screenshot." Does any interim (v0.4) want selective per-region screenshot fallback (*Option B* in original planning), or do we wait for the agent approach? Flagged for discussion once v0.3.5 is in users' hands.

---

## References

- [ADR-0011](./0011-browser-extension-architecture.md) — the Epic 8 foundation this ADR extends
- PRD Story 8.1 / 8.2 / 8.3
- Ruby's research briefs — `website-capture-research.md`, `capture-tool-comparison.md` (Obsidian vault)
- `chrome-devtools-mcp` (Google, Apache-2.0) — reference for §3's tool surface + UID system
- `simov/screenshot-capture` (MIT) — source for §1's stitcher algorithm
- `html.to.design` — production CDP-based Figma capture; validating precedent for §2
- SingleFile (AGPL / commercial) — reference implementation for author-mode capture (§4)
- Paper Snapshot — the UX blueprint for G1 (closed-source; behavior inferred from docs + public MCP tool surface)
- Onlook (Apache-2.0) — reference for G2 (kept separate per §5)

---

## Addendum (2026-04-24) — §1 implementation status

§1 hybrid screenshot backplate landed in `f6ae37f`. §§2–4 (CDP pivot,
three-tool split, author/computed/hybrid modes) remain Proposed.

What shipped:

- New `packages/chrome-extension/src/capture/screenshot-stitcher.ts` —
  pattern lifted from `simov/screenshot-capture` (MIT), code rewritten.
  Exports `captureFullPagePixels()` (content-script orchestrator:
  scroll-tile loop + scrollbar suppression + 350ms throttle to stay
  under chrome.tabs.captureVisibleTab's 2/sec quota) and
  `compositeTiles()` (pure-ish DPR-aware compositor with injected
  `loadImage` / `createCanvas` / `toDataUrl` deps so tests can exercise
  the maths without a real DOM canvas).
- `chrome.runtime.onMessage` handler `capture:visible-tab` in the
  background — the only context where `chrome.tabs.captureVisibleTab`
  can run. Captures the originating tab's window so multi-window setups
  don't capture the wrong viewport.
- `relayCapture` extended with optional `screenshotDataUrl`. When
  present: `create_artboard` → backplate `add_components` → HTML
  `add_components` → `fit_artboard`. Backplate is best-effort so a
  stitcher / add_components failure doesn't lose the structural
  capture.
- Backplate styling lives in a hoisted `<style data-designjs-backplate-
  css>` block targeting the `.designjs-backplate-wrapper` (z-index:-1,
  position:absolute, inset:0, pointer-events:none) and
  `.designjs-backplate-img` (display:block, opacity:0.15) classes —
  same load-bearing class-hoist pattern as `959331d` so GrapesJS'
  inline-style strip doesn't drop the layout. Marker attributes
  `data-designjs-backplate` / `data-designjs-backplate-wrapper` give
  future inspector / MCP work a structural hook.

Notes:

- **The dedicated "Source screenshot backplate" inspector toggle —
  resolved 2026-04-24 in `d4dcf43`.** AppearanceSection gains a
  labelled "Source screenshot backplate" subsection that renders only
  when the selected component carries `data-designjs-backplate` (the
  img marker) or `data-designjs-backplate-wrapper` (the wrapper
  marker). Single opacity slider 0-100% reading/writing the selected
  component's `opacity` style; a slider value matching the class-CSS
  default (15% on the img, 100% on the wrapper) clears the inline
  override and reverts to the class baseline. E2E coverage in
  `e2e/story-backplate-inspector.spec.ts` — both the hidden case (no
  backplate selected) and the rendered+writes case green.
- **§3 / §4 prep stubs from epic-8-followups (§4.1 `data-dj-uid`, §4.2
  `mode` param)** landed separately on `adr-0011-prep-stubs` (`bb916ae`)
  — referenced from the ADR-0011 addendum. §1 has no remaining
  prerequisites.
- **§§2–4 remain Proposed.** SingleFile commercial license price-check
  (epic-8-followups §7) is still the gate for the v0.4 author-mode
  path; the CDP pivot still needs the manifest `"debugger"` permission
  and the three-tool split design.

Vitest coverage: 5 specs in
`src/capture/__tests__/screenshot-stitcher.test.ts` — DPR canvas
sizing, per-tile y-offset, partial trailing tile DPR, dimension
guard, return-value pass-through. All green; full chrome-extension
suite 15/15 green; typecheck clean.

---

## Addendum (2026-05-04) — Open Q §5 resolved: build, don't buy

The SingleFile commercial-license price-check (Open Q §5,
[epic-8-followups §7](../epic-8-followups.md#7--price-check-singlefile-commercial-license))
is **resolved without contacting the author**: we are *not* pursuing the
commercial license at this time. §4 author-mode capture will be built
in-house on the CDP path rather than purchased or vendored.

Consequence for the §§2–4 gate: the price-check is no longer a
prerequisite. The remaining gates for §§2–4 are purely technical —
the manifest `"debugger"` permission, the CDP-fallback design (Open Q
§1), and the three-tool split (§3). The earlier addendum line *"SingleFile
commercial license price-check … is still the gate"* is superseded by
this entry (body left intact per the no-rewrite convention).

An AGPL working copy of SingleFile lives at `SingleFile/` for
architecture study only — gitignored (`.gitignore`, alongside the other
study-only reference clones) so the AGPL copyleft never reaches the
MIT tree. Study the architecture; reimplement clean per §H's rule of
thumb.

---

## Addendum (2026-05-04) — scope clarification after v0.3.5 same-origin landings

Two content-script-only landings on ADR-0011's v0.3 path
(`5226b68` same-origin iframe inlining, `debdc1d` author-CSS supplement)
close the *same-origin* halves of gaps §2 and §4 were written to
address. Recording the scope shift here so future readers don't
mis-read the v0.3.5 work as §§2/§4 shipping.

**§2 remaining scope narrows but does not shrink in importance.** The
CDP pivot was justified by four capabilities (shadow DOM, cross-
origin iframes, authed/cookie-protected assets, full author CSS).
After v0.3.5:

- Shadow DOM — still §2's responsibility (unchanged).
- Cross-origin iframes — still §2's responsibility. The *same-origin*
  half is now handled in the content script via
  `iframe.contentDocument` + `srcdoc`; the cross-origin half remains
  unreachable without `DOM.getDocument`.
- Authed/cookie-protected assets — still §2's responsibility
  (unchanged; `Network.getResponseBody` is the only path).
- Author CSS — *partly* covered. Same-origin sheets are now extracted
  via `document.styleSheets`. Cross-origin sheets still throw
  `SecurityError` and need `CSS.getMatchedStylesForNode` from §2.

**§4 remains Proposed and is *not* covered by `debdc1d`.** The author-
CSS supplement is a hoisted `<style>` block alongside the existing
computed-style block; it is *not* the discrete mode system §4
describes. Specifically, what §4 still requires:

- A `mode` parameter accepting `"author"` / `"computed"` / `"hybrid"`
  (today only `"computed"` is valid; A.2 is an additive hoist that
  runs regardless of mode).
- Source-class preservation as the *primary* selector mechanism
  (today, captured elements still carry both their source classes
  *and* auto-generated `_dj…` computed classes — author rules can
  match the former but computed always wins on conflict).
- True `@media` reflow on the canvas (today the computed snapshot
  pins per-element values at the host viewport, overriding narrower-
  width media rules even though the rules are present in the author
  block).
- Cascade-aware emission for the hybrid mode (author-first with
  computed fallback only where author rules are ambiguous or
  missing).

Treat A.2 as a "preview of value" — the things it brings along
(`@keyframes`, `@font-face`, `::before/::after`, decorative author
rules) are real fidelity wins, but the narrative of "author mode
shipped" would be inaccurate.

Cross-references:
[ADR-0011 2026-05-04 v0.3.5 addendum](./0011-browser-extension-architecture.md#addendum-2026-05-04--v035-same-origin-fidelity-landings)
records the matching landings and the source-side cascade rationale.

---

## Addendum (2026-05-23) — v0.3.5 research+experiment outcome + roadmap pivot

A focused research+experiment track ran 2026-05-23 (plan + full experiment
log in `docs/capture-fidelity-baseline.md`; original plan archived at
`~/.claude/plans/do-you-want-crystalline-summit.md`). Outcome: a working
high-fidelity capture configuration AND a meaningful re-framing of the
medium-term roadmap.

### What landed (v0.3.5)

Five commits on top of the existing v0.3 + ADR-0012 §1 baseline form the
proven configuration:

- `24cb12c` — **Experiment A: capture `documentElement`, not `body`.**
  Preserves `:root` CSS variables, html-level inherited defaults, and
  color-scheme. Post-serialize tag-swap rewrites `<html>`/`<body>` to
  `<div data-dj-source-html>`/`<div data-dj-source-body>` for GrapesJS
  parser compatibility.
- `70a7a25` — `excludeIds` option on `serialize()`. Drops the extension's
  own overlay (`#designjs-capture-root`) from `<html>` capture.
- `2048128` — **Experiment C: `mode: "inline"`.** Writes computed styles
  directly to per-element `style=""` instead of hoisting to `._djN`
  classes in a `<style data-designjs-capture>` block. Bypasses
  GrapesJS' CSS Manager cascade-reorganization entirely.
- `c747f74` — Strip `<html>`/`<body>` UA-default margin/padding on
  capture. Source pages don't intend the 8px body margin (it's a
  browser default); preserving it pushed captured content off the
  artboard's top-left corner by 7-18px.
- `d1f517d` — Inspector falls back to `offsetLeft`/`offsetTop` for
  static-positioned elements. Captured roots are static by default;
  reading `left`/`top` styles returned empty, leaving the X/Y inputs
  blank. New `readBoundingBox()` helper.

Plus prior v0.3.5 landings: `989fe18` root-inheritance fix, `59491e6`
scroll-to-bottom-and-settle, `5226b68` A.1 same-origin iframe inlining,
`debdc1d` A.2 author-CSS supplement, `e95b398` dead-scaffold removal.

### Measured outcome (Python docs reference)

| Metric | Baseline | After v0.3.5 final config | Delta |
|---|---|---|---|
| Sampled property mismatches (50-element fingerprint, 30 props) | 247 | **102** | **-58%** ✓ |
| color drift | 47 / 50 | dropped out of top 5 | ✓ |
| width drift | 49 / 50 | dropped out of top 5 | ✓ |
| height drift | 49 / 50 | dropped out of top 5 | ✓ |
| Paired by walk-order UID | 1705 / 1755 (97%) | **1755 / 1755 (100%)** | ✓ |
| Captured body height | — | 10,903px (source: 10,853px) | within +50px |
| Pixel diff | 9.39%* | 12.90% | misleading — see below |

\* The 9.39% baseline pixel diff was an artefact: the captured page was
mostly empty whitespace, which pixel-matched the source's whitespace.
After v0.3.5 the captured page renders real visible content (sidebar,
headings, body, code blocks), which doesn't pixel-match the source
*exactly* (positioning, font rendering, antialiasing), so the pixel
metric goes UP even as fidelity improves. **Per-element drift is the
truer metric**; record both but lean on drift counts for decisions.

### Load-bearing learnings

1. **Width/height pinning was a GrapesJS cascade artifact, not a
   `getComputedStyle` issue.** Pre-experiment hypothesis: "captures
   resolve `auto` to pixels → break in new layout context, fundamental
   bug." Reality: `mode: "inline"` bypassed GrapesJS' CSS Manager re-ID
   + per-rule storage, and width/height drift fell from 49-50 / 50 →
   out of the top 5 mismatchers. The captured *values* were fine — the
   *transport* (class-hoist into the CSS Manager) was the bug.

2. **GrapesJS' default HTML-import path is structurally lossy by
   design.** Confirmed by discussion [#6333](https://github.com/GrapesJS/grapesjs/discussions/6333),
   discussion [#6732](https://github.com/GrapesJS/grapesjs/discussions/6732)
   *("GrapesJS is not an HTML editor — it's a component editor")*,
   and closed-as-WONTFIX issues [#341](https://github.com/GrapesJS/grapesjs/issues/341)/[#476](https://github.com/GrapesJS/grapesjs/issues/476).
   Our ~12.9% pixel diff is roughly state of the art for OSS
   GrapesJS-based capture.

3. **Custom `parserHtml` alone wouldn't have helped** — the drift is
   downstream of parse (component recognition + CSS Manager re-ID),
   not in the parse step. Experiment B (parser overrides) was
   correctly deferred.

4. **`chrome-devtools-mcp` is the wrong CDP abstraction.** Its
   `take_snapshot` is text-targeted for LLMs ([issue #86](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/86)
   confirms no computed-style support). The right primitive is raw
   [`DOMSnapshot.captureSnapshot`](https://chromedevtools.github.io/devtools-protocol/tot/DOMSnapshot/)
   via `chrome.debugger` — same path
   [html.to.design](https://html.to.design/docs/what-is-the-browser-extension/)
   (closed-source commercial competitor) uses.

### Roadmap pivot (changes §§2–4 priority)

A second research pass focused on **recent GrapesJS changes (2024-2026)
+ PR opportunities** turned up the load-bearing fact that **PR
[#6767](https://github.com/GrapesJS/grapesjs/pull/6767) merged
2026-05-22 (one day before this research)**. It adds
`Parser.addParserCode` — first-class extensibility for registering a
custom HTML parser. Combined with the already-existing `preParser`
hook and the inline-style fixes in v0.22.8 (PRs
[#6520](https://github.com/GrapesJS/grapesjs/pull/6520) +
[#6539](https://github.com/GrapesJS/grapesjs/pull/6539)), the upstream
extension surface is *materially better* than when ADR-0012 was
originally written.

This re-frames the path between current v0.3.5 and §2's CDP destination
without invalidating either. The middle step is **a GrapesJS plugin +
small upstream PRs**, not "wait for §2 to be funded."

**Revised phasing:**

| Sprint | Work | Goal |
|---|---|---|
| Now (this addendum) | Document v0.3.5. **Don't refactor.** | Lock in what shipped |
| +1 | File upstream PRs in order of acceptance odds: doc PR (wrapper `stylable` pattern) → `keepEmptyElements` flag → `preserveInlineStyle` import flag | Community presence; fix small bugs at source |
| +1-2 | Build `@designjs/grapesjs-fidelity-import` plugin against `dev` + v0.22.16, using `addParserCode` + `preParser` + wrapper `stylable` override. Treat as parallel architecture exploration — extension continues to ship v0.3.5 production config | Validate plugin architecture without disrupting users |
| +3-4 | If plugin proves the architecture, migrate: extension produces structured payload, canvas uses plugin to consume. Deprecate `mode: "inline"` after equivalent fidelity confirmed | Cleaner architecture, public infrastructure |
| +6+ | Begin §2 CDP pivot. Plugin becomes one of two consumption paths (CDP-rich path + content-script fallback path) | Real visual parity (≤5% drift) |

**Key insight:** the plugin is no longer a *replacement* for the
current approach — it's an *evolution* of it. PR #6767 turned the
GrapesJS canvas-side from "hostile black box" into "first-class
extension point." Plugin + upstream PRs buy us 12-18 months of "good
enough" fidelity (target ~5-10% per-element drift on representative
pages); CDP per §2 is the only path to actual visual parity (~0-2%).

**Tradeoff to flag:** waiting for PR #6767 to ship in a tagged
release vs. depending on `dev` could be weeks-to-months. If we want
to use `addParserCode` *now* for the plugin, we depend on an
unreleased GrapesJS version — risky for production. So the plugin
work realistically starts after a tagged release that includes
#6767, OR we pin to a `dev` commit and accept the breakage risk.

### Deferred items (still proposed, but priority shifts)

- **§2 CDP pivot** — strategic long-term destination, unchanged.
  Plugin work *complements*, doesn't replace it.
- **§3 three-tool split + UID system** — unchanged. The `data-dj-uid`
  prep stub already shipped; v0.4 work pending.
- **§4 author/computed/hybrid mode system** — unchanged. The `mode:
  "inline"` we shipped is a *different* axis (storage strategy, not
  style-source strategy). True author mode still requires §2's
  `CSS.getMatchedStylesForNode` to source author CSS reliably.

### Cross-references

- [ADR-0011 2026-05-04 addendum](./0011-browser-extension-architecture.md#addendum-2026-05-04--v035-same-origin-fidelity-landings) — the v0.3.5 same-origin landings.
- [docs/capture-fidelity-baseline.md](../capture-fidelity-baseline.md) — full per-experiment numbers + reproduction steps.
- Original plan + research at `~/.claude/plans/do-you-want-crystalline-summit.md` (gitignored — user's claude home; not in repo).

---

*End of ADR-0012.*
