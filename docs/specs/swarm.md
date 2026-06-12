# Multi-agent SWARM mode — variations-first, per-artboard isolation

**Status:** Spec drafted 2026-05-24 from a verified research pass (Pencil SWARM, Cursor 2.0 Parallel Agents, Claude Agent SDK, opencode multi-session). Not yet implemented. Maps to the v0.3 roadmap feature "Multi-agent SWARM mode" in [opencanvas-roadmap.md](opencanvas-roadmap.md).

**Track:** A (chat-and-agent) · **Depends on:** [ai-chat.md](ai-chat.md) · **Blocks:** _nothing_ · **Feature branch:** `feat/swarm-mode` (rebases off main after `feat/ai-chat-panel` lands)

**Why this exists:** Pencil shipped 6-agent SWARM in Feb 2026; Cursor 2.0 shipped 8-agent Parallel Agents in Oct 2025; Cursor 3.2 added auto-decomposition. Multi-agent canvas work is competitively table-stakes for v0.3. The 2026-05-24 research pass closed the key design questions (isolation model, presence UI, cost framing) — this spec captures the answers.

## Goals

1. A user can **spawn 3-6 concurrent agents** on a single brief, each producing a design variation in its own artboard. **Variations-first**, not collaboration-first.
2. Each agent runs independently — own context, own model, own optional style kit / reference images / system prompt — with per-artboard scoping that prevents collisions without requiring CRDT merge logic.
3. The agent panel surfaces all running agents with name, color, status, last action, artboard scope, and cost — addressing the "what is each agent doing right now and what does it cost me" question explicitly.
4. The architecture stays local-first (no backend in v1); concurrent agents = concurrent provider calls from the local Node process, no orchestration server required.

## Outcomes

- A designer types one brief ("design 5 hero section variations using our brand tokens") → 5 colored agents spawn in 5 new artboards → user picks the strongest, deletes the others, iterates.
- Wall-clock latency for a 6-agent variations run ≈ the slowest agent's response time (not the sum). Cost ≈ $1-3 per spawn at Sonnet 4.5 prices (~20k context × ~10 turns × 6 agents).
- A second mode supports "specialist collaboration" (Layout Agent + Style Agent on one shared artboard) but it's secondary — the default UI affordance pushes variations.

## Decision log (2026-05-24)

| Decision | Outcome |
|---|---|
| Max concurrent agents | 6. Empirical ceiling per Cursor's flat-agent-teams research; matches Pencil's number. |
| Isolation model | Per-artboard scoping (worktree-style) — one agent per artboard at a time. No CRDT merge logic needed. |
| Default mode | **Variations** (spawn N agents on same brief, each in own artboard). Specialist collaboration is secondary. |
| Agent shape | Mirror Claude Agent SDK's `AgentDefinition` field names (`description` / `prompt` / `tools` / `model` / `mcpServers` / `maxTurns`) + DesignJS extensions (`color`, `artboardScope`). |
| Presence UI | Right-sidebar agent list (Cursor 2.0 pattern) as canonical. Colored canvas cursors as polish. "Follow agent" viewport mode deferred. |
| Cost meter | Per-agent token spend in real time (cumulative this run + cumulative this session). Net-new vs Pencil / Cursor / Onlook. |
| Op-log tagging | Extend existing `origin: 'chat' \| 'mcp:<client-name>'` to also include `origin: 'agent:<agent-id>'`. |
| Coordination | User as orchestrator at v0.3. Auto-decomposition (Cursor `/multitask` style) deferred to v0.4+. |

## How competitors approach this (verified 2026-05-24)

- **Pencil.dev SWARM mode** (Feb 26, 2026 launch) — up to 6 concurrent agents with per-agent chat tabs, models, style kits, reference images, and design-system constraints. Specialization-led ("layout agent" / "typography agent") and variation-led ("design 6 variants") both supported. A master agent decomposes briefs. Visual: agents move colored cursors on the canvas. Cost: 6× user's Claude Code subscription token spend. **Conflict resolution not publicly documented** — almost certainly last-write-wins, queued per node. Sources: [Tom Krcha on X](https://x.com/tomkrcha/status/2026329359838318906), [Creator Economy interview](https://creatoreconomy.so/p/i-watched-6-ai-agents-design-an-app-in-real-time-tom-krcha).
- **Cursor 2.0 Parallel Agents** (Oct 29, 2025) — up to 8 agents on a single prompt. **Git worktree isolation** — each agent in its own working dir, same repo. Right-side sidebar lists each agent (name, status, progress, output log). User reviews diffs side-by-side, picks the strongest, accepts partial changes per-agent, undo per-agent. **The cheapest correct answer — no merge logic at all.** Source: [cursor.com/changelog/2-0](https://cursor.com/changelog/2-0).
- **Cursor 3.2** (April 2026) — `/multitask` slash command auto-decomposes one request into concurrent subtasks. Orchestration layer over Parallel Agents.
- **Cursor Background Agents** (May 2025) — different product, often conflated. Async, off-machine, separate VM + git branch + PR per task. Multiple background agents = multiple branches. **Not the same as Parallel Agents.**
- **Claude Agent SDK** — `AgentDefinition` primitive for subagents. Concurrent execution supported. Subagent gets its own prompt/tools/skills, NOT parent's conversation history. Only final message returns to parent. One-level tree (subagents can't spawn subagents). The canonical multi-agent shape DesignJS should mirror. Source: [code.claude.com/docs/en/agent-sdk/subagents](https://code.claude.com/docs/en/agent-sdk/subagents).
- **opencode (sst/anomalyco)** — multi-session TUI, share sessions, multiple instances against different parts of a codebase. Event-driven peer-to-peer messaging between sessions in a single process. TUI-only, so visual lessons don't translate; coordination pattern (event-driven > polling) does.
- **Onlook** — single-agent UI confirmed. Sequential conversations, not parallel. `selectConversation()` is one-at-a-time. Not a SWARM reference. Verified directly in `apps/web/client/src/app/project/[id]/_components/right-panel/chat-tab/`.

## Architecture

### Variations-first UX (the default mode)

When the user types a brief in the chat panel and clicks a new "Spawn Variations" button (or types `/variations N: <brief>`):

1. N new artboards are created in a row, named `Variation 1`, `Variation 2`, ..., `Variation N` (N defaults to 3, max 6)
2. N agents spawn, each scoped to one variation artboard, all receiving the same brief + same context
3. Right-sidebar agent panel shows N agent rows (color, name, status, last action, cost-so-far)
4. Each agent runs independently; their tool calls go through the same MCP dispatcher with `origin: 'agent:<agent-id>'` tags
5. As agents complete, their artboard frames flash green (or red on error); the user can review side-by-side
6. "Keep this, discard others" button on each variation completes the run

This is the killer use case per the research. Frame it explicitly in the UI so users learn the pattern.

### Specialist collaboration (the secondary mode)

When the user wants multiple agents on the SAME artboard (e.g., "Layout Agent shapes the hero, Style Agent colors it"):

1. User opens an artboard, clicks "Add specialist" in the agent panel
2. Modal asks: name, color, system prompt (or pick from preset specialists: "Layout", "Typography", "Style", "Accessibility")
3. Agent joins the artboard's queue — tool calls serialize per-artboard so two specialists don't collide
4. The artboard's chat thread shows interleaved messages from each specialist with name + color attribution

This is allowed and supported but **NOT the default surface** — users have to deliberately click "Add specialist." The variations-first framing is the entry point.

### Per-artboard isolation (worktree-style, no CRDT)

The canonical lock is per-artboard:

- Each artboard has an `agentScope` field: `null` (unscoped, anyone can edit) or `agent-id` (only that agent)
- The MCP dispatcher checks `agentScope` on every mutation call
- A mutation against a scoped artboard from a different agent returns: `"Artboard 'Variation 2' is assigned to Agent #3 (Drift). Wait for the agent to finish, or unassign it from the Agent panel."`
- Tool calls within an artboard from its assigned agent serialize (FIFO queue per artboard); two unscoped agents on different artboards run truly in parallel
- User mutations (manual edits) bypass agent scoping but warn: "Agent #3 is working on this artboard — your edit may conflict with its next action. Continue?"

**Why this is correct (per the research):** Cursor's worktree pattern is the OSS-validated "cheapest correct answer." No CRDT — Yjs / Automerge / tldraw-sync would all need a network sync layer that doesn't exist in DesignJS's local-first v1. No merge math. No conflict resolution UI. The user picks the winner.

### `AgentDefinition` shape (mirrors Claude Agent SDK)

```ts
// packages/app/src/swarm/agent-definition.ts
interface SwarmAgent {
  // Mirrored from Anthropic's AgentDefinition (same field names for portability)
  id: string                       // unique per session
  name: string                     // user-editable; default "Agent N"
  description?: string             // shown in agent picker
  prompt: string                   // system prompt
  tools?: string[]                 // allowed MCP tool names (default: all)
  disallowedTools?: string[]       // denied MCP tool names
  model: string                    // e.g. 'openrouter:anthropic/claude-sonnet-4.5'
  mcpServers?: McpServerConfig[]   // additional MCP servers beyond DesignJS's
  maxTurns?: number                // default 20
  background?: boolean             // run async without blocking chat input
  effort?: 'low' | 'medium' | 'high' // routes to faster/slower models

  // DesignJS extensions
  color: string                    // from preset palette of 6 distinct colors
  artboardScope: string[] | null   // artboard IDs this agent can edit (null = unscoped)
  spawnedAt: number                // timestamp
  spawnedBy: 'user' | 'orchestrator'
}
```

Even though DesignJS uses Vercel AI SDK + OpenRouter (not the Claude Agent SDK directly), mirroring the field names gives users a single mental model across Claude Code and DesignJS.

### Right-sidebar agent list (canonical presence UI)

The agent panel (already in [ai-chat.md](ai-chat.md) as the Agent tab) gains a multi-agent section when SWARM is active:

```
┌─ Agent Panel ───────────────────────────────┐
│ ● Agent #1 "Cohorts"  ⏳ Design  $0.18      │
│   Artboard: Variation 1                     │
│   Last: update_styles (5 changes)           │
├─────────────────────────────────────────────┤
│ ● Agent #2 "Atlas"    ✅ Done    $0.22      │
│   Artboard: Variation 2                     │
│   Last: get_screenshot                      │
├─────────────────────────────────────────────┤
│ ● Agent #3 "Lyra"     ⏳ Design  $0.14      │
│   Artboard: Variation 3                     │
│   Last: add_components                      │
└─────────────────────────────────────────────┘
       Total this run: $0.54
[+ Add specialist]  [Stop all]  [Keep Atlas, discard others]
```

Each row is expandable to show that agent's full activity log (the `activity-log.tsx` pattern from [ai-chat.md](ai-chat.md)).

### Colored canvas cursors (polish — ship after right-sidebar)

Each running agent shows a colored cursor on the canvas at the position of its last tool call. Activity-pulse animation while a tool call is in flight. Name label next to the cursor.

This is the visible "wow factor" but secondary in shipping priority — the right-sidebar list is the information-dense surface that actually drives the UX. **Defer the "follow agent" viewport mode** (Figma took years to make non-nauseating).

### Per-agent cost meter (DesignJS differentiator)

Vercel AI SDK exposes token counts in the response stream. Capture and surface per-agent:

- **Cumulative this run** — total tokens × model price for this agent since spawn
- **Cumulative this session** — total tokens × model price for this agent across all runs (resets when "New Agent" is clicked)
- **Total all agents this run** — shown at the bottom of the agent panel

No existing SWARM tool publishes this in real time. It's the honest answer to "what does 6 agents cost me" — and a content opportunity once shipped (no public per-agent cost data exists today).

### Coordination with existing single MCP dispatcher

The MCP dispatcher pattern from [ai-chat.md](ai-chat.md) extends cleanly:

- Op-log tag `origin: 'agent:<agent-id>'` is added alongside the existing `'chat'` and `'mcp:<client-name>'` tags
- The per-artboard serialization queue already exists for the single-agent case — SWARM just adds more queueable origins
- Replay/undo at op-log level works per-agent (undo just that agent's last batch) or globally (undo everything since timestamp X)

No new infrastructure required at the dispatcher level. The complexity lives in the agent panel UI.

## User stories

**Story 1 — variations spawn:**
*As a designer working on a hero section, I want to type one brief and get 5 distinct variations side-by-side so I can pick the strongest direction.*

Acceptance criteria:
- [ ] "Spawn Variations" button in the chat panel input row (or `/variations 5: <brief>` slash command)
- [ ] 5 new artboards created in a row, named Variation 1-5
- [ ] 5 agents spawn (distinct colors from preset palette of 6)
- [ ] Right-sidebar lists all 5 with name/color/status/artboard/cost
- [ ] As each completes, its artboard frame flashes green; on error, red
- [ ] "Keep this" button on each variation completes the run (others discarded)

**Story 2 — agent collision protection:**
*As a designer with two agents running, I want to be told clearly if I try to manually edit an artboard one of them is working on.*

Acceptance criteria:
- [ ] Editing an unscoped artboard: no warning
- [ ] Editing an artboard with an active agent: confirmation modal "Agent Cohorts is working on this — your edit may conflict. Continue?"
- [ ] Confirming proceeds; "Wait" cancels
- [ ] Two agents on different artboards: both edit freely in parallel
- [ ] Two agents on the SAME artboard (specialist mode): tool calls serialize, FIFO queue per artboard

**Story 3 — cost transparency:**
*As a designer who just ran 6 agents, I want to see exactly what that cost me so I can decide whether to spawn 6 again or use fewer.*

Acceptance criteria:
- [ ] Per-agent cost shown in the agent panel as each tool call completes (real-time, not just on completion)
- [ ] Total-this-run shown at the bottom of the agent panel
- [ ] Settings → Usage tab shows historical totals per provider
- [ ] Cost is computed from Vercel AI SDK's reported token counts × current OpenRouter / provider list price for that model

**Story 4 — specialist collaboration:**
*As a designer who wants a Layout agent to shape my hero and a Style agent to color it, I want to add both to the same artboard without them colliding.*

Acceptance criteria:
- [ ] "Add specialist" in agent panel; modal asks name + system prompt (or pick preset: Layout / Typography / Style / Accessibility)
- [ ] Both agents listed in panel, both scoped to the same artboard
- [ ] Their tool calls serialize per-artboard (FIFO queue)
- [ ] Chat thread shows interleaved messages with name + color attribution

## Open questions / future work

1. **Auto-decomposition (orchestrator mode):** Cursor's `/multitask` auto-decomposes one request into concurrent subtasks. For DesignJS, this would mean "design my dashboard" → orchestrator decomposes into "sidebar variant 1-3 / topbar variant 1-3 / metric card variant 1-3 / data table variant 1-3" automatically. Defer to v0.4+. User-as-orchestrator is fine for v0.3.
2. **Real per-prompt cost data at 6 agents:** No public number exists. DesignJS should publish its own once shipped — content opportunity, no competitor has it.
3. **Pencil's exact spawn UI:** still needs a hands-on probe. If Pencil does "1 MCP connection that fans out to 6 model calls internally" rather than "6 simultaneous MCP connections," that's a simpler architecture. The current v0.3 spec assumes the latter; the former may be a worthwhile simplification.
4. **Variations vs collaboration usage data:** only resolvable via v0.3 alpha telemetry. PostHog setup is well-positioned to instrument this — track the variations-spawn count vs add-specialist count split from day one.
5. **Background agents (Cursor-style):** Cursor's other product is async off-machine agents that take many minutes and report back via PR. Out of scope for v0.3; revisit when DesignJS adds a hosted/cloud tier (the async pattern needs server infrastructure DesignJS doesn't have in v1).
6. **Conflict UX detail:** Pencil docs don't address what happens when the user manually edits an artboard an agent is working on. Cursor's answer (warn, then last-write-wins on confirm) is the realistic minimum — locked in Story 2 above.

## Cross-references

- [AI chat spec](ai-chat.md) — SWARM extends the single-agent chat surface; the activity log, status taxonomy, and named-agent dot all carry forward
- [Repo connection spec](repo-connection.md) — agents inherit the connected-repo context via `get_project_context`; per-agent `projectContext` works the same way
- [Projects spec](projects.md) — SWARM operates within one project at a time; switching projects pauses all running agents for that project
- [Sandbox preview spec](sandbox-preview.md) — agents can read sandbox HMR errors and offer fixes; not changed by SWARM
- [opencanvas-roadmap.md](opencanvas-roadmap.md) § "Multi-agent SWARM mode" (v0.3) — corresponding roadmap feature block; should now point to this spec as the canonical source
