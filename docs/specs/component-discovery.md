# Component discovery — Storybook → React components → design system

**Status:** Spec drafted 2026-05-24. **Explicitly v2+ work**, not blocking the v1 chat + repo + preview pivot. Captured here so the v1 architecture doesn't preclude it.

**Track:** B (repo-and-preview, deferred to v2+) · **Depends on:** [sandbox-preview.md](sandbox-preview.md) · **Blocks:** _nothing_ · **Feature branch:** `feat/component-discovery` (after `feat/sandbox-preview` ships and stabilizes)

**Why this exists:** Dessn.ai's headline feature is component autodiscovery — they read the user's repo, auto-render every React component with its props, and let designers compose with the user's real components. This is a different problem from route/screen rendering (which the [sandbox preview spec](sandbox-preview.md) covers) and a different problem from generic block libraries like shadcn/ui (which v0.3 covers). It's about lifting the user's *existing* code into the canvas as first-class design primitives.

## Goals

Three phases, each independently shippable:

1. **Storybook story import (Phase 1)** — auto-discover `.stories.tsx` / `.stories.jsx` files in the connected repo; expose each story as a draggable block in the Components panel; render the story's actual JSX (not just a screenshot).
2. **React component autodiscovery (Phase 2)** — parse the repo for exported React components; identify which are usable on the canvas; render each with default-from-PropTypes/TypeScript props; add to the Components panel.
3. **Design system extrapolation (Phase 3)** — analyze the discovered components for shared tokens (colors, spacing, typography, shadows); generate a full design-system definition (the existing v0.4 "Design system picker" feature consumes this).

## Outcomes

- A designer connects their existing Storybook-using repo → DesignJS's Components panel populates with their stories within seconds.
- The designer can compose new screens by dragging existing components, not just generic HTML primitives.
- For a repo without Storybook, autodiscovery still finds useful components (Card, Button, Modal, etc.) with sensible default props.
- A repo with consistent design tokens (even just Tailwind theme configuration) becomes a first-class DesignJS design system that the agent can reference: "Use the Card component with the brand-primary color."

## Why this is v2+ (not v1)

- The v1 strategic pivot (chat + repo + preview) is competitively urgent — Figma, Replit, Dessn are moving fast. Component discovery is a quality-of-experience boost; v1 must ship first.
- Phase 1 (Storybook) is the easiest entry point and aligns with the existing v0.3 "shadcn/ui blocks" roadmap feature — both populate the Components panel with real components. They could be unified in a single "Components panel sources" feature later.
- Phase 2 (React component autodiscovery) requires solving real engineering problems: dynamic component rendering, prop introspection, default-value inference, dead-component detection. Worth getting right rather than shipping fast.
- Phase 3 (design system extrapolation) is research-territory — Dessn does this, but the quality varies. DesignJS should ship Phases 1+2 first and let real-user repos inform Phase 3 heuristics.

## How competitors approach this (verified 2026-05-24)

- **Dessn.ai** does Phase 2 in production. Read-only repo access, cloud microVM compiles the repo, auto-renders every React component with its props. Designers semantically search through their components. Read-only by design — no write-back. Source: dessn.ai.
- **Paper.design** syncs design tokens between canvas and codebase via MCP — closer to Phase 3 but only for tokens, not components. Components in Paper are HTML/CSS the user defines on the canvas, not pulled from the repo.
- **Pencil.dev** doesn't do autodiscovery. Components in Pencil are either Pencil's built-in design system blocks (Lunaris, etc.) or user-defined `.pen` components.
- **Storybook itself** is the reference for Phase 1 — it indexes `.stories.*` files into a navigable component library with controls for props. DesignJS adopts the indexing pattern, just renders into the Components panel instead of Storybook's own UI.
- **Histoire, Ladle, react-cosmos** — Storybook alternatives, similar `.stories.*` discovery patterns. All Phase 1-compatible.

## Architecture (sketched, not finalized)

**Prerequisite — framework detection.** All three phases depend on knowing the connected repo's framework, styling system, and component library. The `get_project_context` MCP tool (defined in [repo-connection.md § MCP integration](repo-connection.md#mcp-integration-get_project_context--hello-handshake)) returns `{ framework, styling, componentLibrary, tailwindConfig }`. Phase 1 reads this to pick the right Storybook adapter (`@storybook/*` vs `@histoire/*` vs `@ladle/react` vs `react-cosmos`); Phase 2 uses it to scope discovery to the right component directories and pick the right AST parser; Phase 3 uses it to merge Tailwind theme tokens with extracted CSS variables. Discovery can't run before a repo is connected and `get_project_context` has succeeded.

### Phase 1: Storybook story import

```ts
// packages/app/src/components/discovery/storybook.ts
export async function discoverStorybookStories(repo: RepoHandle): Promise<DiscoveredStory[]> {
  const storyFiles = await repo.glob('**/*.{stories,story}.{tsx,jsx}', { ignore: ['node_modules/**'] })
  return Promise.all(storyFiles.map(parseStoryFile))
}

interface DiscoveredStory {
  id: string                    // e.g. "components/Button:Primary"
  title: string                 // "Components / Button"
  name: string                  // "Primary"
  filePath: string              // "src/components/Button.stories.tsx"
  componentImportPath: string   // "../Button"
  args: Record<string, unknown> // default args for the story
  render: () => ReactElement    // the story's render function
}
```

Rendering happens inside the sandbox preview iframe (Phase 1 requires the [sandbox preview](sandbox-preview.md) to be live — story rendering = small running React app per story). The Components panel shows a thumbnail captured from the rendered story; drag-and-drop adds an `<UserComponent .../>` reference to the canvas that the agent can later expand into JSX.

**Compatibility detection:** check `package.json` for `@storybook/*`, `@histoire/*`, `@ladle/react`, or `react-cosmos` dependencies. The discovery strategy varies per tool but the output shape (DiscoveredStory) is unified.

### Phase 2: React component autodiscovery

```ts
// packages/app/src/components/discovery/react-components.ts
export async function discoverReactComponents(repo: RepoHandle): Promise<DiscoveredComponent[]> {
  // 1. Find files in src/components/ (configurable paths)
  // 2. Parse with Babel AST + react-docgen-typescript or react-docgen
  // 3. Extract: component name, props with types, default values, JSDoc descriptions
  // 4. Filter out internal/utility components (heuristics: lowercase name, no JSX return, no exports)
  // 5. Render each with default props in the sandbox
}

interface DiscoveredComponent {
  name: string                            // "Card"
  filePath: string                        // "src/components/Card.tsx"
  exportName: string                      // "default" or "Card" or "{ Card }"
  props: Array<{
    name: string
    type: string                          // "string", "number", "ReactNode", etc.
    required: boolean
    defaultValue?: unknown
    description?: string                  // from JSDoc / TSDoc
  }>
  examples?: Array<{ args: object }>      // pulled from .stories.* if present
}
```

**Default-prop inference is the hard part.** Heuristics:

- Prop named `children`: pass placeholder text "Card content"
- Prop typed `string` named `title` / `heading` / `label`: pass realistic placeholder ("Welcome back")
- Prop typed `string` named `imageUrl` / `src` / `avatar`: pass a placeholder image URL (e.g., a colored block)
- Prop typed `boolean` named `disabled` / `loading`: pass `false`
- Prop typed `() => void`: pass a no-op function
- Prop typed `string` with no obvious name: pass `'Lorem ipsum'`
- TypeScript union types: pass the first option (`'primary' | 'secondary'` → `'primary'`)

Components that can't render with sensible defaults: show in the Components panel with a "Configure props..." badge; clicking opens a Traits-panel-style editor.

### Phase 3: Design system extrapolation

```ts
// packages/app/src/components/discovery/design-system.ts
export async function extrapolateDesignSystem(
  components: DiscoveredComponent[],
  repo: RepoHandle,
): Promise<DesignSystem> {
  // 1. Read tailwind.config.{ts,js,cjs} if present → extract theme tokens
  // 2. Read CSS / SCSS files for :root { --token: value; } declarations
  // 3. Cluster computed styles across discovered components → identify shared values
  //    - Colors used in >3 components → likely a brand color
  //    - Spacing values repeating across margins/paddings → likely a spacing scale
  //    - Typography clusters → likely font sizes / weights / families
  // 4. Generate a DesignSystem.designjs.json with extracted tokens
}
```

Phase 3 deliverable: a synthesized `designjs-design-system.json` file. This is the same format defined by the v0.4 "Design system picker" feature in [opencanvas-roadmap.md](opencanvas-roadmap.md) — block definitions (HTML templates), starter template (component layout), variables (design tokens), metadata (name, version, author, preview image). The user can edit it (rename tokens, add semantic aliases), and the agent gets a clean palette to reference when generating new components. Community can publish design system packages to npm in the same format (e.g., `@designjs/design-system-material`); `npx designjs add-design-system @designjs/design-system-material` installs them. The v0.4 picker UI loads both extrapolated and community-published systems through this single format.

## User stories (sketched — refine when prioritized)

**Story 1 — Storybook user:**
*As a designer connecting a repo with Storybook, I want my existing stories to show up as draggable blocks in DesignJS's Components panel within seconds, so I can compose new screens from the components my team already built.*

**Story 2 — repo without Storybook:**
*As a designer connecting a Vite + Tailwind repo with no Storybook, I want DesignJS to discover my React components automatically and offer them as draggable blocks with sensible defaults — so I don't have to write stories first.*

**Story 3 — generated design system:**
*As a designer working with a 6-month-old codebase, I want DesignJS to analyze my existing components and generate a design system JSON I can review and refine — turning implicit conventions into explicit tokens.*

## Open questions / future work

1. **Rendering performance:** discovering + rendering 200 components in a sandbox is expensive. Lazy-render on Components-panel scroll? Pre-render and cache thumbnails?
2. **Source-of-truth conflicts:** if the user edits a component via DesignJS, does the change go to the source file (the Phase 2 + Onlook OID pattern) or stay in the canvas (Phase 1 reference-only)? Probably Phase 1 = reference, Phase 2 = optional write-back via a future "edit source" mode.
3. **Non-React frameworks:** Phase 1 (Storybook) supports Vue / Svelte / Angular natively via Storybook. Phase 2 needs per-framework parsers — defer until React version is solid.
4. **Versioning:** if a discovered component's API changes (prop renamed), existing canvas usages break. Defer migration tooling until users hit this.
5. **Library components (node_modules):** discover shadcn/ui, Radix, Chakra, MUI from `node_modules`? Probably skip — these are well-known and v0.3 ships hand-curated shadcn blocks anyway.
6. **Composition rules:** Card + Button compose well; Button + Modal don't. Can we learn composition affordances from existing usages in the codebase? Far future.
7. **Component search:** semantic search across discovered components (Dessn's UX). Embedding the component description + props + render → vector store → search by intent ("find a header with a search bar").

## Cross-references

- [Sandbox preview spec](sandbox-preview.md) — Phase 1 (Storybook) and Phase 2 (component rendering) depend on the sandbox being live for story / component rendering
- [Repo connection spec](repo-connection.md) — discovery operates on the connected repo
- [Projects spec](projects.md) — discovered components could be shared across projects in the same workspace
- [AI chat spec](ai-chat.md) — the agent can reference discovered components in its prompts ("use the Card component from src/components/")
- [opencanvas-roadmap.md](opencanvas-roadmap.md) §§ "shadcn/ui blocks" (v0.3) and "Design system picker" (v0.4) — related Components-panel work that should unify with this spec
