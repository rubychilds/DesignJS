# Projects — multi-project workspace + gallery

**Status:** Spec drafted 2026-05-24, not yet implemented.

**Track:** B (repo-and-preview) · **Depends on:** _nothing_ · **Blocks:** _nothing_ (improves with [repo-connection.md](repo-connection.md) but doesn't require it) · **Feature branch:** `feat/projects-gallery`

**Why this exists:** A single user often works on multiple distinct designs — a marketing site, a dashboard prototype, a quick scratch experiment. Today DesignJS opens one `.designjs.json` file at a time with no way to browse or switch between projects. This spec defines the multi-project workspace, the three project types, and the gallery view that ties them together.

## Goals

1. A user can have **many DesignJS projects** of varying types (repo-connected, folder-connected, standalone) and switch between them from a single gallery view.
2. The gallery is **local-first** — no backend, no cloud sync. Reads from a local index file (`~/.designjs/projects.json`).
3. Each project has its own `.designjs.json` file in its own location; the gallery just tracks where they are and shows thumbnails.
4. New projects can be created standalone (no commitment to a repo/folder yet) and later "moved" to a repo or folder without losing work.

## Outcomes

- Opening DesignJS shows the gallery (if multiple projects exist) or the most recent project (if one).
- User can create a new project from the gallery in 5 seconds (just "+ New Project" → blank canvas).
- Switching between two projects mid-session is one click — both projects' state (selection, zoom, last screen) is preserved.
- A project can move between types: standalone → repo-connected (offer to commit existing file to repo), folder-connected → standalone (file copies to default location), etc.

## Decision log (2026-05-24)

| Decision | Outcome |
|---|---|
| Three project types | Repo-connected, folder-connected, standalone. Same workspace can host any mix. |
| Gallery view | Local-first. Reads from `~/.designjs/projects.json`. |
| File browser model | Inspired by Paper's files dashboard (verified screenshot earlier in research), local-first instead of cloud-hosted. |
| Project switching | One-click from gallery; current project's state preserved on switch. |
| Standalone default location | `~/Documents/DesignJS/` (or platform equivalent — `XDG_DATA_HOME/designjs` on Linux). |
| Future cloud tier | Sync `~/.designjs/projects.json` via Supabase when cloud tier ships. |

## The three project types

| Type | Where files save | Branch behavior | Use case |
|---|---|---|---|
| **Repo-connected** | Inside the GitHub repo's `/design/` directory (configurable) | Auto-creates `designjs/<uuid>` branch; commits per save; draft PR on push | Production design work tied to a codebase |
| **Folder-connected** | Inside the picked local folder | If folder is a git repo, same as above; else no git operations | Local development workflows; folder may or may not be a git repo |
| **Standalone** | `~/Documents/DesignJS/<project-name>.designjs.json` | No git operations | Quick experiments; greenfield design without commitment to a codebase |

A project can change type without losing data:

- **Standalone → Folder-connected:** "Save to folder..." opens File System Access API picker; existing `.designjs.json` copies to `<folder>/design/`; old default-location copy can be deleted or kept.
- **Standalone → Repo-connected:** "Connect to repo..." opens the GitHub OAuth flow; on success, file moves to the cloned repo's `/design/`.
- **Folder-connected → Repo-connected:** same flow if the folder is already a git repo; otherwise prompts the user to push the folder to a new GitHub repo first.
- **Any → Standalone:** "Disconnect" option in project menu; file copies to `~/Documents/DesignJS/`.

## Gallery view

The gallery is the default home screen when DesignJS opens with no `?project=...` URL parameter, OR when the user clicks the "Projects" button in the Topbar.

**Layout (inspired by Paper's files dashboard, local-first):**

```
┌─ DesignJS Projects ────────────────── [+ New] [Settings] ┐
│ All  Repos  Folders  Standalone  Recents  Archived       │
│ Search: [ .................................. ]  [Grid|List]│
│                                                           │
│ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐          │
│ │         │ │         │ │         │ │         │          │
│ │ thumb   │ │ thumb   │ │ thumb   │ │ thumb   │          │
│ │         │ │         │ │         │ │         │          │
│ ├─────────┤ ├─────────┤ ├─────────┤ ├─────────┤          │
│ │ Project │ │ Project │ │ Project │ │ Project │          │
│ │ Name    │ │ Name    │ │ Name    │ │ Name    │          │
│ │ ⊕ repo  │ │ ⊟ folder│ │ ⬚ standa│ │ ⊕ repo  │          │
│ │ 2d ago  │ │ 5h ago  │ │ 1w ago  │ │ today   │          │
│ └─────────┘ └─────────┘ └─────────┘ └─────────┘          │
└───────────────────────────────────────────────────────────┘
```

- **Filter tabs:** All / Repos / Folders / Standalone / Recents / Archived (matches Paper's pattern)
- **Search:** filters by project name, repo name, or path
- **Grid / List toggle:** thumbnails or compact list
- **+ New button:** opens a "New Project" modal (see below)
- Each card shows: thumbnail (first artboard rendered), project name, type badge (repo / folder / standalone), last-modified time
- Right-click on a card: menu with Open, Open in new tab, Move to..., Rename, Archive, Delete

### Project index file (`~/.designjs/projects.json`)

```jsonc
{
  "version": 1,
  "projects": [
    {
      "id": "01HXYZ123abc",
      "name": "Marketing Site",
      "type": "repo",
      "filePath": "/repos/myorg-marketing/design/marketing-site.designjs.json",
      "repoOrigin": "https://github.com/myorg/marketing.git",
      "branch": "designjs/01HXYZ123abc",
      "lastOpenedAt": "2026-05-24T10:23:45Z",
      "thumbnailPath": "/Users/dana/.designjs/thumbnails/01HXYZ123abc.png"
    },
    {
      "id": "01HXYZ456def",
      "name": "Dashboard prototype",
      "type": "folder",
      "filePath": "/Users/dana/Projects/dashboard/design/dashboard.designjs.json",
      "folderHandle": "<persisted IndexedDB key>",
      "lastOpenedAt": "2026-05-24T07:11:02Z",
      "thumbnailPath": "/Users/dana/.designjs/thumbnails/01HXYZ456def.png"
    },
    {
      "id": "01HXYZ789ghi",
      "name": "Hero scratch",
      "type": "standalone",
      "filePath": "/Users/dana/Documents/DesignJS/hero-scratch.designjs.json",
      "lastOpenedAt": "2026-05-17T19:34:20Z",
      "thumbnailPath": "/Users/dana/.designjs/thumbnails/01HXYZ789ghi.png"
    }
  ]
}
```

- File mode `0o600` to match the secrets file pattern
- Updated atomically on every project create / open / rename / delete
- Thumbnails stored in `~/.designjs/thumbnails/<id>.png`, generated from the first artboard on close

### "+ New Project" modal

```
┌─ New Project ─────────────────────────────┐
│ Name: [ ............................... ] │
│                                            │
│ Save to:                                   │
│ ◉ Standalone (DesignJS default folder)    │
│ ◯ Local folder (pick a folder...)         │
│ ◯ GitHub repo (connect a repo...)         │
│                                            │
│ Start from:                                │
│ ◉ Blank canvas                            │
│ ◯ Template: Landing page                  │
│ ◯ Template: Dashboard                     │
│ ◯ Template: Mobile app screens            │
│                                            │
│              [ Cancel ]  [ Create ]       │
└────────────────────────────────────────────┘
```

Default name: "Untitled Design" with incrementing suffix if conflict. Templates are starter `.designjs.json` files shipped with the app — defer to the existing v0.4 "Design system picker" feature in [opencanvas-roadmap.md](opencanvas-roadmap.md).

## Project switching

From within an open project, the Topbar shows:

```
[Projects ▾]  Marketing Site  ⊕ designjs/01HXYZ123  ●●●
```

Clicking "Projects ▾" opens a quick-switcher dropdown (Cmd+P shortcut):
- Search-as-you-type filter
- Recent projects at the top
- "View all in gallery..." at the bottom (opens the full gallery)

Switching to another project:
- Current project saves automatically (no "are you sure?" prompt — saves are non-destructive)
- New project loads in the same tab; canvas state restored from `~/.designjs/state/<id>.json` (selection, zoom, last screen)
- "Open in new tab" alternative opens the project in a new browser tab without leaving the current one

## Implementation notes

### Browser-only state

Everything is local — no backend. The project index file lives in `~/.designjs/projects.json`, managed by the local Node process that serves the canvas (same process that holds secrets). The browser renderer fetches the project list via the WebSocket bridge.

### Agent connection → project routing

When an MCP client connects (Cursor, Claude Code, Codex, etc.), the MCP server tells the canvas which project the agent is operating from via a `hello` handshake. See [repo-connection.md § MCP integration](repo-connection.md#mcp-integration-get_project_context--hello-handshake) for the tool spec.

The handshake includes `{ projectRoot, name }`. The canvas then:

1. **Looks up the project in `~/.designjs/projects.json`** by matching `projectRoot` against `filePath` ancestors
2. **If found:** switches to that project (loads `.designjs.json`, restores selection/zoom from `~/.designjs/state/<id>.json`)
3. **If not found:** auto-creates a new project entry of the appropriate type:
   - `projectRoot` is a git repo → `type: "repo"` (read `repoOrigin` from `.git/config`)
   - `projectRoot` is a plain folder → `type: "folder"`
   - In both cases, generate a new project `id`, set `name` from the handshake, `lastOpenedAt` = now
4. **Updates the gallery in real-time** — the new project appears immediately for the user to confirm or rename

**Multi-peer routing:**

The WebSocket bridge supports multiple agents connected to different projects simultaneously. Each agent's tool calls are scoped to that agent's project — Agent A on `/tmp/marketing` can't accidentally mutate Agent B's `/Users/dana/dashboard` project. The canvas shows a tab strip with one tab per active project; clicking a tab switches the visible canvas to that project (the underlying agents stay connected to their respective projects regardless of which tab is foregrounded).

**Standalone projects (no agent connected):**

The gallery + switcher work the same — standalone projects just don't receive tool calls. Switching to a standalone project from the gallery loads its `.designjs.json` directly.

### Thumbnail generation

On project close (or every 30s autosave that has visible changes), capture a screenshot of the first artboard using the existing `get_screenshot` MCP tool path. Save to `~/.designjs/thumbnails/<id>.png`. Gallery cards render these as `<img src="file://...">` via a local-file-serving endpoint on the dev server.

### Folder handles across sessions

For folder-connected projects, the `FileSystemDirectoryHandle` is persisted to IndexedDB on first pick. When DesignJS re-opens a folder-connected project, it re-requests permission via `handle.requestPermission()` — the browser shows a one-click "Allow" prompt. If the user denies, the project shows a "Re-grant access" button.

### Repo-connected on a different machine

If the user signs in on a different machine, the `~/.designjs/projects.json` is local — projects from machine A don't appear on machine B. The user can re-add by selecting the same repo via Connect Repo; the existing `designjs/<uuid>` branch is detected and reused.

This is intentional for v1 — local-first means local-state. The future cloud tier (Supabase) will sync the project index across machines.

## User stories

**Story 1 — first project (standalone):**
*As a designer just trying DesignJS, I want to create a project and start designing without connecting to GitHub or picking a folder.*

Acceptance criteria:
- [ ] First-launch shows an empty gallery with a prominent "+ New Project" button
- [ ] Creating a project (standalone): just enter name, file saves to `~/Documents/DesignJS/<name>.designjs.json`
- [ ] Project appears in gallery as "Standalone" with a thumbnail
- [ ] Default location is shown in Settings → Storage so users know where to find their files

**Story 2 — connect existing project to repo:**
*As a designer who started a standalone project and now wants to commit it to a repo, I want to "upgrade" it without losing my work.*

Acceptance criteria:
- [ ] Open project → Topbar → Project menu → "Save to..." → "GitHub repo"
- [ ] GitHub OAuth flow → repo selected → existing `.designjs.json` copies to `<repo>/design/`
- [ ] Project type updates from "Standalone" to "Repo" in the gallery
- [ ] Old standalone file: prompt to keep or delete

**Story 3 — switch between projects mid-session:**
*As a designer working on a marketing site and a dashboard prototype, I want to flip between them quickly without losing my place.*

Acceptance criteria:
- [ ] Cmd+P opens quick-switcher; type to filter; Enter to switch
- [ ] Current project autosaves before switch
- [ ] New project loads with last-known selection, zoom, and active screen
- [ ] "Open in new tab" alternative available in the switcher

**Story 4 — gallery browsing:**
*As a designer with 15 DesignJS projects across various repos and folders, I want a visual gallery to find the one I'm looking for.*

Acceptance criteria:
- [ ] Gallery shows all projects with thumbnails
- [ ] Filter tabs (All / Repos / Folders / Standalone / Recents / Archived) work
- [ ] Search filters in real time
- [ ] Grid / List toggle persists per-user
- [ ] Right-click context menu on each card (Open / Open in new tab / Move to... / Rename / Archive / Delete)

## Open questions / future work

1. **Cloud sync (future):** Sync `~/.designjs/projects.json` via Supabase when cloud tier ships. Per-machine sees one merged list.
2. **Project archiving:** Archive vs delete — archive keeps in index but hides from default view, file stays on disk. UX TBD.
3. **Templates:** "Start from template" needs a template gallery — defer to the existing v0.4 "Design system picker" roadmap feature.
4. **Shared projects (cloud):** Multi-user editing on a single project — far future, requires multiplayer (currently roadmap'd as a Tempo Labs / Onlook competitive gap).
5. **Search by canvas content:** "Find me the project with the pricing table" — semantic search over canvas content. Cool but premature.
6. **Multiple files per project:** Today, one project = one `.designjs.json`. A power user may want multi-file projects (e.g., `homepage.designjs.json` + `pricing.designjs.json` in the same project). Defer; one file per project is enough for v1.

## Cross-references

- [Repo connection spec](repo-connection.md) — repo-connected projects use the OAuth flow + branch workflow described there
- [AI chat spec](ai-chat.md) — chat history persists per-project
- [Sandbox preview spec](sandbox-preview.md) — preview is per-project (each project's connected repo = one sandbox session)
- [Component discovery (future)](component-discovery.md) — discovered components could be reused across projects in the same workspace
- [opencanvas-roadmap.md](opencanvas-roadmap.md) — corresponding roadmap feature pending placement
