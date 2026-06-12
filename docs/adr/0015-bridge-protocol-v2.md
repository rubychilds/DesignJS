# ADR-0015: Bridge protocol v2 — auth, versioning, capabilities

**Status:** Proposed
**Date:** 2026-06-10
**Owner:** Architecture
**Related:** [`docs/architecture/architecture-security.md`](../architecture/architecture-security.md) §2 (F.51 — bridge has no auth or origin check), §5 (F.54 — capability scoping for Build/Ask), §6.1 (Chrome extension pairing UX); [`docs/architecture/architecture-codebase.md`](../architecture/architecture-codebase.md) (F.07 — protocol version negotiation); [`docs/architecture/architecture-review-2026-05-24.md`](../architecture/architecture-review-2026-05-24.md) (Tier-4 ADR proposal — "v0.2 security gate"); [`docs/specs/ai-chat.md`](../specs/ai-chat.md) (Build/Ask modes); [`docs/specs/swarm.md`](../specs/swarm.md) (per-agent scope); [`packages/bridge/src/protocol.ts`](../../packages/bridge/src/protocol.ts), [`packages/app/plugins/bridge-server.ts`](../../packages/app/plugins/bridge-server.ts); coupled with [ADR-0013](./0013-cloud-tier-supabase.md) (cloud tier — preconditioned on bridge being hardened) and [ADR-0017](./0017-secrets-module.md) (secrets module — must land at the same time so key-handling code never runs against an unauthenticated bridge)

---

## Context

The bridge WebSocket server (`packages/app/plugins/bridge-server.ts`, 144 LOC) is the single point of trust between the canvas, the MCP server, and the browser extension. It binds to `127.0.0.1:29170/designjs-bridge` and routes JSON messages between peers.

**It has no authentication.** Any process that can reach `127.0.0.1:29170` can send `{ "type": "hello", "role": "canvas" }` and become the canvas, kicking the real canvas off (the existing-canvas-replacement logic intentionally accepts the newer peer to support HMR reconnects). Or it can send `{ "type": "hello", "role": "mcp-server" }` and **drive every MCP tool on the user's canvas without authentication.** The security deep dive's full attack analysis is in [`architecture-security.md`](../architecture/architecture-security.md) §2.

**It has no origin check.** The `verifyClient` callback isn't set; the `Origin` header isn't inspected. A misconfigured CORS proxy or an Electron-style host could in theory bypass the same-origin policy.

**It has no protocol versioning.** The `HelloMessage` carries `type`, `role`, and an optional `sessionId` — no version field. Any future wire-level change to the protocol is silently incompatible; a too-new MCP server talking to a too-old bridge produces a confusing error far downstream of the actual mismatch.

**It has no capability scoping.** All 22 MCP tools are available to any peer that authenticated as `mcp-server` or `browser-extension`. The chat panel's Build/Ask differentiation (Ask mode read-only; Build mode read+write) has no bridge-level enforcement; the chat client can lie about its mode.

All four gaps are **defensible at v0.1** — the bridge is localhost-only, the assets are low-value (design state in `.designjs.json`), and the user agreed to install the canvas. The threat model in SECURITY.md says exactly this: out of scope is "an attacker who already controls the user's machine."

That framing breaks the moment v0.2 lands:

- **`ai-chat.md`** introduces BYOK API keys (OpenRouter / Anthropic / OpenAI / Gemini). Once those keys live in `~/.designjs/secrets.json` (per ADR-0017), an unauthenticated `mcp-server` peer can drive prompts that exfiltrate canvas state to attacker-controlled URLs.
- **`repo-connection.md`** introduces GitHub OAuth tokens with `repo` scope (write access to all the user's repos). An unauthenticated peer can issue MCP-tool-shaped calls that trigger repo writes.
- **The threat model expands.** Browser extensions running in the user's Chrome and other localhost processes the user is testing can both reach `127.0.0.1:29170` trivially. Neither "controls the machine" in the SECURITY.md sense, but both can drive the bridge.

The fix needs to land **before any v0.2 key-handling code merges.** This ADR locks the bridge protocol v2 — auth (the F.51 token gate), versioning (F.07), and capability scoping (F.54) — as one coordinated change. Three load-bearing reasons to bundle them in one bridge release:

1. **The wire shape changes once.** Adding `token`, `protocolVersion`, and (optional) `capabilities` to `HelloMessage` is a single schema bump. Releasing them separately means three protocol-incompatible-with-older-clients moments instead of one.
2. **They share a migration story.** The Chrome extension needs a pairing UX before the token is enforced; the MCP server needs the env-var/CLI shape before any agent integration breaks. Designing all three together produces a coherent rollout.
3. **The v0.2 security gate** (per the 2026-05-24 review's Top-10 rec #10) bundles bridge auth + capability scoping + window.__designjs prod gate. All three are blocking for the chat panel's first PR; ship them together.

---

## Decision

Bridge protocol v2 adds three fields to `HelloMessage`. Plus a phased capability-scoping story aligned with the chat-panel and SWARM rollouts.

### 1. `token: string` (required) — F.51 remediation

The Vite plugin generates a random 32-byte hex token at boot, writes it to `node_modules/.designjs/bridge.token` (mode `0o600`, parent dir mode `0o700`), and shares it with the three peer types:

- **Canvas** — via `window.__designjs_bridge_token__`, **gated on `import.meta.env.DEV`**. Production builds never expose the token (compounds protection with F.09's `window.__designjs` dev gate).
- **MCP server** — via a `DESIGNJS_BRIDGE_TOKEN` env var, auto-set when the server is spawned via `pnpm mcp` (the wrapper reads `node_modules/.designjs/bridge.token` and exports it). Power-user override via `--token <path-or-value>` CLI flag for non-pnpm-spawned setups (CI smoke runners, alternate launchers).
- **Chrome extension** — via a **first-time pairing UX**:
  1. User clicks "Pair extension" in Canvas Settings → MCP (or the extension popup nudges them to do so on first launch).
  2. Canvas displays a 6-digit pairing code (derived from the current `BRIDGE_TOKEN` via HMAC; one-time).
  3. User opens the extension popup, enters the code.
  4. Extension sends the code over the bridge as a `pair` message; canvas verifies the HMAC and replies with `{ extensionId, sharedSecret }`.
  5. Extension stores `{ extensionId, sharedSecret }` in `chrome.storage.local`.
  6. Subsequent connections present `sharedSecret` (not the bridge token directly — the extension never sees the raw token).

```ts
// packages/bridge/src/protocol.ts (proposed)
export const PROTOCOL_VERSION = "2" as const;

export const HelloMessage = z.object({
  type: z.literal("hello"),
  role: BridgeRole,
  token: z.string(),                        // NEW — required
  protocolVersion: z.literal(PROTOCOL_VERSION),  // NEW — required
  capabilities: z.array(ToolCapability).optional(),  // NEW — optional
  sessionId: z.string().optional(),
});
```

```ts
// packages/app/plugins/bridge-server.ts (proposed)
const BRIDGE_TOKEN = crypto.randomBytes(32).toString("hex");
const TOKEN_PATH = path.join(viteRoot, "node_modules/.designjs/bridge.token");
fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true, mode: 0o700 });
fs.writeFileSync(TOKEN_PATH, BRIDGE_TOKEN, { mode: 0o600 });

// On hello:
if (msg.data.token !== BRIDGE_TOKEN) {
  socket.close(4001, "invalid token");
  return;
}
```

**Defense-in-depth: Origin check** also lands in the same change. The `verifyClient` callback inspects `info.req.headers.origin`; browser-origin connections must be in `ALLOWED_ORIGINS` (the Vite dev server's origin + the Chrome extension's `chrome-extension://<id>` origin once paired). Non-browser-origin connections (the MCP server has no `Origin` header) pass through. Origin alone wouldn't be enough (`Origin` is forgeable from a non-browser client) but combined with the token gate it raises the bar.

### 2. `protocolVersion: "2"` (required) — F.07 remediation

The bridge server rejects connections with a mismatched `protocolVersion` via close code `4002` and message `"protocol version mismatch (expected 2, got <X>)"`. The peer surfaces the close code to the user with a clear "upgrade your MCP server" message.

```ts
// packages/bridge/src/protocol.ts (proposed)
export const PROTOCOL_VERSION = "2" as const;
```

Exported from `@designjs/bridge`. The MCP server imports it; the canvas references it via the same import. Future incompatible wire changes bump `PROTOCOL_VERSION` and trigger a major-version bump of `@designjs/bridge`.

**Why a string, not a number:** SemVer-style strings ("2", "3", possibly "3.1" for additive-but-strict changes) give us room to disambiguate "additive optional field" from "rename/remove field" without overloading numeric major versions. Today's value is `"2"`; this ADR doesn't reserve string format beyond "must be a stable identifier the server compares with strict equality."

### 3. `capabilities: ToolCapability[]` (optional) — F.54 remediation

When present, the bridge server limits the peer to invoking tools matching the listed capabilities. When absent, all tools are available (preserves today's behavior for legitimate `mcp-server` peers that want full access). Four capability types:

```ts
// packages/bridge/src/protocol.ts (proposed)
export const ToolCapability = z.enum(["inspect", "mutate", "artboard", "selection"]);
export type ToolCapability = z.infer<typeof ToolCapability>;
```

Mapping (matches the security deep dive §5.2):

| Capability | Tools |
|---|---|
| `inspect` | `get_tree`, `get_html`, `get_css`, `get_screenshot`, `get_selection`, `get_jsx`, `get_variables`, `list_artboards` |
| `mutate` | `add_components`, `add_css_rules`, `update_styles`, `delete_nodes`, `set_text`, `set_variables`, `add_classes`, `remove_classes` |
| `artboard` | `create_artboard`, `find_placement`, `fit_artboard` |
| `selection` | `select`, `deselect` |

**Chat panel mode mapping:**

- **Ask mode** connects with `capabilities: ["inspect"]`. Read-only — the model can describe the canvas but not modify it.
- **Build mode** connects with `capabilities: ["inspect", "mutate", "selection"]`. Adds mutation + selection; `artboard` deliberately separate to gate artboard-creation flows.
- **Power Build mode** (or "Architect" — naming TBD per ai-chat.md) connects with all four.

The bridge server enforces. The canvas never sees a request from a peer that exceeds its declared capabilities — the bridge rejects with a `response { ok: false, error: "capability denied: tool '<name>' requires '<capability>'" }`.

### 4. SWARM per-artboard scopes (Phase 3) — deferred

SWARM (per `docs/specs/swarm.md`) needs per-agent tokens with per-artboard scopes — agent A can only mutate artboard 1, agent B can only mutate artboard 2, prevents collision. Shape:

```ts
// Phase 3 — NOT in v2.0 of the protocol
artboardScope?: string[];  // list of artboard IDs the peer may touch
```

Enforcement lives in the bridge dispatcher (server-side, not the canvas), so a misbehaving agent can't lie about which artboard it's mutating. This is **not blocking for v0.2**; the chat panel and repo-connection don't need it. Phase 3 of this ADR lands when SWARM ships.

### 5. Implementation phases

| Phase | Lands with | Scope |
|---|---|---|
| **Phase 1** — v0.2 unblock | Coordinated bridge release (probably `@designjs/bridge@0.2.0`) | `token` + `protocolVersion` fields. Mandatory before chat-panel code merges. Token gate, origin check, Chrome extension pairing UX, MCP server env-var/CLI plumbing. Mandatory + non-deferrable. |
| **Phase 2** — Chat panel Ask mode | Lands with the chat-panel PR series | `capabilities` field + dispatcher enforcement. Required before chat-panel ships to users (Ask mode without capability enforcement defeats the point). |
| **Phase 3** — SWARM | Lands with SWARM | `artboardScope` per-peer + per-artboard dispatcher enforcement. Deferred until SWARM is a concrete feature, not just a spec. |

Each phase is its own protocol-version bump if needed. Phase 1 → `PROTOCOL_VERSION = "2"`. Phase 2 adds the `capabilities` field as an *optional* addition (no protocol bump needed — the field is optional). Phase 3 may bump to `"3"` if `artboardScope` enforcement changes semantics for existing peers (TBD).

### 6. Migration story

The bridge server accepts **both v1 (no token) and v2 (with token)** Hello messages for **one minor release** after v2 lands. The transition window:

| Window | Behavior |
|---|---|
| **v2.0** (Phase 1 release) | Server accepts both v1 and v2 hellos. v1 (no `token`, no `protocolVersion`) logs a deprecation warning to the server console (`[bridge] v1 hello accepted from <peer>; v1 will be rejected in v2.1`). v2 hellos require valid token + matching protocolVersion. |
| **v2.1** (next minor) | v1 hellos rejected. Close code `4002` with message `"v1 protocol no longer supported"`. Users on v1 MCP servers must upgrade. |

This applies to the **OSS / open-source legacy clients**, not the in-repo packages. The DesignJS in-tree packages (`@designjs/mcp-server`, the canvas's own client, the Chrome extension) all upgrade in lockstep with the bridge release — there's no internal v1-after-v2 case to support. The grace window exists for any third-party MCP client that's been speaking v1, plus power users with custom integrations.

**Per the project's pre-public release status** ([memory](../../../../.claude/projects/-Users-rubychilds-Documents-Ruby-Obsidian-Notes-DesignJS-Notes/memory/MEMORY.md): no external clients yet, back-compat ceremony doesn't apply), the v2.0 → v2.1 grace window is **conservative**, not a strict requirement. If the user is comfortable with hard-cutover (drop v1 immediately in v2.0), that's defensible — there are no real third-party clients to migrate. The grace window is reserved here in case external integrations exist by the time this ADR is implemented.

### 7. Token security operational notes

The token is sensitive. The operational story:

- **Never print in app output.** `console.log` / `console.error` / stack traces / smoke-test output must not include the token. A unit test on the bridge server asserts a synthetic exception's output doesn't include the token value.
- **Never accept the token via argv.** Process titles are world-readable (`ps`). The CLI flag `--token <path-or-value>` accepts a **path** preferentially (e.g. `--token ./bridge.token`); a literal value via CLI is supported but documented as a power-user fallback.
- **Document in CONTRIBUTING.md.** Add a "Don't echo `$DESIGNJS_BRIDGE_TOKEN`" note. Shell history leaks are the most likely real-world exposure.
- **Token rotation:** the token rotates on every Vite dev server restart. The Chrome extension's pairing survives token rotation because it holds a derived `sharedSecret`, not the raw token; the canvas re-derives the shared secret on each boot using the new bridge token + the stored extension ID. (Pairing UX needs to handle the "stored secret no longer valid" edge case gracefully — user clicks "re-pair extension" and goes through the flow again.)

---

## Consequences

### Positive

- **Closes the biggest single security finding** (F.51) before v0.2 makes it critical. The chat panel and repo-connection cannot ship safely without this.
- **Protocol versioning is the right shape for future evolution.** SWARM tagging, Slack-bot-style integrations, mobile-IDE adapters — any future peer type can land without ambiguous-version moments.
- **Capability scoping enables defense-in-depth for chat Ask mode.** A compromised Ask-mode peer can't silently escalate to Build mode; the bridge rejects.
- **The Chrome extension pairing UX is one-time.** After first pair, the extension's behavior is identical to today. No per-action friction.
- **Aligns with the `v0.2 security gate` bundle.** Lands alongside F.09 (`window.__designjs` prod gate) and F.52 (persistence middleware token gate, which can reuse the same token). Coherent security upgrade rather than a piecemeal hardening pass.

### Negative

- **Every existing MCP integration needs to handle the token.** The in-repo `@designjs/mcp-server` ships with the change; external integrations (custom scripts, .mcp.json configs that spawn MCP servers manually) must read the token from the documented path. One-time, but real.
- **Chrome extension needs a pairing UX.** Modal in the canvas Settings + a flow in the extension popup. ~half day of UX work plus copy. New error states ("pairing code expired", "pairing failed", "shared secret invalid") all need to be handled.
- **One-time protocol break.** Pre-public-release means no real third-party clients to migrate, but the in-tree migration still touches three packages (`@designjs/bridge`, `@designjs/mcp-server`, the chrome extension) plus the canvas's bridge client. Coordinated release.
- **Token operational complexity.** Writing/reading `node_modules/.designjs/bridge.token`, env-var plumbing in `pnpm mcp`, CLI flag handling, rotation across Vite restarts. Doable; just real.

### Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Token leak via shell history if user does `echo $DESIGNJS_BRIDGE_TOKEN` | Med | Document in CONTRIBUTING.md ("never print the token"); never print in app output; consider mode-0o600 on the env-var-receiving shell-startup file. |
| Pairing UX fails or is confusing for non-technical users | Med | Mirror Pencil's MCP-pairing affordance (simple modal, short code, clear copy). Add an "I'm stuck" link in the modal that opens the docs explainer. |
| Chrome extension stored `sharedSecret` desyncs from canvas (e.g. user nukes `node_modules/`) | Low | Pairing flow gracefully detects "secret no longer valid" and prompts to re-pair. Two clicks; not a fatal experience. |
| External MCP client integrations break on protocol bump | Low | Pre-public release means we don't know of any real external integrations. The v2.0 → v2.1 deprecation window covers the case where unknown integrations exist. |
| Capability enforcement bug silently grants too much | Med | Dispatcher's capability check has 100% unit-test coverage; an integration test asserts a chat-Ask-mode peer cannot invoke `add_components`. |
| Token write race condition during HMR (server restarts, writes new token, peer reads stale token) | Low | Token-read happens after WS-connect-success; peers re-read on reconnect. Stale-token failure manifests as "invalid token" close code, which triggers reconnect-and-re-read. |

---

## Open questions

1. **Does Phase 3's `artboardScope` enforcement live in the dispatcher (server-side) or in the canvas (client-side)?** Likely server-side — a malicious agent should not be able to lie about which artboard it's touching, and the canvas should be the dumb renderer. Server-side enforcement requires the bridge to understand artboard IDs (today it's a pure dispatcher; tool params are opaque to it). Adding artboard-aware logic to the bridge dispatcher is a non-trivial change; deferring to Phase 3 means the SWARM ADR can re-open this and pick the implementation.

2. **Does the pairing UX need a QR code for non-clipboard transfer to mobile dev tools?** If a power user is doing mobile-IDE work and wants to connect a mobile-side MCP client to the desktop canvas, copy-paste of a 6-digit code via QR is the cleanest. Defer until mobile-IDE integration is a concrete use case.

3. **Should the `--token` CLI flag accept stdin?** Pattern: `cat ./bridge.token | designjs-mcp --token-stdin`. Cleaner than `--token $(cat ./bridge.token)` for shell-history-conscious users. Decide alongside the MCP server's env-var/CLI implementation.

4. **Origin allowlist for the Chrome extension** — `chrome-extension://<id>` is per-installation. The allowlist needs to be updated when the extension is installed via the Web Store (the ID changes from the unpacked-load ID). The pairing flow can register the extension's actual origin; the bridge dynamically allowlists it after a successful pair. Resolve at implementation time.

5. **Does Phase 2's capability scoping interact with the cloud-tier ADR (ADR-0013)?** Cloud-tier features might want their own capability bucket (`cloud-sync`, `cloud-publish`). Defer until cloud-tier features are implementation-real.

6. **What's the right error UX when an MCP server has the wrong `protocolVersion`?** Close code `4002` is machine-readable; the user-facing message should clearly say "upgrade your MCP server" with a link to the npm page. Resolve at implementation time.

---

## References

### Authoritative
- [WebSocket close codes](https://www.iana.org/assignments/websocket/websocket.xhtml) — `4001` and `4002` are the application-defined range we use here.
- [Web Crypto API — `crypto.randomBytes`](https://nodejs.org/api/crypto.html#cryptorandombytessize-callback) — 32-byte hex token generation.
- [MV3 Chrome extension `chrome.storage.local` docs](https://developer.chrome.com/docs/extensions/reference/api/storage) — for pairing-secret storage.

### Internal prior art
- [`packages/bridge/src/protocol.ts`](../../packages/bridge/src/protocol.ts) — current v1 schema
- [`packages/app/plugins/bridge-server.ts`](../../packages/app/plugins/bridge-server.ts) — current server implementation
- [`packages/app/plugins/persistence-middleware.ts`](../../packages/app/plugins/persistence-middleware.ts) — F.52, gets the same token gate
- [`docs/architecture/architecture-security.md`](../architecture/architecture-security.md) §2 (F.51 attack analysis), §5 (capability scoping shape), §6.1 (pairing UX recommendation)
- [`docs/architecture/architecture-codebase.md`](../architecture/architecture-codebase.md) (F.07 — protocol version negotiation)
- [`docs/specs/ai-chat.md`](../specs/ai-chat.md) — Build/Ask mode differentiation
- [`docs/specs/swarm.md`](../specs/swarm.md) — per-agent scope, the Phase 3 motivation

### Coupled ADRs
- [ADR-0013](./0013-cloud-tier-supabase.md) — cloud tier, preconditioned on bridge being hardened.
- [ADR-0017](./0017-secrets-module.md) — secrets module, lands in the same v0.2 release window (must not run against an unauthenticated bridge).

---

*End of ADR-0015.*
