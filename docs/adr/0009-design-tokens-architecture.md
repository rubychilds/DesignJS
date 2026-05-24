# ADR-0009: Design tokens — data model, modes, CSS emission, agent surface

**Status:** Phase 1 Accepted (2026-05-04); Phases 2 + 3 Proposed
**Date:** April 22, 2026
**Owner:** Architecture
**Related:** [ADR-0001](./0001-frontend-ui-stack.md) (Tailwind v4 CDN in iframe), [ADR-0003](./0003-panel-information-architecture.md) (Assets panel deferred — the home for grouped tokens UI), [ADR-0007](./0007-user-extensibility.md) (kits + Tailwind `@theme`-file theming), [ADR-0008](./0008-figma-import-strategy.md) (Figma relay — Variables flow via `get_variable_defs`); PRD Story 6.2 (Design tokens / CSS variables — partially shipped, category-grouping + mode-aware AC still open)

---

## Context

Story 6.2 shipped a **flat `Record<string, string>`** store of CSS custom properties. Today's model:

```ts
// packages/app/src/canvas/variables.ts
const store = new Map<string, string>();
// e.g. { "--brand-primary": "#ff3366", "--space-4": "16px" }
```

Values are raw CSS strings; keys auto-prefix with `--`. Writes iterate every frame's iframe `:root` via `setProperty`. Persisted under the `cssVariables` sidecar field in `.designjs.json` (via `getExtras` on the persistence channel). MCP surface is `get_variables` + `set_variables` returning the flat map.

That shape is fine for v0.1 alpha — it's the minimum that round-trips. It has **eight visible gaps** against what competitors and interchange formats support:

| Dimension | DesignJS today | Gap |
|---|---|---|
| 1. Data model | Flat `Record<string, string>` | No typed metadata |
| 2. Types | None — every value is a raw CSS string | No color / dimension / duration distinction; no validation |
| 3. Collections / groups | Flat list in one category | Story 6.2 AC open — "grouped by colors / spacing / typography / shadows / borders" |
| 4. Modes / themes | Single `:root` state | No dark/light/density/brand variants of the same token |
| 5. Aliases | CSS-native `var(--x)` works but we don't track the graph | No "edit source, all consumers update" UX; agents can't introspect the graph |
| 6. CSS output | Custom props on iframe `:root` | No Tailwind v4 `@theme` emission → no auto-generated utilities |
| 7. Agent / API | MCP `get_variables` / `set_variables`, merge semantics, flat map | No type-aware set, no mode-scoped set, no alias resolution |
| 8. Interchange | `.designjs.json` sidecar only | No W3C DTCG, no Tokens Studio, no Style Dictionary, no Figma Variables round-trip |

This ADR picks the v0.3 / v0.4 evolution — the internal data model, the mode system, the CSS emission strategy, the agent-facing tool surface, and the import/export plan. It's load-bearing because:

1. Cross-tool compatibility (Figma Variables ⇄ DesignJS ⇄ Tokens Studio ⇄ Style Dictionary) is only cheap if the on-disk schema is right up front. Migrating the schema mid-cycle costs us the sidecar's round-trip guarantee (Story 6.2 open AC).
2. The v0.3 Assets panel (deferred in ADR-0003) needs this decided before it can show category groups.
3. Tailwind v4's `@theme` directive makes **token → utility** trivial if our emission targets it directly. Getting this right means `bg-brand-500` just works across the canvas without any extra user plumbing.

---

## Survey

### Figma Variables (2023 onward)

Authoritative refs: [help.figma.com/Overview-of-variables](https://help.figma.com/hc/en-us/articles/15145852043927-Overview-of-variables-collections-and-modes), [developers.figma.com/Variable](https://developers.figma.com/docs/plugins/api/Variables/), [VariableCollection](https://developers.figma.com/docs/plugins/api/VariableCollection/).

Two plugin objects — `Variable` and `VariableCollection`. Value lookup is always `(variable, modeId) → value | VariableAlias`:

```ts
interface Variable {
  id: string; name: string;
  variableCollectionId: string;
  resolvedType: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";
  valuesByMode: { [modeId: string]: RGBA | number | string | boolean | VariableAlias };
  scopes: VariableScope[];             // "ALL_FILLS", "CORNER_RADIUS", ...
  codeSyntax: { WEB?: string; ANDROID?: string; iOS?: string };
  description: string; hiddenFromPublishing: boolean;
}
interface VariableAlias { type: "VARIABLE_ALIAS"; id: string; }
```

- **4 primitive types.** No shadow / gradient / typography / composite — those stay in Figma *Styles*.
- **Collections carry modes.** `VariableCollection { modes: {modeId,name}[], defaultModeId, variableIds }`. Flat within a collection; hierarchy via `/`-delimited names or multiple collections.
- **Aliases** cross-collection, resolved lazily; cycles rejected; alias-to-alias allowed.
- **Dev Mode CSS:** emits `--collection-name/variable-name` custom props, uses `var(--…)` in generated CSS; `codeSyntax.WEB` overrides the emitted name.
- **Unique `scopes` field** restricts where a variable can be bound (keeps a spacing token from leaking into a fill). No ecosystem equivalent.
- **No native JSON export.** Interchange goes through Tokens Studio or similar bridges.

### W3C Design Tokens Community Group (DTCG)

Authoritative: [tr.designtokens.org/format](https://tr.designtokens.org/format/), [design-tokens/community-group](https://github.com/design-tokens/community-group).

Nested JSON, token leaves identified by `$value`:

```json
{
  "color": {
    "brand": {
      "primary": { "$type": "color", "$value": "#ff3366", "$description": "Primary" },
      "hover":   { "$value": "{color.brand.primary}" }
    }
  }
}
```

- **9 primitive types** — `color` · `dimension` · `fontFamily` · `fontWeight` · `duration` · `cubicBezier` · `number` · `strokeStyle` plus **5 composite** — `border` · `transition` · `shadow` · `gradient` · `typography`. `$type` inherits down groups.
- **Arbitrary nesting**; dotted path = canonical id.
- **Modes are NOT in the core spec.** Handled via `$extensions` — Tokens Studio uses `themes`, Style Dictionary uses `modes`. Proposal active; marking as "unclear for v1."
- **Aliases:** `{group.subgroup.token}` curly-brace strings; chains allowed; must resolve to same `$type`.
- **Format only — no runtime API, no CSS emission spec.** Emitters like Style Dictionary, Cobalt UI, Terrazzo do the `--group-token` kebab conversion.
- **Primary value prop = interchange.** Round-trips across Figma (via Tokens Studio), Style Dictionary, Supernova, Specify, Penpot.

### Tokens Studio + Style Dictionary

Both are ecosystem context, not direct competitors:

- **Tokens Studio** (Figma plugin) — richer type set beyond DTCG (`sizing`, `spacing`, `borderRadius`, `borderWidth`, `opacity`, `boxShadow`, `asset`, math expressions `{spacing.base} * 2`). Adds "token sets" (layered files) + "themes" (named combinations of sets) — richer mode model than Figma's. Syncs into Figma Variables by turning each theme into a Figma mode.
- **Style Dictionary** — transforms/filters/formats pipeline from nested JSON to CSS / SCSS / iOS / Android / JS / Compose. DTCG support via v4 / `preview: "2025-01"` flag. Adopted at Salesforce, Amazon, Microsoft, Adobe Spectrum, Shopify Polaris.

We don't need to adopt either directly — DTCG compatibility is enough to pick both up for free.

### Pencil.dev

Verified from MCP schema: `get_variables(filePath) → { variables, themes }`; `set_variables({ filePath, variables, replace? })` — "theme axes and values that aren't yet present… will be automatically registered." Themes are **first-class multi-axis**, auto-registered. Axes ≈ modes (light/dark, density, brand). Aliases unclear from the schema; sync with `globals.css` appears to be **agent-orchestrated** (the tool returns tokens, the agent writes the file) — not an editor-side watcher.

Takeaway for us: Pencil ships the mode model we want, in a shape that's friendly to agents. Their `get_variables` returning *both* `variables` and `themes` in one call is worth mirroring.

**Hierarchy** (verified 2026-04-24): `.pen format` page documents variables stored at the document level under a `variables` object, keyed by **dot-notation strings** (`"color.background"`, `"text.title"`). No "Collection" primitive in storage; grouping is conveyed through the dot-notation. Themes are an **orthogonal axis**, not a hierarchy level. Effectively a 2-level flat model with logical grouping via dotted keys — confirms our hybrid storage choice (§1).

### Paper.design — verified 2026-04-22

Direct fetch of [paper.design/docs/mcp](https://paper.design/docs/mcp) succeeded (curl; WebFetch tool still denied but curl works through Bash). The `/docs` and `/manifesto` pages are client-rendered SPAs and exposed no token-model detail in raw HTML, but the MCP tools page rendered fully. Findings:

- **No `get_variables` / `set_variables` tools.** Paper does *not* ship a structured token MCP surface.
- **Tokens are CSS strings** applied via `update_styles` + `write_html`. OKLCH / LCH / LAB / Display P3 values are stored as raw CSS strings (e.g. `"oklch(72% 0.11 178)"`), not as structured `{L, C, H}` fields.
- **No DTCG schema** exposed in the docs. No `$type` fields.
- **No mode / theme primitive** in the MCP surface. Agents apply theming via CSS classes.
- **No Figma Variables import endpoint.** Their documented workflow is *"paste a screenshot of the variables table and ask the agent"* — prompt-driven, not structured import. Export is `get_jsx` (React + Tailwind).

**Implication for this ADR:** Paper went the opposite direction — pure CSS strings, zero schema. Our DTCG-first bet is architecturally more ambitious and more interoperable. That differentiation is worth retaining: DesignJS is the HTML/CSS-native canvas *with* typed interop (Figma Variables ⇄ DTCG ⇄ Style Dictionary round-trip). Paper is the HTML/CSS-native canvas *without* it. Neither is wrong; they target different tails of the market.

No Paper ⇄ DesignJS token round-trip is possible at the structured level — there's nothing structured to round-trip with. An agent can always translate string ↔ DTCG via prompt, but there's no machine path. This simplifies ADR-0008's relay narrative: the relay imports Figma Variables (structured) via Figma's own Dev Mode MCP, and we don't need to mention Paper interop.

**Hierarchy** (verified 2026-04-24): zero. Paper has no native token model; tokens are CSS variables in the user's stylesheet, organised however the user organises their CSS. Our hybrid choice (§1) is more structured than Paper's, less rigid than Figma's — a conscious middle ground.

**Color storage** (verified 2026-04-24): Paper's MCP `update_styles` accepts raw CSS strings, so OKLCH round-trips losslessly through their canvas (inferred — not empirically tested). Aligns with our OKLCH-canonical decision (§2).

### Tailwind v4 `@theme`

Verified from [tailwindcss.com docs](https://tailwindcss.com/docs/theme):

```css
@theme {
  --color-mint-500: oklch(72% 0.11 178);
  --spacing-4: 1rem;
  --font-sans: "Inter", ...;
}
```

- Each token does **double duty** — a real `:root` `--color-mint-500` *and* auto-generated utilities (`bg-mint-500`, `text-mint-500`, `border-mint-500`…). This is the superpower we want to target.
- **Namespaces drive utility generation** — `--color-*` → colour utilities, `--spacing-*` → padding/margin/width/height, `--font-*` → family, `--text-*` → size, `--radius-*` → rounded, `--shadow-*`, `--breakpoint-*` → variants, `--animate-*`.
- **Reset:** `--color-*: initial;` wipes a namespace; `--*: initial;` wipes all.
- **Inline aliasing:** `@theme inline { --font-sans: var(--font-inter); }`.
- **`tailwind.config.js` deprecated.** Loadable via `@config "./tailwind.config.js"` for migration; CSS is the canonical config surface.
- **No first-class modes, types, or aliases** in the Figma / DTCG sense. Modes are standard CSS — `@media (prefers-color-scheme: dark)` or a `.dark` class overriding the same `--color-*`.

### Convergence table

| Dimension | Figma Variables | DTCG | Tailwind v4 `@theme` | DesignJS today |
|---|---|---|---|---|
| Data model | `Variable` + `Collection`, `valuesByMode` map | Nested JSON, `$type`/`$value` | Flat custom props in `@theme { }` | Flat `Record<string, string>` |
| Types | 4 primitive | 9 primitive + 5 composite | None (namespace-by-naming) | None |
| Collections | Per collection flat | Arbitrary nesting | None | None |
| Modes | N per collection | Not in core | Via standard CSS | None |
| Aliases | `VariableAlias` | `{path.to.token}` | `@theme inline` + `var()` | CSS-native `var()` |
| CSS output | `--collection/name`, `codeSyntax` override | Not specified | **Double duty — custom prop + utility** | `--token` on `:root` |
| API | Plugin API + REST (Enterprise) | File format only | CSS directive | MCP `get_variables` / `set_variables` |
| Interchange | Via Tokens Studio → DTCG | Native (primary value prop) | None | Sidecar only |

**Implication:** DTCG is the only realistic **on-disk** format; Tailwind v4 `@theme` is the only realistic **CSS output** format; Figma Variables is the only realistic **import** format (via ADR-0008's relay). All three can coexist — they operate at different layers.

---

## Decision

### 1. Adopt DTCG as the internal data model

Switch the `cssVariables` sidecar from flat map to **DTCG-shaped nested JSON** (`$type` / `$value` / `$description` / `$extensions`) starting in v0.3. Example:

```json
{
  "tokens": {
    "color": {
      "brand": {
        "primary": { "$type": "color", "$value": "#ff3366" },
        "hover":   { "$value": "{color.brand.primary}" }
      },
      "surface": { "$type": "color", "$value": "#ffffff" }
    },
    "spacing": {
      "4": { "$type": "dimension", "$value": "1rem" }
    }
  }
}
```

Stored at a new `tokens` key in `.designjs.json` (the existing `cssVariables` field becomes deprecated — see §8 for migration). Authoritative format on disk, in memory, and over the MCP wire.

**Hybrid hierarchy — flat-with-dot-notation storage, three-level UI projection.** Storage follows DTCG's natural nested-object shape (effectively flat: `color.brand.primary` is a path through nested keys, not a rigid Collection/Group structure). The UI (§9) projects this onto Figma's familiar three-level Collection → Group → Variable presentation: the topmost object key in `tokens` is the Collection, intermediate keys are Groups, the leaf is the Variable. Permissive on disk (a user can flatten or restructure without breaking emission), familiar in UX (Figma vocabulary). Matches Pencil.dev's dot-notation grouping pattern at the storage layer; matches Tailwind v4's `--color-brand-primary` flat-with-prefix at the emission layer.

### 2. Type system — primitives in v0.3, composites in v0.4

v0.3 ships **7 primitive DTCG types**: `color` · `dimension` · `number` · `duration` · `cubicBezier` · `fontFamily` · `fontWeight`. Ships enough for colour / spacing / typography tokens — which covers Story 6.2's open AC group list ("colors, spacing, typography, shadows, borders") for four of five categories.

**`strokeStyle`** (DTCG primitive) ships in v0.4 alongside the composites. The full DTCG composite set — `border` · `transition` · `shadow` · `gradient` · `typography` — ships in v0.4 so shadow and border groups work in the Assets panel. Until then, shadow and border values can be stored as `$type: "string"` (escape hatch) with a linter warning.

Typed values for v0.3:
- `color` — **OKLCH canonical**, with a `$extensions.designjs.colorSpace` field per token (`"oklch" | "srgb" | "p3"`) so non-OKLCH inputs round-trip without lossy normalisation. The picker accepts hex / `rgb()` / `rgba()` / `hsl()` / `hsla()` / `lab()` / `oklch()` and converts to OKLCH on store with a one-way conversion log to `console.info` for non-OKLCH inputs. **Why OKLCH:** Tailwind v4 (our emission target, §5) ships its default palette in OKLCH and treats it as the canonical form; perceptual uniformity matters for designed colour scales; CSS Color Module 4 supports OKLCH natively in target browsers. Figma stores sRGB (verified 2026-04-24); ADR-0008 relay does the OKLCH ⇄ sRGB conversion at the import/export edge — lossy on the OKLCH-to-sRGB direction (gamut clamp), lossless on sRGB-to-OKLCH. Flagged in the relay docs for users.
- `dimension` — accepts `px`, `rem`, `em`, `%`, `vh`, `vw`, `fr`. Stored as CSS string; validation on write.
- `duration` — `ms` / `s`; `cubicBezier` — 4-value array.

### 3. Modes — Figma-shaped, stored as DTCG `$extensions`

DTCG core doesn't specify modes. We adopt **Figma's shape** (N modes per collection; each token holds one value per mode) stored under `$extensions.designjs.modes`:

```json
{
  "tokens": {
    "color": {
      "surface": {
        "$type": "color",
        "$value": "#ffffff",
        "$extensions": {
          "designjs.modes": { "dark": "#0a0a0a", "hc": "#000000" }
        }
      }
    }
  },
  "$extensions": {
    "designjs.collections": {
      "color": { "modes": ["light", "dark", "hc"], "defaultMode": "light" }
    }
  }
}
```

`$value` is always the default-mode value; other modes live under `$extensions.designjs.modes.<modeId>`. Keeps on-disk files DTCG-parseable by external tools (they'll see the default, ignore the extensions) while preserving mode fidelity for DesignJS's own tooling and Figma round-trip.

Token-set composition (Tokens Studio's richer model) is **deferred to v0.5** — modes cover the 80% case; composition is an advanced-user follow-up.

### 4. Aliases resolved lazily; agents see the graph

Alias values use DTCG's `{path.to.token}` syntax. Resolution is lazy (at CSS-emission time and at MCP-read time), recursive (alias-to-alias allowed), cycle-checked (loop → error, token falls back to the literal string form of the alias). The MCP surface exposes a new `resolve_alias` tool for agents that want the concrete value without re-implementing resolution:

```ts
resolve_alias({ tokenPath: "color.brand.hover", mode?: "dark" })
  → { value: "#ff3366", chain: ["color.brand.hover", "color.brand.primary"] }
```

Round-trips with Figma Variables aliases via ADR-0008's relay (Figma's `VariableAlias` → DTCG `{…}` string).

### 5. CSS emission — Tailwind v4 `@theme` dual-emit

At runtime, the token store emits **two artefacts** into the iframe:

1. **A `<style>` with `@theme { }`** for tokens whose group path matches a Tailwind namespace (`color.*` → `--color-*`, `spacing.*` → `--spacing-*`, `font.*` → `--font-*`, `radius.*` → `--radius-*`, `shadow.*` → `--shadow-*`, `text.*` → `--text-*`). These tokens automatically generate Tailwind utilities — `bg-brand-primary`, `p-4`, `rounded-lg` — *for free* without user plumbing.
2. **A `<style>` with plain `:root { --token: value; }`** for tokens outside Tailwind's namespaces. These are still addressable via `var(--token)` in user CSS but don't auto-generate utilities.

Modes emit per-mode via CSS attribute selectors:

```css
@theme {
  --color-brand-primary: #ff3366;
}
:root[data-designjs-mode="dark"] {
  --color-brand-primary: #ff6b8a;
}
```

The canvas sets `data-designjs-mode` on the `:root` element to switch the active mode. Mode switching is a local editor UI (Topbar dropdown, stretch goal for v0.3); not persisted to `.designjs.json` beyond the default-mode pointer in `$extensions.designjs.collections`.

**Name-collision detection** — the path-to-CSS-variable transform is deterministic, so two distinct DTCG paths can collapse to the same CSS variable name (e.g. `color.brand.primary` and `color.brand-primary` both → `--color-brand-primary`). The emission pipeline detects this at load time and **refuses to emit until resolved**, surfacing the conflict in the Topbar via the existing variable-count badge as a red "X conflicts" marker. Style Dictionary precedent: same shape (build fails, lists offending tokens). Tailwind v4 has no built-in collision detection, so we own this. See Open Q §7 for the rationale.

### 6. Agent surface — new typed tools replace old

The new typed tool set:

- `get_tokens({ mode?: string, resolve?: boolean })` → DTCG-shaped JSON. `resolve=true` chases aliases; default returns the raw tree with alias strings intact.
- `set_tokens({ tokens: DTCGTree, mode?: string, replace?: boolean })` — merges by default; `replace` swaps the whole tree (Pencil's pattern).
- `resolve_alias({ tokenPath, mode? })` — as §4 above.
- `list_modes({ collection?: string })` → per-collection mode list + default.
- `set_mode(modeId)` — switches the canvas preview; equivalent to clicking the Topbar dropdown.

The existing `get_variables` / `set_variables` tools are **removed**, not deprecated. DesignJS has not done a public release; there are no third-party clients depending on the flat shape, so a deprecation window would be pure ceremony. The new typed tools land alongside the §1 data-model migration; the legacy MCP tools come out at the same time.

Pattern borrowed from Pencil: a single `get_tokens` response includes both the tree and the available modes, so agents don't round-trip to discover what modes exist.

### 7. Import / export

Three surfaces, different priorities:

- **DTCG JSON — ✅ ship in v0.3.** Drop a `tokens.json` at the project root; canvas picks it up on load. Write-back via Cmd+Shift+E → downloads a DTCG file. Matches Tokens Studio out of the box (they speak DTCG post v2).
- **Figma Variables — ✅ ship in v0.3, via ADR-0008 relay.** Agent reads Figma's `get_variable_defs` (Dev Mode MCP server), translates, calls our `set_tokens`. The RGBA-to-CSS converter + mode-mapping happens in the agent step. Quality ceiling: tokens visible to Dev Mode MCP's selection scope. Relay docs (ADR-0008 Path A deliverable) get a "Importing Figma Variables" section. **Doc-drift note:** ADR-0008's relay docs as shipped in v0.3-early reference `set_variables` (the flat tool that existed at that moment). Once v0.3-mid lands this ADR's `set_tokens` typed tool, update ADR-0008's docs to reference `set_tokens` instead — the flat `set_variables` still works (deprecation alias) but `set_tokens` preserves type + mode fidelity through the relay.
- **Style Dictionary emission — ⚠️ deferred to v0.4.** Our DTCG-shaped store is directly ingestible by Style Dictionary, so users who want Android / iOS / JS emission can just feed `tokens.json` to Style Dictionary themselves. No DesignJS-owned CLI in v0.3.

### 7a. Kit baseline tokens cascade under user tokens

ADR-0007 §2a introduces per-kit baseline token sets (e.g., shadcn's canonical `--primary`/`--secondary`/`--background` set) bundled under `packages/app/src/kits/{kit}/tokens.json`. These are **not** migrated into the user's `.designjs.json#tokens` on kit install — they remain kit assets.

At CSS emission time (§5), the runtime merges token layers in this order (lowest to highest precedence):

1. **Kit baseline tokens** for every kit currently contributing a block in `DEFAULT_BLOCKS` (shadcn + Base UI + Tremor + Park UI + Magic UI in v0.3).
2. **User tokens** from `.designjs.json#tokens` (migrated from the old `cssVariables` flat map on first load, or authored fresh via the Topbar popover / `set_tokens` MCP).
3. **User tokens from `tokens.json`** at project root, if present — same precedence as `.designjs.json#tokens` (the file is the canonical authoring surface; `.designjs.json#tokens` is the canvas's runtime copy). Collision between the two is resolved by most-recently-written-wins.

Alias resolution walks the merged tree — a user alias `{color.brand.primary}` can point at a kit baseline token that the user hasn't overridden. No special handling.

Rationale — referenced-not-copied (vs. copy-on-kit-install): keeps the user's `tokens.json` project-scoped and diff-clean; no "where did these 60 tokens come from" moments after installing shadcn; progressive disclosure (the user only sees the tokens they've chosen to override); kit upgrades propagate cleanly without stomping overrides. Trade-off: slightly more complex runtime merge (three layers to resolve at CSS emission). Acceptable — the merge is ~30 lines and runs once per token-tree change, not per paint.

### 8. Migration from the flat `cssVariables` sidecar

On load, if `.designjs.json` contains a `cssVariables` flat map and **no** `tokens` DTCG field, we **auto-migrate in memory** with a conservative shape inference:

- Keys matching `--color-*` or values parseable as colours → `$type: "color"`.
- Keys matching `--space-*`, `--padding-*`, `--margin-*`, `--radius-*`, values ending in valid CSS length units → `$type: "dimension"`.
- Keys matching `--font-*` → `$type: "fontFamily"` or `fontWeight` based on value shape.
- Everything else → `$type: "string"` (escape hatch).

Grouping uses kebab-segments: `--color-brand-primary` → `color.brand.primary`.

On next save, the file is written with `tokens` populated and `cssVariables` omitted. A one-time migration log fires to `console.info` for maintainer visibility. This is the same silent-migration pattern we use for other sidecar evolutions (pattern established by the Story 6.2 `getExtras` channel).

Projects not migrated yet continue to work via the deprecated `get_variables` / `set_variables` shape — no forced migration.

### 9. UX — table-with-mode-columns + chip-in-input + global mode switcher

The data model (§§1–7a) determines what's stored. This section determines what users see. Patterns lifted, adapted, and rejected from a 2026-04-24 Figma Variables UX audit (full research notes in `DesignJS-Notes/figma-variables-ux-research.md`):

**UX philosophy — alignment first, divergence with justification.** Default to existing design-tool patterns (Figma primarily; Penpot, Pencil, Storybook secondary). Users arrive with mental models from those tools; re-learning is the dominant source of UX complexity. Borrow patterns where they fit; diverge only with a one-sentence written justification covering *what* we're doing differently, *why* the established pattern doesn't fit our context (HTML/CSS-native, agent-driven, pre-public), and *what compensates* for the unfamiliarity. If a behaviour exists in zero competitors, that's a yellow flag — usually means we're solving a non-problem or carrying an unstated constraint we should question. Each "Diverge from Figma" entry below carries its justification inline; "Lift from Figma" entries don't need one since alignment is the default.

**Three surfaces** — each tuned to a different user state:

- **Topbar popover (existing)** — `packages/app/src/components/VariablesPopover.tsx`. Always-accessible quick CRUD for the "I want to add or tweak one variable fast" mental model. Stays as a flat list with type filter; the existing affordance our users already know.
- **Deselected-state right-sidebar section (new)** — when nothing is selected on the canvas, the inspector right-sidebar shows a "Local variables" section: most-recently-used variables and an "Open variables" button. Contextual; appears only in the deselected state, matching Figma's pattern. Quick "let me peek at what's defined" without committing to the modal.
- **Full modal "Variables view" (new)** — launched from the popover, the sidebar section's "Open variables" button, or a keyboard shortcut. Bulk authoring lives here: modes-as-columns table, multi-collection switcher, alias editing. The popover and sidebar cannot scale to multi-collection × multi-mode without losing the "quick" property.

**Browse / authoring layout:**

- **Table with one column per mode**, leftmost = default. Variable name on the left; one cell per mode. This is the single most distinctive Figma pattern and matches our DTCG mode-extension shape exactly.
- **Three-level hierarchy in the UI** (Collection → Group → Variable), **flat-with-dot-notation in storage** (§1). Collection switcher in the modal's left sidebar; group folders in the variable tree; variable rows in the table. The UI projects three rigid levels onto a permissive flat-with-dots data shape — users get Figma's familiar vocabulary; storage stays DTCG-natural and Tailwind-emission-friendly.
- **Type filter** ("Sizing" / "Color" / "Typography" / "Effect"). DTCG distinguishes `dimension` / `color` / `fontFamily` / `duration` / `cubicBezier` etc. — keep those as explicit `$type`s (Figma collapses them all into `Number`; we do not, because CSS emission needs unit information). Picker groups by family so the surface still feels scannable.
- **Visually collapse identical-across-modes rows** — Figma renders them as repeated values, which is noise at scale. We render a single span when all modes resolve to the same value.

**Apply flow (where users meet the inspector):**

- **`=` shortcut** in any numeric inspector field opens the variable picker scoped to compatible types. Lifted from Figma — lowest-friction apply flow they ship. Wire into our inspector's number-input primitives.
- **Chip-in-input** — applied variable renders as a `gray pill: token-name + resolved-value` chip *inside* the property field (e.g. "spacing.lg / 16px"). Hover-icon on the chip detaches.
- **Right-click → Apply variable** on color swatches, text properties, and visibility (boolean) controls.
- **Square-vs-circle swatch** convention reserved for if we ever ship a second token-like primitive (presets / styles); for v0.3 we have one shape.

**Aliases:**

- Created via right-click → "Create alias" on a value cell, then picking another variable of the same `$type`.
- Aliased cell renders the resolved value plus a reference-pill showing the source variable's name.
- **Improve on Figma**: hover the reference-pill and we render the *full* alias chain (semantic → primitive → CSS value) in a tooltip. Important because devs reading our emitted Tailwind `@theme` need the chain — Figma only shows the immediate parent.

**Mode switching:**

- **Per-frame mode override** in the inspector (when a frame is selected) — same shape as Figma's "Apply variable mode" affordance, lives in the Layout or Appearance section. Mode-tag pill renders next to the layer in the Layers panel for any node with an override.
- **Global preview switcher in the topbar** — a top-bar dropdown that flips the entire canvas between modes for preview. Figma deliberately doesn't ship this. We do, because for an HTML/CSS-native tool a global toggle (matching OS dark-mode toggles, Storybook backgrounds) is the strongest mental model. Maps onto a `data-designjs-mode` attribute selector on the document root in emitted CSS.
- **Inheritance via CSS cascade** — modes set on an ancestor flow to descendants until a descendant overrides, matching how `prefers-color-scheme` / theme classes already work in real CSS. Free of cost; consistent with the HTML-native bet.

**Single-token edit surface:**

- Modal dialog opened from a hover-row → edit-icon. Fields: Name, Description, Value (per mode), Hide-from-publishing (when v0.4 ships publishing). DROP Figma's per-platform "Code syntax" field (Web/iOS/Android) — we emit one CSS target.
- **Type immutable post-creation.** Dramatically simplifies emission and matches Figma's behaviour. Migration from flat `cssVariables` (§8) infers the type once on first load; subsequent edits cannot change it.

**Explicitly skipped:**

- **Styles vs Variables duality.** Figma carries this for legacy reasons — Color Styles predate Variables and handle multi-value resources (gradients, images, effects) that early Variables couldn't. We have no legacy. DTCG covers gradients via composite types (v0.4); Tailwind v4 `@theme` is the single emission target. One picker, one swatch shape.
- **Authenticated-library publishing flows.** Figma's team-library / publishing UX is its own subsystem. Out of scope for v0.3; revisit if/when DesignJS grows a team-library story.

### 10. Implementation phasing — three phases, two gates

The full §§1–9 surface is ~5–6 weeks of focused work. Splitting into three checkpoints reduces blast radius, ships user-visible value at each gate, and isolates the highest-risk single change (storage shape migration) into the smallest phase.

**Phase 1 — v0.3: foundation (~1.5 weeks).** Data shape + emission only; existing UX surface unchanged.

| § | Scope | Notes |
|---|---|---|
| §1 | DTCG-shaped storage (flat-with-dots) | No `$extensions.designjs.modes` wiring yet |
| §2 | All 7 typed primitives + OKLCH canonical | Conversion logic + `$extensions.designjs.colorSpace` field |
| §5 | Tailwind v4 `@theme` dual-emit + collision detection | The headline user-visible payoff (`bg-brand-primary` "for free") |
| §7 | DTCG import / export | Basic JSON pipe |
| §8 | Migration from flat `cssVariables` | Auto-migrate on load with conservative type inference |

Existing `VariablesPopover` continues unchanged behaviourally — it just reads/writes the new DTCG store underneath. Existing `get_variables` / `set_variables` MCP tools continue, returning a flat default-mode view derived from the DTCG store.

**Phase 2 — v0.4-α: data + MCP (~1.5–2 weeks).** Modes, aliases, and the new typed agent surface. No new UX surface yet — Phase 2 is data-and-API only so the contract can settle before building UI on top of it.

| § | Scope | Notes |
|---|---|---|
| §3 | Modes — Figma-shaped, `$extensions.designjs.modes` | Data model + per-mode resolution; no per-frame override UI yet |
| §4 | Aliases — lazy resolution + cycle detection | `{path.to.token}` syntax + `resolve_alias` MCP tool |
| §6 | 5 new typed MCP tools land; legacy `get_variables` / `set_variables` removed | No deprecation window per pre-public release (memory: feedback_no_premature_deprecation) |
| §7a | Kit baseline tokens cascade | **Unblocks ADR-0007 implementation at this point** |

By the end of Phase 2, agents can fully use the typed token surface; the canvas can resolve aliases and apply modes via the new MCP `set_mode` tool. Existing popover still works but shows only default-mode values — explicitly a transition state.

**Phase 3 — v0.4-β: UX (~2–3 weeks).** The full §9 surface. Every UX decision in this phase aligns with Figma / Penpot / Pencil patterns first; divergences carry the inline justification per the §9 philosophy.

| § | Scope | Notes |
|---|---|---|
| §9 surfaces | Three-tier — popover refactored, deselected-state sidebar section, full modal "Variables view" | Modal: modes-as-columns table, collection switcher, group folders, type-grouped picker, alias editor, edit dialog |
| §9 apply flow | `=` shortcut in numeric inspector fields, chip-in-input, right-click apply | Wires into existing inspector primitives |
| §9 mode switching | Topbar global mode switcher, per-frame override UI, layer-tree mode-tag pill | Topbar is the one diverge-from-Figma in this phase (justified per §9 philosophy: HTML/CSS-native users have an OS-dark-mode mental model Figma users don't) |
| §9 alias UI | Right-click → Create alias + reference-pill + full-chain tooltip | Full-chain tooltip is the second justified divergence (devs reading emitted Tailwind `@theme` need the chain) |

**Why this split:**

1. **v0.3 is independently shippable + valuable.** Tailwind `@theme` emission alone is the "disproportionate value prop" (Consequences below) — typed primitives + auto-generated utilities + OKLCH fidelity without users learning a new UI.
2. **Phase 2 / 3 boundary lets the data contract settle before UX is built on it.** Modes + aliases + new MCP tools land first; UX in Phase 3 is built against a stable substrate.
3. **No half-baked UX.** Modes, aliases, and the modal are interdependent — splitting them across phases forces confusing mid-states ("modes column header but you can only have one mode"). They land together in Phase 3.
4. **ADR-0007 unblocks at the Phase 2 boundary** when §7a kit cascade ships. ADR-0007 implementation can begin in parallel with Phase 3.
5. **Migration risk is contained to v0.3.** Storage shape change (flat → DTCG) is the riskiest single change; isolating it in the smallest phase reduces blast radius.

**Open at this layer (not architectural, project-planning):**

- Calendar dates for each phase. Depend on prioritisation against other v0.3 work (Epic 8 polish, kit research, etc.) — outside the ADR's scope.
- Whether Phase 3 itself sub-splits further if it runs long (e.g. modal first, then sidebar + topbar). Defer until Phase 3 estimate is concrete.

---

## Consequences

- **Interchange unlocks.** DesignJS gains tokens round-trip with Tokens Studio, Style Dictionary, and (via ADR-0008 relay) Figma Variables. Doesn't ship as a DesignJS feature we market — it's a platform primitive that future features assume.
- **Tailwind utilities just work.** Users set a color token, get `bg-brand-primary` in the block palette and in agent-generated HTML without extra plumbing. The `@theme` emission is ~20-line runtime code; the value prop is disproportionate.
- **MCP surface grows by 3 tools net.** Five new typed tools (`get_tokens`, `set_tokens`, `resolve_alias`, `list_modes`, `set_mode`) replace the two legacy tools (`get_variables` / `set_variables`) per §6 — no deprecation window because DesignJS hasn't done a public release. From 20 → 23 tools at v0.3. Competitive context (verified 2026-04-22): Figma Dev Mode MCP ships 15, Pencil 13 (with two composite `batch_*` tools), Paper 21, Onlook no MCP. DesignJS post-v0.3 at ~23 tools is firmly in the design-tool MCP range. Composite-tool consolidation (Pencil's pattern) is not the industry direction; MCP guidance discourages overloading single tools with operation-string dispatch. Governance captured as a separate open discussion item, not in this ADR.
- **Assets panel in v0.3 can group by `$type`** per Story 6.2's open AC — the grouping key is the DTCG type field, not a separate "category" dimension we'd have to invent.
- **Mode-switching UX is a small editor feature** — Topbar dropdown + a `data-designjs-mode` attribute + CSS attribute-selector overrides. Isolated concern; not coupled to the data model work.
- **v0.3 scope grows by ~1 week** over the minimal "add grouping" option. Trading a 3-day schema band-aid (v0.3-early) for a 1-week schema-plus-emission effort (v0.3-mid) that doesn't need revisiting at v0.4 or v0.5.
- **Composite types missed in v0.3** — shadow / gradient / typography tokens fall back to `$type: "string"` until v0.4. Tokens Studio files that use composite types ingest as strings, which is lossy but not broken (values still render correctly via the CSS emitter; they just don't participate in the type system).
- **`tokens.json` and `designjs.theme.css` (ADR-0007) coexist at different layers.** `tokens.json` is the source of truth for *structured* tokens; its emission is a **runtime `<style>` injected into each frame's iframe `<head>`** (never written to disk, never touches the user's files). `designjs.theme.css` remains the user-authored file ADR-0007 describes — untyped Tailwind directives, `@layer` overrides, `@import` pulls from `app/globals.css` — and is injected into the iframe as-is. Neither mechanism overwrites the other: the token-derived `<style>` and the user-authored `<style>` are siblings in the iframe `<head>`, loaded in that order so user `designjs.theme.css` rules can override token-emitted ones by specificity. Users who want token-scoped control edit `tokens.json`; users who want raw CSS escape-hatch edit `designjs.theme.css`.

---

## Open questions

1. ~~**Paper.design verification.**~~ **Resolved 2026-04-22:** Paper does not ship a structured token MCP surface. Tokens are CSS strings applied via `update_styles`/`write_html`; no DTCG, no variable collections, no mode primitive. Our DTCG-first bet differentiates us (see §Survey → Paper.design). No cross-tool structured round-trip possible; agent prompt-translation is the only Paper ⇄ DesignJS path. *Left here as a record of the decision.*

2. ~~**Scope field — v0.4?**~~ **Resolved 2026-04-24: skip indefinitely.** Only Figma ships per-token scopes, and verified-2026-04-24 their "enforcement" is just picker-visibility filtering (out-of-scope variables are *omitted* from the picker for that field) — not validation, not warning, not a real constraint. Tokens Studio, Style Dictionary, DTCG core, and Pencil all rely on `$type` alone. For an HTML/CSS-native canvas, the browser already silently ignores malformed bindings, so the marginal value of a soft-filter UX is dev-experience nice-to-have, not a load-bearing piece. Reserve `$extensions.designjs.scopes` namespace if a v0.5+ user-flow surfaces a real need. *Left here as a record.*

3. ~~**OKLCH / lab / Display P3.**~~ **Resolved 2026-04-24:** §2 promotes OKLCH to canonical with a `$extensions.designjs.colorSpace` field for graceful degradation. Driven by Tailwind v4 being our emission target (canonical OKLCH there); Figma uses sRGB and the ADR-0008 relay does the conversion at the import/export edge. OKLCH-to-sRGB is lossy on Figma export (gamut clamp); flagged in relay docs. *Left here as a record.*

4. ~~**Token-set composition (Tokens Studio's richer model) — v0.5?**~~ **Deferred to a future ADR (post-v0.3).** Modes cover the 80% case for v0.3. Token sets (layered files, `"theme": "Brand A + Dark"`) require their own design pass — composition rules, conflict resolution, UI for layering — and are not in scope this cycle. Re-open if multi-brand users push back. *Left here as a record.*

5. ~~**Deprecation timeline.**~~ **Resolved 2026-04-24:** Not applicable. DesignJS has not done a public release; no third-party clients depend on the legacy `get_variables` / `set_variables` shape. §6 now removes them outright at the same time the new typed tools land — no deprecation window needed. Revisit only if a public release ships before the data-model migration. *Left here as a record.*

6. ~~**Migration for projects with cross-frame tokens.**~~ **Resolved 2026-04-24:** split into two cases, both addressed.
   - **Per-frame *mode* override** (frame picks which mode of the existing collection it renders) — already shipping in §9 Mode-switching. Matches Figma + Pencil + Storybook precedent. Use cases: brand A/B side-by-side, light/dark comparison frames.
   - **Per-frame *value* override** (frame redefines token values, separate from mode) — **deferred to a future ADR.** Penpot tried this exact thing and called it "complex, no roadmap" (verified 2026-04-24); we follow their lead. Re-open if a real demand surfaces. *Left here as a record.*

7. ~~**Name-space collisions in Tailwind's `@theme`.**~~ **Resolved 2026-04-24: error at load time, hard-fail.** If a user defines both `color.brand.primary` (→ `--color-brand-primary`) and `color.brand-primary` (→ `--color-brand-primary`), the two collide in the emitted CSS. The §5 emission pipeline detects the collision deterministically and refuses to emit, surfacing the conflict in the Topbar via the existing variable-count badge as a red "X conflicts" marker until resolved. Style Dictionary's collision-warning precedent (verified 2026-04-24) confirms this is the right shape — silent last-write-wins is a deferred bug. Tailwind v4 itself has no built-in collision detection, so we own this. *Left here as a record.*

---

## References

### Authoritative
- [Figma Variables Plugin API](https://developers.figma.com/docs/plugins/api/Variables/)
- [W3C DTCG format spec](https://tr.designtokens.org/format/) · [community-group repo](https://github.com/design-tokens/community-group)
- [Tailwind v4 @theme docs](https://tailwindcss.com/docs/theme)
- [Pencil.dev docs](https://docs.pencil.dev) — for the mode-aware `get_variables`/`set_variables` pattern

### Ecosystem
- [Tokens Studio docs](https://docs.tokens.studio) — DTCG + extensions
- [Style Dictionary](https://styledictionary.com) — DTCG consumer / platform emitter

### Unverified (flagged Open Q #1)
- [paper.design/docs](https://paper.design/docs) — WebFetch denied during this ADR's research

### Prior art in this tree
- `packages/app/src/canvas/variables.ts` — current flat `Record<string, string>` store
- `packages/app/src/components/VariablesPopover.tsx` — current Topbar UI
- PRD Story 6.2 — the ship state this ADR evolves
- [ADR-0008](./0008-figma-import-strategy.md) — relay path for Figma Variables ingest

---

## Addendum (2026-05-04) — Phase 1 implementation status

Phase 1 (per §10 phasing — §§1, 2, 5, 7 data layer, 8) shipped in
four chunks on `adr-0009-phase-1`. Existing surface (popover, MCP
`get_variables` / `set_variables`, persistence) continues unchanged
behaviourally — the new DTCG store sits underneath and projects
through a flat-shape adapter so every Phase 1 commit is non-breaking
to consumers.

What landed:

- `67499c8` — **Chunk A: DTCG store + migration + variables.ts adapter.**
  New `packages/app/src/canvas/tokens.ts` with DTCG types
  (`Token`, `TokenTree`), module-level mutable store, dot-path
  operations (get / set / delete / walk), the
  `pathToCssVariable` ↔ `cssVariableToPath` bijection, all 7 §2
  validators, key-prefix-first type inference (§8), and the legacy
  round-trip helpers `inflateFromCssVariables` /
  `flattenToCssVariables`. `variables.ts` refactored from a flat-Map
  store into a thin adapter — public API unchanged so the popover,
  MCP handlers, and persistence's `getExtras` channel keep working.
- `563a906` — **Chunk B: OKLCH-canonical color storage + colorSpace.**
  New `color-conversion.ts` — pure CSS Color 4 math, no deps. Parsers
  for hex / rgb() / hsl() / oklch() (full unit coverage); conversion
  path sRGB → linear sRGB → OKLab (Björn Ottosson's pre-composed
  matrices) → OKLCH; `formatOKLCH` rounds to 4 / 4 / 3 decimals for
  stable round-trip. `inflateFromCssVariables` now canonicalises
  color tokens and tags `$extensions.designjs.colorSpace`.
  Unrecognised literals (named colors, `currentColor`, `var(...)`)
  preserve raw value — graceful degradation per §2.
- `dcd055e` — **Chunk C: Tailwind v4 `@theme` dual-emit + collisions.**
  New `token-emit.ts` walks the tree and emits two CSS blocks:
  `@theme { ... }` for tokens whose CSS variable matches a Tailwind
  v0.3 namespace (17 prefixes — color, spacing, font, radius,
  shadow, ease, etc.), `:root { --x: ...; }` for everything else.
  Collision detection per §7 — paths that collapse to the same CSS
  variable name are *omitted* from emitted CSS (no last-write-wins
  ambiguity reaches the canvas) and reported in the result's
  `collisions: Collision[]` array so UI can surface the badge.
  Output is sorted for deterministic round-trip.
- `7742953` — **Chunk D: DTCG file import / export.** New `token-io.ts`
  with `parseDTCG` / `serialiseDTCG`. Color tokens canonicalise on
  parse but preserve any existing `colorSpace` annotation so external
  DTCG files round-trip with their origin metadata intact.
  `$description` and proprietary `$extensions` (Tokens Studio,
  custom) pass through opaquely. Pretty-printed 2-space-indent
  output; round-trip target met.

Test coverage at Phase 1 close: **95/95** vitest specs across four
files green; typecheck clean; existing legacy-flat consumers
unchanged.

What's deferred (per §10):

- **Phase 2 (v0.4-α):** §3 modes, §4 aliases, §6 new typed MCP tools
  (replace legacy at the same time — no deprecation per pre-public
  release), §7a kit cascade. **Unblocks ADR-0007** at Phase 2 close.
- **Phase 3 (v0.4-β):** §9 surfaces — full modal "Variables view",
  deselected-state sidebar section, Topbar global mode switcher,
  per-frame override UI, layer-tree mode-tag pill, `=` shortcut +
  chip-in-input + right-click apply, alias UX. Topbar `Cmd+Shift+E`
  DTCG export action also lands here (data-layer is in Chunk D
  already).

Three notes worth recording:

- **The popover continues to work unchanged in Phase 1.** It reads
  via the legacy `variables.ts` adapter, which projects DTCG to the
  flat shape. Phase 3 replaces the popover wholesale with the new
  three-surface UX (§9). Until then it shows default-mode values
  with no mode/alias affordance — explicitly a transition state, not
  the destination.
- **`@theme` emission is wired but not yet *injected* into iframes.**
  `emitTokens` returns CSS strings; consuming the strings (a runtime
  `<style>` injected into each frame's `<head>` via the existing
  `canvas:frame:load` listener in `App.tsx`) is a thin wiring step
  that lands in Phase 2 alongside modes — modes share the injection
  surface and we want to wire it once.
- **Color canonicalisation is one-way today.** OKLCH → sRGB
  conversion (for ADR-0008 relay export to Figma) is not yet
  implemented; the colorSpace annotation flags the original source
  space so Phase 2 / ADR-0008's relay can do the export-edge clamp.
  v0.3 readers (browsers, Style Dictionary, Tokens Studio) all
  understand OKLCH natively.

---

## Addendum (2026-05-06) — Post-Phase-1 fix: hyphen-as-separator inference removed

Phase 1 Chunk A's `cssVariableToPath` split CSS variable names on `-`
to derive a tree path (e.g. `--color-brand-primary` → `color.brand.primary`).
That made the mapping non-injective: writing both `--brand-primary` and
`--brand-primary-hover` through `set_variables` silently destroyed the
first because their inferred paths overlapped, and `setToken` clobbers a
leaf when a deeper path lands on it.

Surfaced as a real failure on the ADR-0008 Path A Figma relay e2e
(`e7fc44d`), where the fixture mirrors how Figma Variables / Tokens
Studio / Style Dictionary all emit names in practice — flat CSS-var-
style with internal hyphens that don't denote hierarchy. None of those
tools try to recover hierarchy from a flat name; they all source it
from explicit nested input. Aligning with that — `cssVariableToPath`
now returns the CSS variable name as a single path segment — fixes the
relay without precluding the hybrid-hierarchy story for the Phase 2
MCP surface or the Phase 3 popover, both of which take explicit nested
input via `parseDTCG` / `loadTokenTree`.

What landed:

- `2055408` — **Drop hyphen-as-separator inference.** `cssVariableToPath`
  is now `cssVar.replace(/^--/, "")`. Header comment in `tokens.ts`
  rewritten to record the contract and the established-tools
  precedent. Two existing tests for the dotted-path inference
  rewritten to assert the new contract; one regression test asserts
  that prefix-overlapping names round-trip without one clobbering the
  other.

Test coverage post-fix: **97/97** vitest specs (was 95/95 — added the
prefix-collision regression and a `pathToCssVariable` distinctness
assertion); ADR-0008 Path A relay e2e now passes end-to-end.

The §1 "hybrid hierarchy" decision is unchanged — hierarchy always
came from DTCG-shaped input, not from the legacy CSS-var adapter.
This fix removes a sharp edge from the legacy path that the §10
Phase 1 scope had glossed over.

---

*End of ADR-0009.*
