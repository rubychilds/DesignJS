# ADR-0008: Figma → DesignJS import strategy

**Status:** Accepted (Path A — relay docs shipped); Path B (first-party plugin) remains deferred per §2 below
**Date:** April 22, 2026 (Proposed); Path A accepted April 24, 2026 after the docs + relay e2e shipped
**Owner:** Architecture
**Related:** [ADR-0005](./0005-html-primitives-mapping.md) (HTML primitives — the target shape), [ADR-0007](./0007-user-extensibility.md) (blocks + Tailwind theme); PRD Story 6.3 (parked → v0.3, 2026-04-18 spike), PRD Story 3.1 follow-up (`2de1520` — Figma binary clipboard refusal); paper.design/docs/mcp (relay precedent)

---

## Context

PRD Story 6.3 ("Figma copy-paste import") was parked on 2026-04-18 after a spike established that Figma's clipboard payload is two empty `<span>` elements with the proprietary **fig-kiwi** binary tunneled through HTML comments (`<!--(figma)…-->` / `<!--(figmeta)…-->`) — no semantic HTML, no Tailwind, no inline styles, no auto-layout markup, no `<img>` tags. Decoding fig-kiwi requires Figma's own WASM; there is no public schema.

What shipped instead, under Story 3.1, was a **refusal path**: the clipboard handler detects the fig-kiwi markers, refuses the import (no DOM bloat), `console.warn`s a clear message, and dispatches a `designjs:paste-blocked` CustomEvent for a user-facing toast pointing at viable alternatives. Commit `2de1520`. That's the current state.

This ADR picks the v0.3 delivery path — **how Figma content actually enters the DesignJS canvas**. The decision is load-bearing because:

1. Figma compatibility is the single most-requested feature from the expansion persona (PRD §3.3 Frontend Lead Fiona — "30–50% of sprint capacity lost to translating Figma designs into React components").
2. The delivery surface (clipboard vs plugin vs REST vs MCP relay) permanently shapes the engineering maintenance burden.
3. The competitors have taken different bets (§Survey below), and doing the wrong one costs weeks of sunk work — Onlook's PR #3077, a 13,052-line attempt, was closed without merging.

---

## Survey

### fig-kiwi binary clipboard — **explicitly rejected**

The 2026-04-18 spike (PRD Story 6.3) established this path is infeasible for DesignJS: decoding Figma's binary payload requires a WASM runtime we don't own and Figma doesn't publish a schema. **Pencil.dev** writes a fig-kiwi decoder because they're a vector canvas — they map Figma vector nodes 1:1 to Pencil JSON nodes (docs.pencil.dev/core-concepts/import-and-export). DesignJS is HTML/CSS-native (ADR-0001, ADR-0005); the fig-kiwi route is wrong-shaped per unit of effort.

The Story 3.1 follow-up kept the refusal toast in place as the "visible bad-path signaller" so users get a clear pointer rather than silent failure.

### Penpot — no in-tree Figma importer

A local clone sits at `./penpot/` (MPL-2.0, gitignored per ADR-0001). The entire Penpot source has **one** Figma reference: `frontend/src/app/main/ui/onboarding/questions.cljs`, which asks users *which tool they came from before Penpot*. There is no importer code.

Penpot's Figma import story is the third-party **"Penpot exporter"** Figma plugin — maintained outside the Penpot repo, published on the Figma marketplace, walks the Plugin API and emits to Penpot's format. This is the Anima / Locofy / Builder.io Visual Copilot pattern.

Penpot itself is not a reference implementation for this ADR; its Figma plugin is. The Penpot plugin is the closest open-source example of Path B below, though it targets Penpot's vector storage, not HTML/CSS.

### Onlook PR #3077 — proposed then closed; illustrative, not canonical

Onlook opened [PR #3077 "Adding missing features that are not selected on the readme.md"](https://github.com/onlook-dev/onlook/pull/3077) on 2026-04-17; it was closed on 2026-04-18 without merging (`mergedAt: null`). 13,052 additions across ~100 files bundling Figma + GitHub + MCP + assets + comments + a self-admitted "random html file as a joke." The scope killed it, not the approach per se.

The Figma submodule lived under `packages/platform-extensions/src/figma/` and took the **REST API + OAuth** route:

- `FigmaApiClient` (148 lines) — HTTP client
- `FigmaAuthService` (108 lines) — OAuth 2.0 flow
- `FigmaFileParser` (472 lines) — walks the Figma file tree
- `FigmaTokenStorage` (120 lines) — DB-backed token persistence
- Backing tables for `figma_asset`, `figma_component`, `figma_file`

The parser's mapping was a TypeScript **intermediate representation**, not HTML emission — `{components, assets, pages, artboards}` typed objects with styles stored as parallel `{property, value, cssProperty, cssValue}` entries. A later code-generator step would be needed to produce HTML/CSS from the IR.

Quality of the mapping was uneven:

| Aspect | Handling |
|---|---|
| Auto-layout → CSS | `layoutMode: HORIZONTAL → display: flex`, `VERTICAL → display: block` (❗). Padding and `itemSpacing` captured as raw values; no `gap`, no `justify-content`, no `align-items` generated. |
| Fills | `SOLID → rgba()`, `GRADIENT_LINEAR → linear-gradient(deg, stops)`, `IMAGE → url(...)` (placeholder) |
| Strokes | `${weight}px solid ${rgba}` — no dashed/dotted, no per-side strokes |
| Shadows | `DROP_SHADOW` only — `${x}px ${y}px ${blur}px ${rgba}` |
| Text | `${fontWeight} ${fontSize}px/${lineHeight} "${fontFamily}"` shorthand — no mixed-style runs, no letter-spacing, no text-decoration |
| Component variants | Captured as `{name, type, defaultValue, variantOptions}` — **no substitution, no explosion into sibling blocks** |
| Constraints | Stored on nodes but **unused** — no `position: absolute + top/left/right/bottom` generation |
| Icon detection | Heuristic: `size ≤100px && aspect ratio 0.5–2.0 → save as SVG asset`. Pragmatic |

The REST transport works. The mapping layer is the cost centre — Onlook's parser covers the easy surface area and punts on the load-bearing parts (full flexbox, constraints, text runs, variants). A production importer that covers what PRD §7.4 Epic 3.2 actually requires is **~4–5× the mapping code Onlook wrote**.

### Paper.design — MCP-to-MCP relay (Path A pattern)

Per [paper.design/docs/mcp](https://paper.design/docs/mcp): Paper deliberately avoided both the clipboard and a REST integration. Instead, **the user runs Figma's official Dev Mode MCP server alongside Paper's MCP server** in the same client (Cursor / Claude Code). An agent then orchestrates:

1. Agent reads from Figma's Dev Mode MCP tools — `get_design_context` (current selection's layout tree) and `get_variable_defs` (design tokens scoped to selection).
2. Agent translates by prompting itself — "Turn this Figma spec into HTML/Tailwind." Because the target is HTML/CSS-native and the source is Figma's own semantic output, the translation is a natural-language step, not a structural mapper we ship.
3. Agent writes via Paper's MCP — `write_html`, `update_styles`.

Paper's cost: **zero code**. Two documentation pages and a config snippet. The maintenance burden is Figma's — they ship and maintain the Dev Mode MCP server. Paper explicitly limits scope to **tokens + design-system components, not arbitrary frames** — a deliberate quality ceiling that avoids promising fidelity they can't guarantee.

### Anima / Locofy / Builder.io Visual Copilot — Figma plugins (Path B pattern)

All three bypass the clipboard and ship as Figma plugins. The plugin walks `figma.currentPage.selection` via the Plugin API (richer than REST — exposes layout constraints, component property definitions, variable bindings), generates framework-specific code, and POSTs (or pastes) into the target tool.

- **Anima** — deepest of the three, emits framework-aware React / Vue / HTML with responsive breakpoints.
- **Locofy** — similar surface; stronger on components + design-system mapping.
- **Builder.io Visual Copilot** — newer entrant; uses LLM-assisted mapping atop the plugin.

All ship with paid tiers and marketplace listings with hundreds of thousands of installs. The plugin model has mature infrastructure; the quality gap is in walker breadth and mapping fidelity, not transport.

### Convergence

The surveyed tools split cleanly:

- **Vector-native** (Pencil, Penpot) → decode Figma's vector format (fig-kiwi) or the Plugin API into their own vector storage. Not applicable to us.
- **HTML/CSS-native** (Paper) → MCP relay, zero-code, explicitly accepts a quality ceiling.
- **Framework-generator tools** (Anima, Locofy, Builder.io) → Figma plugin + their own walker + their own code-gen. Paid products; multi-year maintenance investment.
- **Unmerged proposal** (Onlook PR #3077) → REST + OAuth. Demonstrates the transport works; demonstrates the mapping cost is real.

DesignJS aligns with Paper architecturally. That pulls us toward MCP relay as the default path. But we're open-source and self-contained, and our users include people with no Figma Dev Mode subscription — the relay ceiling is real. A first-party plugin (Path B) is the natural next step once the relay validates demand.

---

## Decision

Three delivery paths, ordered by cost:

| Path | Transport | Ship | Cost | Quality ceiling |
|---|---|---|---|---|
| **A — MCP relay** | User runs Figma Dev Mode MCP + our MCP in one client; agent orchestrates | 2 docs pages + `.mcp.json` snippet + paste-blocked toast link | ~4 hours | Bounded by Figma Dev Mode tool surface (selection-scoped, token-scoped) + agent translation |
| **B — First-party Figma plugin** | Our plugin walks `figma.currentPage.selection` via Plugin API, emits HTML, POSTs to our MCP `add_components` | Plugin source + mapper + marketplace listing | 1–2 weeks core + ongoing maintenance | Matches plugin walker coverage — we control all dimensions |
| **C — REST API + OAuth** | Our server receives Figma file URL + OAuth token, pulls the file tree, runs the mapper server-side, POSTs to canvas | OAuth app registration + API client + mapper + token storage + DB schema | 3–4 weeks minimum | Same as B; slightly weaker because REST exposes less than Plugin API |

### 1. Path A is the v0.3-early delivery

We ship the MCP relay documentation as the **primary Figma import story for v0.3**. Deliverables:

- A docs page at `designjs-docs/guides/figma-import.mdx`. **First paragraph leads with the Figma Dev Mode requirement** ("Requires a Figma Dev Mode seat (paid tier) — the relay uses Figma's Dev Mode MCP server, which is gated to Dev Mode subscribers"). Then: copy-pasteable `.mcp.json` showing both servers registered, a recommended first prompt (`"Import the selected Figma frame as HTML with Tailwind classes"`), and a brief on the quality ceiling (selection-scoped, not full-file; tokens via `get_variable_defs`; agent judgment required).
- A docs page at `designjs-docs/concepts/figma-relay.mdx` explaining *why* we chose the relay over a plugin and what the user's workflow looks like end-to-end.
- An update to `packages/app/src/canvas/paste-import.ts`'s `designjs:paste-blocked` toast copy: link it at the new relay docs page with a "Try the MCP relay →" action. The existing refusal behavior stays unchanged.
- One end-to-end e2e spec (pending MCP-test infra for dual-server scenarios — spec-new, may need a relaxed integration-test mode) verifying the relay round trip against a canned Figma API response.

No new code ships in `@designjs/app` or `@designjs/mcp-server`. The docs + existing toast do all the work.

### 2. Path B is committed for v0.3-late or v0.4

Decision: **ship Path B as a follow-on once Path A validates demand.** The plugin is the correct long-term answer — it's how Anima / Locofy / Builder.io built mature products, and it gives us control over the mapping layer where the quality actually lives.

Timeline gate: cut Path B in v0.3-late if Path A's docs page hits >200 unique pageviews in its first four weeks (via Mintlify analytics — signal that users are trying the workflow); otherwise push to v0.4 alongside the Onlook-style codebase-component discovery work.

Scope for Path B v1, when it ships:

- **Transport:** a DesignJS Figma plugin that connects to a *locally-running* DesignJS canvas over the same WebSocket bridge the MCP server already uses (port 29170). This preserves the local-first architecture — the plugin POSTs HTML directly to the running canvas, not to a server we host. Users need both Figma and their local DesignJS running; same ergonomic cost as running `pnpm dev` + Figma.
- **Walker coverage in v1:** FRAME (with auto-layout → flex: direction, gap, justify-content, align-items, padding all generated), TEXT (single-style only; mixed runs explicit v2), RECTANGLE + ELLIPSE + IMAGE + VECTOR (→ inline SVG), GROUP (flattened), COMPONENT/INSTANCE (flattened to HTML; no variant substitution). Matches PRD Story 6.3's original AC table plus the auto-layout coverage Onlook's parser punted on.
- **Explicitly deferred to v2+:** constraints → absolute positioning, component instance swap, variants as sibling-block explosion (this depends on ADR-0007's block model and should be sequenced behind the `designjs.config.ts` work).

Plugin marketplace listing happens once v1 is feature-complete — not before — to avoid a bad first impression.

### 3. Path C is explicitly rejected

No REST + OAuth server-side integration. Reasons:

- **Contradicts local-first.** OAuth demands a hosted OAuth app, API key storage (even at user level), and a redirect URL we maintain. DesignJS is meant to run without any service we operate. (Exception: an npm OTP relay for publishes — the only user-remote interaction in the stack, and scoped to maintainers.)
- **Transport has no quality advantage over Path B.** Plugin API exposes everything REST does, plus richer layout-mode and variable-binding data. Choosing REST costs 2-3 weeks and buys strictly less information.
- **Onlook PR #3077 is concrete evidence of the cost.** Thirteen thousand lines, 472 of them parser, closed without merging. Even with unlimited motivation, the scope is large.
- **Users don't want a "paste your Figma file URL" workflow.** Figma users' muscle memory is `Cmd+Shift+P → "run plugin"`, not hunting for file URLs.

An ADR-level revisit is required to overturn this rejection. Not easily reversed.

### 4. What happens to Story 6.3's original AC

The original AC (clipboard-based) archived in the PRD stays archived — they were written assuming Figma puts semantic HTML on the clipboard, which it doesn't. The new Story 6.3 AC for v0.3 is three-pronged:

- [ ] Ship **relay docs** (guides/figma-import.mdx + concepts/figma-relay.mdx).
- [ ] Extend the **paste-blocked toast** to link the relay docs page.
- [ ] **Verify end-to-end** via a spec that simulates the relay round trip against canned Figma API fixtures.

Path B's AC is written when we commit to it (v0.3-late or v0.4 per §2 above).

---

## Consequences

- **Marketing claim "DesignJS imports from Figma" is available in v0.3-early** — Path A alone earns it, with footnotes. We're explicit in the docs that the import is selection-scoped and token-scoped (Paper's framing). No overstatement.
- **Maintenance burden stays minimal for v0.3.** Figma maintains the Dev Mode MCP server; we maintain a docs page and a toast. Any breakage in the relay path is either theirs (Dev Mode MCP bugs) or the user's agent's translation quality — neither falls to our triage queue.
- **The paste-blocked toast becomes a lead-gen surface.** Users who Cmd+V a Figma selection today see a refusal; with Path A shipped, the same users get a link to a workflow that works. Converts a negative moment into a discovery moment.
- **Path B timing is gated on signal, not calendar.** If Path A traffic is flat, Path B slips to v0.4; we don't sink 1-2 weeks on a plugin users aren't asking for. Small organizational change in how we track v0.3 velocity — docs signal (pageviews) joins engineering signal (commits merged) as a gate.
- **Path B ships with local-first architecture preserved.** Plugin POSTs to `ws://127.0.0.1:29170`, same bridge the MCP server uses. Users need both Figma and `pnpm dev` running simultaneously — familiar cost since `pnpm dev` is already required.
- **We don't have a story for Figma-component-instance import.** Intentional scope limit. Agents can always translate manually by prompt. Component-aware import is ADR-level work that folds in alongside ADR-0007's block model, not inside this ADR.
- **Auto-layout mapping in Path B is where our quality bar has to be.** Onlook's parser covered auto-layout weakly (just `display: flex`) and that's the visible gap in their output. Our plugin walker needs gap, justify-content, align-items, flex-direction, padding from `layoutMode` + `primaryAxisAlignItems` + `counterAxisAlignItems`. Checked into the v0.3-late or v0.4 scope explicitly.

---

## Open questions

1. **Path A e2e test infrastructure.** We don't have a way to run two MCP servers in a single Playwright spec today. Options: (a) mock Figma Dev Mode MCP with a local fixture server for the test, (b) skip automated e2e and ship a manual QA checklist, (c) gate CI's e2e behind a `FIGMA_RELAY_INTEGRATION` env var and run it only on scheduled cron builds. Leaning (a). Decision before docs ship.

2. **Plugin naming + marketplace listing ownership.** If we go to Path B, is the plugin published under `rubychilds` or a dedicated DesignJS org account? Figma's marketplace review process takes 1-3 weeks; factor into v0.3-late vs v0.4 decision.

3. ~~**Dev Mode subscription gating.**~~ **Resolved 2026-04-22:** lead the docs with the Dev Mode requirement. First paragraph of `guides/figma-import.mdx` and the `designjs:paste-blocked` toast copy both state *"Requires a Figma Dev Mode seat (paid tier)"* up front. Sets honest expectations; avoids frustration for free-tier users who'd otherwise hit a wall mid-setup. *Left here as a record of the decision.*

4. **What's the minimum fixture-based e2e test worth writing?** A full-file walk of a realistic Figma payload (100+ nodes) against a canned Dev Mode MCP response? Or just the hello-world "one frame, one text node" case? Bigger fixtures catch more mapping bugs; maintenance cost scales. Leaning toward a single realistic fixture at `e2e/fixtures/figma-relay-sample.json` with a ~30-node landing-page layout.

5. **Paste-blocked toast UX in the short term.** Today it dispatches a `designjs:paste-blocked` event but no Sonner toaster consumes it (per PRD Story 3.1 follow-up, toast surface depends on ADR-0001 Phase D which isn't fully wired). The docs-page link ships in the toast *whenever* the toast ships — until then, the `console.warn` gets the docs URL too. Small copy tweak.

6. **Variables interop.** Figma's Dev Mode MCP `get_variable_defs` returns design-token definitions that map onto our `set_variables`. Should we add a `designjs:ingest_figma_tokens` convenience tool that wraps the relay pattern into one MCP call, so an agent doesn't have to hand-translate? Flagged — possibly a Story 6.3 stretch. The simple tokens → `set_variables` loop is already reachable via existing tools.

---

## References

- PRD Story 6.3 (parked → v0.3, 2026-04-18 spike) — in `opencanvas-prd.md`, line 787ff (source of the fig-kiwi findings + Penpot plugin framing)
- Commit `2de1520` — paste-import.ts Figma-binary refusal (ships the precursor toast)
- Paper's relay docs — https://paper.design/docs/mcp
- Pencil's vector import — https://docs.pencil.dev/core-concepts/import-and-export
- Onlook PR #3077 — https://github.com/onlook-dev/onlook/pull/3077 (closed 2026-04-18)
- Onlook parser source (reference, not merged) — https://raw.githubusercontent.com/onlook-dev/onlook/1788826cc6d84c1df722aedc6389646688ef4f77/packages/platform-extensions/src/figma/parser.ts
- Figma Dev Mode MCP — https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Dev-Mode-MCP-Server
- Figma Plugin API reference — https://developers.figma.com/docs/plugins/api/
- Alex Harri, "The web's clipboard, and how it stores data of different types" — the definitive reference on the fig-kiwi comment-tunneling trick

---

## Addendum (2026-04-24) — Path A implementation notes

Path A shipped in two commits across two repositories:

- `e7fc44d` (this repo) — `e2e/fixtures/figma-relay-sample.json` +
  `e2e/story-figma-relay.spec.ts`. The fixture models what an agent
  would emit after walking Figma's `get_design_context` and
  `get_variable_defs`: four top-level components (eyebrow, headline,
  pricing card, CTA) + a token map referenced by `var(--…)` inside
  the translated HTML. The spec drives the relay round trip through
  the existing `set_variables` and `add_components` tools — no new
  MCP tool, which was the load-bearing constraint of the strategy.
- `8469a12` (`designjs-docs` repo) — `guides/figma-import.mdx` +
  `concepts/figma-relay.mdx` + `docs.json` nav entries. The guide
  leads with the Dev Mode requirement per Open Question 3 above. The
  concept page records the cost / quality comparison across the four
  candidate strategies (paste / REST / plugin / relay) and explains
  what each piece of the relay does at runtime.

Three notes worth recording:

- **Open Question 1 was resolved (a) — fixture-based test.** The
  spec stages Figma's output as a JSON fixture rather than running a
  second MCP server in the test process. This sidesteps the
  dual-server e2e infrastructure problem entirely; the relay's
  DesignJS half is exactly what Story 2.x already exercises, and the
  fixture stands in for whatever the agent translates from upstream.
  No `FIGMA_RELAY_INTEGRATION` env var, no scheduled cron build —
  the spec runs in the default `pnpm test:e2e` set.
- **Open Question 4 was resolved toward "modest fixture, not full
  page-walk."** Four components (~20 lines of HTML each) is enough
  to verify the round trip without committing the maintenance cost
  of a 100-node fixture that would ossify around our current
  Tailwind generation. We can grow the fixture if the relay walks
  surface specific bugs; we can't easily shrink one if it doesn't.
- **`paste-import.ts`'s `FIGMA_BLOCKED_MESSAGE` already points users
  at the relay flow** (the message says "pair the Figma Dev Mode MCP
  server with DesignJS in Cursor / Claude Code so an agent can
  translate the design"). Now that the relay docs page exists, a
  follow-up can swap the `console.warn` line for a docs-URL link
  (Open Question 5). Out of scope for this addendum since the toast
  surface itself is gated on ADR-0001 Phase D's Sonner wiring.

Path B (first-party plugin) remains deferred per §2. Gate is
unchanged: cut Path B in v0.3-late if the relay docs hit >200 unique
pageviews in their first four weeks, otherwise push to v0.4.
