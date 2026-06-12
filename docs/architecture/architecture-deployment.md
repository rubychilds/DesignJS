# Architecture review — Phase 2.5: Deployment deep dive

> Companion to the earlier phases. Read-only analysis of the npm publish flow, versioning strategy, tarball verification, Chrome extension distribution, Mintlify docs hosting, and the cloud-tier (Supabase) deployment readiness gap. Continues `[F.NN]` numbering — Phase 2.4 ended at F.61.
>
> Deployment is small surface today (3 npm packages, manual flow), so this doc is focused. The forward-looking material (Chrome Web Store + Supabase) is where most of the recommendations live.

## 1. The published-npm surface

Three packages on the registry as of `0.1.0` (local versions; npm registry not live-checked):

| Package | Latest local | Visibility | Bin | Public surface |
|---|---|---|---|---|
| `@designjs/bridge` | `0.1.0` | published, `access: public` | — | Zod schemas + protocol constants (43-line `protocol.ts` + 260-line `tools.ts` + 3-line `index.ts`) |
| `@designjs/mcp-server` | `0.1.0` | published, `access: public` | `designjs-mcp` | Stdio MCP server (~200 LOC, pure forwarder onto bridge) |
| `create-designjs` | `0.1.0` | published | `create-designjs` | Project scaffolder (130 LOC + `template/` dir) |

Three private packages (build-only, never published):

| Package | Reason for private |
|---|---|
| `@designjs/app` | The Vite SPA. Runs locally; no npm artifact. |
| `@designjs/chrome-extension` | Web Store distribution path (not npm). Currently load-unpacked only. |
| `@designjs/cli` | Deferred per RELEASING.md — `designjs init` consolidated into `create-designjs` for v0.1. |

### 1.1 Package metadata is well-curated

All three published packages have:

```jsonc
{
  "files": ["dist", "README.md"],
  "publishConfig": { "access": "public" },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/rubychilds/DesignJS.git",
    "directory": "packages/<name>"
  },
  "homepage": "https://github.com/rubychilds/DesignJS/tree/main/packages/<name>#readme",
  "bugs": "https://github.com/rubychilds/DesignJS/issues",
  "license": "MIT",
  "keywords": ["designjs", "mcp", "model-context-protocol", "grapesjs", ...]
}
```

**[F.62] This is best-practice metadata for npm distribution.** Specifically:
- `files` field set explicitly — controls tarball contents (avoids accidentally publishing `src/`, `.tsbuildinfo`, etc.)
- `publishConfig.access: "public"` — required for scoped packages to publish publicly
- `repository.directory` — npm and GitHub know exactly where the package source lives in the monorepo
- `homepage` + `bugs` are URLs (best practice; pure-text bug-tracking links would be brittle)
- Keywords are well-curated and SEO-relevant (`mcp`, `model-context-protocol`, `claude`, `cursor`, `design-to-code`)
- Per-package licenses are MIT — matches the repo's MIT

**Worth keeping** as the surface grows; new published packages should mirror this shape.

### 1.2 Public API shapes

| Package | `main` | `exports` | `bin` | `types` |
|---|---|---|---|---|
| `@designjs/bridge` | `./dist/index.js` | `{ ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } }` | — | `./dist/index.d.ts` |
| `@designjs/mcp-server` | `dist/index.js` | — (just `main` + `bin`) | `{ "designjs-mcp": "dist/index.js" }` | — |
| `create-designjs` | — (no `main`) | — | `{ "create-designjs": "dist/index.js" }` | — |

**[F.63] `mcp-server` lacks an `exports` field.** Modern (post-Node 12) the `exports` field is the recommended way to declare entry points; it locks down what consumers can `require` / `import` from the package. Today, anyone could `require('@designjs/mcp-server/dist/internal-thing.js')` and create a hidden dependency. For a CLI-only package (mcp-server is only ever spawned via `bin`), this is **low severity** — no consumer imports it. But adding `exports` makes the contract explicit:

```jsonc
"exports": {
  "./package.json": "./package.json"
  // Nothing else — this package is a bin, not a library
}
```

Closes the back-door. Defensive and cheap.

### 1.3 Tarball contents — verified

Ran `pnpm pack` against `create-designjs/` to inspect actual contents:

```
package/dist/index.js
package/dist/index.d.ts
package/dist/index.d.ts.map
package/dist/index.js.map
package/template/.mcp.json
package/template/CLAUDE.md
package/template/README.md
package/README.md
package/package.json
package/LICENSE   ← workspace-root inheritance
```

Note the surprising one: **`LICENSE` is in the tarball even though `ls packages/create-designjs/LICENSE` returns no file.** pnpm pack picks it up from the workspace root via npm's auto-inclusion rule (`license` field set in package.json + LICENSE at workspace root → tarball gets it).

**[F.64] `create-designjs` relies on implicit workspace-root LICENSE inheritance.** Per the alpha.1 CHANGELOG entry: *"LICENSE file in `packages/bridge` and `packages/mcp-server` so it ships in the tarballs (previously only `create-designjs` had its own)."* That implies `create-designjs` *used to* have its own LICENSE. It doesn't anymore. The workspace inheritance compensates today; if RELEASING.md or pnpm semantics change, the LICENSE could silently vanish from the published tarball. **Fix: copy `LICENSE` into `packages/create-designjs/`** for consistency with the other two published packages.

The same is presumably true for any future published package — explicit per-package LICENSE files prevent surprises.

### 1.4 `mcp-server` ships without source maps

| Package | `dist/` contents |
|---|---|
| `bridge/dist` | `index.{js,d.ts,d.ts.map,js.map}` × 3 files (12 total) — full source + declaration maps |
| `mcp-server/dist` | `index.{js,d.ts}`, `bridge-client.{js,d.ts}` (4 files) — **no maps** |
| `create-designjs/dist` | `index.{js,d.ts,d.ts.map,js.map}` (4 files) — full maps |

Per per-package tsconfig (from Phase 2.1):
- `bridge`: `declarationMap: true`, `sourceMap: true`
- `mcp-server`: just `declaration: true` — **no maps**
- `create-designjs`: full maps (own config, has declarationMap + sourceMap)

**[F.65] `mcp-server` tsconfig is missing `declarationMap` + `sourceMap`.** Inconsistent with the other two published packages. Impact: when an agent's `mcp-server` errors stack-trace through compiled JS without sourcemaps, the trace lines don't map back to TypeScript source — harder to debug failure reports. Add to `mcp-server/tsconfig.json`:

```jsonc
"declarationMap": true,
"sourceMap": true,
```

Lands in next release. Worth bundling with F.07 (protocol versioning) and F.51 (bridge auth) into a single coordinated bridge+mcp-server release.

## 2. Versioning strategy

### 2.1 v0.1 shared-version lockstep

All three published packages tracked the same version through v0.1: `0.1.0-alpha.0` → `0.1.0-alpha.1` → `0.1.0`. RELEASING.md justifies this:

> All three public packages share a version today (`0.1.0-alpha.0` → `0.1.0-alpha.1` → `0.1.0`). Independent versioning is an option once the surface stabilises.

**This was the right call for v0.1.** A single-version lockstep means:
- Users install matching versions trivially (`npm install @designjs/bridge@latest @designjs/mcp-server@latest create-designjs@latest`)
- The bridge ↔ mcp-server protocol contract is implicit in "same version"
- Release ergonomics are simple (bump three package.json files, publish)

### 2.2 The case for going independent in v0.2

The forward-looking specs in `DesignJS-Notes/` change the change-frequency calculus:

| Package | Change frequency v0.2+ |
|---|---|
| `@designjs/bridge` | **Low-to-medium** — protocol additions (chat dispatcher origin tags, SWARM capability scoping, project-context handshake, bridge token field) |
| `@designjs/mcp-server` | **Very low** — pure forwarder, only changes when bridge schema changes |
| `create-designjs` | **Medium** — template updates (new IDE configs, new providers, settings.json shape changes) |

Lockstep means every `create-designjs` template tweak bumps the bridge version too — version pollution. **[F.66] Recommend transition to independent versioning in v0.2.** Combine with Changesets adoption (F.39 from CI/DX) — Changesets handles independent versioning natively via the `linked` config (or by leaving the field empty).

Two concrete proposals:

```jsonc
// .changeset/config.json (proposed)
{
  "linked": [["@designjs/bridge", "@designjs/mcp-server"]],
  // bridge + mcp-server stay linked because the wire protocol is the contract
  // create-designjs goes independent
  "ignore": ["@designjs/app", "@designjs/chrome-extension", "@designjs/cli"]
}
```

The bridge ↔ mcp-server linkage ensures published mcp-server tarballs always declare a concrete bridge version that exists. RELEASING.md's manual verification step ("mcp-server's published tarball has `@designjs/bridge: <concrete-version>` not `workspace:*`") becomes Changesets' automatic behavior.

### 2.3 The protocol contract should become explicit

With independent versioning, the **wire protocol version** moves out of "same package version" and becomes an explicit field. This is exactly F.07 from the codebase deep dive (bridge protocol has no version negotiation). Combined work:

- `HelloMessage` gains `protocolVersion: "1"`
- `@designjs/bridge` exports `PROTOCOL_VERSION` constant
- `@designjs/mcp-server` declares the protocol version it speaks in its `hello`
- Bridge server rejects connections with mismatched `protocolVersion`

When bridge's protocol changes incompatibly, `PROTOCOL_VERSION` bumps. Bridge + mcp-server release together (because mcp-server's protocol-version constant has to update). This makes the contract enforceable + observable rather than implicit-in-version-alignment.

## 3. RELEASING.md assessment

Re-read with deployment-specific eyes (after the Phase 1 read).

### 3.1 Strengths

- **End-to-end pre-flight checklist** (7 items: CI green, e2e local, smokes, CHANGELOG drafted, README accurate, npm login + access, namespace claimed)
- **Per-package dry run** with explicit tarball-content + access-mode + bridge-version verification
- **Bridge published before mcp-server** because mcp-server's tarball declares a concrete bridge version — RELEASING.md uses `pnpm publish --recursive` which handles this automatically
- **`--no-git-checks`** flag is documented + justified (just-pushed clean tree triggers pnpm's false-positive check)
- **Post-publish verification** via `npm view @designjs/<pkg> versions` ensures the publish actually happened
- **Tag + GitHub release** as the final step, attaching CHANGELOG.md notes
- **Hotfix release procedure** — branches from latest tag, fixes, version bumps, publishes, merges back
- **Rollback playbook** — `npm deprecate` (not unpublish) with a clear message, plus a new patch release

**This is genuinely above-average release process for a v0.1.** The bridge-version-in-tarball check is the kind of verification step most projects only add after they've been bitten by `workspace:*` leaking into a published package.

### 3.2 Gaps

- **[F.67] Manual flow has no audit trail beyond `git log`.** A `.github/workflows/release.yml` triggered by tag push or a Changesets release-PR would produce a CI log showing exactly what got built, what was published, what npm reported. Today the audit lives in Ruby's shell history.

- **[F.68] No automated CHANGELOG enforcement.** RELEASING.md says "CHANGELOG.md entry drafted" as a pre-flight item but no script verifies it. A `scripts/check-changelog.mjs` that asserts the current `package.json` version has a corresponding `## [<version>]` entry in CHANGELOG.md would close this. ~10-line script.

- **[F.69] No SBOM (software bill of materials) published.** For supply-chain-conscious downstream consumers (enterprise, federal, OSS auditors), an SBOM (CycloneDX or SPDX) shipped alongside each release is increasingly table-stakes. `cyclonedx-npm` generates one from the lockfile. Defer; raise when an enterprise user asks.

- **[F.70] No package provenance via npm.** The `npm publish --provenance` flag (since npm 9.5) signs published packages with a verifiable link to the GitHub Actions run that produced them. Requires CI-based publish (so depends on F.30 / F.67). High-trust signal for security-conscious users. Adopt when the release workflow lands.

## 4. Chrome extension distribution

### 4.1 Build pipeline

`packages/chrome-extension/package.json`:

```jsonc
"scripts": {
  "build": "webpack --mode=development",
  "build:prod": "NODE_ENV=production webpack --mode=production",
  "dev": "webpack --mode=development --watch",
  "package": "NODE_ENV=production webpack --mode=production && cd dist && zip -r ../designjs-extension.zip ."
}
```

Webpack config has two entry points: `background` (service worker) and `content` (content script). Both bundled to `dist/<name>.bundle.js`. `dist/` size: **3.1 MB** (development mode; production bundle would be smaller).

### 4.2 Current install path

Per README's "Capture web pages with the Chrome extension" section:

```
pnpm install
pnpm --filter @designjs/chrome-extension build
# Then: chrome://extensions → Developer mode → Load unpacked → packages/chrome-extension/dist/
```

**Load-unpacked is the only install path today.** Works for dev + early adopters; not viable for the v0.3 public launch.

### 4.3 [F.71] Chrome Web Store submission is gating v0.3 public

README + roadmap make this explicit: *"Chrome Web Store submission (gating public v0.3 availability)."* The work:

1. **Production build artifact** — `pnpm --filter @designjs/chrome-extension package` produces `designjs-extension.zip`. This is the upload artifact.
2. **Developer account** — Google Developer registration ($5 one-time fee per Google's pricing).
3. **Store listing** — name, description, screenshots, privacy policy, support URL.
4. **Review process** — typically 1-3 business days for MV3 extensions with `host_permissions` limited to localhost.
5. **CI verification** — no current step builds the extension. **[F.72] Add a CI step to `pnpm --filter @designjs/chrome-extension build:prod` in the `verify` job.** Catches broken extension builds before they land on `main`.
6. **Versioning** — Web Store auto-bumps with each upload; the package.json `version` in `manifest.json` should match the package.json's `version` field. Webpack config doesn't currently inject this; recommend a `DefinePlugin` or `manifest.json` template + build step that fills in the version from `package.json`.

### 4.4 [F.73] Chrome extension bundle size is high

3.1 MB dev bundle. Production will be smaller (minification + tree-shaking) but the React + capture pipeline + style serializer is intrinsically chunky. Chrome Web Store has a 10 MB hard limit; under it but worth a budget. Recommended:

- Add `size-limit` to the chrome-extension package
- Set per-bundle budget: 1.5 MB content, 500 KB background (rough first-pass values)
- CI step fails if exceeded

This is a Tier-3 recommendation; the bundle isn't a real problem at 3.1 MB but should be monitored as v0.3 capture-pipeline work continues to grow it.

### 4.5 Auto-updates via Chrome Web Store

Once submitted, the Web Store handles auto-update. The package.json's `manifest.json.update_url` is auto-populated when the extension lives on the Store. **Recommendation: bridge token (F.51) updates need to be backward-compatible with extensions that haven't auto-updated yet** — keep the token field optional in the protocol for at least one minor release after introducing it.

## 5. Mintlify docs site

`designjs-docs/` is a self-contained Mintlify docs site, separate from the code repo's `docs/` directory.

### 5.1 Configuration

`designjs-docs/docs.json`:

```jsonc
{
  "name": "DesignJS",
  "theme": "luma",
  "seo": {
    "metatags": {
      "og:url": "https://opencanvas.mintlify.app",   // ← STALE: pre-rebrand
      "og:title": "DesignJS — An open-source MCP design canvas..."
    },
    "indexing": "all"
  },
  "logo": { "light": "https://media.brand.dev/...", "dark": "..." }
}
```

**[F.74] `docs.json` has stale rebrand URL.** `og:url` points at `opencanvas.mintlify.app` instead of the post-rebrand site. Need to (a) figure out whether the Mintlify site has been migrated to a new subdomain, (b) update the OG metadata. Verify via `curl -I https://opencanvas.mintlify.app` (still resolves?) and `curl -I https://designjs.mintlify.app` (registered?). One of those answers is the source of truth.

**Same drift seen elsewhere:**
- `designjs-docs/llms.txt` (from recon) still uses `https://opencanvas.mintlify.app` links
- This is part of the broader "rebrand sweep" cluster — at least 3 places (`docs.json`, `llms.txt`, README's MCP tool count)

### 5.2 Auto-deployment via Mintlify

Mintlify auto-deploys on push to `main` (the default integration). The `.mintignore` file is well-configured. No CI workflow in `.github/workflows/` for docs — Mintlify handles it.

**Implication:** **[F.75] Docs deployment is opaque to the project's CI.** A broken MDX file would deploy a broken docs site without `verify`/`e2e` catching it. Recommended:

- Add a `pnpm --filter designjs-docs lint` or `pnpm --filter designjs-docs build` step (if Mintlify CLI supports it) to verify MDX validity in CI
- OR: GitHub Actions step `mintlify-cli check` if Mintlify ships one

### 5.3 Docs coverage of MCP tools

From the recon: `designjs-docs/mcp/` has 14 MCP tool reference pages. Current tool list is 22. **Missing tool reference docs:** `add_css_rules`, `add_classes`, `remove_classes`, `set_text`, `fit_artboard`, `select`, `deselect` — likely overlap with the 8 missing pages. Phase 2.7 (docs deep dive) will produce the actual coverage matrix.

## 6. Cloud tier readiness — Supabase handoff

DesignJS today is local-first by design. The forward-looking specs (chat panel, repo connection, projects gallery) describe a future cloud tier built on Supabase. **No Supabase code exists today.** This section assesses the deployment posture for that future tier.

### 6.1 What the specs imply

| Spec | Cloud-tier infrastructure |
|---|---|
| `ai-chat.md` | Optional cloud-hosted Settings → AI Providers backup (so users don't lose keys on machine swap) |
| `repo-connection.md` | GitHub App with `pem` in Supabase Edge Function env (vs OAuth-PKCE for local-first) |
| `projects.md` | Cloud sync of `~/.designjs/projects.json` index; multi-machine "one merged list" |
| `sandbox-preview.md` | CodeSandbox SDK with DesignJS-provided API key for free tier, BYOK for power users |
| `swarm.md` | Hosted MCP relay if SWARM agents run server-side; not explicitly required |

### 6.2 [F.76] No cloud-tier deployment story yet — and that's correct

Today's state matches today's product. Adding cloud-tier infrastructure before user demand exists would be premature optimization. **The right move now is to capture the architectural decisions in an ADR before implementation**, so when the cloud tier ships, deployment is calibrated:

- **ADR-0013 (proposed): Cloud tier — Supabase as the backbone.** Captures: Supabase project structure, Edge Functions vs Auth vs Storage vs Postgres allocation, env-var management strategy, dev/staging/prod separation, secrets storage (NPM_TOKEN, GITHUB_APP_PEM, etc.), domain + DNS plan, GDPR / SOC2 / data residency considerations.

This is one of the ADRs the synthesis should propose.

### 6.3 What needs to land before cloud tier ships

A pre-flight checklist for the synthesis:

1. **Environment management story** — `.env.example` at root; per-environment `.env.development` / `.env.production`; env-var validation at boot (Zod-based, like Hono's `c.env` pattern)
2. **Secrets in CI** — `NPM_TOKEN` (already required for Changesets release workflow per F.39), `SUPABASE_*` secrets, `GITHUB_APP_PRIVATE_KEY` for the cloud-tier OAuth
3. **Database migrations** — `supabase/migrations/` directory + the Supabase CLI in devDeps; migrations versioned + reviewable in PRs
4. **Cloud-tier observability** — Supabase Logs + Sentry for the Edge Functions; PostHog for product analytics (referenced in Phase 2.6)
5. **Cost monitoring** — Supabase has per-project cost dashboards; alert thresholds to set at 50% / 80% / 100% of monthly budget

### 6.4 [F.77] No `.env.example` or env-config story today

Not a problem today (no env to configure). **Becomes a problem the moment any API key, OAuth token, or Supabase URL needs to be configured.** Cheap one-time setup:

```
# .env.example
# Optional: override the bridge port (default: 29170)
# DESIGNJS_BRIDGE_PORT=29170

# v0.2+ — populated when API key storage lands
# OPENROUTER_API_KEY=
# ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
```

Plus a `packages/app/src/env.ts` Zod schema that validates env at boot. Pattern matches well-deployed projects (Hono / Bun / Vercel).

## 7. Findings rollup

| # | Finding | Severity | Effort |
|---|---|---|---|
| F.62 | Package metadata is best-practice across all 3 published packages (positive) | n/a | n/a |
| F.63 | `mcp-server` lacks `exports` field — defensive contract is implicit | Low | XS (~5 min) |
| F.64 | `create-designjs` LICENSE lives at workspace root, not in package dir — fragile | Low | XS (copy file) |
| F.65 | `mcp-server` tsconfig missing `declarationMap` + `sourceMap` | Low (debug ergonomics) | XS (~2 lines) |
| F.66 | Recommend independent versioning + linked-bridge-mcp-server with Changesets | Med | M (depends on F.39) |
| F.67 | Manual release flow has no audit trail beyond git log | Low-Med | M (depends on F.39 release workflow) |
| F.68 | No CHANGELOG enforcement script | Low | XS (~10-line script) |
| F.69 | No SBOM published with releases | Low | S (defer until enterprise user asks) |
| F.70 | No npm provenance via `--provenance` flag | Med (security) | S (depends on F.67 / CI publish) |
| F.71 | Chrome Web Store submission pending — gates v0.3 public | High (product blocker) | L (per Google's review process) |
| F.72 | No CI step builds chrome extension dist | Med | XS (~5 lines of YAML) |
| F.73 | Chrome extension bundle size unbudgeted (3.1 MB today) | Low | S (~1h to wire size-limit) |
| F.74 | Mintlify `docs.json` OG URL is stale (pre-rebrand) | Low (SEO) | XS |
| F.75 | Docs site deploy is opaque to project CI | Low | XS (~10 lines, IF Mintlify supports build-only mode) |
| F.76 | Cloud-tier deployment story needs an ADR before implementation | Med (forward-looking) | M (ADR drafting, ~half day) |
| F.77 | No `.env.example` / env-config story | Low today / Med v0.2 | XS (one file + Zod schema later) |

## 8. Risk tiers

**Tier 1 — fix-in-the-week:**
- F.63 — Add `exports: { "./package.json": "./package.json" }` to `mcp-server/package.json`. 1 line.
- F.64 — Copy `LICENSE` into `packages/create-designjs/`. Eliminates the workspace-inheritance fragility.
- F.65 — Add `declarationMap` + `sourceMap` to `mcp-server/tsconfig.json`. 2 lines.
- F.68 — `scripts/check-changelog.mjs` enforcement.
- F.72 — Add `pnpm --filter @designjs/chrome-extension build:prod` to CI's `verify` job.
- F.74 — Update `docs.json` OG URL. Part of the broader rebrand-drift cleanup that Phase 2.7 will surface.

**Tier 2 — fix-this-quarter:**
- F.66 — Independent versioning via Changesets (linked bridge ↔ mcp-server). Combine with F.39 from CI/DX.
- F.67 + F.70 — Release workflow with `npm publish --provenance`.
- F.71 — Chrome Web Store submission. The gating work for v0.3 public.
- F.76 — Cloud-tier ADR (ADR-0013 candidate).
- F.77 — `.env.example` + env-validation. Before any v0.2 key-storage code lands.

**Tier 3 — keep an eye on:**
- F.69 — SBOM (when enterprise users ask).
- F.73 — Chrome extension bundle size budget (when v0.3 capture-pipeline growth threatens 10 MB Store limit).
- F.75 — Docs CI verification.

**Tier 4 — strategic:**
- The synthesis should consider whether to **adopt a single "v0.2 release-readiness gate"** — F.39 (Changesets) + F.66 (independent versioning) + F.67 (release workflow) + F.70 (provenance) + F.65 (mcp-server sourcemap parity) + F.51 (bridge auth) bundled. This is the migration from manual-disciplined to CI-automated releases. Recommended timing: after Track A or Track B's first real PR lands.

---

**Next:** Phase 2.6 — Observability deep dive.
