# Contributing to DesignJS

Thanks for your interest in contributing. This document covers local setup, coding conventions, and the PR process.

## Prerequisites

- **Node.js 20+** (LTS recommended)
- **pnpm 9+** (`corepack enable` then `corepack install -g pnpm@9` if you don't have it)
- A modern browser (Chrome, Firefox, Safari) for the canvas

## Local setup

```bash
git clone https://github.com/rubychilds/DesignJS.git
cd DesignJS
pnpm install
pnpm dev
```

`pnpm dev` rebuilds the `@designjs/bridge` package (so fresh protocol types land in `dist/`) then boots the Vite dev server for the canvas. The WebSocket bridge is embedded in the Vite process and listens on `127.0.0.1:29170`.

To run the MCP server standalone (useful for debugging agent connections):

```bash
pnpm mcp
```

## Workspace layout

```
designjs/
├── packages/
│   ├── app/          # Vite + React SPA hosting the GrapesJS canvas
│   ├── mcp-server/   # stdio MCP server process
│   └── bridge/       # shared WS protocol + Zod tool schemas
├── scripts/          # smoke tests and helpers
└── ...
```

When adding a new MCP tool:

1. Define input/output Zod schemas in [`packages/bridge/src/tools.ts`](./packages/bridge/src/tools.ts) and add it to `TOOL_SCHEMAS` + `TOOL_DESCRIPTIONS`.
2. Implement the handler in [`packages/app/src/bridge/handlers.ts`](./packages/app/src/bridge/handlers.ts) — it receives validated params and returns a result that matches the output schema.
3. Rebuild the bridge package: `pnpm --filter @designjs/bridge build` (or let `pnpm dev` do it).
4. The MCP server auto-registers it via `TOOL_SCHEMAS`.

## Running checks

```bash
pnpm typecheck              # all packages
pnpm lint                   # ESLint (flat config: typescript-eslint, react-hooks, jsx-a11y)
pnpm format:check           # Prettier check (no writes)
pnpm format                 # Prettier write (formats files in place)
pnpm --filter @designjs/bridge build
pnpm smoke:bridge           # WebSocket round-trip (no browser)
node scripts/smoke-mcp.mjs  # MCP stdio handshake + tools/list
node scripts/check-doc-drift.mjs  # README MCP tool count + e2e count drift
node scripts/check-changelog.mjs  # CHANGELOG entry for each published-package version
pnpm test:e2e               # Playwright E2E (chromium); cross-browser runs nightly
pnpm test:e2e:ui            # Same, with the Playwright UI runner
```

The CI pipeline runs the same checks on every push and PR. Before running Playwright for the first time, install the browser: `pnpm exec playwright install chromium`.

### Pre-commit hooks (Lefthook)

Lefthook runs in parallel on every commit:

- `eslint --max-warnings 0` on staged `*.{ts,tsx,js,mjs,cjs}` files
- `prettier --check` on staged `*.{ts,tsx,js,mjs,cjs,json,md,yml,yaml}` files

Skip hooks for WIP commits with `git commit --no-verify` (alias `-n`). CI still gates on lint + format-check, so push-and-fix is fine — just don't merge unclean.

If hooks didn't install (e.g., the workspace was cloned without `pnpm install` first), run `pnpm exec lefthook install` once.

### E2E test layout

End-to-end tests live in [`e2e/`](./e2e) and run against a real browser booting `pnpm dev`. They exercise the app through `window.__designjs` (an editor handle exposed at runtime in dev) to keep interactions deterministic; iframe drag-drop is avoided because it's fragile. Each story has its own spec — e.g. `story-1.4-block-palette.spec.ts`.

## Code conventions

- **TypeScript strict mode** — no implicit any, `noUncheckedIndexedAccess` enabled.
- **ESM only** — all packages are `"type": "module"`. Import with explicit `.js` extensions in relative paths.
- **Zod for all wire formats** — both the WS protocol and MCP tool I/O are validated at the boundary. Never skip parsing on incoming messages.
- **Small, orthogonal packages** — the bridge package is purely types and has no side effects. The app never imports from `mcp-server` and vice versa; they communicate only through the WS protocol.
- **Tool handlers are pure** (relative to the GrapesJS editor state) — they take params, call GrapesJS APIs, return a value. Don't stash state between calls.

## Editor-chrome UI conventions (ADR-0001)

The editor chrome — everything outside the GrapesJS iframe — follows [ADR-0001](./docs/adr/0001-frontend-ui-stack.md). Summary:

- **Tailwind v4 + shadcn/ui + Radix**: style with Tailwind utilities, compose from `components/ui/`. shadcn components are copied into the repo, not imported as a package — edit them freely.
- **Tokens in [`styles/tokens.css`](./packages/app/src/styles/tokens.css)**, mirrored into Tailwind's `@theme inline` block in [`globals.css`](./packages/app/src/styles/globals.css). `bg-background`, `text-muted-foreground`, `border-border`, etc. resolve to tokens — prefer those over raw hex.
- **Two themes, light default.** Token set is duplicated for `[data-theme="dark"]`. Never hardcode a color; use a token. If you need a new token, add it in both themes.
- **Type scale capped at 14px in the chrome.** Use `text-xs` (11) / `text-sm` (12) / `text-base` (13) / `text-lg` (14). Anything larger belongs to modals, toasts, or onboarding.
- **Icons via `lucide-react`**: 16px default (`size-4`), 14px in dense controls (`size-3.5`). Stroke weight 1.5 (Lucide default). Avoid filled icons unless conveying state.
- **Tests anchor on `data-testid`**, not CSS classes. CSS refactors shouldn't break E2E.
- **When reaching for a new library**: first check [ADR-0001](./docs/adr/0001-frontend-ui-stack.md) § "Specialized design-tool pieces". Don't add a second component library — that's an ADR change.

### Adding a shadcn primitive

shadcn components are copied from [ui.shadcn.com](https://ui.shadcn.com) into `packages/app/src/components/ui/`. Adapt the classes to our density (h-6/7/8, text-xs/sm/base) and use `variant: "ghost"` as the default. Import via relative paths, not a package alias.

### Design-tool composites (`components/editor/` convention)

Our composites — `LayerTree`, `BlockPalette`, `StylePanel`, `NumberInput`, `ColorField`, `CommandPalette` — live in `components/` alongside their panel wrappers. They're where the design-tool feel lives. Keep them small and composable; a property row shouldn't know which sector it's rendering in.

## Pull request process

1. Fork the repo or create a branch from `main`.
2. Make your change with a focused commit history.
3. Run `pnpm typecheck` and both smoke tests — all must pass.
4. Open a PR describing **what** changed and **why**. Link any relevant PRD story.
5. CI must be green before merge.

## Reporting bugs / proposing features

Open a GitHub issue. For MCP tool requests, include:

- The agent workflow you're trying to unlock
- Proposed tool name, input, output
- Why an existing tool can't be combined to cover it

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
