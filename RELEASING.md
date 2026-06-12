# Releasing DesignJS

Maintainer-facing process for cutting a new release. DesignJS is a local-first tool, so "release" here means **publishing the npm packages** and **cutting a GitHub release**, not deploying a hosted service.

## What gets published

| Package | npm name | Public? | Purpose |
|---------|----------|---------|---------|
| `packages/bridge` | `@designjs/bridge` | ✅ | Shared Zod schemas and protocol constants. Consumed by the canvas and the MCP server. |
| `packages/mcp-server` | `@designjs/mcp-server` | ✅ | The `designjs-mcp` stdio binary that agents spawn. Depends on `@designjs/bridge`. |
| `packages/create-designjs` | `create-designjs` | ✅ | The `npm create designjs@latest` project scaffolder. Drops `.mcp.json` + `CLAUDE.md` + `README.md` into a fresh project. |
| `packages/cli` | `@designjs/cli` | ❌ (`private: true`) | `designjs init` auto-detects IDEs and writes the right MCP config. Not published in v0.1 — users write `.mcp.json` by hand or use `create-designjs`. |
| `packages/app` | *(not published)* | ❌ | The Vite + React canvas SPA. Runs locally via `pnpm dev` from the repo; no npm artifact. |

## Versioning

**v0.1 uses manual version bumps, not [Changesets](https://github.com/changesets/changesets).** The Changesets tooling is not installed (`@changesets/cli` is not a devDependency, there is no `.changeset/` directory, and no release workflow runs it on tag pushes). Installing it is a follow-up for v0.2 — see [Future: Changesets](#future-changesets) at the bottom.

All three public packages share a version today (`0.1.0-alpha.0` → `0.1.0-alpha.1` → `0.1.0`). Independent versioning is an option once the surface stabilises.

## Release steps (manual, current process)

The following is the exact flow used for `0.1.0-alpha.1`. Follow it verbatim until Changesets lands.

### 1. Pre-flight

- [ ] CI is green on `main` — `verify` (typecheck + lint + audit + build + smokes), `e2e` (Playwright chromium), and **CodeQL** jobs all pass on the commit you intend to publish
- [ ] **Cross-browser nightly is green** — last `E2E cross-browser` run (Firefox + WebKit) on `main` passed. Trigger a manual `workflow_dispatch` run if the last scheduled one is stale (more than 2 days old).
- [ ] Local quality gates pass:
  - `pnpm typecheck` — all packages
  - `pnpm lint` — ESLint clean (or remaining warnings acknowledged)
  - `pnpm format:check` — Prettier clean
  - `node scripts/check-doc-drift.mjs` — README MCP tool count / e2e test count match `tools.ts` and `e2e/`
  - `node scripts/check-changelog.mjs` — every published-package version has a `## [<version>]` CHANGELOG heading
- [ ] Full local E2E suite passes: `pnpm test:e2e`
- [ ] Bridge + MCP smokes pass: `pnpm smoke:bridge`, `node scripts/smoke-mcp.mjs`, `node scripts/smoke-create.mjs`
- [ ] [CHANGELOG.md](./CHANGELOG.md) entry drafted for the new version — covers user-facing changes, acks pre-existing bugs fixed, notes breaking changes
- [ ] README, docs, and RELEASING.md are accurate for the release
- [ ] You're logged into npm with publish access on the `@designjs` scope: `npm whoami` returns your user, `npm access list packages @designjs` shows `read-write` on `@designjs/bridge` and `@designjs/mcp-server`
- [ ] For scoped packages, `create-designjs` namespace availability already claimed

### 2. Bump versions

From a clean `main`, in the same commit:

```bash
git checkout main && git pull
```

Edit each publishable package's `package.json` and bump the `version` field:

- `packages/bridge/package.json`
- `packages/mcp-server/package.json`
- `packages/create-designjs/package.json`

(All three share a version in v0.1. Keep them in sync.)

### 3. Build + dry-run

```bash
pnpm --filter @designjs/bridge --filter @designjs/mcp-server --filter create-designjs build

# Per-package dry run — verifies auth, tarball contents, access scope without publishing
(cd packages/bridge         && npm publish --dry-run)
(cd packages/mcp-server     && npm publish --dry-run)
(cd packages/create-designjs && npm publish --dry-run)
```

Check each output:
- Tarball Contents lists **LICENSE + README + dist + package.json** and nothing unexpected (no src/, no .tsbuildinfo, no node_modules)
- `access: public` on the publishing line
- For `@designjs/mcp-server`: the rewritten `package.json` inside the tarball has `"@designjs/bridge": "<the current version>"` — *not* `workspace:*`. Verify with:
  ```bash
  cd packages/mcp-server && pnpm pack --pack-destination /tmp && \
    tar -xzOf /tmp/designjs-mcp-server-<version>.tgz package/package.json | \
    python3 -c "import json,sys; print(json.load(sys.stdin).get('dependencies'))"
  ```
- Verify the npm registry doesn't already have this version: `npm view @designjs/<pkg> versions` should not include the bump target. (Publishing over an existing version is blocked by the registry — the dry-run passes, the real publish fails.)

### 4. Commit + push

```bash
git add -A
git commit -m "chore: release v0.X.Y"
git push
```

Wait for CI to go green on the release commit before publishing — the CI run verifies the published code, not just the pre-release state.

### 5. Publish

Bridge must publish **before** `mcp-server` because mcp-server's tarball declares a concrete dependency on the new bridge version. `pnpm publish --recursive` handles the ordering automatically:

```bash
pnpm --filter @designjs/bridge --filter @designjs/mcp-server --filter create-designjs publish --no-git-checks
```

(The `--no-git-checks` flag is required because we just pushed and the working tree is clean; pnpm's default git-sanity check fires false positives in this state.)

Confirm on the registry:

```bash
npm view @designjs/bridge versions
npm view @designjs/mcp-server versions
npm view create-designjs versions
```

The new version should appear in all three lists.

### 6. Tag + GitHub release

```bash
git tag v0.X.Y
git push --tags

gh release create v0.X.Y \
  --title "v0.X.Y" \
  --notes-file CHANGELOG.md \
  --latest
```

Paste only the relevant CHANGELOG section into the release body if CHANGELOG.md is long — `--notes-file` attaches the whole file otherwise.

### 7. Post-release

- Announce in Discord / the public channel
- Update pinned demo links if the release includes a new demo GIF
- Close the GitHub milestone for this version

## Hotfix releases

For a patch release off the latest tag:

```bash
git checkout -b hotfix/v0.X.Y-hotfix <latest-tag>
# ...fix the bug, add a test, add a CHANGELOG entry
# bump all three publishable package.json versions to the patch target
git commit -am "chore: hotfix v0.X.(Y+1)"
pnpm --filter @designjs/bridge --filter @designjs/mcp-server --filter create-designjs build
(cd packages/bridge && npm publish --dry-run) && \
  (cd packages/mcp-server && npm publish --dry-run) && \
  (cd packages/create-designjs && npm publish --dry-run)
pnpm --filter @designjs/bridge --filter @designjs/mcp-server --filter create-designjs publish --no-git-checks
git tag v0.X.(Y+1) && git push --tags
gh release create v0.X.(Y+1) --title "v0.X.(Y+1)" --notes-file CHANGELOG.md
```

Merge the hotfix branch back into `main` afterwards.

## Environment / secrets

- **Local publishing** — you need to be logged into npm (`npm login`) with an account that has `read-write` on `@designjs` and has claimed `create-designjs`. `npm whoami` + `npm access list packages @designjs` verify both.
- **2FA** — if your npm account has 2FA enabled on publish, npm will prompt for an OTP during `pnpm publish`. A common gotcha: npm returns `E404` on a missing OTP instead of a clear auth error. If a publish fails with 404 and the package exists, it's likely 2FA.

## Rollback

If a bad release ships:

1. `npm deprecate @designjs/<pkg>@<version> "known issue, use <version-1>"` — do **not** `npm unpublish` unless it's within 72 hours and contains a secret (unpublishing permanently burns the version number).
2. Open a GitHub issue linking the CHANGELOG entry + the breakage.
3. Cut a new patch release fixing the issue rather than reverting the bad version.

## Future: Changesets

Once the v0.1 alpha cycle settles, the manual flow above should be replaced with [Changesets](https://github.com/changesets/changesets):

```bash
pnpm add -Dw @changesets/cli
pnpm changeset init
# ... adds .changeset/config.json + README, wires `pnpm changeset` into the workspace
```

Then a `.github/workflows/release.yml` that runs `pnpm changeset version && pnpm changeset publish` on tagged commits. This gives us per-PR changelogs that merge into CHANGELOG.md automatically, and pushes the publish step into CI so no maintainer needs local npm credentials.

Blocking tasks before Changesets lands:
- Decide on independent vs shared versioning across `@designjs/bridge`, `@designjs/mcp-server`, `create-designjs`
- Seed `.changeset/config.json` with the right `ignore` list for `@designjs/app` and `@designjs/cli` (unpublished)
- Add `NPM_TOKEN` as a repo secret (with `publish` scope on `@designjs`) so the workflow can run unattended

Not urgent for v0.1 patch releases — the manual flow is <5 minutes and leaves a visible audit trail in git. Revisit around v0.2.
