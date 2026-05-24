# ADR-0006: Sizing modes, auto-layout taxonomy, canvas model, and the Raw CSS exit path

**Status:** Accepted (2026-04-24)
**Date:** April 19, 2026
**Owner:** Architecture
**Related:** [ADR-0001](./0001-frontend-ui-stack.md) (UI stack), [ADR-0002](./0002-inspector-information-architecture.md) (inspector IA), [ADR-0003](./0003-panel-information-architecture.md) (panel IA), [ADR-0005](./0005-html-primitives-mapping.md) (HTML primitives); PRD §5.1 (HTML/CSS-native canvas)

---

## Context

The inspector has reached a point where the shape of each section is right but four load-bearing concepts are under-modelled, and that gap is leaking through a "Raw CSS" escape hatch sitting permanently at the bottom of the panel:

1. **Sizing.** Width and Height are raw `px` inputs. A user can't express the three intents every modern design tool supports — "this is exactly 320px," "this hugs its content," "this fills its parent." The semantic intent flips between `width: 320px`, `width: auto`, `width: 100%`, `flex: 1`, etc. as a function of the parent's layout. Users currently have to know CSS to get the right one.

2. **Auto-layout taxonomy.** Our current Direction toggle offers `free / horizontal / vertical`. Real design tools also offer **grid** as a layout flow — two-dimensional placement with explicit rows and columns. Without it, any design that requires a grid falls through to Raw CSS.

3. **Canvas model.** Every GrapesJS component must live inside a Frame (a Canvas iframe with explicit dimensions). Users from Figma expect to drop a text block or a shape directly on the canvas — no enclosing Frame. Our InsertRail currently targets the active Frame's wrapper, so a text insertion is immediately parented to a Frame, which is the wrong mental model.

4. **Raw CSS.** Today the inspector ends with a collapsed Accordion that exposes the full GrapesJS StyleManager — 100+ CSS properties. It's the escape hatch for anything the semantic layer doesn't cover: padding (added in this ADR), margin, `cursor`, `z-index`, text colour (also this ADR), etc. A permanent escape hatch is a tell that the semantic layer is incomplete. The product direction is a **design tool, not a CSS editor** — users should be able to build any credible design without opening Raw CSS.

This ADR decides the sizing model, the auto-layout taxonomy, the canvas-frame relationship, and the plan to retire Raw CSS. The four are inter-related: sizing semantics change depending on whether a parent is a flex container, a grid container, or a loose-canvas parent; all three need to be settled together.

---

## Survey

### Penpot (cloned at `./penpot/`, MIT-incompatible — studied for shape, not copied)

Findings from `frontend/src/app/main/ui/workspace/sidebar/options/menus/measures.cljs` and `layout_container.cljs`:

- **Sizing is contextual, not stored as a mode.** A child shape doesn't have a "Hug" field. Penpot derives behaviour from *predicates* over the parent: `flex-auto-width?` returns true when the parent has layout and `:flex-shrink` is set; `flex-fill-width?` when `:flex-grow` is set. If neither matches, the child uses its stored `:width` as an absolute value. This keeps the data model thin — the same stored dimension means different things under different parents — but makes the UI logic that renders Fixed/Hug/Fill require knowledge of the parent.
- **Layout container is unified across flex and grid.** One `:layout-type` field takes `"flex"` or `"grid"`. The UI branches off that value: flex shows direction/wrap/align/justify/gap, grid shows track definitions (`:column-tracks`, `:row-tracks`, each `{type: FR|AUTO|PX|%, value}`) + gap + padding. Both share the *same* padding and gap infrastructure.
- **Padding has a dual-mode toggle.** `:layout-padding-type` flips between `simple` (two fields: `p1` = vertical, `p2` = horizontal) and `multiple` (four fields: `p1=top, p2=right, p3=bottom, p4=left`). Under the hood the data structure can always hold 4 values; the toggle is purely UI.
- **Frames (called Boards) are not data-model-special.** Everything is a shape; a frame is a shape whose `:type` is `"frame"`. A shape's parent can be another shape *or* the page root. Being "on the canvas without a frame" means having the page root as parent.

### Figma

Terminology and behaviour from the public Help Center and 2025 Config disclosures:

- **Sizing: Fixed / Hug contents / Fill container.** The three are exposed as a per-axis dropdown on the W and H inputs. Rules:
  - *Fixed* is always available; typing a number or dragging a canvas handle flips that axis to Fixed automatically.
  - *Hug contents* is only available on the **parent** (an auto-layout frame).
  - *Fill container* is only available on **children** of an auto-layout frame.
  - Min-W / Max-W / Min-H / Max-H are clamps layered on top of any mode, exposed via an overflow menu. If any child's axis is set to Fill, Figma silently forces the parent on that axis to Fixed (Hug becomes invalid when a child wants to fill).
- **Auto-layout taxonomy (as of Config 2025).** Direction is now a **three-value flow**: `none | horizontal | vertical | grid`. Grid is inside Auto Layout, not a separate feature. It implements a subset of CSS Grid: columns + rows (px or `fr`, no `%`), gaps, padding, per-child `columnSpan` / `rowSpan`, per-cell alignment. No named lines, no areas, no subgrid. "Layout grids" — the overlay for visual alignment guides — was renamed to **"Layout guides"** to disambiguate from the grid flow.
- **Padding.** Stored as 4 independent values (top, right, bottom, left). UI toggles between *uniform* / *vertical+horizontal* / *per-side* input modes. Default when auto-layout is turned on is **16px on all sides**. Negative padding is blocked in the UI (but settable via variable binding; messy — a cleaner design-tool answer is "fully allow or fully block").
- **Canvas model.** A Figma file holds Pages; each Page has an infinite canvas. Children of a Page can be Frames, Sections, Groups, or **loose leaves** (text / shapes / vectors / images directly on the page). Frames are not required. Coordinates are stored **parent-relative**: a frame at (100, 200) containing a child at (10, 20) is absolutely at (110, 220). The plugin API exposes `relativeTransform` for stored and `absoluteBoundingBox` for derived. Groups are transparent for the relative transform.

### Current DesignJS state

- Sizing: raw `width` / `height` px inputs. No Hug / Fill abstraction; users translate CSS mentally.
- Auto-layout: Direction is free / horizontal / vertical (no grid).
- Padding: added in this ADR cycle (not previously modelled — was Raw CSS only).
- Canvas model: GrapesJS hard-requires at least one Frame. Loose-canvas objects are impossible in the underlying data model. The InsertRail targets `editor.addComponents()` which appends to the active Frame's wrapper.
- Raw CSS: bottom-of-inspector Accordion exposing the full GrapesJS StyleManager.

---

## Decision

### 1. Sizing: per-axis `fixed | hug | fill` + Min/Max clamps

Each component stores (or derives) a `widthMode` and `heightMode` per axis. The three values:

- **Fixed** — an explicit px value. Writes `width: <N>px` / `height: <N>px`.
- **Hug** — size to content. Writes `width: max-content` in block contexts; `width: auto` in flex parents (flex containers naturally hug their content's intrinsic axis). For the main axis of a wrapping flex container, `width: fit-content`.
- **Fill** — stretch to parent. In a flex child, main-axis Fill writes `flex: 1 1 auto`; cross-axis Fill writes `align-self: stretch`. In a block child, Fill writes `width: 100%` / `height: 100%`.

Availability mirrors Figma's rules: Hug only when the element is itself an auto-layout container; Fill only when the parent is an auto-layout container. On a non-auto-layout element with a non-auto-layout parent, only Fixed is offered. UI gates the dropdown options accordingly.

**Min/Max clamps** — `minW`, `maxW`, `minH`, `maxH` — are optional and layered on top of any mode. When set, they emit `min-width` / `max-width` / `min-height` / `max-height` respectively. Exposed via an overflow menu next to the W/H field (Figma-style).

**Control:** new `<SizeField>` component at `components/editor/inspector/controls/SizeField.tsx`. Three-state dropdown + numeric (active only in Fixed) + overflow for Min/Max. Replaces the existing `<NumberInput>` pair in Layout's W/H row.

### 2. Auto-layout taxonomy: Free / Horizontal / Vertical / Grid

The Layout section's Direction toggle becomes four-valued. Semantics:

- **Free** — no layout. Children position manually (absolute-in-parent coordinates).
- **Horizontal** — flex row. All existing controls apply (gap, justify, align-items, align-self).
- **Vertical** — flex column. Same.
- **Grid** — CSS Grid. Exposes: **Columns** (list of tracks, each `px` or `fr`), **Rows** (same shape), **Column gap**, **Row gap**, **Padding** (already in ADR), per-child **Column span** + **Row span** + cell **Justify** + **Align**. No named lines, no areas, no subgrid in v0.x — same subset Figma ships.

Grid's feature surface is bigger than flex's. It earns its own sub-section inside Layout when enabled (just as Layout Item rows appear contextually when the parent is a flex container).

**Storage:** the element's flow is derived from its CSS `display` value — `display: flex` → horizontal or vertical depending on `flex-direction`, `display: grid` → grid, no `display` → free. Track lists stored as `grid-template-columns` / `grid-template-rows`.

### 3. Padding: always 4 values, UI toggles input density

Already shipping (LayoutSection.tsx). Keep the model: four separate CSS longhands (`padding-top` etc.), a React-local `perSide` toggle that flips between a compact V/H pair and a 4-input grid. **Reject** negative padding. When Fill children are present, padding still applies — no Figma-style silent override here.

### 4. Canvas model: root frame as "the page"

GrapesJS requires at least one Frame; fighting this at the data model level is not worth the rewrite cost. Instead, adopt a convention:

- The **first Frame** on the canvas is the **Page root** — semantically equivalent to a Figma Page, not a Figma Frame. Its chrome (name label, border, delete affordance) becomes implicit / hidden in the Layers tree so users perceive it as "the canvas." The existing unopinionated auto-frame GrapesJS creates on init is this root.
- Users can create additional Frames. Those are Figma-Frames — named containers with auto-layout semantics, clip-by-default, visible in the layer tree as distinct top-level nodes.
- Loose-canvas objects (text, shapes, images inserted via the InsertRail with no Frame selected) attach to the Page root. Their `left` / `top` make them positioned absolutely within the page's infinite canvas. This is *behaviourally* "loose on the canvas" even though the data-model parent is the root frame.
- The bug where `InsertRail` text goes into the active Frame is fixed by targeting the Page root instead of `editor.addComponents()` when no Frame is explicitly selected. When a Frame is selected, insertion still goes into that Frame (expected auto-layout behaviour).

This matches Figma's mental model ("Pages accept loose leaves") without fighting GrapesJS's ("every component lives in a Frame"). The Page-root frame is just rendered as "the canvas" visually.

### 5. Raw CSS retirement

Raw CSS stays until every commonly-reached CSS property has a semantic surface. Then it goes. The gap list — what the semantic layer doesn't cover today:

| Property | Target section | Story |
|----------|---------------|-------|
| `padding-*` | Layout (Padding) | **Shipping in this ADR cycle.** |
| `color` (text) | Fill | **Shipping in this ADR cycle** — Fill drives `color` on text components. |
| `margin-*` | Layout (Spacing) | New Spacing row adjacent to Padding. |
| `cursor` | Appearance (Interaction subsection) | Enum dropdown — `auto / pointer / text / crosshair / grab / not-allowed`. |
| `z-index` | Appearance | Numeric when set; Layer Order affordance (Bring to Front / Send to Back) in the Layers tree drives it. |
| `position` mode | Position | Enum — `static / relative / absolute / fixed / sticky`. Gates the visibility of the `top/left/right/bottom` fields. |
| `overflow-*` | Layout (Clip) | Already partially shipping as a single Clip toggle. Expand to per-axis `visible / hidden / auto / scroll`. |
| `object-fit / object-position` | Image-specific inspector slot | Shows only for `<img>` selection. |
| `transition` / `animation` | Deferred | Not in v0.x scope. |
| `mask` / `clip-path` | Deferred | Niche. |

Raw CSS becomes a **conditional fallback**: it renders only when the selected component has at least one property set that the semantic layer doesn't recognise. On a well-styled component, the section is absent entirely. When visible, the header reads "Other CSS" with a subtitle explaining it's for advanced overrides.

### 6. Rejected alternatives

| Option | Reason |
|--------|--------|
| Match Penpot's "contextual sizing" (derive mode from parent; no stored mode) | Cleaner data model but makes the UI logic fragile — every mode render needs the parent in scope. Explicit mode per axis is easier for agents (MCP tool `set_size_mode`) to target directly. |
| Grid as its own top-level section, separate from Auto Layout | Forks a concept users already understand. Figma's 2025 move was to put Grid *inside* Auto Layout as a third flow; match that. |
| Allow negative padding | Figma's backdoor-only support is a sign that even its designers find it messy. Block it in UI; for overlap, use gap (which we already allow negatives). |
| Make Page separate from Frame (true Figma model) | Requires a GrapesJS fork or a parallel data model on top. Not worth v0.x. Root-Frame-as-Page is the pragmatic approximation. |
| Ship Grid now | Figma's grid-flow is in beta; our users probably don't need it yet. Ship the sizing model + padding + loose canvas first; grid earns the next cycle. |
| Keep Raw CSS permanent | Signals "we're a CSS editor" to users. Product direction says design tool; gaps are a bug, not a feature. |

---

## Consequences

### Positive

- **Users build designs without CSS knowledge.** The Fixed/Hug/Fill dropdown + padding + loose canvas is the 80% of the gap Raw CSS was patching. The remaining 20% (cursor, z-index, position, margin) closes in a follow-up cycle.
- **The mental model matches Figma.** Loose canvas objects + named Frames as semantic containers is the vocabulary most users arrive with; teaching a different one costs them time.
- **MCP tool surface grows cleanly.** Agents get `set_size_mode(component, axis, "hug" | "fill" | "fixed")` rather than having to write correct CSS per parent type.
- **Raw CSS becomes a badge of failure** — if it appears on a component, something in the semantic layer isn't modelled. That's a useful signal for future work.

### Negative

- **SizeField is a non-trivial control.** Three states, per-axis, parent-aware availability rules, Min/Max overflow. Budget ~1.5 days to build correctly with tests.
- **Grid introduces a second layout-item taxonomy.** Grid children have different controls (column-span, row-span, cell-alignment) than flex children. The LayoutItemRows component splits into FlexItemRows + GridItemRows with a selector based on parent type.
- **Root-frame-as-page is convention, not enforcement.** A user could create a small first-frame and treat it as a normal Frame. We don't forbid it, but the first-frame's chrome-suppression depends on "is this the first frame?" which is a fragile check. Consider an explicit flag (`isPageRoot: true`) stored on the frame.
- **Conditional Raw CSS needs an orphan-property detector.** Walk the component's style object, filter out properties the semantic layer owns, show Raw CSS only if the residual is non-empty. Adds one helper function; stays cheap.

### Risks and mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| "Fill child forces Fixed parent" UX surprise (hidden state flip) | Medium | Show an inline hint in the UI when the silent override triggers: "Parent switched to Fixed because a child is set to Fill." |
| Grid shipped without subgrid / areas — users expect CSS-Grid feature parity | Low–Medium | Explicit in-app note on the Grid sub-section: "Subgrid / areas / named lines are not supported — use Raw CSS." Match Figma's published feature-set in comms. |
| Page-root frame deletion (user trashes it) leaves no canvas | Medium | `deleteArtboard` already refuses to delete the last frame? Check + enforce; if the page-root is the only frame, deletion is a reset to empty canvas, not a true delete. |
| MCP agents rely on raw CSS writes that the semantic layer would now intercept | Low | The `update_styles` MCP tool still works identically; the semantic layer just makes *human-authored* writes go through nicer paths. Agents aren't affected. |

---

## Implementation notes (non-normative)

### Phase plan

**Phase 1 — Sizing + Padding + loose canvas (this cycle)**
- `<SizeField>` control with Fixed/Hug/Fill + Min/Max overflow.
- Layout section's W/H row uses SizeField.
- Padding row with V/H + per-side toggle (already shipped in this cycle; kept as part of the bundle).
- Fix InsertRail to target Page root when no Frame is selected.

**Phase 2 — Semantic gap-closers**
- Margin row (alongside Padding in Layout).
- `cursor` enum in Appearance (new Interaction subsection).
- `position` mode enum in Position.
- `overflow-*` split into X/Y in Layout.

**Phase 3 — Grid auto-layout**
- Extend Direction to 4-valued.
- Grid controls sub-section: Columns, Rows, Gaps, per-cell alignment.
- Flex vs Grid LayoutItem split.

**Phase 4 — Raw CSS conditional**
- Orphan-property detector.
- Raw CSS section renders only when residual is non-empty.
- Rename "Raw CSS" → "Other CSS" with subtitle.

### Testid conventions

- `oc-ins-width-mode`, `oc-ins-height-mode` — new dropdowns.
- `oc-ins-min-w`, `oc-ins-max-w`, `oc-ins-min-h`, `oc-ins-max-h` — clamp inputs.
- `oc-ins-flex-direction` — extend existing to include `"grid"` value.
- `oc-ins-grid-cols`, `oc-ins-grid-rows` — track list inputs.
- `oc-ins-margin-*`, `oc-ins-cursor`, `oc-ins-position-mode` — gap-closer controls.

### Penpot-inspired patterns we adopt

- **Unified layout type (flex | grid) with branched UI** — ADR §3.2 mirrors this.
- **Padding dual-mode toggle (simple ↔ multiple)** — already shipped; matches Penpot's `:layout-padding-type`.
- **Per-track data (px / fr)** — use for grid columns/rows.

### Penpot-inspired patterns we reject

- **Contextual sizing (no stored mode)** — rejected above; explicit modes chosen for agent-tool clarity.

### Figma-inspired patterns we adopt

- **Fixed / Hug / Fill terminology** — match exactly; users arrive with it.
- **Grid as a flow inside Auto Layout, not a separate feature** — match Figma's 2025 direction.
- **Pages accept loose leaves** — approximated via root-frame-as-page.

### Figma-inspired patterns we reject

- **Sections as organisational containers** — niche for v0.x; out of scope.
- **Negative padding via variable-binding backdoor** — fully block; cleaner product story.

---

## Open questions

- Does "Page root" need an explicit `isPageRoot` flag on the frame, or is "first frame in document order" sufficient? Leaning toward explicit flag — less fragile — but the flag needs to survive `loadProjectData` round-trips.
- When a loose-canvas object is dragged into a Frame, does the Frame auto-expand (Hug) or does the object clip? Figma's answer: depends on the frame's width mode. Match that.
- Should Min-W / Max-W be a single overflow popover (Figma) or always-visible inputs under the W field (Penpot)? Figma's overflow is tidier; ship that.
- When a user adds an auto-layout to a Group, do we preserve child positions as Fixed or flip them all to Hug? Figma preserves Fixed; probably right.
- Does Raw CSS retirement happen as a single flip or gradually as Phase 2 properties ship? Probably gradual — "Other CSS" hides when residual is empty, which is already the conditional behaviour.

---

## Addendum (2026-04-24) — implementation status

Shipped across four commits plus the Min/Max clamp follow-up on
`adr-0006-sizing-canvas`:

- `0d03444` — Phase 1 + Phase 2 in one go: `<SizeField>` (Fixed / Hug /
  Fill) replaces the raw W/H inputs, padding row + per-side toggle,
  margin row, cursor enum (Appearance), `position` mode enum, overflow
  X/Y split, and the loose-canvas fix via `getPageRootWrapper(editor)`
  in `packages/app/src/canvas/primitives.ts` — primitives inserted with
  no Frame selected attach to the first frame's wrapper instead of the
  active frame.
- `593cb09` — Phase 3 grid auto-layout: 4-valued Direction (`free` /
  `row` / `column` / `grid`), `GridRows` with track inputs
  (`grid-template-columns` / `grid-template-rows`), gaps, per-child
  `grid-column` / `grid-row`. Subgrid / areas / named lines remain out
  of scope per the Decision (§2).
- `c261e49` — Phase 4 Raw CSS conditional: `hasOrphanProperties()`
  helper in `packages/app/src/components/inspector/orphan-properties.ts`
  walks the selection's defined styles and filters out semantic-layer
  owners; the section now renders only when residual is non-empty and
  is titled **"Other CSS"** per the rename.
- `4bf2ad8` — visual-density / lucide-only icons polish over the new
  surfaces.
- `e126aa4` — ADR §1 Min/Max clamps. SizeField gains `minValue` /
  `maxValue` / `onMinChange` / `onMaxChange` props and a Figma-style
  overflow popover (`⋯` trigger to the right of the px label)
  exposing two clearable numeric rows. LayoutSection's W/H consumers
  wire to `min-width` / `max-width` / `min-height` / `max-height`
  longhands via `readStyle` / `writeStyle` / `clearStyle`. Empty
  input clears; clamps are mode-independent — a Hug or Fill axis can
  still carry a clamp (verified by spec). New thin wrapper
  `packages/app/src/components/ui/popover.tsx` around the existing
  `@radix-ui/react-popover` dep. E2E coverage:
  `e2e/story-inspector-min-max-clamps.spec.ts` (2 specs, both green).

Three notes worth recording:

- **The orphan-property allowlist already claimed `min-width` / `max-width` /
  `min-height` / `max-height`** before any UI rendered them. Pre-Min/Max
  this was a real footgun: a clamp set by paste, MCP, or an agent would
  persist but be invisible from the inspector, and the "Other CSS"
  fallback wouldn't surface it either because the orphan detector said
  "we own this." Shipping the popover closes that hole and keeps the
  allowlist honest.
- **The overflow-popover trigger renders only when at least one of the
  Min/Max handlers is supplied.** Backward-compatible — consumers that
  don't yet wire the clamps see no visual change.
- **Open Question §1 (`isPageRoot` flag) — resolved 2026-04-24 in
  `c96f3f7`.** The flag now lives on the page-root frame's wrapper
  Component as the boolean attribute `data-designjs-page-root`,
  exported as `PAGE_ROOT_ATTR` from `packages/app/src/canvas/
  artboards.ts`. New `ensurePageRoot(editor)` is the single writer
  (idempotent — stamps the first frame on init only when nothing else
  carries it); wired into `App.tsx` `handleReady` after
  `ensureDefaultArtboard`. `getPageRootWrapper` reads via the marker
  with first-frame fallback for legacy projects whose saved data
  predates the flag. E2E coverage in
  `e2e/story-page-root-flag.spec.ts` (2 specs, both green).

---

*End of ADR-0006.*
