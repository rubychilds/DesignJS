# Architecture review — Phase 2.3: CI / DX deep dive

> Companion to [`architecture-recon-2026-05-24.md`](./architecture-recon-2026-05-24.md), [`architecture-codebase.md`](./architecture-codebase.md), and [`architecture-testing.md`](./architecture-testing.md). Read-only analysis of CI workflows, release process, code-quality automation, dependency hygiene, repository governance, and solo-dev sustainable DX. Continues the `[F.NN]` finding numbering — Phase 2.2 ended at F.22.
>
> **Two corrections to the recon doc surfaced here:** the recon claimed Dependabot was Actions-only, and undercounted the issue-template surface. Both corrected inline.

## 1. The CI surface (one workflow)

`.github/workflows/ci.yml` — re-examined now with full context. The recon covered the structure; this section assesses the quality + completeness.

### 1.1 What it does well

```yaml
on:
  push:        { branches: [main] }
  pull_request:{ branches: [main] }

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:  # typecheck + build + smoke
    runs-on: ubuntu-latest
    timeout-minutes: 10
  e2e:     # Playwright chromium
    runs-on: ubuntu-latest
    timeout-minutes: 15
```

**Solid foundations:**
- Concurrency cancellation per ref — no zombie runs on rapid pushes
- Reasonable per-job timeouts (10 + 15 min) with measurable headroom (recon showed ~4-5 min typical for verify, ~7-9 min for e2e)
- Cache key honours pnpm via `setup-node`'s `cache: pnpm`
- Corepack enables exactly the `pnpm@9.12.0` version pinned in `package.json`
- The bridge round-trip smoke backgrounds `pnpm dev`, polls TCP `127.0.0.1:29170` for up to 20s before sending the smoke, then kills the process group on exit — robust pattern for dev-server-dependent smokes
- Playwright report uploaded only on failure (`if: failure()`) — saves artifact storage
- Action versions are current: `checkout@v6`, `setup-node@v6`, `upload-artifact@v7` (Dependabot just bumped these — see §4)

### 1.2 What's missing

The recon flagged these and they remain accurate after a re-read:

- **No lint job.** [F.23] No `pnpm lint` invocation. Combined with the per-package script absence (§3.1), lint isn't gating anything.
- **No SAST (CodeQL).** [F.26] GitHub provides CodeQL free for public repos. ~10 lines of YAML.
- **No `npm audit` / advisory check.** [F.27] Dependabot covers the periodic case; nothing catches a new advisory between Mondays.
- **No release workflow.** [F.30] RELEASING.md is the entire release surface today.
- **No scheduled / nightly job.** [F.35] No cross-browser test against Firefox/WebKit, no rolling supply-chain check.
- **No matrix.** Single Node 20, single chromium. Defensible at this stage; flag for v0.3+.

### 1.3 The verify job sequence is fragile

```yaml
- name: Build @designjs/bridge       # required before typecheck
- name: Typecheck all packages
- name: Unit tests
- name: Build all packages           # excludes bridge (already built)
- name: Bridge round-trip smoke
- name: MCP stdio smoke
- name: designjs init smoke
```

Two observations:

1. **Build-bridge-twice elsewhere:** the e2e job *also* runs the bridge build (`pnpm --filter @designjs/bridge build`). The `pnpm` cache speeds this up but it's still rerun in each job. With a Turborepo / Nx caching layer this would be one build, cached, reused. Track for v0.3 if CI minutes become a meaningful cost.

2. **Step ordering encodes hidden dependencies.** Typecheck runs *before* unit tests. Tests run *before* "Build all packages" — meaning unit tests can't import from a sibling's `dist/`. This works because bridge is the only package that produces compiled `dist/` for consumers, and its build happens first. **Fragile contract** if a new published package joins the workspace.

**[F.38] CI step ordering encodes an implicit build-dep DAG.** A `pnpm exec turbo run typecheck test build smoke` (or Nx equivalent) would make the DAG explicit and parallel-executable. Defer until size justifies — Phase 2.5 (deployment) will revisit if Changesets adoption nudges this.

## 2. Release process

### 2.1 The current state (RELEASING.md is gospel)

Re-read of [RELEASING.md](../../RELEASING.md) confirms the manual-but-disciplined v0.1 process. Highlights:

- **Pre-flight checklist** with 7 items (CI green, full e2e local, smokes, CHANGELOG drafted, README accurate, npm login + access, `create-designjs` namespace claimed)
- **Per-package dry-run** before publish (`npm publish --dry-run` per package) with explicit verification of tarball contents and the `@designjs/bridge` dep in `mcp-server`'s tarball — *not* `workspace:*`
- **Shared versioning** for v0.1: all three published packages bump together
- **Bridge published before mcp-server** because mcp-server's tarball declares a concrete bridge version
- **Rollback playbook**: deprecate (not unpublish) with a message; cut a new patch fixing the issue

This is **above-average release process for a v0.1**. Most pre-1.0 projects don't document hotfix releases, version-mismatch verification in tarballs, or the `npm view <pkg> versions` post-publish check.

### 2.2 The Changesets gap

RELEASING.md is explicit: "**v0.1 uses manual version bumps, not Changesets.**" The doc lists the blockers in §"Future: Changesets":

- Decide independent vs shared versioning across `@designjs/bridge`, `@designjs/mcp-server`, `create-designjs`
- Seed `.changeset/config.json` with the `ignore` list for `@designjs/app` and `@designjs/cli` (unpublished)
- Add `NPM_TOKEN` as a repo secret (with `publish` scope on `@designjs`) so the workflow can run unattended

**[F.39] Adopt Changesets after the in-flight Track A / Track B specs stabilize.** The blockers are explicitly listed in RELEASING.md. The win:
- Per-PR changelog entries that aggregate into `CHANGELOG.md` automatically (closes the F.36 PR-template-doesn't-reference-CHANGELOG gap implicitly — the template can ask "did you `pnpm changeset add`?")
- `pnpm changeset version` becomes the bump command — no hand-editing three `package.json` versions in sync
- Publish moves into CI on tag push — no maintainer holds local npm credentials
- Released artifacts get an automatic GitHub release with the right notes

**Cost:** ~2-3 hours setup (config + first changeset migration + release workflow). One-time. Pays dividends from release #2.

**Open decision:** independent vs shared versioning. RELEASING.md poses it but doesn't decide. The forward-looking specs (chat panel, repo connection, sandbox preview, SWARM) will primarily touch `@designjs/app` (unpublished) and add deps to `packages/app`. The published surface — bridge, mcp-server, create-designjs — changes less frequently. **Recommendation for the synthesis: independent versioning, each package on its own pace.** Shared versioning made sense for v0.1's lockstep release; the surface stabilizes differently per package.

### 2.3 The CHANGELOG.md is well-maintained

Reads cleanly:
- Keep-a-Changelog format
- Per-version sections (`[0.1.0]`, `[0.1.0-alpha.1]`, `[0.1.0-alpha.0]`)
- Sub-sections per kind (Added / Changed / Fixed)
- Links at the bottom to GitHub release tags
- The alpha.1 section documents the four multi-frame regressions with their root causes — *excellent* historical record

**One drift signal in CHANGELOG.md:** the `0.1.0` entry says *"`@designjs/mcp-server` exposes **20+ MCP tools**"* — actual is 22 (this is an "atomic" 22 across the published surface as of `main`, per `tools.ts`). Same drift as the README's "21 MCP tools." Single source of truth: `Object.keys(TOOL_SCHEMAS).length`. **[F.40] MCP tool count drifts across CHANGELOG.md, README.md, designjs-docs/, smoke-mcp.mjs.** A `scripts/check-doc-drift.mjs` that asserts these match `Object.keys(TOOL_SCHEMAS).length` (or generates them) would close the drift class. Mid-priority.

## 3. Code-quality automation — the hole

### 3.1 Lint: nothing, everywhere

```
@designjs/app:              lint=false
@designjs/bridge:           lint=false
@designjs/chrome-extension: lint=false
@designjs/cli:              lint=false
create-designjs:            lint=false
@designjs/mcp-server:       lint=false
```

**Zero of six packages has a `lint` script.** Root `pnpm lint` runs `pnpm -r lint` which iterates zero packages, returns 0, and silently no-ops. **CI's not enforcing lint because there's nothing to enforce.**

This was noted in the recon but understated. **[F.41] No ESLint anywhere in the project.** Implications:

- React hooks rules (`react-hooks/exhaustive-deps`, `react-hooks/rules-of-hooks`) — not enforced. Bugs the compiler can't catch silently pass.
- `import/no-cycle` — circular imports between bridge / app / canvas / components are possible without warning.
- `@typescript-eslint/no-floating-promises` — un-awaited promises pass silently. This is *the* common foot-gun in async React code.
- `@typescript-eslint/no-unused-vars` — TS catches unused locals but not unused parameters / unused imports of side-effect modules.
- `eslint-plugin-jsx-a11y` — accessibility on the chrome (especially modals + panels) goes unchecked.

**The TypeScript strictness is excellent**, but TS catches type errors, not logic / style / a11y patterns. ESLint catches what TS doesn't. Setting up a flat config (`eslint.config.js`) with `@typescript-eslint`, `react-hooks`, `import`, and `jsx-a11y` is **the highest-leverage DX win in the entire review** — a few hours of setup, then CI gates a broad class of bugs.

**Suggested shape:**
```js
// eslint.config.js (flat config)
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import importPlugin from "eslint-plugin-import";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/vendored/**"] },
  ...tseslint.configs.recommendedTypeChecked,
  reactHooks.configs.recommended,
  jsxA11y.flatConfigs.recommended,
  { rules: { "@typescript-eslint/no-floating-promises": "error" } },
);
```

Per-package `lint` script: `eslint src --max-warnings 0`. Root: `pnpm -r lint`. CI gates on it.

### 3.2 Format: nothing, everywhere

```
=== format / format-check scripts ===
(empty)
```

**[F.42] No Prettier or equivalent formatter.** With one contributor today the impact is invisible — Ruby has a consistent personal style. With Dependabot bot opening PRs and (eventually) other contributors, formatting drift will start. Cheap one-time install:

- `prettier` in root devDeps
- `.prettierrc.json` with minimal config (matches existing patterns: 2-space indent, double quotes, trailing comma, 100-char line)
- `.prettierignore` mirroring `.gitignore` plus `**/dist/**`
- Root `pnpm format` and `pnpm format:check` scripts
- CI runs `format:check` (not `format`) so unformatted code fails the build

### 3.3 No pre-commit hooks

```
=== huskyrc / lefthook / lint-staged ===
./opencode/.husky  (vendored — not ours)
```

**[F.43] No Husky / Lefthook / pre-commit.** When ESLint and Prettier land (F.41 + F.42), a pre-commit hook that runs `lint-staged` ensures every commit is clean *before* CI runs. Saves CI minutes and gives faster local feedback.

Recommended: **Lefthook** (faster than Husky, native config). Single `lefthook.yml` at root:

```yaml
pre-commit:
  parallel: true
  commands:
    eslint:
      glob: "*.{ts,tsx}"
      run: pnpm eslint {staged_files}
    prettier:
      glob: "*.{ts,tsx,md,json,yml}"
      run: pnpm prettier --check {staged_files}
```

### 3.4 No commit-message conventions

CHANGELOG entries are hand-written. Commit messages follow `area(scope): description` convention informally (per the codebase deep dive's recon of recent commits) — but nothing enforces it.

**[F.44] No commitlint or conventional-commits enforcement.** Optional; combines with Changesets (F.39) to auto-derive CHANGELOG from commit history. Defer; the current hand-written CHANGELOG quality is high enough that automation isn't urgent.

### 3.5 No `.editorconfig` / `.nvmrc`

```
=== root editorconfig / nvmrc / engines ===
(empty)
```

- **`.nvmrc`** with `20` lets contributors `nvm use` without thinking. Today `corepack` + `engines.node` in `package.json` (`>=20`) shoulder this; explicit `.nvmrc` is a one-line nicety.
- **`.editorconfig`** standardizes editor settings (tab width, trim trailing whitespace, final newline) across editors. Without it, contributors using different defaults drift the file.

**[F.45] Minor: missing `.nvmrc` + `.editorconfig`.** Low priority but cheap.

## 4. Dependency hygiene — Dependabot is well-configured (correction to recon)

The recon doc claimed: *"Dependabot enabled for Actions only, **no Dependabot for npm packages**."* **This is wrong.** Re-reading `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule: { interval: "weekly", day: "monday" }
    open-pull-requests-limit: 10
    groups:
      dev-dependencies:
        dependency-type: "development"
        update-types: ["minor", "patch"]
      prod-dependencies:
        dependency-type: "production"
        update-types: ["patch"]
    ignore:
      - dependency-name: "grapesjs"

  - package-ecosystem: "github-actions"
    directory: "/"
    schedule: { interval: "weekly", day: "monday" }
```

**This config is thoughtful:**

- **npm IS enabled.** Weekly Monday schedule. 10 PR limit (generous).
- **Grouped PRs.** Dev-deps bundled with `minor + patch`; prod-deps bundled with `patch only`. This is the conservative + correct pattern: prod deps get only safe semver bumps; dev deps can take minor risk.
- **GrapesJS explicitly ignored** — manual review only. Comment captures *why*: "canvas regressions are subtle." This is exactly the right call given the alpha.1 multi-frame regression class.
- **github-actions ecosystem** also weekly — visible in the recent merge history (PRs #3, #4, #5 in May 2026 bumped checkout to v6, setup-node to v6, upload-artifact to v7).

### 4.1 What's still missing from the supply-chain posture

Dependabot handles known-CVE patching. What it doesn't cover:

- **[F.46] No CodeQL / Semgrep SAST.** GitHub's `github/codeql-action/init@v3` is a 30-line workflow that runs free on public repos. Catches injection patterns, weak cryptography, hardcoded secrets, unsafe regex, etc. **High-value security baseline** — defer the depth to Phase 2.4 security deep dive, but the CI-infrastructure decision belongs here.

- **[F.47] No `npm audit` / `pnpm audit` in CI.** Dependabot opens PRs reactively; an audit step in `verify` fails the build if any known-vuln dep is in the lockfile *between* Monday Dependabot runs. ~1-line addition: `pnpm audit --audit-level=high` (or `moderate` for stricter).

- **[F.48] No secret-scanning workflow on PR.** GitHub's built-in push protection scans commits to the default branch and on certain push patterns; for PR-time gating, `gitleaks-action` runs on every PR and surfaces leaked keys before merge. Optional but cheap.

### 4.2 The grapesjs version-pin trade-off

Pinning grapesjs at `^0.22.16` and ignoring Dependabot bumps is correct *today* given the multi-frame regression class — but it also means **the project is one CVE-in-grapesjs-or-its-deps away from a manual fire-drill**. The mitigation:
- Monitor the GrapesJS GitHub releases / security advisories manually (or via `gh release watch`)
- When a security release lands, prioritize manual review + the full e2e suite before bumping
- Capture the assessment in an ADR addendum if the bump is non-trivial

This is the right trade-off. Just be intentional about the monitoring.

## 5. Repository governance

### 5.1 Issue templates — best-in-class

`.github/ISSUE_TEMPLATE/`:

- `bug_report.yml` (standard)
- `feature_request.yml` (standard)
- **`mcp_tool_request.yml`** — exceptional. The template:
  - Forces `snake_case`, `verb_noun` naming convention in the input description
  - Splits the request into: name → motivation ("What can't agents do today?") → input schema (TypeScript/Zod sketch) → output shape → example agent prompt + tool call → failure modes → roadmap fit dropdown
  - Pre-fills with a real example (`get_jsx`)
  - Labels: `mcp`, `feature`, `triage`
- `config.yml` — blank issues disabled, redirects general questions to Discussions

The `mcp_tool_request.yml` template is structurally aligned with how the codebase already adds tools (per CONTRIBUTING.md's 4-step process: schema in bridge → description → handler in app). **This is excellent.** Worth showcasing.

**One drift point: [F.49] the roadmap dropdown in `mcp_tool_request.yml` lists "v0.1 (existing 9 tools)" as the first option.** v0.1 is shipped; the tool count is now 22. Should be: `v0.1 (shipped — 22 tools)`, `v0.2`, `v0.3`, `Speculative / future`. One-minute update.

### 5.2 PR template

`pull_request_template.md`:

```markdown
## Summary
<!-- One or two sentences: what changed and why. Link to ADR / issue if relevant. -->

## Test plan
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes (unit)
- [ ] `pnpm test:e2e` passes (if canvas / bridge / extension touched)
- [ ] Manually verified in the app (if user-facing)

## Notes for reviewers
<!-- Anything risky, anything you skipped, anything you'd like a second opinion on. Delete if N/A. -->
```

**Solid.** Tests are a checklist (good — forces explicit acknowledgment). Test plan asks `pnpm test:e2e` only for certain areas, which is right.

**Missing:** [F.36 carries] no CHANGELOG.md update prompt. When Changesets lands (F.39), this gets replaced with "`pnpm changeset add` if user-visible."

### 5.3 CODEOWNERS

```
# Default owner for everything in the repo.
# When more maintainers join, add per-package rules above this line, e.g.:
#   /packages/bridge/        @rubychilds @other-maintainer
*  @rubychilds
```

Sole owner — `@rubychilds` for everything. The template comment for adding per-package rules is the right shape; just hasn't been needed yet.

**[F.50] No required-review branch protection.** With sole CODEOWNERS, GitHub doesn't gate on review. Manual discipline today; as the project grows, a "require 1 approval from CODEOWNERS" rule prevents unreviewed merges. Out-of-scope for solo dev; flag for when a second maintainer lands.

### 5.4 FUNDING.yml is commented-out

```yaml
# Uncomment and fill in the platforms you accept sponsorship on.
# GitHub renders a "Sponsor" button on the repo when at least one is set.
#
# github: [rubychilds]
# custom: ["https://example.com/donate"]
```

Explicitly opted out (or pending). Project-decision; not a finding.

### 5.5 ADR-0010 confirmed missing

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
docs/adr/0011-browser-extension-architecture.md
docs/adr/0012-capture-fidelity-evolution.md
docs/adr/README.md
```

**ADR-0010 is missing from the filesystem.** The README's index also skips 0010 — implying intentional reservation, not accidental deletion. Will dig into the cause in Phase 2.7 (docs deep dive). Not a CI/DX issue per se.

## 6. Per-package script consistency

| Package | dev | build | test | typecheck | lint | format |
|---|---|---|---|---|---|---|
| `@designjs/app` | ✅ vite | ✅ tsc --noEmit && vite build | ✅ vitest | ✅ tsc --noEmit | ❌ | ❌ |
| `@designjs/bridge` | ✅ tsc --watch | ✅ tsc | ✅ vitest | ✅ tsc --noEmit | ❌ | ❌ |
| `@designjs/chrome-extension` | ✅ webpack --watch | ✅ webpack | ✅ vitest | ✅ tsc --noEmit | ❌ | ❌ |
| `@designjs/cli` | ❌ (start only) | ✅ tsc | ❌ | ✅ tsc --noEmit | ❌ | ❌ |
| `create-designjs` | ❌ | ✅ (own build) | ❌ | ✅ tsc --noEmit | ❌ | ❌ |
| `@designjs/mcp-server` | ❌ (start only) | ✅ tsc | ❌ | ✅ tsc --noEmit | ❌ | ❌ |

**Patterns visible:**

1. **Bridge has watch-mode (`tsc --watch --preserveWatchOutput`)** — answers F.02 from the codebase deep dive. The script exists in `packages/bridge/package.json`. Root `pnpm dev` doesn't invoke it, but a contributor working on bridge can run `pnpm --filter @designjs/bridge dev` for live rebuilds. **Promote in CONTRIBUTING.md** as the workflow for bridge work.

2. **3 of 6 packages have no `test` script** — `cli`, `create-designjs`, `mcp-server`. Confirmed from the testing deep dive (F.NN there). The smokes (`smoke-init.mjs`, `smoke-create.mjs`, `smoke-mcp.mjs`) substitute for unit tests at the package level. **For `create-designjs` and `@designjs/mcp-server` (both published), per-package unit tests with vitest would catch regressions before smoke.**

3. **The `prepublishOnly` script** is set on `bridge`, `create-designjs`, and `mcp-server` (the three published packages). It runs `tsc` to ensure the published artifact has fresh `dist/`. Good safety net. **`@designjs/app` has no `prepublishOnly`** — by design (it's never published).

## 7. Solo-dev DX considerations

The user is a solo developer (confirmed in earlier conversation). DX recommendations should be calibrated to this.

### 7.1 What's already optimized for solo

- **Manual release process** — `RELEASING.md` is comprehensive and low-overhead. For a solo project doing 1-2 releases a month, automation is over-engineering.
- **Dependabot grouping** — 10 PRs/week is a lot to review solo, but grouping cuts that to ~2-3 PRs/week (one for dev deps, one for prod deps, one for actions). Manageable.
- **Single CI workflow** — simpler than 4 specialized workflows. Solo dev doesn't need separation-of-concerns at this scale.
- **`reuseExistingServer: !CI`** in Playwright — local dev reuses the running dev server; CI fresh-boots. Both right for their context.

### 7.2 What would speed solo iteration

- **F.41 (ESLint).** The single biggest pain-point reducer. ESLint catches React-hook bugs at edit time in the editor (via the language-service integration), not at PR time. Saves Slack-with-yourself debugging.
- **F.43 (pre-commit hooks).** `lefthook` runs `eslint` + `prettier --check` on changed files in <1s. Local feedback before push beats CI feedback after.
- **F.21 (retry observability) + F.13 (drop retries).** Today CI green ≠ no flakes. With 1-3 attempts allowed, a real flake costs you time only when it's bad enough to fail all 3 attempts. Surfacing retried-passes lets you fix flakes you don't know exist.
- **F.16 (self-updating smoke-mcp.mjs).** Pure DX — never edit the EXPECTED_TOOLS list again.

### 7.3 What's over-engineered for solo

- **Multiple workflows / matrix testing.** Defer. Single workflow is fine.
- **Changesets right now.** RELEASING.md is faster for the current release cadence (manual edit of 3 package.json files takes <2 min). Adopt Changesets when independent versioning becomes a real need (Track A/B may trigger this).
- **CODEOWNERS automation.** No second maintainer; the sole-owner config is correct.

## 8. Forward-looking: CI for v0.2/v0.3

The track-A and track-B scaffolds are merged-able today as empty scaffolds. As real implementation lands, the CI needs to grow.

### 8.1 What the in-flight specs add

| Spec | New CI need |
|---|---|
| AI chat panel (Track A) | Mock-LLM E2E (msw + AI SDK testing). New env var `OPENROUTER_API_KEY` for any *real* tests (kept out of CI; nightly only). |
| Repo connection (Track B) | Mock GitHub OAuth callback. `isomorphic-git` unit tests against in-memory FS. Bundle-size budget for `isomorphic-git` + ZenFS additions to `@designjs/app`. |
| Sandbox preview | WebContainers smoke (browser-only, flaky in CI). Likely **nightly-only** until the sandbox stabilizes. |
| Projects gallery | `~/.designjs/projects.json` r/w unit tests (Node fs + tmpdir). |
| SWARM mode | Property-based tests for the lock primitive (fast-check). |

### 8.2 Recommended CI evolution

**Near-term (v0.2):**
- Add ESLint job (F.41) — gate before unit tests
- Add format-check job (F.42) — fast-fail before lint
- Add `pnpm audit` step (F.47) — fast-fail in verify
- Add CodeQL workflow (F.46) — runs on PR + schedule
- Add JSON reporter + retry-stat post-step to e2e (F.21)
- Add nightly cross-browser job (F.14): Firefox + WebKit, separate from main e2e

**Mid-term (v0.3):**
- Adopt Changesets (F.39) + release workflow
- Sharding strategy for e2e (F.12) when test count grows past ~200
- Coverage upload (F.22) to Codecov or as build artifact

**Long-term (post-v1.0):**
- Bundle-size budgets per package (size-limit) — relevant once chat + ZenFS + isomorphic-git lands in `@designjs/app`
- Visual regression baseline updates as a labeled-PR workflow

## 9. Findings rollup

| # | Finding | Severity | Effort |
|---|---|---|---|
| F.23 | (recon) No lint job in CI | High (DX/quality) | M (depends on F.41 first) |
| F.25 | (recon correction) Dependabot npm IS configured; corrected | n/a | n/a |
| F.26 | No CodeQL / SAST in CI | Med (security) | XS (~30 min) |
| F.27 | No `pnpm audit` step in CI | Low-Med | XS (~10 min) |
| F.28 | No PR-time secret scanning | Low | XS |
| F.30 | No release workflow | Low (manual works) | M (depends on F.39) |
| F.35 | Single CI workflow; no scheduled or nightly | Low | S (add nightly cross-browser) |
| F.36 | PR template doesn't reference CHANGELOG | Low | XS |
| F.38 | CI step ordering encodes implicit build-dep DAG | Low | n/a (track) |
| F.39 | Adopt Changesets after Track A/B stabilizes | Med (release ergonomics) | M (~2-3h setup) |
| F.40 | MCP tool count drifts across CHANGELOG / README / docs / smoke | Low | S (script + run) |
| F.41 | **No ESLint anywhere — biggest DX win available** | **High** | M (~3-4h setup) |
| F.42 | No Prettier or equivalent | Med | XS (~30 min) |
| F.43 | No pre-commit hooks (Lefthook / Husky) | Med | XS (depends on F.41+F.42) |
| F.44 | No commitlint / conventional-commits | Low | n/a (defer) |
| F.45 | Missing `.nvmrc` + `.editorconfig` | Low | XS |
| F.46 | No SAST baseline | Med (security) | XS |
| F.47 | No `npm audit` baseline | Low-Med | XS |
| F.48 | No PR-time secret scanning workflow | Low | XS |
| F.49 | MCP tool issue template's roadmap dropdown lists "v0.1 (existing 9 tools)" | Low | XS (~1 min) |
| F.50 | No required-review branch protection (single owner) | Low | n/a (defer until 2nd maintainer) |

## 10. Risk tiers

**Tier 1 — fix-in-the-week:**
- F.41 + F.42 + F.43 — Install ESLint + Prettier + Lefthook in one go. The biggest single DX improvement available. 3-4 hours for all three, gates a broad class of bugs forever after.
- F.49 — Update the MCP tool issue template's stale roadmap dropdown. 1 minute.
- F.36 — Add CHANGELOG.md prompt to PR template. 2 minutes.

**Tier 2 — fix-this-quarter:**
- F.46 + F.47 — CodeQL + `pnpm audit` in CI. ~30 min total. Closes the SAST baseline gap.
- F.39 — Adopt Changesets. ~2-3 hours. Recommended timing: after Track A or Track B's first real PR lands and forces independent-vs-shared versioning decisions.
- F.40 — Doc-drift checker script for MCP tool count.
- F.45 — `.nvmrc` + `.editorconfig`.

**Tier 3 — keep an eye on:**
- F.30 — Release workflow (depends on F.39 first)
- F.35 — Nightly cross-browser job
- F.38 — Build-graph automation if a 3rd publishable package joins
- F.50 — Branch protection when a second maintainer lands

**Tier 4 — strategic:**
- F.44 — Conventional commits + commitlint, if Changesets adoption justifies
- Bundle-size budgets per package as v0.3 specs land

---

**Next:** Phase 2.4 — Security deep dive.
