# AI chat panel — Vercel AI SDK + OpenRouter (+ direct API + CLI subprocess)

**Status:** Spec drafted 2026-05-24, not yet implemented. Pending placement in [opencanvas-roadmap.md](opencanvas-roadmap.md) (currently in the "Scratch — chat + repo + preview proposal" section).

**Track:** A (chat-and-agent) · **Depends on:** _nothing_ · **Blocks:** [swarm.md](swarm.md) · **Feature branch:** `feat/ai-chat-panel`

**Why now:** In-canvas chat is what every closer competitor ships (Onlook, Dessn, Tempo Labs, bolt.new, v0.dev, Lovable, Replit Agent 4, Figma Design Agent). The current DesignJS MCP server already lets external agents (Cursor, Claude Code, Codex) drive the canvas — but users have to alt-tab away from the canvas to talk to them. In-canvas chat closes that gap.

## Goals

1. A persistent chat panel **on the left side** of the canvas, where users can talk to an AI agent without leaving DesignJS.
2. Support **multiple backend options** so users aren't locked into one provider's pricing or auth: OpenRouter (default, easiest), direct Claude/OpenAI API key (uses user's own credits), Claude CLI subprocess (uses user's existing CLI auth).
3. The in-canvas chat and external MCP **coexist** — both can drive the canvas without state races.
4. Model picker is a dropdown in the chat header; selecting a model opens settings for any needed API key.

## Outcomes

- User types "build a card with header, image, and CTA" in the chat → watches the canvas update in real time as the agent calls MCP tools.
- User can switch between models (Claude Sonnet, GPT-5, Gemini, etc.) per-message without leaving the chat.
- A Cursor session connected via external MCP works simultaneously with the in-canvas chat — both agents see each other's changes via a shared op log.

## Decision log (2026-05-24)

| Decision | Outcome |
|---|---|
| AI SDK abstraction | Vercel AI SDK (`@ai-sdk/*`) + `useChat` for the React client |
| Default provider | OpenRouter via `@openrouter/ai-sdk-provider` |
| User-provider options | All three offered: OpenRouter, direct Claude/OpenAI API key, Claude CLI (`claude -p`) subprocess. User decides. |
| Panel location | Left sidebar (matches other AI services: Cursor, opencode, bolt.new). |
| Default tab on first launch | Agent (NOT Layers — chat is the new flagship surface). Returning users restore last-used tab. |
| Model picker | Dropdown in chat header. Click a model → opens Settings inline with the relevant key field pre-focused. |
| MCP coexistence | Single in-process MCP dispatcher; tag operations with `origin: 'chat' \| 'mcp:<client-name>'`. |
| Backend | None for v1. Browser → local Node process → providers. |

## Three provider options — honest framing

The user reasonably hopes "DesignJS will just use my Claude Pro / ChatGPT Plus subscription." The reality (verified 2026-05-24):

- **Anthropic banned third-party apps from calling subscription OAuth tokens** (Feb 2026, enforced server-side with fingerprinting). API access requires either an API key (paid separately) OR subprocess-the-CLI (which authenticates as the official Claude Code client).
- **OpenAI's ChatGPT Plus has never been API-callable** at all. Same constraint.
- From **June 15, 2026**, `claude -p` (the CLI subprocess path) draws from a *separate* metered Agent SDK credit pool ($20 Pro, $100 Max5x, $200 Max20x monthly, API-priced, no rollover) — not the subscription's "unlimited" pool.

So the user-decides menu DesignJS offers:

| Provider | Auth methods (selectable in Settings → AI Providers) | Billing |
|---|---|---|
| **OpenRouter** | API key | OpenRouter credits (~5% markup over provider list) |
| **Anthropic Claude** | API key · AWS Bedrock · Google Vertex AI · Microsoft Foundry · Claude Code CLI (subprocess) | Per auth method; CLI subprocess draws from separate metered Agent SDK pool from June 15, 2026 |
| **OpenAI GPT** | API key · Azure OpenAI · Codex CLI (subprocess) | Per auth method; CLI subprocess similar metered pattern |
| **Google Gemini** | API key · Google Vertex AI | Google AI list price; Vertex per GCP billing |

Each provider supports multiple authentication methods, selectable via an "Authenticate with" dropdown in Settings → AI Providers — see the Settings modal section below. This matches Pencil's pattern (verified via screenshot 2026-05-24) and lets enterprise users bring their existing AWS/Azure/GCP infrastructure auth rather than provisioning yet another API key.

**Documentation tone:** "Use the CLI you already trust with your existing auth — note that as of June 15, 2026, programmatic use draws from a separate credit pool." NOT "free use of your subscription."

## Architecture

### Vercel AI SDK as the abstraction layer

All providers route through one interface: `streamText({ model, system, tools, messages })`. The chat client (`useChat` in React) doesn't know which provider it's talking to. Switching from OpenRouter to direct Anthropic is a model-id change, nothing else.

```ts
// packages/app/src/chat/providers/index.ts
import { openrouter } from '@openrouter/ai-sdk-provider'
import { anthropic } from '@ai-sdk/anthropic'
import { openai } from '@ai-sdk/openai'
import { createCliSubprocessProvider } from './cli-subprocess' // custom

export function modelForId(id: string): LanguageModel {
  if (id.startsWith('openrouter:')) return openrouter(id.slice('openrouter:'.length))
  if (id.startsWith('anthropic:'))  return anthropic(id.slice('anthropic:'.length))
  if (id.startsWith('openai:'))     return openai(id.slice('openai:'.length))
  if (id.startsWith('claude-cli:')) return createCliSubprocessProvider({ cli: 'claude' })(id)
  if (id.startsWith('codex-cli:'))  return createCliSubprocessProvider({ cli: 'codex' })(id)
  throw new Error(`Unknown model: ${id}`)
}
```

The CLI subprocess provider is a custom adapter that spawns `claude -p --output-format stream-json --mcp-config <designjs-mcp>.json --resume <session>` and translates its NDJSON event stream into AI SDK's normalized message parts. Same pattern for `codex exec --json`.

For OpenRouter specifically, set headers for the OpenRouter dashboard's per-app analytics:
- `HTTP-Referer: https://designjs.dev`
- `X-Title: DesignJS`

And for Anthropic models (through any provider), pass `providerOptions.anthropic.cacheControl = {type:'ephemeral'}` to enable prompt-caching pass-through.

### Component tree (left sidebar Agent tab)

```
packages/app/src/components/sidebar/panels/agent/
├── index.tsx              hosts useChat({ transport: byoTransport })
├── chat-header.tsx        model picker dropdown + history + new-chat button
├── chat-messages/
│   ├── assistant-message.tsx   renders message.parts (text | tool-call | tool-result | image)
│   ├── user-message.tsx
│   ├── stream-message.tsx
│   ├── tool-call-card.tsx      collapsible — always render placeholder when collapsed
│   ├── activity-log.tsx        chronological task progress with status indicators (Pencil "Drift" pattern)
│   └── completion-summary.tsx  structured breakdown when agent finishes a multi-step task
├── chat-input/
│   ├── textarea.tsx       autosize, paste-image, drag-image
│   ├── context-pills.tsx  selected nodes / artboards / files as removable chips
│   ├── mode-toggle.tsx    Build / Ask
│   └── send-stop.tsx
└── settings-link.tsx      jumps to Settings → AI Providers
```

Mirrors Onlook's `apps/web/client/src/app/project/[id]/_components/right-panel/chat-tab/` structure, with two key differences:

1. **Left, not right** — matches Cursor's chat-on-left default, opencode's left split, bolt.new's left chat. Onlook's right-panel choice is the outlier.
2. **Default tab is Agent**, not Layers, on first launch. Returning users restore last-used.

### Model picker UX

The chat header has a dropdown:

```
[ Claude Sonnet 4.6 ▾ ]   Build │ Ask    [ History ]  [ New ]
```

Clicking the dropdown:

- Shows enabled providers' models (populated from `GET https://openrouter.ai/api/v1/models` for OpenRouter, hardcoded shortlist for direct providers, detected models for CLI subprocess)
- Each row shows: model name, provider badge, cost-per-1M-tokens (input/output)
- Shows a "+ Add provider" item at the bottom that opens Settings → AI Providers
- **Selecting a model the user hasn't added a key for opens Settings inline with the relevant key field pre-focused** (per the 2026-05-24 decision)

Model selection persists per-conversation. Next message uses the new model. A model badge appears on each assistant message so the user can tell which model produced what.

### Key storage (three-tier)

| Tier | When | Storage |
|---|---|---|
| 1. OS keychain | Desktop wrapper (future Electron/Tauri) | Electron `safeStorage` / Tauri `keyring` crate (macOS Keychain, Linux libsecret, Windows Credential Vault) |
| 2. Local Node process | Browser-against-local-dev-server (current arch) | `~/.designjs/secrets.json` mode `0o600`. Renderer never sees the key; backend reads + passes to provider. |
| 3. `apiKeyHelper` | Power users | Shell command that prints the key. Lets users hook 1Password CLI / Vault / aws-vault. Pattern from Claude Code. |

Never persist any key in `.designjs.json`, exports, screenshots, or telemetry. Explicit redaction list in the serializer.

`~/.designjs/secrets.json` shape (mirrors opencode's `auth.json`):

```jsonc
{
  "providers": {
    "openrouter":  { "apiKey": "sk-or-v1-..." },
    "anthropic":   { "apiKey": "sk-ant-..." },
    "openai":      { "apiKey": "sk-..." },
    "github":      { "token":  "ghu_..." }
  },
  "apiKeyHelper": "op read 'op://Personal/OpenRouter/credential'"
}
```

`{env.VAR_NAME}` substitution supported throughout — `"apiKey": "{env.OPENROUTER_API_KEY}"` is valid.

### Settings modal — provider configuration (Pencil-inspired)

Per the 2026-05-24 decision: a single Settings modal manages all provider auth. It opens via two triggers:

- **Manual:** click the Settings icon (gear) in the bottom-left of the sidebar, or press Cmd+,
- **Auto:** when the user selects an unconfigured model in the chat header's model picker — the modal opens automatically with the relevant provider section focused and the first empty input field highlighted

Layout (left nav + right pane), inspired by Pencil's Settings → Agents page (verified via user-provided screenshot 2026-05-24):

```
┌─ Settings ──────────────────────────────────────────────────┐
│ General        │ AI Providers                                │
│ AI Providers ◄ │ ─────────────────────────────────────────── │
│ MCP            │ Configure how DesignJS authenticates with   │
│ Storage        │ each provider. Models you select in chat    │
│ Agents         │ use the active auth method for that         │
│ Account        │ provider.                                   │
│ ───────        │                                             │
│                │ ⊛ OpenRouter                                │
│                │   Authenticate with: [ API Key ▾ ]          │
│                │   [ sk-or-v1-... ............ ] [ Save ]    │
│                │   Get a key at openrouter.ai                │
│                │ ─────────────────────────────────────────── │
│                │ ✱ Anthropic Claude                          │
│                │   Authenticate with:                        │
│                │   [ Your Claude Code CLI (subscription) ▾ ] │
│                │   ↳ Detected: claude 1.2.3 at /usr/bin/...  │
│                │   Note: programmatic use draws from a       │
│                │   separate Agent SDK pool from June 15, 2026│
│                │   Get started or configure Claude Code      │
│                │ ─────────────────────────────────────────── │
│                │ ◉ OpenAI GPT                                │
│                │   Authenticate with: [ API Key ▾ ]          │
│                │   [ sk-... .................. ] [ Save ]    │
│                │   Generate a key at platform.openai.com     │
│                │ ─────────────────────────────────────────── │
│                │ ✦ Google Gemini                             │
│                │   Authenticate with: [ API Key ▾ ]          │
│                │   [ AIza... ................. ] [ Save ]    │
│                │   Generate your API key at Google AI Studio │
└─────────────────────────────────────────────────────────────┘
```

**Per-provider "Authenticate with" dropdowns:**

| Provider | Dropdown options |
|---|---|
| **OpenRouter** | API key |
| **Anthropic Claude** | API key · AWS Bedrock · Google Vertex AI · Microsoft Foundry · Claude Code CLI (subprocess) |
| **OpenAI GPT** | API key · Azure OpenAI · Codex CLI (subprocess) |
| **Google Gemini** | API key · Google Vertex AI |

Selecting a different auth method swaps the fields shown below it:

- **API key:** single input + Save button + link to provider's signup
- **AWS Bedrock:** region selector + access key ID + secret + (optional) session token; OR "Use AWS_PROFILE / AWS env vars" toggle that reads from the local environment
- **Azure OpenAI:** resource name + deployment name + API key + API version
- **Google Vertex AI:** GCP project ID + region + service account JSON (paste or file-pick) OR "Use GOOGLE_APPLICATION_CREDENTIALS env var" toggle
- **Microsoft Foundry:** endpoint + API key + (optional) deployment name
- **Claude Code CLI / Codex CLI:** auto-detect CLI in PATH; show detected version + path; help text about June 15, 2026 metered-pool billing; "Re-run detection" button

Each section also has:

- Provider icon + name header (Pencil uses tinted icons — DesignJS should match)
- Auth-method dropdown defaulting to the most common option per provider (API key for OpenRouter/Gemini; API key for Anthropic/OpenAI with CLI as a prominent alternative if detected in PATH)
- Method-specific input fields with inline Save (per-field, not global — saves per-provider so users can configure one and try it)
- Inline help text (status of detected CLI, gotchas like June-15 billing, links to provider docs)
- "Test connection" button (sends a minimal ping / list-models request to verify the auth works)

**Auto-open from chat (per 2026-05-24 decision):**

When the user clicks the model picker in the chat header and selects a model whose provider isn't configured:

1. Settings modal opens immediately
2. Left nav auto-focuses "AI Providers"
3. Right pane scrolls to that provider's section
4. The first empty input in the active auth method is focused
5. After Save + successful "Test connection," modal closes and the original message-send proceeds with the new model selected

**Why this matters (vs Onlook's hidden picker):**

Onlook hardcodes a single key per provider (one `OPENROUTER_API_KEY` env var in their hosted deployment) and hides the picker entirely. DesignJS is BYOK and local-first — users must see and control which auth is being used. The dropdown also lets enterprise users (AWS Bedrock, Azure OpenAI, Vertex AI) bring their existing infrastructure auth rather than provisioning a personal API key just for DesignJS. This is the same trade-off Pencil made.

**Settings nav (matches Pencil's structure):**

| Tab | Purpose |
|---|---|
| General | Theme, canvas preferences, keyboard shortcuts |
| **AI Providers** | This section |
| MCP | External MCP server toggles + custom config (already roadmap'd as the in-app MCP settings) |
| Storage | Default DesignJS folder location, connected repos/folders, file naming conventions |
| Agents | Named agents (from v0.3 SWARM mode), agent colors, default scopes |
| Account | Future cloud-tier auth (Supabase Auth) |

### Coexistence with external MCP

Today's WebSocket bridge on port 29170 handles one or more external MCP clients (Cursor, Claude Code subprocess, etc.). Adding the in-canvas chat creates a second message source. **Both must converge on one canonical canvas state** — otherwise Cursor's `update_styles` and the chat panel's `update_styles` can race on the same node.

Solution: route the in-canvas chat's tool calls through the **same MCP dispatcher**, in-process:

```
External MCP clients ──[WebSocket]──┐
                                    ├──→ MCP dispatcher ──→ Canvas mutation
In-canvas chat tool calls ──────────┘     │
                                          └──→ Op log (with origin tag)
```

Every mutation gets tagged: `origin: 'chat' | 'mcp:cursor' | 'mcp:claude-code'`. The op log enables:

- Replay/undo at the op-level (not per-client)
- "Cursor selected X" presence indicators in the UI
- The chat panel can reuse external selection as auto-injected context

This is Onlook's pattern — the AI is just-another-actor against a shared editor engine.

### Task progress log + status indicators (Pencil "Drift" pattern)

The chat panel doesn't render text + tool calls as a flat stream — it groups them into a **task progress log** with named-status indicators that summarize what the agent is doing, matching Pencil's "Drift" agent UX (roadmap competitor reference, verified screenshot 2026-04-22).

**Status taxonomy** (each tool call is categorized into one):

| Status | Triggered by | Visual |
|---|---|---|
| **Design** ⏳ | `add_components`, `update_styles`, `delete_nodes`, `set_text`, `add_classes`, `remove_classes`, `add_css_rules` | Orange spinner while running; green check when batch completes |
| **Reading objects** ✅ | `get_tree`, `get_selection`, `get_html`, `get_css`, `get_jsx`, `get_variables` | Green check (fast, usually invisible) |
| **Reviewing visuals** ✅ | `get_screenshot` | Green check; tooltip shows "Verified visual output" |
| **Setting up** ⚙️ | `create_artboard`, `find_placement`, `fit_artboard`, `set_variables`, `select`, `deselect` | Gray neutral |
| **Error** ❌ | Any tool call that errors | Red with error message expandable |

Tool calls of the same status that happen sequentially within ~2 seconds are **grouped into a single line item** (e.g., 5 `update_styles` calls in 1s → "Design ✅ (5 changes)"). Tool call detail stays accessible by clicking the line item to expand into individual `tool-call-card.tsx` rendering.

**Component tree (within `chat-messages/`):**

- `activity-log.tsx` — chronological list of status-indicator line items, replacing the flat "one tool-call-card per call" rendering for multi-step turns
- `completion-summary.tsx` — when the agent's turn ends, a structured summary card appears with the named agent's dot (e.g., "● Default Agent finished") and a bulleted breakdown of what changed (e.g., "Created Header component", "Updated 3 Card backgrounds", "Adjusted spacing on hero section")

**Named agent + status dot:**

The chat header shows the agent's name with a colored status dot:

- **● green** — idle, available
- **● blue pulse** — actively working
- **● red** — last action errored, waiting for user

Names are user-configurable per agent session (Settings → Agents). Default: "Agent" for the single-agent case. Auto-generated names like "Agent 1", "Agent 2" for SWARM (v0.3+, see note below).

**New Agent button (fresh-context reset):**

A "New Agent" button in the chat header starts a fresh conversation with an empty context. Useful when switching tasks (e.g., from "build a card" to "review accessibility of the whole page") where the old context would just bias the new task. Persists the prior conversation in the history dropdown so it's recoverable.

> **Future work — Multi-agent SWARM:** see [swarm.md](swarm.md) for the full v0.3 spec covering up to 6 concurrent agents, per-artboard worktree-style isolation (no CRDT needed), `AgentDefinition` shape mirrored from Claude Agent SDK, **variations-first** UX (the killer use case per 2026-05-24 research, not collaboration-first), per-agent cost meter (DesignJS differentiator vs Pencil/Cursor/Onlook), and right-sidebar agent list as canonical presence UI. The status taxonomy and `activity-log.tsx` / `completion-summary.tsx` components above are the single-agent baseline that SWARM extends — each agent gets its own collapsible activity log row in the agent panel, all flowing through the same MCP dispatcher with `origin: 'agent:<agent-id>'` tags added alongside the existing `'chat'` / `'mcp:<client-name>'` origins.

### Mode toggle (Build / Ask)

The chat input has a Build/Ask toggle:

- **Build (default):** agent can call canvas-mutation tools (`add_components`, `update_styles`, `delete_nodes`, `set_text`, etc.). System prompt: "Build/edit by writing minimal HTML. Prefer existing components on the canvas. Use Tailwind classes."
- **Ask:** agent can only call read tools (`get_tree`, `get_screenshot`, `get_selection`, `get_html`, `get_css`). System prompt: "Answer questions about the current canvas. Don't make changes."

Onlook also has hidden `CREATE` and `FIX` modes auto-triggered on project creation / error fix flows. **Skip for v1** — too clever, hard to discover.

### Context auto-injection

When the user has elements selected and sends a prompt, the selected elements' tree data + screenshot are automatically injected as context — they don't need to say "for the selected elements." (Pattern from Pencil.dev docs: "Any selections you make on the canvas are automatically added to the context.")

Selected elements appear as removable context pills above the input. The user can also drag in:

- Other canvas elements (becomes additional context)
- Image files (uploaded as base64)
- Code files from the connected repo (path becomes context — references the repo connection spec)

### Cmd+K from anywhere

Cmd+K focuses the chat input from anywhere on the canvas. Matches Pencil's prompt shortcut and Cursor's chat-toggle.

## User stories

**Story 1 — first chat:**
*As a designer who just opened DesignJS for the first time, I want to see the Agent panel by default with a prompt suggesting "Build a login form" — so I can try the agent loop without configuring anything.*

Acceptance criteria:
- [ ] First-launch default left-sidebar tab = Agent
- [ ] Empty Agent panel shows 3 starter prompts: "Build a login form", "Build a pricing table", "Build a landing page hero"
- [ ] First send → if no provider configured, modal: "Pick a provider to get started" with the five options (OpenRouter / Anthropic / OpenAI / Claude CLI / Codex CLI)
- [ ] OpenRouter selected → key paste field, "Don't have a key? Get one at openrouter.ai" link, save → first message sends

**Story 2 — switching models per-message:**
*As a designer iterating on a complex layout, I want to use Claude Sonnet for design work and switch to Haiku for cheap quick fixes, all from the same chat.*

Acceptance criteria:
- [ ] Model picker in chat header lists enabled models with provider badge + cost-per-1M-tokens
- [ ] Switching models persists per-conversation (next message uses the new model)
- [ ] Each assistant message shows a small badge with the model that produced it
- [ ] Selecting a model the user hasn't added a key for: opens Settings inline with key field focused

**Story 3 — using my Claude Pro subscription via CLI:**
*As a Claude Max subscriber, I want to use my existing `claude` CLI auth instead of paying for OpenRouter credits — and I want to be told honestly what that costs.*

Acceptance criteria:
- [ ] Settings → AI Providers shows "Claude CLI" option
- [ ] Enabling it: DesignJS checks for `claude` in PATH, runs `claude --version`, confirms version supports `--output-format stream-json`
- [ ] Sending a message: DesignJS spawns `claude -p ... --resume <session>` and streams the NDJSON back as AI SDK message parts
- [ ] Help text under the option: "Uses your existing Claude CLI auth. Note: programmatic use draws from a separate Agent SDK credit pool from June 15, 2026 ($20 Pro, $100 Max5x, $200 Max20x monthly, API-priced)."

**Story 4 — coexisting with Cursor:**
*As a developer with Cursor open in another window connected via MCP, I want to also use DesignJS's in-canvas chat without state conflicts.*

Acceptance criteria:
- [ ] Both Cursor (external MCP) and in-canvas chat work simultaneously
- [ ] UI shows both agents' presence (colored dots, last-action tooltip)
- [ ] Tool calls from both go through the same MCP dispatcher with `origin` tags
- [ ] Op log shows the merged history with origin attribution

## Open questions / future work

1. **Streaming MCP tool calls from the canvas TO the chat:** if the user manually edits a component while the agent is mid-response, should the agent see that change? (Probably yes — tool re-call on each turn fetches fresh canvas state.)
2. **Token budget UI:** Onlook shows a 200k-token budget bar for Sonnet 4.5. Useful but cluttered — defer to v0.5.
3. **Chat history persistence:** stored where? Inside `.designjs.json`? Separate `<project>.chat.json`? IndexedDB? Pick before shipping.
4. **Cost tracking:** OpenRouter returns usage in each response. Surface total spend in Settings → Usage as a courtesy.
5. **Voice input:** Onlook ships paste-image + drag-image; voice is a v1+ nice-to-have.
6. **Ollama / local model support:** add as a sixth provider once someone asks (OpenAI-compatible local endpoint, trivial).
7. **Per-mode model presets:** Onlook hardcodes per-mode (GPT-5 for CREATE/FIX, Sonnet for ASK/EDIT). DesignJS shows the picker — but should we offer "smart defaults" that pick a sensible model per Build/Ask?

## Cross-references

- [Repo connection spec](repo-connection.md) — chat panel uses connected-repo context for prompts that reference specific files/components
- [Sandbox preview spec](sandbox-preview.md) — preview errors surface in the chat as "fix this" suggestions
- [Projects spec](projects.md) — chat history persists per-project
- [Component discovery (future)](component-discovery.md) — agent can reference discovered components in prompts ("use the Card from /src/components/")
- [opencanvas-roadmap.md](opencanvas-roadmap.md) § "In-canvas chat panel" — corresponding roadmap feature block
