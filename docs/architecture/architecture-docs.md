# Architecture review — Phase 2.7: Docs deep dive

> Companion to earlier phases. Read-only analysis of all three doc surfaces (root markdown, internal `docs/`, public `designjs-docs/` Mintlify site), ADR hygiene, doc-drift causes, and the relationship between the v0.2/v0.3 strategic specs (currently in the user's Obsidian vault) and the code repo's documentation. Continues `[F.NN]` numbering — Phase 2.6 ended at F.86. **Last deep dive before synthesis.**

## 1. The three doc surfaces

```
┌─────────────────────────────────────────────────────────────────────────┐
│  1. Root markdown   — committed to code repo, npm-page-visible          │
│     README.md (346 LOC, updated 2026-05-24)                             │
│     CONTRIBUTING.md, RELEASING.md, SECURITY.md, CHANGELOG.md            │
│     LICENSE, NOTICE                                                       │
├─────────────────────────────────────────────────────────────────────────┤
│  2. Internal docs/  — committed to code repo, contributor-facing        │
│     docs/adr/        12 ADRs (0001-0012, 0010 missing) + README          │
│     docs/architecture/  6 review docs (this round) — NEW                 │
│     docs/             4 operational docs (capture-fidelity, epic-8,       │
│                        font-preservation, qa-followups)                   │
├─────────────────────────────────────────────────────────────────────────┤
│  3. designjs-docs/  — SEPARATE GIT REPO, public Mintlify site            │
│     ~35 MDX files: intro, quickstart, concepts, editor, integrations,    │
│        guides, MCP tool reference (15 of 22 tools)                       │
│     docs.json (Mintlify config)                                          │
│     llms.txt, AGENTS.md, README, LICENSE                                 │
│     Has its own .git/, deploys to (currently) opencanvas.mintlify.app    │
└─────────────────────────────────────────────────────────────────────────┘
```

**Plus** — 18 strategic specs in the user's Obsidian vault at `~/Documents/Ruby Obsidian Notes/DesignJS-Notes/` (not part of either repo's git):

- The master roadmap (`opencanvas-roadmap.md`)
- The 6 v0.2/v0.3 specs (`ai-chat.md`, `repo-connection.md`, `sandbox-preview.md`, `projects.md`, `swarm.md`, `component-discovery.md`)
- 11 research / scratch docs (Paper / Pencil / Flux / opencode research, prior ADR drafts, PRD)

**This three-surface (plus Obsidian) split is the root cause of the doc drift cluster** surfaced throughout the earlier deep dives. §5 below.

## 2. Root markdown — solid baseline

`README.md` (346 lines, last touched `a055e25` 2026-05-24): excellent. Covers positioning, architecture diagram, quickstart, manual MCP config, the Chrome extension flow, known quirks honestly documented, package matrix, 22-tool table, comparison vs Paper / Pencil / Figma / Penpot / GrapesJS / Onlook / Webstudio, and the roadmap. Recent updates reflect the chrome-extension + add_css_rules work.

`CONTRIBUTING.md`, `RELEASING.md`, `SECURITY.md`, `CHANGELOG.md` — all assessed in earlier phases. Pattern is **above-average** for a v0.1 project.

**Drift signals (already flagged):**
- README's *"160+ tests across 28 specs"* — actual is 156/37 (F.NN from testing) — **[F.87] confirmed in this phase**
- README's *"Twenty-one bidirectional tools"* — actual is 22 (F.40 from CI/DX) — **persistent**

Plus a new one:

- **[F.88] Per-package README absence for the 3 published packages** — referenced briefly in Phase 2.1 (F.11); reinforced here. The npm registry pages for `@designjs/bridge`, `@designjs/mcp-server`, `create-designjs` will show "no README" because the `files` field includes `"README.md"` but there's no per-package `README.md` file. Verified via `pnpm pack` in Phase 2.5 — `create-designjs` tarball includes `README.md`, but `bridge` and `mcp-server` need their own. **Priority: at minimum `@designjs/mcp-server`** (the package users `npx -y @designjs/mcp-server` directly without ever seeing the repo).

## 3. Internal docs/

### 3.1 ADR hygiene is excellent (genuinely)

Recapping from the codebase deep dive — 12 ADRs in `docs/adr/`:

| # | Title | Status | LOC |
|---|---|---|---|
| 0001 | Frontend UI stack | Accepted + 2 addenda | 232 |
| 0002 | Inspector IA | Superseded by 0003 | 208 |
| 0003 | Panel IA — Penpot reference | Accepted | 207 |
| 0004 | Frames in layer tree | Accepted | (skim) |
| 0005 | HTML primitives mapping | Accepted | (skim) |
| 0006 | Sizing / auto-layout / canvas model | Accepted | 292 |
| 0007 | User extensibility | **Proposed** (never implemented) | 276 |
| 0008 | Figma import strategy | Path A Accepted; Path B deferred | 247 |
| 0009 | Design tokens (DTCG, Tailwind `@theme`) | Phase 1 Accepted; Phases 2+3 Proposed | **600** |
| 0010 | **MISSING** | — | — |
| 0011 | Browser extension | Accepted + 3 addenda | 315 |
| 0012 | Capture fidelity evolution | §1 Accepted; §§2-4 Proposed | 438 |

Average 270 LOC; largest is 0009 (design tokens, 600 LOC — most architecturally complex feature). **3,223 total LOC of ADR.**

What makes this exemplary (worth preserving as the convention scales):

1. **`docs/adr/README.md` documents the convention.** Explicit rule: addenda preserve history; supersession is bidirectionally linked; load-bearing implementation commits link from the Index column.
2. **Status column is honest.** ADR-0007 is *Proposed* and never implemented; ADR-0009's Phase 1 is *Accepted* with Phases 2+3 still *Proposed*. No false "Accepted" signals.
3. **Implementation commits link from the index.** ADR-0001's row lists `81930a1`, `b56957a`, `3f0bda7`, `f8fc6d5`, `b6e6fa5`. Lets a reader follow code from decision to delivery.
4. **Addenda over rewrites.** ADR-0001 has two dated addenda capturing icon-stack amendments and Phase A status. The original body never gets rewritten. **This is the gold-standard ADR pattern.**
5. **Pattern is documented.** Future contributors don't have to reverse-engineer the convention.

**[F.89] Keep ADR hygiene exactly as-is.** This is a top-quartile signal for the project.

### 3.2 ADR-0010 mystery

```
docs/adr/0001-frontend-ui-stack.md
docs/adr/0002-inspector-information-architecture.md
docs/adr/0003-panel-information-architecture.md
docs/adr/0004-frames-in-layer-tree.md
docs/adr/0005-html-primitives-mapping.md
docs/adr/0006-sizing-auto-layout-canvas-model.md
docs/adr/0007-user-extensibility.md
docs/adr/0008-figma-import-strategy.md
docs/adr/0009-design-tokens-architecture.md
                                                  ← 0010 gap
docs/adr/0011-browser-extension-architecture.md
docs/adr/0012-capture-fidelity-evolution.md
```

Filesystem confirms ADR-0010 doesn't exist. `docs/adr/README.md`'s Index table skips from 0009 to 0011 with no acknowledgment.

Three possibilities for the gap:

1. **Reserved slot** — someone planned an ADR-0010, didn't write it. Should be tracked.
2. **Deleted draft** — was written, scrapped before merge. Goes against the convention's "immutable historical record" principle if it was ever Proposed.
3. **Off-by-one numbering** — 0011 was intended to be 0010 but landed with the wrong number. Convention says don't renumber.

**[F.90] ADR-0010 gap is undocumented.** Either restore the file with a `Status: Rejected (with reason)` or a `Status: Reserved` entry, OR add a one-line note in `docs/adr/README.md` after the index table:

> *"ADR-0010 is intentionally vacant — [the proposed topic] was [absorbed into ADR-0011 / abandoned during scoping]. The slot remains for historical numbering consistency."*

5-minute fix once the user surfaces the original intent.

### 3.3 Operational docs (load-bearing)

| Doc | LOC | Purpose |
|---|---|---|
| `docs/epic-8-followups.md` | 349 | v0.3 Chrome extension operational doc (status, gaps, commit-tracked checklist) |
| `docs/capture-fidelity-baseline.md` | (significant) | Capture-pipeline regression baselines + diff scoring methodology |
| `docs/font-preservation-plan.md` | (significant) | Font preservation phasing (Phase 1 fallback name; Phase 2 binary inlining) |
| `docs/qa-followups.md` | 161 | Bounded bugs from 2026-05-23 test-coverage + CI audit |

**Pattern observation:** these are *living* operational docs — updated as the work progresses, cross-referenced by ADRs (`epic-8-followups` is referenced by ADR-0011 and ADR-0012). The pattern works because:

- They're scoped narrowly enough that a quick read tells you "what's left"
- They link out to ADRs for strategy, commits for implementation
- Their existence doesn't compete with ADRs — they're complementary

**[F.91] The operational-doc pattern is worth codifying.** Add a brief note to `docs/adr/README.md`: *"For commit-tracked work-in-progress checklists (e.g., 'epic-N-followups.md'), use the existing pattern — link from the relevant ADR's Addendum."*

### 3.4 The architecture/ directory is new (this review)

The 6 architecture review docs land at:

```
docs/architecture/
├── architecture-recon-2026-05-24.md   (Phase 1)
├── architecture-codebase.md            (Phase 2.1)
├── architecture-testing.md             (Phase 2.2)
├── architecture-ci-dx.md               (Phase 2.3)
├── architecture-security.md            (Phase 2.4)
├── architecture-deployment.md          (Phase 2.5)
├── architecture-observability.md       (Phase 2.6)
└── architecture-docs.md                (this doc, Phase 2.7)
```

Phase 3 will add `architecture-review-2026-05-24.md` as the synthesis index.

**[F.92] `docs/architecture/` needs an index README.** A 1-page `docs/architecture/README.md` that explains the convention (point-in-time deep dives vs ADRs as durable decisions) and links to the docs in order would help future-you navigate this review when it's referenced 6 months from now.

### 3.5 No top-level `ARCHITECTURE.md`

The root has no `ARCHITECTURE.md`. README.md substitutes — it has the diagram + package matrix — but doesn't link to the `docs/adr/` or `docs/architecture/` directories.

**[F.93] Add a minimal `ARCHITECTURE.md`** at the repo root (or as a section in README.md) linking to:
- `docs/adr/README.md` for ADRs
- `docs/architecture/` for the 2026-05-24 review
- `docs/epic-8-followups.md` etc. for operational state

GitHub's repo-stats shows projects with `ARCHITECTURE.md` get better contributor onramp. Low-effort.

## 4. designjs-docs/ — the Mintlify site

### 4.1 Structure

35 MDX files across 6 logical sections (per `docs.json` navigation):

| Section | Pages |
|---|---|
| Get Started | introduction, quickstart, connect-agent |
| Core Concepts | canvas, mcp, file-format, figma-relay |
| Using the Editor | interface, blocks, artboards, keyboard-shortcuts |
| Integrations | claude-code, cursor, vscode |
| Guides | design-with-agent, export-to-react, css-variables, figma-import |
| MCP Tools | overview + 15 per-tool pages |

**This is a complete-feeling docs site.** Mintlify's `theme: "luma"` gives it a polished default look. SEO + OG metadata configured. Auto-deploys on push to designjs-docs/main.

### 4.2 [F.94] MCP tool reference coverage is incomplete

15 per-tool MDX pages exist; 22 tools actually exist. **7 tools are entirely undocumented on the live site:**

| Missing tool | Tool age |
|---|---|
| `add_classes` | v0.1 |
| `add_css_rules` | v0.1 (just shipped, commit `9c99089`) |
| `deselect` | v0.1 |
| `fit_artboard` | v0.1 |
| `remove_classes` | v0.1 |
| `select` | v0.1 |
| `set_text` | v0.1 |

These are the same 5+ tools that:
- Lack bridge unit tests (F.17 from testing)
- Are missing from `smoke-mcp.mjs` `EXPECTED_TOOLS` (F.16)
- Aren't surfaced in the README's tool table either (which has `add_css_rules` per the recent update; the others are inconsistent)

**This is the doc-drift cluster's most visible failure.** Agent users searching the docs site for `set_text` find nothing; they end up reading `tools.ts` directly.

### 4.3 designjs-docs/ is a separate git repo — this is the root cause

```
designjs-docs/.git/    ← independent git repo
   refs/heads/main
   refs/heads/adr-0008-path-a-docs
   refs/remotes/origin/HEAD
```

The site has its own clone, its own remote, its own branches. Changes to MCP tools in the code repo do NOT automatically propagate to docs. The 7 missing tool docs reflect this — they were added to `tools.ts` and `TOOL_DESCRIPTIONS`, but no one opened a corresponding PR in `designjs-docs/`.

**[F.95] `designjs-docs/` as a separate repo structurally enables doc drift.** Three remediation paths:

#### Option A: Submodule the docs into the code repo
```
designjs-docs/ becomes a git submodule
```
- ✅ Code-repo PRs can include doc updates atomically
- ❌ Submodules are notoriously contributor-hostile (`git submodule update --init` ceremony, broken Mintlify deploy if the submodule pointer is wrong)
- ❌ Mintlify's auto-deploy works on the docs repo's main; submodule pointer commits don't trigger deploys

#### Option B: Monorepo into `packages/docs/`
```
packages/docs/ becomes a workspace package
```
- ✅ Single source of truth
- ✅ Code-repo CI can validate docs (`pnpm --filter docs build`)
- ✅ Doc changes in same PR as code changes
- ❌ Mintlify deploy needs to be reconfigured to watch the code repo (Mintlify supports this — per [Mintlify's monorepo docs](https://mintlify.com/docs/settings/global))
- ❌ One-time migration (move files, update git history)

#### Option C: Generate MCP tool docs from `tools.ts`
```
scripts/generate-mcp-docs.mjs reads TOOL_SCHEMAS + TOOL_DESCRIPTIONS,
generates docs/mcp/<tool>.mdx, syncs to designjs-docs/
```
- ✅ Eliminates the drift class entirely for MCP tools
- ✅ Self-updating: a new tool in `tools.ts` automatically gets a docs page
- ✅ Keeps the two-repo structure for everything else
- ❌ Generated docs have less hand-written nuance (but Zod schemas + descriptions are actually quite expressive)
- ❌ Doesn't fix the OG-URL / "21 tools" / "160+ tests" prose drift class

**Recommendation: Option C first** (closes the MCP tool drift in a half-day), **Option B later** (closes everything else, requires a coordinated cutover).

### 4.4 docs.json + llms.txt drift

Already flagged in deployment + recon:

- `docs.json` OG URL: `https://opencanvas.mintlify.app` (pre-rebrand) — **[F.74 from deployment]**
- `llms.txt` references `opencanvas.mintlify.app/...` URLs throughout — **[F.96]**

Single rebrand-pass on the docs repo (search-and-replace `opencanvas.mintlify.app` → `designjs.mintlify.app`, plus the Mintlify dashboard URL update) closes both.

### 4.5 AGENTS.md — modern convention

`designjs-docs/AGENTS.md` exists. The 2026 convention (gaining traction since late 2025): projects ship an `AGENTS.md` that briefs AI coding agents (Claude Code, Cursor, etc.) on conventions and load-bearing context — a parallel to `README.md` but agent-targeted.

**Worth keeping**. Adding an equivalent at the **code repo root** would brief agents working on the code (not just the docs) — DesignJS's own MCP tools become discoverable + conventions land in agent context.

**[F.97] Recommend code-repo `AGENTS.md`** mirroring designjs-docs's pattern. Adapts the CONTRIBUTING.md content for agent consumption (briefer, tactical, fewer prose niceties).

### 4.6 Two CONTRIBUTING.md files

`CONTRIBUTING.md` exists at the code repo root AND `designjs-docs/CONTRIBUTING.md` exists. Presumably the docs one is doc-site-specific (how to author MDX, how to run Mintlify locally). **Verify they aren't duplicates.** If they are, kill one; if not, the docs one should explicitly link from the root one with a one-line pointer ("for docs site contributions, see `designjs-docs/CONTRIBUTING.md`").

## 5. The doc drift cluster (the consolidated picture)

Six items across the review map to this one root cause:

| # | Drift signal | Root cause |
|---|---|---|
| F.40 (CI/DX) | MCP tool count drifts across CHANGELOG / README / docs / smoke-mcp | Multiple sources of truth |
| F.49 (CI/DX) | MCP tool issue template lists "v0.1 (existing 9 tools)" | Stale before tools were added |
| F.74 (deployment) | `docs.json` OG URL is pre-rebrand | Docs repo lagging rebrand |
| F.94 (this) | 7 of 22 MCP tools undocumented on Mintlify | Docs repo not synced to code repo |
| F.95 (this) | `designjs-docs/` separate-repo structure enables drift | Architectural cause |
| F.96 (this) | `llms.txt` references stale URL | Same as F.74 |
| F.87 (this) | README's "160+ tests across 28 specs" | Stale claim, never gated |
| F.16 (testing) | `smoke-mcp.mjs` EXPECTED_TOOLS lists 9 of 22 | Hand-maintained list |

**The drift compass:** every fact in the codebase that's reproduced in prose (tool count, test count, version numbers, URLs) eventually drifts. The cure is **derived facts**:

- Tool count → `Object.keys(TOOL_SCHEMAS).length`, generated into both README and docs site at build time
- Test count → `pnpm test:e2e --list | wc -l`, generated into README
- URLs → environment-templated in `docs.json` and `README.md` (Mintlify supports this)
- MCP tool reference pages → generated from `tools.ts` (per F.95 Option C)

A small `scripts/check-doc-drift.mjs` that asserts these match (or generates them) is the highest-leverage doc fix available.

**[F.98] Single doc-drift checker script** closes the entire class of drift in one place. Estimated effort: ~half day to write the script + integrate into the `verify` CI job + fix everything currently drifted.

## 6. Forward-looking specs in DesignJS-Notes (Obsidian)

The 18 files in `~/Documents/Ruby Obsidian Notes/DesignJS-Notes/` include the load-bearing specs for the v0.2/v0.3 roadmap:

```
ai-chat.md                  ← v0.2 Track A
repo-connection.md          ← v0.2 Track B
sandbox-preview.md          ← v0.2 Track B
projects.md                 ← v0.2 Track B
swarm.md                    ← v0.3 Track A continuation
component-discovery.md      ← v2+ (deferred)
opencanvas-roadmap.md       ← master roadmap
opencanvas-prd.md           ← original PRD
... + 10 research/scratch docs
```

These are **personal notes that shape implementation decisions**, currently invisible to anyone but the user. The scaffolded feature branches (`feat/ai-chat-panel`, `feat/projects-gallery`) reference them implicitly — every scaffolded file has a header comment `Spec: DesignJS-Notes/<spec>.md § "..."`.

**[F.99] The 6 v0.2/v0.3 implementation specs should migrate into the code repo** at `docs/specs/` or `docs/proposals/`. The benefits:

- **Discoverable** for any contributor (the file-header references in `feat/ai-chat-panel` would actually resolve to a file the contributor can read)
- **Versioned with the code** — when the spec evolves, the diff is reviewable in PR
- **Survives the user changing note-taking systems** (Obsidian, Roam, Logseq — these vaults are personal)
- **The recon doc's "scope" answer** ("Main + the in-flight scaffolding on feature branches") implicitly treats the specs as in-scope; making them visible in the code repo aligns the reality with the intent

The other 12 files (research notes, PRD drafts, scratch) can stay in Obsidian.

**Migration is light:** copy the 6 files into `docs/specs/`, update the scaffolded code's header comments from `Spec: DesignJS-Notes/...` to `Spec: docs/specs/...`. Keep the Obsidian copies as the user's working drafts; the code repo's copy is the canonical.

## 7. Doc navigation

The README has lots of inline content but few links to deeper docs. Following one path:

```
README.md
  → links to: docs/adr/0011-browser-extension-architecture.md
  → links to: docs/font-preservation-plan.md
  → links to: docs/epic-8-followups.md
  → links to: docs/adr/0012-capture-fidelity-evolution.md
  → does NOT link to: docs/adr/README.md (ADR index)
  → does NOT link to: docs/architecture/ (this review)
```

**[F.100] README's link surface is incomplete.** Add a "Documentation" section near the bottom (or just before Roadmap) with:

```markdown
## Documentation

- [User docs](https://designjs.mintlify.app) — quickstart, integrations, MCP tool reference
- [Architecture Decision Records](./docs/adr/README.md) — load-bearing decisions
- [Architecture review (2026-05-24)](./docs/architecture/README.md) — point-in-time deep dives
- [Operational state](./docs/epic-8-followups.md) — v0.3 Chrome extension followups
```

5 minutes. Closes the F.93 ARCHITECTURE.md gap implicitly.

## 8. Findings rollup

| # | Finding | Severity | Effort |
|---|---|---|---|
| F.87 | README's "160+ tests across 28 specs" stale | Low (doc drift) | XS |
| F.88 | Per-package READMEs missing on `@designjs/bridge` and `@designjs/mcp-server` (npm-page-visible) | Med (user-facing) | S (~30 min each) |
| F.89 | ADR hygiene is exemplary (positive) | n/a | n/a — preserve |
| F.90 | ADR-0010 gap undocumented | Low | XS |
| F.91 | Operational-doc pattern worth codifying in ADR convention | Low | XS |
| F.92 | `docs/architecture/` needs an index README | Low (this review's discoverability) | XS |
| F.93 | No top-level `ARCHITECTURE.md` (or README "Documentation" section) | Low | XS |
| F.94 | 7 of 22 MCP tools undocumented on Mintlify site | Med (user-facing) | S (~half day for manual) or M (auto-generation) |
| F.95 | `designjs-docs/` separate-repo structure enables doc drift | Med (architectural root cause) | M-L (depends on chosen remediation) |
| F.96 | `llms.txt` references stale `opencanvas.mintlify.app` URLs | Low | XS |
| F.97 | Code-repo `AGENTS.md` would brief agents working on code | Low-Med | S (~1h) |
| F.98 | Single doc-drift checker script closes the drift class | Med | M (~half day) |
| F.99 | Migrate 6 v0.2/v0.3 specs from Obsidian into `docs/specs/` | Med | XS (copy + relink) |
| F.100 | README's link surface incomplete — missing pointers to docs/ | Low | XS |

## 9. Risk tiers

**Tier 1 — fix-in-the-week:**
- **F.99** — Copy the 6 v0.2/v0.3 specs from Obsidian into `docs/specs/`. Makes the architecture's forward-looking thinking visible to contributors and aligns with the scaffolded feature branches' header references.
- **F.94** — Hand-author the 7 missing MCP tool docs. Half-day vs going straight to generation. Defer to F.98 if synthesis suggests the bigger refactor.
- **F.96 + F.74 (deployment)** — Single rebrand-pass on `designjs-docs/` (search-replace `opencanvas.mintlify.app` → `designjs.mintlify.app`).
- **F.92** — `docs/architecture/README.md` index (5 lines).
- **F.100** — README "Documentation" section.
- **F.87** — README's stale test-count claim.
- **F.90** — ADR-0010 explanation.

**Tier 2 — fix-this-quarter:**
- **F.98** — Doc-drift checker script. Highest-leverage doc fix; closes a class of bugs, not individual instances.
- **F.88** — Per-package READMEs for `@designjs/bridge` + `@designjs/mcp-server`. Visible on the npm package pages.
- **F.95 Option C** — Generate MCP tool docs from `tools.ts`. Pairs with F.98.

**Tier 3 — keep an eye on:**
- **F.95 Option B** — Monorepo `designjs-docs/` into `packages/docs/`. The "right" answer architecturally, but requires a coordinated cutover with Mintlify deploy reconfig. Defer until a doc-drift incident makes the case.
- **F.97** — Code-repo `AGENTS.md`. Worth adding before v0.2 lands so chat-panel implementation has its own agent brief.
- **F.91** — Codify the operational-doc pattern in ADR convention.
- **F.93** — Top-level `ARCHITECTURE.md` (subsumed by F.100's README addition).

**Tier 4 — strategic:**
- The synthesis should consider whether the **doc-drift cluster justifies its own ADR** (ADR-0013 candidate alongside the cloud-tier ADR from deployment). Captures: single source of truth for derived facts, generation strategy for MCP tool docs, doc-repo structure decision.

---

**Next:** Phase 3 — Synthesis. Master review doc + new ADR proposals + recommendation prioritization across all 100 findings.
