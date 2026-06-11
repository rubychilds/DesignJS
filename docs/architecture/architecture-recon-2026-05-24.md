# Architecture review — reconnaissance (2026-05-24)

> **Phase 1 of the 2026-05-24 staff-level architecture review.** Captures the as-built state as the baseline for Phase 2 deep dives. Read-only snapshot — no recommendations yet.
>
> Reviewer: solo + Claude. Scope: `main` + the two in-flight feature branches (`feat/ai-chat-panel`, `feat/projects-gallery`). Deliverable destination: this directory (`docs/architecture/`). See `docs/adr/README.md` for ADR conventions kept intentionally separate.

## 1. Repository topology

```
DesignJS/
├── packages/                    pnpm workspace (`packages/*` only)
│   ├── app/                    Vite + React SPA — private
│   ├── bridge/                 Zod schemas + WS protocol — published
│   ├── chrome-extension/       MV3 capture extension — private
│   ├── cli/                    `designjs init` — private (deferred)
│   ├── create-designjs/        `npm create designjs` scaffolder — published
│   └── mcp-server/             stdio MCP binary — published
│
├── docs/                       Internal docs (this dir + adr/)
│   ├── adr/                    12 ADRs (0001–0012, 0010 missing)
│   ├── architecture/           ← this review's destination
│   ├── capture-fidelity-baseline.md
│   ├── epic-8-followups.md
│   ├── font-preservation-plan.md
│   └── qa-followups.md
│
├── designjs-docs/              Mintlify docs site (separate from internal docs)
├── e2e/                        37 Playwright specs (flat, no subdirs)
├── scripts/                    4 smokes + 5 capture-related .mjs scripts
├── .github/workflows/          One file: ci.yml
│
└── (vendored reference dirs, out-of-scope per SECURITY.md)
   onlook/  penpot/  flux/  Blipshot/  SingleFile/  chrome-devtools-mcp/
   design.md/  screenshot-capture/
```

`design.md` is **a directory** (not a file) — a vendored copy of an Anthropic skills/agent reference repo (turbo monorepo with `packages/`, `examples/`, `skills-lock.json`). Confusing root-level name, treated as reference material per SECURITY.md's vendored-projects exception.

## 2. Package matrix

| Package | npm name | Visibility | Version | Bin | Direct deps |
|---|---|---|---|---|---|
| `packages/app` | `@designjs/app` | private | `0.1.0-dev` | — | 28 runtime deps incl. GrapesJS, React, Radix UI primitives, cmdk, react-arborist, zod, html-to-image |
| `packages/bridge` | `@designjs/bridge` | **published** | `0.1.0` | — | `zod` only |
| `packages/chrome-extension` | `@designjs/chrome-extension` | private | `0.1.0-dev` | — | 5 deps (React, tailwind-merge, CVA, clsx) |
| `packages/cli` | `@designjs/cli` | private (deferred) | `0.1.0-dev` | `designjs` | 0 runtime deps |
| `packages/create-designjs` | `create-designjs` | **published** | `0.1.0` | `create-designjs` | 0 runtime deps |
| `packages/mcp-server` | `@designjs/mcp-server` | **published** | `0.1.0` | `designjs-mcp` | `@modelcontextprotocol/sdk`, `@designjs/bridge`, `ws`, `zod` |

Three packages published to npm at `0.1.0`. All v0.1 lockstepped on the same version per `RELEASING.md`. `@designjs/app` is the largest consumer and never published — runs locally from `pnpm dev`.

**Public API surfaces:**
- `@designjs/bridge` — single root entrypoint with `exports` field, ESM-only, ships `dist/index.{js,d.ts}` with explicit types
- `@designjs/mcp-server` — `main` + `bin` (no `exports` field — older shape; works because consumers only spawn the bin)
- `create-designjs` — `bin`-only (`main` is unused for a `create-*` scaffolder)

## 3. TypeScript + tooling

**`tsconfig.base.json` (root):**
```jsonc
{
  "target": "ES2022", "lib": ["ES2022", "DOM", "DOM.Iterable"],
  "module": "ESNext", "moduleResolution": "Bundler",
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "noImplicitOverride": true,
  "isolatedModules": true,
  "esModuleInterop": true,
  "skipLibCheck": true,
  "forceConsistentCasingInFileNames": true
}
```

**Strong baseline.** Strict + `noUncheckedIndexedAccess` + `isolatedModules` + Bundler resolution are the modern recommended settings. TypeScript pinned at `^6.0.3` (very recent). Per-package `tsconfig.json` files extend this (deep-dive will verify).

**Package manager:** pnpm 9.12.0 (pinned via `packageManager` field). Node 20+ engines. Single workspace glob `packages/*` — flat, no nested workspaces.

**Build system:** Each package's `build` script is its own (mix of `tsc` for libs, Vite for the app, esbuild for extension likely). No turbo / nx. Root `pnpm dev` does `pnpm --filter @designjs/bridge build && pnpm --filter @designjs/app dev` — bridge has to rebuild before app boots so types resolve.

**Linting/formatting:** Root `pnpm lint` script delegates to packages (`pnpm -r lint`). No root-level ESLint or Prettier config visible. **No Husky / Lefthook / pre-commit hooks installed.** Deep dive (CI/DX) will confirm per-package lint setup.

## 4. CI shape

Single workflow file: `.github/workflows/ci.yml`. Two jobs:

| Job | Steps | Timeout | Cache |
|---|---|---|---|
| `verify` | corepack + setup-node + install + bridge build + typecheck (all) + unit tests (if-present) + build (all minus bridge) + bridge round-trip smoke + MCP stdio smoke + init smoke | 10 min | pnpm |
| `e2e` | corepack + setup-node + install + bridge build + build (all minus bridge) + Playwright install (chromium only) + `pnpm test:e2e` + upload report on failure | 15 min | pnpm |

Triggers: push to `main` and PRs to `main`. Concurrency-cancelled per ref.

**Gaps observable from CI:**
- ❌ No lint job at all (`pnpm lint` doesn't run in CI)
- ❌ No release/publish workflow (Changesets gap → all releases manual per `RELEASING.md`)
- ❌ No SAST (CodeQL, Semgrep) or dep-vulnerability scan
- ❌ Dependabot enabled for Actions only (recent PR history shows checkout v6 / setup-node v6 / upload-artifact v7) — **no Dependabot for npm packages**
- ❌ No coverage reporting
- ❌ No matrix — single Node 20, single browser (chromium). No Firefox/WebKit even though README lists them as supported
- ❌ No Chrome extension build verification in CI (`@designjs/chrome-extension` builds but the artifact isn't smoke-tested)
- ✅ Bridge round-trip smoke (`scripts/smoke-bridge.mjs`) backgrounds `pnpm dev`, polls port 29170, runs the smoke, kills the process group — robust local-bridge test

## 5. Testing surface

**Counts:**
- 37 `.spec.ts` files in `e2e/` (flat, no subdirs)
- 156 test cases per `grep -c "^\s*test\("` (matches the `156 passed` claim in earlier status notes — README's "160+ across 28 specs" is stale)
- Smoke scripts: 4 user-facing (`smoke-bridge.mjs`, `smoke-mcp.mjs`, `smoke-init.mjs`, `smoke-create.mjs`) + 5 capture-related (`capture-compare.mjs`, `capture-diff.mjs`, `dump-iframe-full.mjs`, `probe-iframe.mjs`, `probe-lazy-mount.mjs`)
- Per-package: `pnpm -r --if-present test` — at least bridge has `__tests__/` (seen in earlier ls)

**Test conventions (per CONTRIBUTING.md):**
- E2E uses `window.__designjs` runtime handle (deterministic API access, not DOM scraping)
- iframe drag-drop avoided (fragile)
- `data-testid` selectors only (CSS-class-resilient)
- Per-story spec convention (e.g. `story-1.4-block-palette.spec.ts`)

**Not observable from recon (deep-dive material):**
- Test pyramid shape (unit-vs-integration-vs-e2e ratio)
- Coverage of the 22 MCP tools
- Whether the 1 flaky from alpha.1 is still flaky
- Visual regression status (mentioned for v0.8 in roadmap)
- Total e2e runtime

## 6. Documentation surfaces

Three distinct doc surfaces:

| Surface | Lives in | Audience | Status |
|---|---|---|---|
| Root markdown | `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `RELEASING.md`, `CHANGELOG.md` | New contributor / maintainer | Solid baseline; README has some stale counts ("160+ tests across 28 specs" — actual 156/37) |
| Internal docs | `docs/` | Internal — ADRs + epic followups + plans | Well-structured: 12 ADRs in `docs/adr/`, ADR README has Index column linking to load-bearing commits |
| User docs site | `designjs-docs/` (Mintlify) | End users — quickstart, integrations, MCP tools | **Stale links** — `llms.txt` still references `opencanvas.mintlify.app` not `designjs.mintlify.app` (rebrand not propagated). Lists ~20 MCP tools but missing post-alpha additions (`add_css_rules`, `add_classes`, `remove_classes`, `set_text`, `fit_artboard`, `select`, `deselect`) |

**`AGENTS.md` exists in `designjs-docs/`** — interesting; deep dive on docs will assess.

## 7. ADR inventory

12 ADRs in `docs/adr/` (0001–0012, with 0010 missing from index — likely a reserved slot or deleted draft):

| # | Title | Status |
|---|---|---|
| 0001 | Frontend UI stack for the editor shell | Accepted |
| 0002 | Inspector information architecture | Superseded by 0003 |
| 0003 | Panel IA — Penpot as the reference shape | Accepted (one item superseded by 0004) |
| 0004 | Frames as top-level nodes inside the layer tree | Accepted |
| 0005 | HTML primitives ↔ design-tool shape concepts | Accepted |
| 0006 | Sizing modes, auto-layout taxonomy, canvas model, Raw CSS exit | Accepted |
| 0007 | Block data model, built-in UI kits, user-extensibility | **Proposed** (no implementation) |
| 0008 | Figma → DesignJS import strategy | Path A Accepted; Path B deferred |
| 0009 | Design tokens — data model, modes, CSS emission | Phase 1 Accepted; Phases 2+3 Proposed |
| 0010 | — | **MISSING** (reserved or deleted) |
| 0011 | Browser extension — transport + style serialization | Accepted + 3 addenda |
| 0012 | Capture fidelity evolution — backplate + CDP + tool split | §1 Accepted; §§2–4 Proposed |

**Strong ADR hygiene** — the `docs/adr/README.md` documents the convention explicitly: addenda preserve history, supersession is bidirectionally linked, the Index column lists load-bearing implementation commits. This is well above average for a solo project.

## 8. Recent activity signal (last 60 commits)

```
15  chrome-extension     ← active feature work
11  docs
 7  canvas
 5  chore
 4  bridge
 3  app
 2  test
 2  scripts
 2  inspector
 1  oss / layers-panel / ci / artboards / canvas+inspector
 4  dependabot / merge commits
```

143 commits since the alpha.1 baseline (`5c59a82`, 2026-04-22). Chrome extension is unambiguously the active surface. Dependabot is enabled for GitHub Actions (3 recent merged PRs) but not for npm dependencies.

## 9. Branch state (snapshot 2026-05-24)

```
main                          (current) ← docs: check off Tier-1 D1, log today's commit chain
f1-google-fonts-fallback              WIP chrome-extension(capture): F1 Google Fonts name fallback
feat/ai-chat-panel                    app(chat): scaffold sidebar Agent panel + provider abstraction  (Track A)
feat/projects-gallery                 app(projects): scaffold multi-project gallery + quick-switcher  (Track B)
```

The two `feat/*` branches were just scaffolded as part of the 2026-05-24 strategic pivot (chat-and-agent + repo-and-preview tracks per the planning docs in the user's Obsidian notes). Both contain TODO-only file scaffolding — no runtime deps added, no logic. `f1-google-fonts-fallback` is a WIP under the chrome-extension active push.

## 10. Open observations (deferred to Phase 2 deep dives)

The recon turned up signals that the deep dives should investigate. **No recommendations here** — just things to look at.

| # | Observation | Deep dive |
|---|---|---|
| O1 | TypeScript strict + `noUncheckedIndexedAccess` is excellent; per-package tsconfig drift not yet inspected | 2.1 Codebase |
| O2 | No central `eslint.config.*` or `prettier.config.*` visible at root; lint happens per-package | 2.1 Codebase, 2.3 CI/DX |
| O3 | `pnpm dev` requires `@designjs/bridge` rebuild before app boots — fragile in CI if cache misses, but smoke-tested | 2.1 Codebase, 2.3 CI/DX |
| O4 | E2E uses `window.__designjs` runtime handle — implies the canvas exposes editor internals globally for tests. Security implication if also exposed in prod build. | 2.2 Testing, 2.4 Security |
| O5 | CI has no lint job. CONTRIBUTING references conventions that aren't gated by CI. | 2.3 CI/DX |
| O6 | Manual release process documented end-to-end in `RELEASING.md`; Changesets prerequisites listed (independent vs shared versioning, NPM_TOKEN, .changeset ignore list) | 2.5 Deployment |
| O7 | Dependabot active for Actions, **not for npm packages** — supply-chain surface unscanned | 2.4 Security |
| O8 | Bridge binds `127.0.0.1:29170` by design (per SECURITY.md), no auth/origin check on the WebSocket | 2.4 Security |
| O9 | No CodeQL / Semgrep / SAST in CI | 2.4 Security |
| O10 | Multi-frame regressions in alpha.1 stemmed from GrapesJS v2 single-frame assumptions throughout the canvas codebase — the coupling deserves a closer look before SWARM (concurrent agents per artboard) lands | 2.1 Codebase |
| O11 | Mintlify docs site has stale rebrand links (`opencanvas.mintlify.app`) and missing MCP tool entries (`add_css_rules` and 6 others) | 2.7 Docs |
| O12 | ADR-0007 (user-extensibility, block model) is *Proposed* and never implemented — relevant to the v2 component-discovery spec the planning docs reference | 2.7 Docs (or skipped if not load-bearing) |
| O13 | ADR-0010 missing from the index — investigate whether reserved, deleted, or simply skipped | 2.7 Docs |
| O14 | `design.md` is a directory containing what looks like Anthropic's skills/agent reference monorepo. Confusing root-level naming. SECURITY.md flags vendored projects as out-of-scope but doesn't mention `design.md`. | 2.4 Security, 2.7 Docs |
| O15 | No observability stack visible — no Sentry, no PostHog client in the app's deps. PostHog is connected to the user's MCP session (per session context) but not wired into the app itself. | 2.6 Observability |
| O16 | Playwright runs only chromium — Firefox/WebKit support claimed in README but unverified by CI | 2.2 Testing |
| O17 | Chrome extension build isn't smoke-tested in CI; load-unpacked verification is manual | 2.2 Testing, 2.3 CI/DX |
| O18 | No `.editorconfig` / `.nvmrc` / per-package README in some packages | 2.1 Codebase |
| O19 | `@modelcontextprotocol/sdk` is a hard dep on `@designjs/mcp-server`; semver-pinning policy not yet inspected | 2.4 Security |
| O20 | Vendored reference dirs (`onlook/`, `penpot/`, `flux/`, `Blipshot/`, `SingleFile/`, `chrome-devtools-mcp/`, `screenshot-capture/`, `design.md/`) live at the repo root and inflate the working tree. SECURITY.md acknowledges them. Worth examining the .gitignore + git-LFS strategy. | 2.1 Codebase |

## 11. Scope confirmation

**In scope for the review** (per the 2026-05-24 scoping decision):
- All six packages under `packages/`
- All CI workflows under `.github/workflows/`
- All ADRs and internal docs under `docs/`
- The Mintlify docs surface (`designjs-docs/`) for the docs deep dive
- The two in-flight feature branches `feat/ai-chat-panel` + `feat/projects-gallery` (file-layout check only — they're empty TODO scaffolds)
- The release process and supply-chain posture
- Forward-looking architecture implications of the six DesignJS-Notes specs (chat / repo / preview / projects / swarm / component-discovery) — these aren't in the code repo yet but the architecture they propose is in scope per "Main + the in-flight scaffolding on feature branches" scoping answer

**Out of scope** (explicit):
- Vendored reference dirs at the repo root (`onlook/`, `penpot/`, `flux/`, `Blipshot/`, `SingleFile/`, `chrome-devtools-mcp/`, `screenshot-capture/`, `design.md/`)
- Anything in `node_modules/` or generated `dist/` directories
- Vulnerabilities requiring local machine compromise (already out of scope per SECURITY.md)
- WIP branch `f1-google-fonts-fallback` (active development by user; will be reviewed in normal PR flow)

## 12. Phase 2 reading list (per deep dive)

Each deep dive starts with the files below; each produces its own doc in `docs/architecture/`.

| Phase | Doc | Required reads beyond this recon |
|---|---|---|
| 2.1 Codebase | `architecture-codebase.md` | Per-package `package.json` + `tsconfig.json`, `packages/app/src/App.tsx` + `main.tsx` + a representative inspector component, `packages/bridge/src/index.ts` + `tools.ts`, `packages/mcp-server/src/index.ts`, ADR-0001 / 0003 / 0006 in full |
| 2.2 Testing | `architecture-testing.md` | `playwright.config.ts`, 3–4 representative e2e specs, `packages/bridge/src/__tests__/*`, all smoke scripts in full |
| 2.3 CI / DX | `architecture-ci-dx.md` | Full `ci.yml` re-read (done), per-package lint configs, `.github/dependabot.yml` if exists, `pnpm-lock.yaml` size + age |
| 2.4 Security | `architecture-security.md` | WS bridge auth in `packages/app/src/bridge/`, `@modelcontextprotocol/sdk` version + advisories, Chrome extension `manifest.json` + `host_permissions`, OAuth-PKCE plan from the in-flight spec |
| 2.5 Deployment | `architecture-deployment.md` | `RELEASING.md` re-read (done), `scripts/smoke-create.mjs`, npm registry snapshot for the three packages, `designjs-docs/docs.json` (Mintlify config) |
| 2.6 Observability | `architecture-observability.md` | Logging usage in `packages/bridge/src/` + `packages/app/src/bridge/`, MCP tool error paths, PostHog config in the planning-docs spec |
| 2.7 Docs | `architecture-docs.md` | All 12 ADRs (skim), `designjs-docs/` MDX coverage matrix vs MCP tool surface, ADR-0010 gap investigation |

## 13. Calibration notes

Five facts I'd want to double-check before relying on them in the deep dives, so they're surfaced now:

1. **156 tests / 37 specs** — recon's `grep -c` is approximate. Playwright's own count (`pnpm test:e2e --list`) is authoritative; deep dive 2.2 should use it.
2. **143 commits since alpha.1** — counted via `git log 5c59a82..HEAD | wc -l`. Includes merge commits; the "feature" commit count is lower.
3. **Published versions are 0.1.0** — per local `package.json`. npm registry state may have drifted; deep dive 2.5 verifies with `npm view`.
4. **22 MCP tools** — per `packages/bridge/src/tools.ts` `TOOL_SCHEMAS` enumeration earlier. README claims 21; `designjs-docs/` lists ~20. Authoritative count comes from `tools.ts`.
5. **GrapesJS coupling shape** — alpha.1 multi-frame regressions point at known seams (`Canvas.getDocument`, `Canvas.getFrameEl`, `component.getEl`, `component.view.el`). Deep dive 2.1 should enumerate every site where the app relies on these to bound the SWARM-readiness question.

---

**Next:** Phase 2.1 — Codebase deep dive.
