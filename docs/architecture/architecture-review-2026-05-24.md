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

Ranked by leverage × urgency. Detailed rationale in the deep dives. **Status column updated 2026-06-11** — see the [Addendum](#addendum--implementation-log-2026-06-1011) for the full session implementation log.

| Rank | Recommendation | Finding | Effort | Why now | Status |
|---|---|---|---|---|---|
| 1 | **Install ESLint + Prettier + Lefthook** | F.41 + F.42 + F.43 | ~half day | Single biggest DX improvement. Gates a class of bugs (React hook rules, floating promises, a11y) that TS doesn't catch. Lands before v0.2 chat-panel code starts pouring in. | **Done — 373cfdb** |
| 2 | **Gate `window.__designjs` behind `import.meta.env.DEV`** | F.09 | ~5 min | One-line security improvement. E2E tests still work under `pnpm dev`. Production exposure closes immediately. | **Done — 1f99aca** |
| 3 | **Add WebSocket bridge token authentication** | F.51 + F.07 | ~half day | Closes the biggest single security finding. Coordinate with protocol versioning (F.07) in one bridge release. Must land before any API-key-handling code merges. | **Design captured — [ADR-0015](../adr/0015-bridge-protocol-v2.md) Proposed, 5df8598; implementation pending v0.2 bridge release** |
| 4 | **Self-update `smoke-mcp.mjs` from `TOOL_SCHEMAS`** | F.16 | ~10 min | Closes a class of doc-drift (asserts subset of 9 of 22 tools today; would silently miss future tools dropping out of registration). | **Done — 373cfdb** |
| 5 | **Add React error boundary at App root** | F.82 | ~1 hour | Prevents a single component crash from killing the canvas. Users on hours of unsaved work get a recoverable error instead of a blank screen. | **Done — 1f99aca** |
| 6 | **Add CodeQL + `pnpm audit` to CI** | F.46 + F.47 | ~30 min | Security baseline. CodeQL is free for public repos. Catches source-level vulnerabilities Dependabot doesn't. | **Done — 373cfdb** |
| 7 | **Migrate the 6 v0.2/v0.3 specs from Obsidian into `docs/specs/`** | F.99 | ~10 min | The scaffolded feature branches' header comments reference `DesignJS-Notes/<spec>.md` paths that don't exist for any contributor but the user. Makes the architecture's forward-looking thinking visible. | **Done — 89052e0** |
| 8 | **Unit-test `packages/app/src/bridge/handlers.ts`** | F.18 | ~1-2 days | 525 LOC, largest single file in the canvas package, GrapesJS's heaviest coupling site. Currently only covered via E2E. A mock-editor harness (already proven in `artboards.test.ts`) closes this. | **Done — e36a88c** (64 tests, all 22 tools covered) + follow-up bug fixes c227274 + typecheck/lint cleanup 842ae0d |
| 9 | **Doc-drift checker script + MCP tool docs generation** | F.98 + F.94 + F.95 Option C | ~half day | Closes the entire doc-drift class (tool count, missing tool pages, stale README claims) by deriving facts from `TOOL_SCHEMAS` and generating Mintlify MDX. | **Partial — script done (F.98 + F.40, d2d5c51); MCP MDX gen (F.94 + F.95 Option C) deferred to the separate `designjs-docs/` repo** |
| 10 | **`window.__designjs` revised + bridge token + capability scoping shipped together as a "v0.2 security gate"** | F.09 + F.51 + F.52 + F.54 | ~1-2 days bundled | The chat panel will introduce capability differentiation (Build vs Ask modes); without bridge-side enforcement, the client can lie about its mode. Bundle the work. | **Partial — F.09 done (1f99aca); F.51/F.52/F.54 design captured in ADR-0015 Proposed, implementation pending the v0.2 bridge release** |

## Findings by tier

The four-tier rollup. Tier-1 + Tier-2 totals are the actionable inventory; Tier-3/4 are the watch-and-strategic items.

### Tier 1 — fix-this-week (28 findings)

Small, high-leverage, low-risk changes. Each fixable in under a day, often in under an hour. Bundled into ~4-6 PRs they close most of the immediate hygiene gaps.

**Progress as of 2026-06-10 (updated after Tier 1 close)** on the `hygiene-pass` feature branch:

| Status | Count | What it means |
|---|---|---|
| `[done]` | 24 | Committed on `hygiene-pass`, commit SHA shown inline |
| `[pre-existing]` | 1 | Subagent verified the work was already done before this review |
| `[deferred]` | 3 | Belongs in the separate `designjs-docs/` repo; deferred to a future session |

**Tier 1 is closed** — 25 of 28 actually completed (24 committed + 1 pre-existing), 3 deferred by scope.

Markers: `[done — <sha>]` (committed); `[pre-existing]` (already done); `[deferred]` (separate-repo work).

**Codebase** ([`architecture-codebase.md`](./architecture-codebase.md))
- `[done — 797b94a]` F.04 — `create-designjs/tsconfig.json` drops `noUncheckedIndexedAccess` (1 line)
- `[done — 1f99aca]` F.09 — Gate `window.__designjs` behind `import.meta.env.DEV` (1 line, security)

**Testing** ([`architecture-testing.md`](./architecture-testing.md))
- `[done — 373cfdb]` F.16 — Self-updating `smoke-mcp.mjs` (`Object.keys(TOOL_SCHEMAS)`)
- `[pre-existing]` F.17 — Bridge schema tests for `add_classes`/`remove_classes`/`set_text`/`select`/`deselect` — these tests already exist in `tools-artboards.test.ts`. The testing deep dive was stale on this finding.
- `[done — 373cfdb]` F.21 — Playwright JSON reporter + retry-stat script

**CI/DX** ([`architecture-ci-dx.md`](./architecture-ci-dx.md))
- `[done — 373cfdb]` F.41 + F.42 + F.43 — **ESLint + Prettier + Lefthook bundle**
- `[done — 797b94a]` F.36 — PR template CHANGELOG prompt
- `[done — 797b94a]` F.45 — `.nvmrc` + `.editorconfig`
- `[done — 797b94a]` F.49 — Update MCP tool issue template ("v0.1 (existing 9 tools)" stale)
- `[done — 373cfdb]` F.46 + F.47 — CodeQL + `pnpm audit` in CI

**Security** ([`architecture-security.md`](./architecture-security.md))
- `[done — 797b94a]` F.57 — SECURITY.md vendored-projects list completeness

**Deployment** ([`architecture-deployment.md`](./architecture-deployment.md))
- `[done — 797b94a]` F.63 — `mcp-server` `exports` field
- `[done — 797b94a]` F.64 — Copy LICENSE into `packages/create-designjs/`
- `[done — 797b94a]` F.65 — Add `declarationMap` + `sourceMap` to `mcp-server/tsconfig.json`
- `[done — 797b94a]` F.68 — `scripts/check-changelog.mjs`
- `[done — 373cfdb]` F.72 — Chrome extension build step in CI
- `[deferred]` F.74 — `docs.json` OG URL rebrand (separate `designjs-docs/` repo)

**Observability** ([`architecture-observability.md`](./architecture-observability.md))
- `[done — 1f99aca]` F.82 — React error boundary at App root

**Docs** ([`architecture-docs.md`](./architecture-docs.md))
- `[done — 797b94a]` F.87 — README "160+ tests" stale claim
- `[done — 797b94a]` F.90 — ADR-0010 gap explanation (one-line note in `adr/README.md`)
- `[done — 74aa28f]` F.92 — `docs/architecture/README.md` index (this directory's own index)
- `[deferred]` F.94 — 7 missing MCP tool docs on Mintlify (separate `designjs-docs/` repo; or defer to F.98 + F.95)
- `[deferred]` F.96 — `llms.txt` rebrand URLs (separate `designjs-docs/` repo)
- `[done — 89052e0]` F.99 — Migrate 6 v0.2/v0.3 specs from Obsidian into `docs/specs/`
- `[done — 797b94a]` F.100 — README "Documentation" section linking to ADRs + this review

### Tier 2 — fix-this-quarter (28 findings)

Larger refactors or coordinated work. Each takes a day to a week. Should land before v0.2 chat panel ships.

**Progress as of 2026-06-11 (updated after the ADR triple landed)** on the `hygiene-pass` branch:

| Status | Count | Findings |
|---|---|---|
| `[done]` | 16 | F.06 (ff384fb); F.11 + F.88 (db122e1); F.14 (d1ba5ad); F.18 (e36a88c + c227274 + 842ae0d); F.40 + F.98 (d2d5c51); F.51 (ADR-0015 Proposed, 5df8598); F.58 (ADR-0017 Proposed, fc1a8c2); F.59 + F.60 + F.61 (6770d3e); F.76 (ADR-0013 Proposed, 5df8598); F.77 (d2d5c51); F.85 (03860cf) |
| `[partial-via-ADR]` | 3 | F.07 (lands in ADR-0015 Phase 1 — implementation pending); F.52 (persistence middleware token lands with ADR-0015); F.54 (capability scoping lands in ADR-0015 Phase 2) |

**Tier 2 status:** 16 of 28 findings closed (8 docs/ADRs + 6 code/test + F.18 follow-ups inline); 3 design-captured via ADRs awaiting implementation; 9 not-yet-started.

**Remaining Tier 2** (deferred to focused follow-up):

- **Codebase:** F.10 (component dir convention — defer until Track A/B merges)
- **Testing:** F.13 (drop CI retries — pending F.21 baseline), F.15 (visual regression baseline), F.22 (coverage reporting in CI)
- **CI/DX:** F.39 (Changesets adoption)
- **Deployment:** F.66 (independent versioning — depends on F.39), F.67 + F.70 (release workflow + provenance — depends on F.39), F.71 (Chrome Web Store submission — manual external)
- **Observability:** F.83 (Sentry, opt-in — before chat panel ships), F.86 (privacy policy on docs site — separate `designjs-docs/` repo)
- **Docs:** F.95 Option C (generate MCP tool docs from `tools.ts` — partially deferred to separate repo)

**v0.2 implementation queue** (now that the design decisions are captured in ADR-0013 + ADR-0015 + ADR-0017): the bridge token (F.51), protocol versioning (F.07), persistence token (F.52), capability scoping (F.54), and the secrets module (F.58) all land as one coordinated bridge release — the "v0.2 security gate" bundle from the synthesis Top 10 row #10. ADR-0013's cloud-tier implementation is gated on the bridge being hardened first.

Adjacent fixes from this session beyond formal Tier 2: root README MCP tool prose count drift "21" → "22" (closed by the doc-drift checker); CONTRIBUTING.md + PR template + RELEASING.md updated for new lint/format/Lefthook/cross-browser/doc-drift gates.

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

---

## Addendum — implementation log (2026-06-10/11)

> Written 2026-06-11. The original 2026-05-24 review above is preserved as a point-in-time snapshot. This addendum captures the implementation work that closed 41 of the 56 actionable Tier-1+2 findings on the `hygiene-pass` feature branch.

### Headline

**23 commits, 41 findings closed across two days.** Tier 1 is closed (25 of 28 actually completed — 24 committed + 1 verified pre-existing; 3 deferred to the separate `designjs-docs/` repo). Tier 2 is at 16 of 28 closed, 3 design-captured via Proposed ADRs awaiting implementation, 9 not-yet-started.

Three new ADRs (Proposed) capture the v0.2 security gate: [ADR-0013](../adr/0013-cloud-tier-supabase.md) (cloud tier on Supabase, closes F.76), [ADR-0015](../adr/0015-bridge-protocol-v2.md) (bridge protocol v2 — auth + versioning + capabilities, closes F.51, F.07-design, F.54-design), and [ADR-0017](../adr/0017-secrets-module.md) (secrets module, closes F.58). Together they describe the coordinated bridge release that's now the gating item for v0.2's chat panel + repo connection.

### Commit log

Commits land in thematic groups. Each row lists the findings the commit closed.

| Commit | Theme | Findings closed |
|---|---|---|
| `74aa28f` | Land 2026-05-24 architecture review docs | F.92 |
| `89052e0` | Migrate v0.2/v0.3 specs from Obsidian into `docs/specs/` | F.99 |
| `797b94a` | Tier-1 config hygiene bundle (tsconfigs, README, SECURITY, templates) | F.04, F.36, F.45, F.49, F.57, F.63, F.64, F.65, F.68, F.87, F.90, F.100 |
| `1f99aca` | Gate `window.__designjs` to DEV; add React error boundary | F.09, F.82 |
| `f24c71c` | First Tier-1 progress checkoff in synthesis | — (tracking doc) |
| `373cfdb` | ESLint + Prettier + Lefthook + CI hardening + test infrastructure | F.16, F.21, F.41, F.42, F.43, F.46, F.47, F.72 |
| `db122e1` | Per-package READMEs | F.11, F.88 |
| `6770d3e` | OAuth state validation + sandbox postMessage origin checks + SECURITY.md gaps | F.59, F.60, F.61 |
| `d2d5c51` | `.env.example` + Zod env validation + doc-drift checker + README MCP tool count fix | F.40, F.77, F.98 |
| `e5eeed8` | Flip Tier-1 `[wt]` → `[done]` markers; add Tier-2 progress block | — (tracking doc) |
| `968829c` | CONTRIBUTING + PR template updates for new lint/format/Lefthook | — (contributor docs) |
| `d1ba5ad` | Firefox + WebKit Playwright projects + nightly cross-browser workflow | F.14 |
| `052a7ab` | RELEASING.md pre-flight checklist for new quality gates | — (release docs) |
| `e36a88c` | Bridge handlers unit tests with mock-editor harness | F.18 |
| `c227274` | F.18 follow-up — `add_components` frameless throw + `select` JSDoc | — (bug-1, 3 from F.18) |
| `842ae0d` | F.18 follow-up — typecheck circularity + unused param | — (post-F.18 hygiene) |
| `03860cf` | Performance instrumentation wrapper | F.85 |
| `ff384fb` | Centralise grapesjs type helpers | F.06 |
| `3b687e5` | Remove 2 missed eslint-disable directives in `perf.ts` | — (post-F.85 lint cleanup) |
| `96047ee` | Flip 6 more Tier-2 findings to `[done]` in synthesis | — (tracking doc) |
| `5df8598` | Land ADR-0013 (cloud tier) + ADR-0015 (bridge protocol v2) | F.51, F.76 (design) |
| `fc1a8c2` | Land ADR-0017 (secrets module) + ADR README index update | F.58 (design) |
| `3547a89` | Flip F.51 + F.58 + F.76 to `[done]`; Tier-2 final tally | — (tracking doc) |

### Code surface delta

- **+1,038 LOC of tests** — `packages/app/src/bridge/__tests__/handlers.test.ts` (F.18; 64 tests, all 22 MCP tools covered). The app test suite grew from ~165 to 229 passing tests / 832ms total runtime.
- **−98 LOC net in canvas modules** — F.06 collapsed 53 inline `as unknown as { ... }` cast patterns to 30, of which 13 are now localised in `packages/app/src/canvas/grapesjs-types.ts` (auditable; 17 remain in business logic). Net: 36 → 17 ad-hoc casts.
- **+86 LOC observability** — `packages/app/src/lib/perf.ts` (F.85) — `timeTool` wraps every bridge handler with `[designjs:perf]` console output; TODO marks the future PostHog `.capture()` call that lands with ADR-0014.
- **+504 LOC ADR design** — ADR-0013 (265 LOC) + ADR-0015 (239 LOC) + ADR-0017 (170 LOC).
- **+~3,800 LOC architecture review docs** — the 9 review docs (synthesis + recon + 7 deep dives + README).

### Quality gates added

The `verify` CI job now runs (on every push + PR): `pnpm typecheck`, `pnpm lint` (continue-on-error until 8 pre-existing warnings are addressed), `pnpm audit` (prod deps), bridge build, `pnpm test`, all bridge/MCP/init smoke tests, plus the new Chrome extension production-build step. The new `codeql` workflow runs on push + PR + weekly Mondays. The new `e2e-cross-browser` workflow runs nightly + on demand against Firefox + WebKit.

Local pre-commit: Lefthook runs ESLint (`--max-warnings 0`) + Prettier `--check` on staged files. `pnpm format` + `pnpm format:check` available repo-wide. `scripts/check-doc-drift.mjs` verifies the README MCP tool count + e2e test count match the source of truth.

### What's next (queue for the next session)

**Highest-leverage** — the v0.2 security gate implementation per ADR-0013 + ADR-0015 + ADR-0017. Five findings collapse into one coordinated bridge release: F.51 (token), F.07 (versioning), F.52 (persistence token), F.54 (capability scoping), F.58 (secrets module). Estimated 1–2 days bundled. This is the gating item for the v0.2 chat panel + repo connection because both touch user credentials.

**F.18 follow-up bugs (2/4/5)** — return-shape fragility in `add_components`, `delete_nodes` silent-skip schema rev, `fit_artboard` structural-unmeasurability fast-fail. Each is small + scoped + has the test harness ready. Estimated ~1 hour total.

**Tier-2 deferred work** — 9 findings not started in this session, each suitable for a focused follow-up:
- **Codebase:** F.10 (component dir convention, blocked by Track A/B merge)
- **Testing:** F.13 (drop CI retries — pending F.21 baseline measurement), F.15 (visual regression), F.22 (coverage reporting in CI)
- **CI/DX:** F.39 (Changesets adoption — gates F.66 + F.67 + F.70 release workflow)
- **Deployment:** F.71 (Chrome Web Store submission — manual external)
- **Observability:** F.83 (Sentry opt-in — before chat panel ships)
- **Cross-repo:** F.86 (privacy policy on docs site), F.95 Option C (generate MCP tool docs from `tools.ts`) — both belong in `designjs-docs/` repo
- ADR-0014 (observability stack — Sentry + PostHog adoption) and ADR-0016 (doc-drift remediation) are drafted-when-locked

**Tier 3 + Tier 4** — situational + strategic items per the original review's roll-up; revisit at the next review cadence (~Q4 2026 or after v0.2 ships, whichever sooner).
