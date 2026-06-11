# Repository connection — GitHub + local folder

**Status:** Spec drafted 2026-05-24, not yet implemented. Pending placement in [opencanvas-roadmap.md](opencanvas-roadmap.md) (currently in the "Scratch — chat + repo + preview proposal" section at the bottom of the roadmap).

**Track:** B (repo-and-preview) · **Depends on:** _nothing_ · **Blocks:** [sandbox-preview.md](sandbox-preview.md), [component-discovery.md](component-discovery.md) · **Feature branch:** `feat/repo-connection`

**Why now:** Every closer competitor (Onlook, Dessn.ai, Pencil.dev, v0.dev, Lovable, Tempo Labs, Builder.io) ships some form of repo connection. DesignJS's local-first positioning lets it ship a backend-free version of this for v1 — a credible wedge against Onlook (who runs a Supabase backend + GitHub App) and Dessn (cloud-only, read-only).

## Goals

1. User can connect either a **GitHub repository** (via OAuth-PKCE) or a **local folder** (via File System Access API) so DesignJS knows where to save design files and — eventually — where to commit design changes back as code.
2. When a repo is connected, design changes accumulate on a feature branch (`designjs/<short-uuid>`), never directly on `main`/default.
3. DesignJS files (`.designjs.json` and related sidecars) save to the connected repo or folder, OR to a user-accessible default location if neither is connected.
4. The architecture stays **backend-free for v1** to preserve local-first positioning. A future cloud-hosted version will add a Supabase backend + GitHub App for hosted-tier features (webhooks, scheduled syncs, per-user repo access).

## Outcomes (when this ships)

- A user opening DesignJS can click "Connect Repo" and have their design file living inside their actual React codebase within 30 seconds.
- When they save the canvas, a commit lands on a `designjs/...` branch — reviewable as a PR.
- Users on Firefox or Safari can still use GitHub (no File System Access API needed there); the local-folder path is Chromium-only by reality.
- DesignJS works fine without ANY repo or folder — files save to a user-accessible default DesignJS folder.

## Decision log (2026-05-24)

| Decision | Outcome |
|---|---|
| GitHub auth (v1) | OAuth App with PKCE — browser-only, no backend required |
| GitHub auth (cloud tier) | Supabase + GitHub App — hosted tier feature, requires backend |
| Local folder | File System Access API. Detect if the selected folder is a git repo. |
| GitHub without local folder | Clone the GitHub repo into ZenFS (in-browser OPFS volume) so DesignJS can operate on it |
| File save location | If repo or folder connected → save inside it. Otherwise → user-accessible default DesignJS folder. Future → database (cloud). |
| Backend (v1) | None. Stay backend-free as long as possible. |
| Backend (cloud tier) | Supabase for auth + storage + Edge Functions for GitHub App webhook handlers |
| Browser limitations | Accepted for v1. Document clearly where things diverge by browser. |

## How competitors approach this (verified 2026-05-24)

- **Onlook** runs a Supabase backend with a GitHub App (`packages/github/src/auth.ts` uses `createAppAuth` with the App `pem` server-side). They clone repos into ZenFS in the user's browser tab, then write changes back via the App's installation-scoped Octokit client. Gold-standard model BUT requires a backend — DesignJS deliberately won't take that path until cloud-hosted.
- **Pencil.dev** doesn't really "connect" repos — it expects you to put your `.pen` files inside your repo (typically in a `/design` folder). The "connection" is just the user's git workflow, not Pencil's. Source: docs.pencil.dev/core-concepts/pen-files. **Implication for DesignJS:** if a user picks an existing folder that happens to be a git repo, just save `.designjs.json` files into it — git commits become the user's responsibility unless they also explicitly connect via OAuth.
- **Paper.design** connects to repos via MCP for syncing design tokens / styles / components between the canvas and the codebase. NOT a "render the app from the repo" pattern — it's a sync-of-design-system-primitives pattern. Worth noting as a v2 follow-up (component autodiscovery, see below).
- **Dessn.ai** has read-only repo access. They clone the repo into a cloud microVM, auto-render every React component with its props, and let designers compose with the user's real components. Cloud-only and read-only by design — they won't write back. **Implication for DesignJS:** component autodiscovery (scan connected repo → populate Components panel with React components) is a viable v2 feature, distinct from route/screen rendering.
- **v0.dev** uses bi-directional git sync (beta). Per-chat branch (`v0/main-<hash>`), commit per message, never pushes to main, "Open PR" button creates the PR. DesignJS adopts this branch pattern directly.

## Project types

DesignJS supports three project modes — a single user can have any mix of them:

1. **Repo-connected** — DesignJS files live inside a GitHub repository (cloned to ZenFS in-browser, or pointed at a local checkout). Design changes commit to a `designjs/<uuid>` branch; user can open a PR.
2. **Folder-connected** — DesignJS files live inside a local folder picked via File System Access API. The folder doesn't have to be a git repo; if it is, design saves can optionally commit + branch.
3. **Standalone** — No external connection. DesignJS files save to a user-accessible default location (`~/Documents/DesignJS/` or platform equivalent).

The same workspace can host multiple DesignJS projects of any type — see [projects.md](projects.md) for the gallery view + project switching UX.

## Architecture

### Entry paths

**(1) GitHub OAuth (PKCE, browser-only) — v1**

- Browser generates `code_verifier` + `code_challenge` + a cryptographically random `state` parameter (32 bytes, hex-encoded via `crypto.getRandomValues`)
- The `code_verifier` and `state` are written to `sessionStorage` before the redirect (NOT `localStorage` — `localStorage` survives tab close and is shared across tabs of the same origin, which is the wrong lifetime for a single-flight OAuth handshake)
- Only the `code_challenge` (SHA-256 of the verifier) and the `state` are placed on the authorize URL; the `code_verifier` itself never leaves the browser
- Redirect to GitHub OAuth authorize URL (with `state`, `code_challenge`, `code_challenge_method=S256`)
- Callback returns to the local dev server's `/oauth/github/callback` route (or `designjs://oauth/github` for a future desktop wrapper)
- On callback, the canvas reads `state` from the URL query params and asserts it matches the value previously stored in `sessionStorage`; mismatch (or missing `state` on the callback URL) aborts the flow with a clear `"OAuth state mismatch — possible CSRF attempt"` error and the `code_verifier` is discarded
- Exchange `code + code_verifier` → access token directly from browser (no client secret needed with PKCE)
- Token stored in `~/.designjs/secrets.json` (mode `0o600`) under `providers.github.token`
- Scope: `repo` (broad — per-repo restrictions require a GitHub App with backend, deferred to cloud tier)

> **Security note — why `state` matters even with PKCE:** PKCE protects the *token exchange* step (an attacker who intercepts the `code` can't redeem it without the `code_verifier`). It does NOT protect against a malicious site triggering an authorize redirect with their own callback URL embedded and tricking the user's browser into completing a flow that links the attacker's GitHub account into DesignJS. The `state` parameter is the CSRF token that binds the callback to the same browser session that started the flow. See [RFC 6749 §10.12](https://datatracker.ietf.org/doc/html/rfc6749#section-10.12). Tracked alongside the broader Track B security review in [docs/architecture/architecture-security.md § 8.2](../architecture/architecture-security.md) (F.59).

**(2) Local folder (File System Access API) — v1**

- `window.showDirectoryPicker({ mode: 'readwrite' })` returns a `FileSystemDirectoryHandle`
- Persist the handle to IndexedDB so DesignJS can re-request access across sessions
- `FileSystemObserver` (Chrome 129+) for external-edit detection — surface conflict warnings if the user's editor modified files between two canvas saves
- Polling fallback for browsers without `FileSystemObserver`

**Browser support reality:**

| Browser | GitHub path | Local folder path |
|---|---|---|
| Chrome / Edge / Opera | ✓ | ✓ (full read/write) |
| Firefox | ✓ | ⚠ Read-only via `<input type="file" webkitdirectory>` fallback (browser copies files into memory — no writeback) |
| Safari | ✓ | ⚠ Same fallback as Firefox |

Document this clearly so users don't expect local-folder writeback on Firefox/Safari.

### MCP integration: `get_project_context` + hello handshake

This is HOW DesignJS knows which repo/folder a connected agent is operating against. Currently not implemented; defined here as the v0.2 target.

**New MCP tool: `get_project_context`**

Returns the agent's project context to the canvas:

```json
{
  "projectRoot": "/Users/dana/my-app",
  "name": "my-app",
  "framework": "nextjs",
  "styling": "tailwind",
  "componentLibrary": "shadcn",
  "tailwindConfig": { "theme": { "colors": { "primary": "#1a5276" } } }
}
```

- `projectRoot` — derived from the agent's `process.cwd()` via nearest-ancestor `package.json` / `.git` lookup
- `name` — `package.json` `name` field, or the project root directory name
- `framework` — auto-detected from `package.json` dependencies: Next.js / React (CRA/Vite) / Vue / Svelte / plain HTML
- `styling` — auto-detected: Tailwind (from `tailwind.config.*`) / CSS Modules / Styled Components / vanilla CSS
- `componentLibrary` — auto-detected: shadcn/ui (from `components.json`) / Radix / Chakra / Material UI
- `tailwindConfig` — full parsed Tailwind config if Tailwind detected, for variable seeding

Implementation: MCP server reads `package.json`, `tailwind.config.*`, `tsconfig.json`, `components.json` from `projectRoot` on startup. Cached; re-read on file change via `fs.watch`.

**Hello handshake (canvas ↔ bridge):**

When an MCP client connects, the MCP server forwards `{ projectRoot, name }` to the WebSocket bridge as a `hello` message. The canvas responds by:

1. Switching the active design file to `<projectRoot>/design/<name>.designjs.json`
2. If the file exists → load it
3. If not → treat as a fresh project scoped to that root; offer to create on first save
4. Updates the Topbar to show the project name + path tooltip
5. Updates the gallery (see [projects.md § Agent connection → project routing](projects.md#agent-connection--project-routing)) — auto-creates a gallery entry if the project isn't tracked yet

**Multi-peer routing:**

The WebSocket bridge supports multiple concurrent MCP clients. Each client's `projectRoot` is tracked independently:

- Agent A connected from `/tmp/marketing-site` → operates against `/tmp/marketing-site/design/marketing-site.designjs.json`
- Agent B connected from `/Users/dana/dashboard` → operates against `/Users/dana/dashboard/design/dashboard.designjs.json`

The canvas UI shows multiple projects simultaneously (one tab per connected project, similar to a browser's tab strip) — see [projects.md](projects.md). Each tab's MCP tool calls are scoped to that project's file; a tool call from Agent A can't mutate Agent B's project.

**Path validation (security):**

The MCP server validates all file-path inputs to `add_components`, `update_styles`, etc. against the `projectRoot`:

- Reject any path containing `..` segments
- Reject any absolute path outside `projectRoot`
- Reject any symlink target outside `projectRoot`

This prevents a hostile prompt from causing an MCP tool to read/write arbitrary user files.

**`projectContext` metadata on tool responses:**

All MCP tool responses include a `projectContext` field with the same shape as `get_project_context` returns. This lets the agent reference framework/styling/library conventions without re-calling `get_project_context` per turn.

### Detecting git in a selected local folder

When a user picks a local folder:

1. Check for a `.git/` directory inside the handle
2. **If present:** treat as a git repo. Show the repo's current branch + dirty/clean state in the Topbar. Offer to create the `designjs/<uuid>` branch on first save.
3. **If absent:** treat as a plain folder. Save `.designjs.json` files directly. Show a "Initialize git" option in case the user wants to convert.

### Cloning a GitHub repo when no local folder is selected

If the user authenticates with GitHub but hasn't picked a local folder, DesignJS clones the repo into ZenFS (OPFS-backed in-browser filesystem):

```ts
import { clone } from 'isomorphic-git'
import http from 'isomorphic-git/http/web'
import { fs } from '@zenfs/core'

await clone({
  fs,
  http,
  dir: `/repos/${owner}-${name}`,
  url: `https://github.com/${owner}/${name}.git`,
  corsProxy: 'https://cors.designjs.dev', // self-hosted, not the free shared one
  onAuth: () => ({ username: githubToken }),
})
```

Operations happen in-browser against the ZenFS volume — same as Onlook's pattern.

**Self-host the CORS proxy.** GitHub doesn't send CORS headers on git endpoints, so push/clone require a proxy. The free shared `cors.isomorphic-git.org` is fine for personal/OSS use but not for production. Ship a `packages/cors-proxy` (~50 lines, `cors-anywhere` pattern) on the same origin as the DesignJS dev server.

### File save locations

```
Priority 1: Connected GitHub repo
            → /design/<project-name>.designjs.json
            (in the cloned ZenFS volume)

Priority 2: Connected local folder (git repo or not)
            → /design/<project-name>.designjs.json

Priority 3: No connection (default)
            → ~/Documents/DesignJS/<project-name>.designjs.json
            (or platform equivalent — XDG_DATA_HOME/designjs on Linux)
            User-accessible, browseable in Finder/Explorer.

Future:    Cloud-hosted DesignJS
            → Supabase Storage (blobs) + Postgres (metadata)
```

The `/design/` subdirectory matches Pencil's convention. Configurable via `designjs.config.json` if the user wants a different folder.

### Branch workflow (v0.dev pattern)

On connect (GitHub or local-git-repo):

1. Read `repo.default_branch` (GitHub API) or detect `main` / `master` (local git via isomorphic-git)
2. `git checkout -b designjs/<short-uuid>` from the default branch
3. Wire the canvas autosave to commit on this branch (NEVER directly to default)
4. Surface an "Open PR" button in the Topbar — creates a draft PR on first push, updates on subsequent pushes, never auto-merges

Differs from Lovable (auto-push every commit) and Onlook (Onlook does its own branch-per-design-session thing) — `designjs/<uuid>` keeps the namespace clean.

### Commit workflow (mirrors Onlook's `packages/git/src/git.ts`)

- On save: `git.add(changedFiles)` → `git.commit({ message: 'design: <intent>', author: { name: 'DesignJS', email: 'git@designjs.dev' } })`
- Append a human-readable note: `git.addNote('refs/notes/designjs-display-name', commit, '<readable description>')` — keeps commit subjects machine-parseable while preserving readable history when running `git log`
- `git.push()` only on explicit user action OR opt-in auto-push

### Files to mirror from Onlook (Apache-2.0, attribution preserved)

| Onlook package | DesignJS adaptation |
|---|---|
| `packages/code-provider/` | Provider abstraction with `CodeProvider` enum |
| `packages/file-system/` | ZenFS wrapper + File System Access API adapter |
| `packages/git/` | isomorphic-git wrapper (copy `git.ts` near-verbatim, change author) |
| `packages/github/` | Split into `oauth-browser.ts` (PKCE, v1) and `app-backend.ts` (cloud, later) |
| `packages/parser/ids.ts` | Defer — element-to-code OID injection only needed once design changes write back to source files (post-v1) |

### Cloud-hosted future (Supabase + GitHub App)

When DesignJS adds a hosted commercial tier:

- **GitHub App** (not OAuth App) — per-repo permissions, short-lived installation tokens, webhooks
- **Supabase Auth** for user identity; Supabase Storage for `.designjs.json` blobs; Postgres for metadata (recent projects, sharing permissions, team membership)
- App `pem` private key lives in the Supabase Edge Function environment, never in browser
- Octokit-with-installation-auth pattern (mirror Onlook's `packages/github/src/auth.ts`)
- Webhook handlers: PR-merged → archive the `designjs/<uuid>` branch; user-pushes-to-default → notify connected DesignJS clients to refresh

The architecture today (OAuth-PKCE direct from browser) and the architecture later (Supabase + GitHub App) coexist — the OAuth path stays for self-hosters / local-only users.

## User stories

**Story 1 — first-time connect (GitHub):**
*As a designer with an existing React repo on GitHub, I want to click "Connect Repo," authorize DesignJS to access it, and have a feature branch ready for design changes — without installing anything on my machine.*

Acceptance criteria:
- [ ] Topbar "Connect Repo" button opens a modal with two tabs: GitHub / Local Folder
- [ ] GitHub flow: redirect → callback → token stored in `~/.designjs/secrets.json`
- [ ] On connect, `designjs/<short-uuid>` branch created from `default_branch`
- [ ] Repo cloned into ZenFS in-browser volume
- [ ] DesignJS file appears at `/design/<project-name>.designjs.json` in the cloned tree

**Story 2 — first-time connect (local folder):**
*As a designer working in Chrome, I want to point DesignJS at an existing project folder on my disk — even one that isn't a git repo yet — and have design files save into it alongside my code.*

Acceptance criteria:
- [ ] Local folder flow on Chrome/Edge: `showDirectoryPicker` returns a handle; persisted to IndexedDB
- [ ] DesignJS detects whether the folder is a git repo (`.git/` present)
- [ ] If git: offer to create the `designjs/<uuid>` branch on first save
- [ ] If not git: save files directly; show "Initialize git" option
- [ ] On Firefox/Safari: show explanatory fallback ("File System Access API not supported — use GitHub instead, or use the file-upload fallback (read-only)")
- [ ] DesignJS files save to `<folder>/design/*.designjs.json`

**Story 3 — no connection (default save location):**
*As a designer just trying DesignJS for the first time, I want to start designing immediately without connecting anything, and have my work saved somewhere I can find it later.*

Acceptance criteria:
- [ ] DesignJS works fully without a repo/folder connection
- [ ] Files save to `~/Documents/DesignJS/<project-name>.designjs.json`
- [ ] A "Save to..." button in the Topbar lets the user switch from default location to a connected repo/folder at any time
- [ ] The default location is shown in Settings → Storage so users know where to find their files

**Story 4 — open PR for design changes:**
*As a designer who's been iterating on a flow inside DesignJS, I want to surface my changes as a draft PR for my team to review.*

Acceptance criteria:
- [ ] "Open PR" button in Topbar (visible when connected to GitHub)
- [ ] First click: creates a draft PR with the `designjs/<uuid>` branch's commits
- [ ] PR title auto-generated from the first non-trivial commit
- [ ] PR body lists the files changed grouped by category (design files / generated code / assets)
- [ ] Subsequent clicks: updates the PR body, doesn't create duplicates
- [ ] PR is always draft — never auto-merged

## Open questions / future work

1. **Component autodiscovery (Dessn pattern, v2):** Scan the connected repo's React components, render each as a draggable block in the Components panel. Different problem from route discovery — Dessn proved this is viable; Onlook hasn't shipped it. Worth a separate spec.
2. **`designjs.config.json` for path customization:** Where in the repo should design files go? Default `/design/`, but some users may want `/src/design/` or `/.designjs/`. Defer until users ask.
3. **Conflict handling when repo is updated externally:** If the user pushes to `main` while DesignJS is on `designjs/<uuid>`, do we rebase? Show a warning? `FileSystemObserver` + git-fetch on focus can detect this; UX TBD.
4. **Multi-repo (one canvas spanning two repos):** Out of scope for v1. Document constraint clearly.
5. **Self-hosted CORS proxy distribution:** Ship as part of `create-designjs` scaffolder, or as a standalone package? Probably scaffolder — one fewer thing for users to install.
6. **Token rotation UX:** GitHub OAuth tokens don't expire by default, but users may want to revoke. Settings → Connected Services should show issued date + a Disconnect button that revokes via the API.

## Cross-references

- [AI chat spec](ai-chat.md) — chat panel needs to know the connected-repo context for prompts like "build this component to match the patterns in /src/components/"
- [Sandbox preview spec](sandbox-preview.md) — preview boots the connected repo in WebContainers; depends on this spec for the repo source
- [Projects spec](projects.md) — repo-connected projects are one of three project types in the workspace
- [Component discovery (future)](component-discovery.md) — discovery operates on the connected repo (Storybook + React component autodiscovery)
- [opencanvas-roadmap.md](opencanvas-roadmap.md) § "Connect a repository" — corresponding roadmap feature block
