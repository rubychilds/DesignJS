# Architecture review — Phase 2.6: Observability deep dive

> Companion to earlier deep dives. Read-only analysis of logging, error reporting, performance instrumentation, analytics, and the instrumentation strategy for the v0.2/v0.3 specs. Continues `[F.NN]` numbering — Phase 2.5 ended at F.77.
>
> Today's surface is small (no error reporting, no analytics, prefixed `console.*` only). The doc is correspondingly focused; most recommendations live in the forward-looking sections.

## 1. Today's observability posture

```
                    ┌────────────────────────┐
                    │  Logging tools         │
                    │                        │
                    │  - Sentry         ❌   │
                    │  - PostHog        ❌   │
                    │  - Datadog        ❌   │
                    │  - OpenTelemetry  ❌   │
                    │  - pino/winston   ❌   │
                    └────────────────────────┘

                    ┌────────────────────────┐
                    │  In-code               │
                    │                        │
                    │  - console.*       ✅  (~25 sites, prefix-tagged)
                    │  - stderr (MCP)    ✅  (well-disciplined)
                    │  - performance.*   ❌
                    │  - Error boundary  ❌
                    │  - Structured logs ❌
                    └────────────────────────┘
```

**Total observability surface: prefixed `console.*` calls + descriptive error messages.** That's it. Acceptable for v0.1 alpha; insufficient for v0.2+ (chat, repo, preview, SWARM all introduce instrumentation-worthy events).

## 2. What exists today

### 2.1 Consistent log-prefix convention

Spot-grep of structured log prefixes across the codebase:

```
7  packages/chrome-extension/src/content/index.tsx:[designjs]
6  packages/chrome-extension/src/background/index.ts:[designjs]
4  packages/app/src/App.tsx:[designjs]
4  packages/app/plugins/bridge-server.ts:[designjs:bridge]
1  packages/mcp-server/src/index.ts:[designjs-mcp]
1  packages/chrome-extension/src/overlay/App.tsx:[designjs]
1  packages/app/src/components/inspector/ExportsSection.tsx:[designjs]
1  packages/app/src/components/Minimap.tsx:[designjs]
1  packages/app/src/canvas/tokens.ts:[designjs]
1  packages/app/src/canvas/paste-import.ts:[designjs]
```

**[F.78] Worth preserving as a strength.** The prefix convention is consistent — every cross-package log is tagged with `[designjs]` or `[designjs:<subsystem>]`. Three sub-tags in active use: `[designjs]` (general), `[designjs:bridge]` (Vite plugin), `[designjs-mcp]` (server). This makes grep + dev-tools filtering trivial.

Sub-strengths:

- **`canvas:frame:load` flow** logs are prefixed `[designjs]` (App.tsx — primitive-CSS injection sweep counter)
- **Tools that surface to users** (Variables popover state, paste-import warnings) use `[designjs]` prefix
- **Bridge server** emits structured-ish lines: `listening on ws://...`, `peer connected: <role>`, `peer disconnected: <role>`, `server error: ...`

### 2.2 MCP server stderr discipline

`packages/mcp-server/src/index.ts`:

```ts
const log = (msg: string) => process.stderr.write(`[designjs-mcp] ${msg}\n`);

// ...
log("mcp server ready on stdio");          // boot
log("shutting down");                       // SIGTERM/SIGINT
log(`fatal: ${err.stack ?? err.message}`); // crash
```

`packages/mcp-server/src/bridge-client.ts`:

```ts
this.log(`bridge connect attempt → ${url}`);
this.log(`bridge connected: ${url}`);
this.log(`bridge disconnected (code=${code}, reason=${reason})`);
this.log(`bridge ws error: ${err.message}`);
```

**Smart pattern.** stdout is reserved for MCP JSON-RPC; stderr is where ops messages go. The hosting agent (Claude Code / Cursor / etc.) can surface stderr in its developer UI without contaminating the protocol stream. **[F.79] Preserve this pattern as the canonical MCP-server logging shape.** When chat-panel-side logging lands (v0.2), the canvas should follow the equivalent split — protocol channel separate from ops channel.

### 2.3 Bridge handler errors are agent-friendly

`packages/app/src/bridge/handlers.ts` errors:

```ts
throw new Error(`artboard not found: ${input.artboardId}`);
throw new Error(`artboard ${input.artboardId} has no wrapper component`);
throw new Error(`component not found: ${input.componentId}`);
throw new Error(`canvas iframe not ready`);
throw new Error(`target component not found: ${input.target}`);
```

These propagate through the bridge as the `error` field on the `ResponseMessage`. Anthropic and OpenAI's tool-use APIs surface these directly to the model, which then explains them to the user. Good shape:

- **Identifies the failed resource** (artboard id, component id)
- **Identifies the failure mode** (not found, no wrapper, iframe not ready)
- **Avoids stack traces** — the model gets a clean signal, not noise

**[F.80] Bridge error message shape is exemplary for agent UX.** Worth codifying as a contributor convention. Counter-pattern to avoid: `throw new Error("Internal error: " + JSON.stringify(state))` — opaque to the model + leaks internal state.

### 2.4 Chrome extension instrumentation

17 `console.*` calls across `packages/chrome-extension/src/`. The README documents the phase events users can grep for:

```
[designjs] page captured: N nodes, MKB, serialized in Tms
[designjs] extracted N <style> block(s)
[designjs] dispatching add_css_rules: NKB
[designjs:bridge] add_css_rules: NKB → N chunks → M rules parsed
```

This is the most instrumented surface in the codebase. Phase-event logging supports the user's debugging workflow when captures go wrong.

**[F.81] Capture-pipeline phase-event instrumentation is solid.** Worth replicating in v0.2 for sandbox preview boot phases, repo clone progress, and chat-panel turn lifecycle.

## 3. What's missing

### 3.1 [F.82] No React error boundary

Grep for `ErrorBoundary`, `componentDidCatch`, `getDerivedStateFromError` returned **zero hits** across the entire `packages/app/src/`. The Topbar, panels, inspector, canvas wrapper — none of them is wrapped in an error boundary.

**Consequences:**

- A single component crash propagates to the React root and breaks the whole app
- Users lose unsaved canvas state on a crash (autosave runs every 30s, but in-progress edits after the last save are gone)
- No error report — the user sees a blank canvas with no explanation
- Recovery is to refresh the page

**Recommended:** an `<ErrorBoundary>` at the App root and another at the Shell level (inspector + panels). On error, show a "Something went wrong — your last save is intact" message with a "Reload" button and a "Copy diagnostic info" link. The diagnostic info goes into the error report path (§3.2).

The shape (React 18+ with hooks):

```tsx
// packages/app/src/components/ErrorBoundary.tsx
import React from "react";

interface State { error: Error | null; errorInfo: React.ErrorInfo | null }

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null, errorInfo: null };
  static getDerivedStateFromError(error: Error) { return { error, errorInfo: null }; }
  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.setState({ error, errorInfo });
    // TODO: feed to error reporter when v0.2 lands (F.83)
    console.error("[designjs:boundary]", error, errorInfo);
  }
  render() {
    if (this.state.error) {
      return <div className="error-fallback">
        <h2>Something went wrong</h2>
        <p>Your last save is intact. Click reload to recover.</p>
        <button onClick={() => location.reload()}>Reload</button>
        <details>
          <summary>Diagnostic info</summary>
          <pre>{this.state.error.stack}</pre>
        </details>
      </div>;
    }
    return this.props.children;
  }
}
```

Wrap `<App />` in `main.tsx`. Maybe 1 hour of work end-to-end.

### 3.2 [F.83] No error reporting

No Sentry, no Honeybadger, no Bugsnag, no PostHog error events. App-side crashes go to `console.error` and stay there. Users would need to manually file an issue with their console output — which the F.82 error boundary's "Copy diagnostic info" would help with, but only if the user thinks to file an issue.

**For v0.1 this is acceptable** — the local-first, self-hosted nature of DesignJS means no centralized error tracking is *expected*. But:

- The Chrome extension is going to the Web Store (F.71); users will install it and never look at the service-worker logs. Silent failures will look like "the capture button just doesn't work."
- v0.2 chat panel will have many failure modes (API key invalid, model timeout, rate limit, prompt-too-long, tool-call-malformed). Without error reporting, debugging user reports of "chat is broken" relies on the user's ability to copy + paste console output.

**Recommended approach: Sentry, opt-in.** Specifically:

1. Self-hosted Sentry is overkill for v0.1. **Use Sentry's free tier (5k events/month)** for the project.
2. **Opt-in via Settings → Privacy** — the user explicitly enables "Send error reports to DesignJS." Default OFF. Matches the privacy-conscious dev-tool user base.
3. **Scrub PII automatically** — Sentry's `beforeSend` hook strips API keys, OAuth tokens, file paths beyond the repo name, project-IDs.
4. **Source maps uploaded** at release time (Sentry CLI integration in the release workflow from F.30).

Browser + Node-side Sentry SDKs (`@sentry/react`, `@sentry/node`). The chrome-extension Sentry SDK has known MV3 quirks (service worker context); track for v0.3 capture-pipeline crash visibility.

### 3.3 [F.84] No product analytics

No PostHog, no Plausible, no Fathom, no Mixpanel. The team makes product decisions without usage data.

**The user's MCP environment includes PostHog** (per earlier conversation: project "Bloom" within organization "Orbis" with PostHog connected). But **the DesignJS app itself has no PostHog client SDK installed.** Local PostHog access is for analysis of other data; the canvas doesn't emit events to PostHog.

This was deferred for v0.1 (sensible — pre-launch). For v0.2 onwards, the case for analytics gets stronger:

| Event class | Why it matters |
|---|---|
| First-canvas-render time | Boot performance regression detection |
| MCP tool call rate | Which tools are actually used? Inform deprecation. |
| MCP tool error rate | Catch real failures users don't report |
| Chat panel: messages per session | Engagement signal for the chat investment |
| Chat panel: model selection distribution | Inform provider prioritization (OpenRouter vs direct keys) |
| Chat panel: Build vs Ask mode usage | Validates the dual-mode UX |
| Project gallery: number of projects per user | "Multi-project" is a v0.2 bet — does it materialize? |
| SWARM: variations spawned per session | Validates the variations-first thesis |
| SWARM: agents-per-spawn distribution (1 vs 3 vs 6) | "6 is the empirical ceiling" — confirm with data |
| Sandbox preview: boot times | Performance budget for WebContainers |

**Recommended: PostHog, opt-in.** Same Settings → Privacy toggle as Sentry. PostHog's free tier (1M events/month) far outstrips DesignJS's needs through v1.0. Same `beforeSend` PII scrubbing. **Server-side events** for things the local Node process can observe (MCP tool calls, file saves); **browser-side events** for UI interactions.

### 3.4 [F.85] No performance instrumentation

No `performance.mark` / `performance.measure` / `performance.now()` instrumentation. Bridge round-trip latency, MCP tool execution time, canvas-render time — all observable in principle, none surfaced.

The alpha.1 status notes mention "Wikipedia-class long pages (~7k components) take 60-180s to land — `add_components` is the bottleneck." That number came from manual stopwatch, not instrumentation. **Performance regression detection is currently impossible** — there's no baseline.

**Recommended for v0.2:**

```ts
// packages/app/src/lib/perf.ts (proposed)
export function timeTool<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  return fn().finally(() => {
    const ms = performance.now() - t0;
    console.log(`[designjs:perf] ${name}: ${ms.toFixed(0)}ms`);
    // TODO: when analytics lands, also send to PostHog
  });
}
```

Wrap each bridge handler in `timeTool("get_tree", ...)`. The data goes to console immediately + to PostHog when analytics lands.

### 3.5 No structured event format

All logs today are human-readable strings. Useful for dev; harder to:

- Parse for trend analysis ("how many `add_components` failed in the last week?")
- Send to a log aggregator (Datadog Logs, Sentry Breadcrumbs)
- Correlate across processes (mcp-server's `bridge connect attempt` ↔ bridge-server's `peer connected: mcp-server`)

**For v0.2 this matters more.** Recommended: introduce a tiny structured-log helper that double-emits (human-readable to console + structured to the analytics SDK when present):

```ts
// packages/app/src/lib/log.ts (proposed)
type LogEvent = { level: "info" | "warn" | "error"; subsystem: string; event: string; props?: Record<string, unknown> };

export function log(e: LogEvent) {
  const propStr = e.props ? " " + JSON.stringify(e.props) : "";
  console[e.level](`[designjs:${e.subsystem}] ${e.event}${propStr}`);
  // when PostHog lands:
  // posthog?.capture(`${e.subsystem}.${e.event}`, e.props);
}
```

Call sites:

```ts
log({ level: "info", subsystem: "bridge", event: "peer_connected", props: { role: "mcp-server" } });
log({ level: "info", subsystem: "tool", event: "executed", props: { tool: "get_tree", durationMs: 23 } });
log({ level: "error", subsystem: "tool", event: "failed", props: { tool: "add_components", err: "wrapper missing" } });
```

Human-readable in dev console, structured for analytics. Migration is incremental — call sites convert one at a time.

## 4. Forward-looking: instrumentation for v0.2/v0.3

### 4.1 AI chat panel (Track A)

Highest-leverage instrumentation target — the chat panel is where most product questions live.

| Event | Captures |
|---|---|
| `chat.message_sent` | model, mode (build/ask), provider, prompt_length, has_context_pills |
| `chat.tool_called` | tool, latency_ms, success, retry_count |
| `chat.response_received` | model, latency_ms, input_tokens, output_tokens, finish_reason |
| `chat.provider_error` | provider, error_type ("rate_limit" / "invalid_key" / "model_unavailable" / "timeout") |
| `chat.model_switched` | from_model, to_model, mid_conversation: bool |
| `settings.key_added` | provider (NOT the key itself) |
| `settings.key_removed` | provider |

The cost meter that Vercel AI SDK enables (per the SWARM spec) ties to PostHog directly — capture `input_tokens` + `output_tokens` × current OpenRouter/provider list price → real-time cost per conversation in the UI + aggregated session cost for the user.

### 4.2 Repo connection (Track B)

| Event | Captures |
|---|---|
| `repo.connect_initiated` | source ("github" / "local_folder"), is_first_time |
| `repo.oauth_completed` | provider, scope |
| `repo.clone_completed` | size_mb, file_count, duration_ms |
| `repo.commit_created` | files_changed_count, branch |
| `repo.pr_opened` | size_bytes, message_length |
| `repo.local_folder_picked` | browser ("chrome" / "edge" / "fallback"), has_git: bool |

### 4.3 Sandbox preview

| Event | Captures |
|---|---|
| `preview.provider_selected` | "webcontainers" / "codesandbox" / "local_dev_server" |
| `preview.boot_started` | provider, repo_size_mb |
| `preview.npm_install_completed` | duration_ms |
| `preview.dev_server_ready` | duration_ms, total_ms_since_boot |
| `preview.hmr_error` | error_type, file_path (redacted) |
| `preview.exit` | duration_in_preview_ms |

WebContainers boot times are *the* UX concern; this is how you know the budget is met.

### 4.4 SWARM

| Event | Captures |
|---|---|
| `swarm.spawn` | mode ("variations" / "specialist"), agent_count, model, brief_length |
| `swarm.agent_started` | agent_id, model, artboard_id |
| `swarm.agent_completed` | agent_id, duration_ms, tool_calls_count, total_cost_usd, was_kept_or_discarded |
| `swarm.lock_collision` | agent_id, artboard_id, blocked_tool |
| `swarm.spawn_aborted` | agent_count, reason |

The "variations-first vs collaboration" thesis is testable from these alone — what's the ratio of `mode: "variations"` to `mode: "specialist"`?

### 4.5 Projects gallery

| Event | Captures |
|---|---|
| `project.created` | type ("repo" / "folder" / "standalone"), source ("blank" / "template") |
| `project.opened` | type, opened_from ("gallery" / "switcher" / "url") |
| `project.switched` | from_type, to_type, ms_since_last_switch |
| `project.archived` | type |
| `project.type_migrated` | from_type, to_type |

### 4.6 Cross-cutting

| Event | Captures |
|---|---|
| `app.boot` | version, boot_duration_ms, restored_from_save: bool |
| `app.canvas_first_paint` | duration_from_boot_ms |
| `app.error` | (Sentry surface; PostHog backup) |
| `app.session_end` | session_duration_ms, projects_touched_count |

## 5. Recommended adoption order

The full observability stack would land in three steps, each independently shippable:

### Step 1 — local visibility (no remote service)
- F.82: React error boundary
- F.85: `performance.now()` wrapper for bridge handlers — logs to console
- Structured `log({...})` helper (§3.5)
- All call sites migrated incrementally over a few weeks

**Cost: zero.** All in-tree. Solo dev gets immediate visibility into perf regressions during dev.

### Step 2 — error reporting (Sentry, opt-in)
- F.83: `@sentry/react` + `@sentry/node` integrated, opt-in via Settings
- Sentry tied to the error boundary (`Sentry.captureException` from `componentDidCatch`)
- Source maps uploaded on release (depends on F.67 release workflow)
- PII scrubbing in `beforeSend`

**Cost: zero (Sentry free tier, 5k events/month).** Ships before chat panel lands so chat errors get reported from day one.

### Step 3 — product analytics (PostHog, opt-in)
- F.84: `posthog-js` + Node SDK, opt-in via same Settings toggle
- All v0.2/v0.3 event schemas land (§4.1-§4.6)
- Real-time cost meter (chat + SWARM) backed by PostHog token data
- PostHog dashboards for the canonical product questions

**Cost: zero (PostHog free tier, 1M events/month).** Ships alongside the chat panel.

### Why this order

1. Step 1 has zero risk (no external service, no privacy implications, just better dev visibility).
2. Step 2 has minimal user surface (opt-in toggle, PII scrubbing). Lands before users will need to report v0.2 issues.
3. Step 3 has the longest implementation tail (event schema work, dashboard setup) and the most user-facing impact (consent flow, privacy review).

## 6. Privacy posture

DesignJS's users skew **privacy-conscious developers** — local-first, MIT, BYO key, no-cloud-by-default are core positioning. Any observability stack must respect this.

### 6.1 Hard rules

1. **No telemetry by default.** Sentry + PostHog are opt-in. The default state is silent.
2. **No PII in events.** API keys, OAuth tokens, GitHub usernames, repo names beyond the slug, file paths beyond the repo-relative path — all scrubbed.
3. **Local-only by default.** All `[designjs:...]` console logs stay local; only opted-in events leave the machine.
4. **One toggle for both.** Settings → Privacy is binary opt-in: "Help improve DesignJS" enables both Sentry and PostHog. Granular toggles (Sentry only / PostHog only) add UX overhead.
5. **The opt-in surface should explain what's collected.** Link to a `/privacy` page on the docs site (currently nonexistent — flag for Phase 2.7).

### 6.2 [F.86] No privacy policy / data-collection docs yet

The Mintlify docs site has no `/privacy` page. Acceptable today (nothing collected). **Becomes a requirement the moment any telemetry lands.** Phase 2.7 will note this.

## 7. Findings rollup

| # | Finding | Severity | Effort |
|---|---|---|---|
| F.78 | Consistent `[designjs:<subsystem>]` log prefix convention (positive) | n/a | n/a |
| F.79 | MCP server stderr discipline (positive) | n/a | n/a |
| F.80 | Bridge handler errors are agent-friendly (positive) | n/a | n/a |
| F.81 | Capture-pipeline phase events instrumented (positive) | n/a | n/a |
| F.82 | **No React error boundary** | High | S (~1h) |
| F.83 | No error reporting (Sentry / equivalent) | Med (today) / High (v0.2) | M (~half day setup + integration) |
| F.84 | No product analytics (PostHog / equivalent) | Med (v0.2) | M (~half day setup + event schema) |
| F.85 | No performance instrumentation | Med | S (~2h helper + migration) |
| F.86 | No privacy policy / data-collection docs (required when telemetry lands) | Med (when v0.2 ships) | S |

## 8. Risk tiers

**Tier 1 — fix-in-the-week:**
- **F.82** — React error boundary. Independent change, high-leverage. ~1h end-to-end.
- Structured `log()` helper (§3.5). ~30 min to add; migrate sites incrementally.

**Tier 2 — fix-this-quarter (before v0.2 chat panel ships):**
- **F.85** — Performance instrumentation wrapper for bridge handlers.
- **F.83** — Sentry integration, opt-in. Should ship *before* chat panel so chat errors are caught from day one.
- **F.86** — Privacy policy on the docs site (depends on F.83/F.84 landing).

**Tier 3 — fix-with-v0.2:**
- **F.84** — PostHog integration with the v0.2/v0.3 event schemas. Lands alongside chat panel.

**Tier 4 — strategic:**
- The synthesis should consider an **"observability stack" ADR** capturing:
  - Sentry + PostHog as the two-vendor stack
  - Opt-in via single Privacy toggle
  - PII scrubbing in `beforeSend`
  - Source maps in release workflow
  - Event schema versioning (so PostHog events can evolve without breaking historical analysis)

---

**Next:** Phase 2.7 — Docs deep dive.
