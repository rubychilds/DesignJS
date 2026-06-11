# Architecture review — synthesis (2026-05-24)

> Master synthesis of the staff-level architectural review conducted 2026-05-24. Read-only findings, no code changes. Companion to the eight deep-dive docs in this directory (see [`README.md`](./README.md) for the full index).
>
> Reviewer perspective: solo dev + Claude. Scope per the 2026-05-24 scoping decision: `main` + the two in-flight feature branches (`feat/ai-chat-panel`, `feat/projects-gallery`) + forward-looking v0.2/v0.3 specs. **100 findings** numbered F.01 through F.100 across seven deep dives.

## Executive summary

**Overall posture: above average for a v0.1 solo project.** The fundamentals are solid — strict TypeScript, well-designed bridge protocol, exemplary ADR hygiene, thoughtful Dependabot configuration, agent-friendly error messages, Chrome extension manifest that's tighter than most production extensions. The work is honest, the documentation captures *why* things are the way they are, and the codebase is internally consistent.

**Three findings stand out as needing attention before v0.2 ships:**

1. **Bridge WebSocket server has no authentication or origin check.** Any localhost process — including a malicious browser extension running in the user's Chrome — can impersonate the canvas, the MCP server, or the browser extension and either control the user's canvas or block legitimate clients. Defensible at v0.1 (low-value assets, localhost-only) but becomes high-severity the moment v0.2 lands API keys and OAuth tokens in `~/.designjs/secrets.json`. **F.51** in [`architecture-security.md`](./architecture-security.md).

2. **No ESLint, no Prettier, no pre-commit hooks anywhere.** Six of six packages have `lint=false`. Root `pnpm lint` is a no-op. TypeScript strict catches type errors; ESLint catches the rest (React hook rules, floating promises, accessibility, import cycles). Single biggest DX win available in the entire review — a few hours of setup, then CI gates a broad class of bugs forever. **F.41 + F.42 + F.43** in [`architecture-ci-dx.md`](./architecture-ci-dx.md).

3. **`window.__designjs` is unconditionally exposed in production builds.** E2E tests rely on it (per CONTRIBUTING.md), but it's not gated by `import.meta.env.DEV`. Any JS on the canvas page can drive the editor — including third-party scripts injected by other browser extensions. Compounds with finding #1 above. One-line fix. **F.09** in [`architecture-codebase.md`](./architecture-codebase.md).

**Three findings stood out as genuinely positive** and worth protecting as the project grows:

- **ADR hygiene is top-quartile.** 12 ADRs with explicit convention (addenda over rewrites, supersession bidirectionally linked, implementation commits in the Index column). Most solo projects don't get this far. F.89 in [`architecture-docs.md`](./architecture-docs.md).
- **The bridge protocol architecture is the right substrate for v0.2/v0.3.** Chat panel, repo connection, SWARM — all fit the existing `BridgeRole`-tagged dispatcher cleanly. No refactor required to land them. F.X in [`architecture-codebase.md`](./architecture-codebase.md) §4.
- **Dependabot configuration is thoughtfully grouped** (dev-deps minor+patch, prod-deps patch only, grapesjs explicitly ignored with a comment-captured rationale). Most projects don't get this nuance right. F.25 correction in [`architecture-ci-dx.md`](./architecture-ci-dx.md).

The recon doc found three things that contradicted its initial impression and got corrected over the review — Dependabot IS configured for npm packages (recon claimed Actions-only); the per-package script surface IS more varied than recon implied; and the chrome-extension manifest is exemplary, not just adequate. These corrections live in the relevant deep dives.

## Top 10 recommendations

Ranked by leverage × urgency. Detailed rationale in the deep dives.

| Rank | Recommendation | Finding | Effort | Why now |
|---|---|---|---|---|
| 1 | **Install ESLint + Prettier + Lefthook** | F.41 + F.42 + F.43 | ~half day | Single biggest DX improvement. Gates a class of bugs (React hook rules, floating promises, a11y) that TS doesn't catch. Lands before v0.2 chat-panel code starts pouring in. |
| 2 | **Gate `window.__designjs` behind `import.meta.env.DEV`** | F.09 | ~5 min | One-line security improvement. E2E tests still work under `pnpm dev`. Production exposure closes immediately. |
| 3 | **Add WebSocket bridge token authentication** | F.51 + F.07 | ~half day | Closes the biggest single security finding. Coordinate with protocol versioning (F.07) in one bridge release. Must land before any API-key-handling code merges. |
| 4 | **Self-update `smoke-mcp.mjs` from `TOOL_SCHEMAS`** | F.16 | ~10 min | Closes a class of doc-drift (asserts subset of 9 of 22 tools today; would silently miss future tools dropping out of registration). |
| 5 | **Add React error boundary at App root** | F.82 | ~1 hour | Prevents a single component crash from killing the canvas. Users on hours of unsaved work get a recoverable error instead of a blank screen. |
| 6 | **Add CodeQL + `pnpm audit` to CI** | F.46 + F.47 | ~30 min | Security baseline. CodeQL is free for public repos. Catches source-level vulnerabilities Dependabot doesn't. |
| 7 | **Migrate the 6 v0.2/v0.3 specs from Obsidian into `docs/specs/`** | F.99 | ~10 min | The scaffolded feature branches' header comments reference `DesignJS-Notes/<spec>.md` paths that don't exist for any contributor but the user. Makes the architecture's forward-looking thinking visible. |
| 8 | **Unit-test `packages/app/src/bridge/handlers.ts`** | F.18 | ~1-2 days | 525 LOC, largest single file in the canvas package, GrapesJS's heaviest coupling site. Currently only covered via E2E. A mock-editor harness (already proven in `artboards.test.ts`) closes this. |
| 9 | **Doc-drift checker script + MCP tool docs generation** | F.98 + F.94 + F.95 Option C | ~half day | Closes the entire doc-drift class (tool count, missing tool pages, stale README claims) by deriving facts from `TOOL_SCHEMAS` and generating Mintlify MDX. |
| 10 | **`window.__designjs` revised + bridge token + capability scoping shipped together as a "v0.2 security gate"** | F.09 + F.51 + F.52 + F.54 | ~1-2 days bundled | The chat panel will introduce capability differentiation (Build vs Ask modes); without bridge-side enforcement, the client can lie about its mode. Bundle the work. |

## Findings by tier

The four-tier rollup. Tier-1 + Tier-2 totals are the actionable inventory; Tier-3/4 are the watch-and-strategic items.

### Tier 1 — fix-this-week (35 findings)

Small, high-leverage, low-risk changes. Each fixable in under a day, often in under an hour. Bundled into ~4-6 PRs they close most of the immediate hygiene gaps.

**Codebase** ([`architecture-codebase.md`](./architecture-codebase.md))
- F.04 — `create-designjs/tsconfig.json` drops `noUncheckedIndexedAccess` (1 line)
- F.09 — Gate `window.__designjs` behind `import.meta.env.DEV` (1 line, security)

**Testing** ([`architecture-testing.md`](./architecture-testing.md))
- F.16 — Self-updating `smoke-mcp.mjs` (`Object.keys(TOOL_SCHEMAS)`)
- F.17 — Bridge schema tests for `add_classes`/`remove_classes`/`set_text`/`select`/`deselect`
- F.21 — Playwright JSON reporter + retry-stat script

**CI/DX** ([`architecture-ci-dx.md`](./architecture-ci-dx.md))
- F.41 + F.42 + F.43 — **ESLint + Prettier + Lefthook bundle**
- F.36 — PR template CHANGELOG prompt
- F.45 — `.nvmrc` + `.editorconfig`
- F.49 — Update MCP tool issue template ("v0.1 (existing 9 tools)" stale)
- F.46 + F.47 — CodeQL + `pnpm audit` in CI

**Security** ([`architecture-security.md`](./architecture-security.md))
- F.57 — SECURITY.md vendored-projects list completeness

**Deployment** ([`architecture-deployment.md`](./architecture-deployment.md))
- F.63 — `mcp-server` `exports` field
- F.64 — Copy LICENSE into `packages/create-designjs/`
- F.65 — Add `declarationMap` + `sourceMap` to `mcp-server/tsconfig.json`
- F.68 — `scripts/check-changelog.mjs`
- F.72 — Chrome extension build step in CI
- F.74 — `docs.json` OG URL rebrand

**Observability** ([`architecture-observability.md`](./architecture-observability.md))
- F.82 — React error boundary at App root

**Docs** ([`architecture-docs.md`](./architecture-docs.md))
- F.87 — README "160+ tests" stale claim
- F.90 — ADR-0010 gap explanation (one-line note in `adr/README.md`)
- F.92 — `docs/architecture/README.md` index (this directory's own index)
- F.94 — 7 missing MCP tool docs on Mintlify (or defer to F.98 + F.95)
- F.96 — `llms.txt` rebrand URLs
- F.99 — Migrate 6 v0.2/v0.3 specs from Obsidian into `docs/specs/`
- F.100 — README "Documentation" section linking to ADRs + this review

### Tier 2 — fix-this-quarter (28 findings)

Larger refactors or coordinated work. Each takes a day to a week. Should land before v0.2 chat panel ships.

**Codebase**
- F.06 — Centralize grapesjs type helpers in `canvas/grapesjs-types.ts`
- F.07 — Bridge protocol version negotiation (coordinate with F.51)
- F.10 — Standardize component directory convention before Track A merges
- F.11 — Per-package READMEs

**Testing**
- F.13 — Drop CI retries to 1 once F.21 confirms suite stability
- F.14 — Add Firefox + WebKit Playwright projects (nightly)
- F.15 — Visual regression on 5-10 surfaces
- F.18 — Unit-test `bridge/handlers.ts` with mock-editor harness (highest-value gap)
- F.22 — Coverage reporting in CI

**CI/DX**
- F.39 — Adopt Changesets (after Track A/B first PR lands)
- F.40 — MCP tool count drift script

**Security**
- **F.51 — Bridge WebSocket token authentication** (the biggest single finding)
- F.52 — Persistence middleware shares the F.51 token
- F.54 — Capability scoping for chat Ask mode
- F.58 — Secrets-module ADR
- F.59 — OAuth-PKCE state validation spec edit
- F.60 — Sandbox iframe postMessage origin + type validation
- F.61 — SECURITY.md gaps update

**Deployment**
- F.66 — Independent versioning with Changesets + linked bridge↔mcp-server
- F.67 + F.70 — Release workflow with `npm publish --provenance`
- F.71 — Chrome Web Store submission (gates v0.3 public)
- F.76 — Cloud-tier ADR before any Supabase code lands
- F.77 — `.env.example` + env-validation

**Observability**
- F.83 — Sentry integration, opt-in (before chat panel ships)
- F.85 — Performance instrumentation wrapper
- F.86 — Privacy policy on docs site (depends on F.83/F.84)

**Docs**
- F.88 — Per-package READMEs for `@designjs/bridge` + `@designjs/mcp-server` (npm-page-visible)
- F.98 — Single doc-drift checker script (closes the class)
- F.95 Option C — Generate MCP tool docs from `tools.ts`

### Tier 3 — keep an eye on (~20 findings)

Situational; revisit when conditions change. Don't preemptively fix.

- F.01 / F.38 — Build-graph automation (Turborepo) when a 3rd consumer joins
- F.02 — Bridge watch-rebuild if protocol churns
- F.05 — TypeScript ecosystem catching up
- F.08 — Multi-frame brittleness if Phase 2.2 finds related bugs
- F.12 — E2E sharding strategy when test count exceeds ~200
- F.19 — Bundle convergence (Webpack → Vite for chrome-ext) when divergence cost shows
- F.20 — Vitest workspace mode for unified coverage
- F.30 / F.35 / F.50 — Release workflow / nightly cross-browser / branch protection
- F.44 — Conventional commits + commitlint if Changesets adoption justifies
- F.55 — Chrome extension exemplary; keep it that way as v0.3 expands
- F.56 — `@modelcontextprotocol/sdk` advisory tracking
- F.69 / F.73 — SBOM and chrome extension bundle-size budget
- F.75 — Docs CI verification
- F.84 — PostHog product analytics (lands with chat panel)
- F.91 — Codify operational-doc pattern in ADR convention
- F.93 / F.97 — `ARCHITECTURE.md` and `AGENTS.md`
- F.95 Option B — Monorepo `designjs-docs/` into `packages/docs/`

### Tier 4 — strategic (the bundles)

Each of these is an ADR-class decision to capture before implementation:

**Proposed ADR-0013: Cloud tier — Supabase as the backbone.** Captures Supabase project structure, Edge Functions vs Auth vs Storage vs Postgres allocation, env-var management, secrets storage, domain plan. ([deployment](./architecture-deployment.md) §6.2, F.76)

**Proposed ADR-0014: Observability stack — Sentry + PostHog, opt-in.** Two-vendor stack, single Privacy toggle, PII scrubbing in `beforeSend`, source maps in release workflow, event schema versioning. ([observability](./architecture-observability.md) §8, F.83 + F.84)

**Proposed ADR-0015: Bridge protocol v2 — auth, versioning, capabilities.** Token-based hello, `protocolVersion` field, `capabilities` field for role+scope. ([security](./architecture-security.md) §2.4 + §5, F.51 + F.07 + F.54)

**Proposed ADR-0016: Doc drift remediation strategy.** Generated MCP tool docs, single source of truth for derived facts (tool count, test count, URLs), `designjs-docs/` repo structure decision. ([docs](./architecture-docs.md) §5, F.95 + F.98)

**Proposed ADR-0017: Secrets module — `~/.designjs/secrets.json`.** Storage path + permissions + read/write API + redaction list + apiKeyHelper escape hatch + threat model. ([security](./architecture-security.md) §8.1, F.58)

The synthesis recommends drafting these as part of the v0.2 planning cycle. They don't need to land before v0.1.x bugfixes, but should land before the v0.2 code they govern.

## Recommended calendar

The user is solo + Claude. Calendar reflects that — small consistent investments beat big one-time pushes.

### This week (~half day total)
- F.04, F.09, F.16, F.74, F.87, F.90, F.92, F.96, F.99, F.100 — bundle into a single "hygiene-pass" PR. Most are 1-line config edits or one-paragraph doc additions.

### Next week (~1-2 days, two PRs)
- **PR A: ESLint + Prettier + Lefthook** (F.41 + F.42 + F.43) — installs, configs, root `lint`/`format` scripts, CI `verify` job lint step, Lefthook pre-commit
- **PR B: `window.__designjs` + CodeQL + `pnpm audit`** (F.09 hardened + F.46 + F.47) — security baseline

### Within ~6 weeks (the v0.2 security gate)
- **Bridge token authentication ADR + implementation** (F.51 + F.07) — ADR-0015 draft, then protocol bump, then bridge-server + bridge-client (both sides) + chrome-extension pairing UX
- **Persistence middleware token gate** (F.52) — falls out of F.51
- **React error boundary + Sentry opt-in** (F.82 + F.83) — before chat panel lands
- **Secrets module ADR + implementation** (F.58, ADR-0017) — secrets.json with redaction
- **Unit tests for `bridge/handlers.ts`** (F.18) — high-leverage gap

### Before v0.2 ships
- Adopt Changesets (F.39, F.66) — landing pattern for independent versioning
- Capability scoping for Build/Ask (F.54) — falls out of F.51 + F.07
- PostHog integration with v0.2 event schemas (F.84) — lands alongside chat panel
- Privacy policy on docs site (F.86)

### Strategic (when bandwidth allows)
- Migrate `designjs-docs/` into `packages/docs/` (F.95 Option B) when next big doc revision happens
- Visual regression baselines (F.15) — start with 5 surfaces, grow
- Cross-browser Playwright (F.14) — nightly to start

## What this review didn't cover

Honest acknowledgments of scope I deferred or didn't have material to address:

- **Live npm registry state.** Versions and tarball contents come from local `package.json` + `pnpm pack`, not `npm view`. The deployment doc flags this as a calibration item for the final pass.
- **`@modelcontextprotocol/sdk` live advisories.** No live advisory check — current version `1.29.0` cross-checked against general awareness as of late May 2026. Worth a `npm audit` run as part of Tier 1.
- **Performance benchmarking.** Phase 2.1 (codebase) noted the GrapesJS-coupling shape but didn't profile or benchmark. The 500-component performance ceiling in the roadmap is real but not measured by this review.
- **Cloud-tier deployment architecture.** Phase 2.5 recommended an ADR before implementation; the ADR itself is out of scope for a read-only review.
- **Visual / UX review of the editor chrome.** The codebase deep dive covered ADR-0001's stack choices but not the resulting visual quality vs Pencil/Figma reference points.
- **Bundle-size profiling.** Chrome extension is 3.1 MB; canvas app bundle size is unprofiled. Phase 2.5 flagged the lack of budget as a Tier-3 watch item.
- **Accessibility audit.** ESLint + jsx-a11y plugin (F.41) is the recommended start; a full axe-core / Lighthouse audit was out of scope.

## Cross-references

Eight deep dives, in dependency order:

1. [`architecture-recon-2026-05-24.md`](./architecture-recon-2026-05-24.md) — 250 LOC — as-built snapshot
2. [`architecture-codebase.md`](./architecture-codebase.md) — ~750 LOC — F.01–F.11
3. [`architecture-testing.md`](./architecture-testing.md) — ~700 LOC — F.12–F.22
4. [`architecture-ci-dx.md`](./architecture-ci-dx.md) — ~750 LOC — F.23–F.50
5. [`architecture-security.md`](./architecture-security.md) — ~700 LOC — F.51–F.61
6. [`architecture-deployment.md`](./architecture-deployment.md) — ~600 LOC — F.62–F.77
7. [`architecture-observability.md`](./architecture-observability.md) — ~500 LOC — F.78–F.86
8. [`architecture-docs.md`](./architecture-docs.md) — ~500 LOC — F.87–F.100

Total ~5,000 LOC of analysis across 100 findings. The full review is ~25-30 hours of careful reading; this synthesis is the 30-minute path to the actionable inventory.

## Sign-off

Conducted 2026-05-24. Solo reviewer + Claude. Read-only — no production code changed. Tier-1 findings should land within a few days; Tier-2 over the next quarter; Tier-3/4 surface naturally as conditions evolve. The next review cadence should be after v0.2 ships, at which point the in-flight specs become implemented surface and the security/observability ADRs land. Suggested next review: ~Q4 2026.

The bones are good. The recommendations are about hardening edges, not replacing foundations.
