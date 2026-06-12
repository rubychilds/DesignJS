# Architecture review — Phase 2.4: Security deep dive

> Companion to the codebase / testing / CI deep dives. Read-only analysis of the threat model, trust boundaries, current and planned authentication surfaces, supply chain posture, and forward-looking security implications of the v0.2/v0.3 specs. Continues `[F.NN]` numbering — Phase 2.3 ended at F.50.
>
> **The biggest finding in this review surfaces here:** the WebSocket bridge has no origin check, no auth, and no role validation. SECURITY.md's "out of scope: attacker already controls the machine" doesn't capture the reality of the browser-extension / localhost-malware threat model. Detail in §3.

## 1. Threat model

### 1.1 Assets

DesignJS today (`main`, v0.1) protects:

| Asset | Where it lives | Sensitivity |
|---|---|---|
| Canvas state (`.designjs.json`) | User's local filesystem | Low–Med: design IP, no secrets |
| MCP tool surface (22 tools) | In-process, reachable via WS bridge | High: anyone with bridge access can drive the user's canvas |
| Editor handle (`window.__designjs`) | Browser global, every page load | High: exposes mutation API |
| `.opencanvas.json` / `.mcp.json` / `.cursor/mcp.json` configs | Repos / user's home | Low: just config |

DesignJS in **v0.2/v0.3 plans** will add:

| Future asset | Spec | Sensitivity |
|---|---|---|
| OpenRouter / Anthropic / OpenAI / Gemini API keys | `~/.designjs/secrets.json` (planned mode 0o600) | **Critical: live billing tokens** |
| GitHub OAuth access token (PKCE flow) | `~/.designjs/secrets.json` | **Critical: repo write access** |
| Repo contents (cloned to ZenFS/OPFS in browser) | Browser IndexedDB | Med: user's code |
| Sandbox preview iframes (WebContainers) | Browser tab | Low: sandboxed |
| Per-agent chat history | `.designjs.json` or sidecar | Low–Med: may contain pasted secrets |

The current-asset profile is **low risk** (local design files, no secrets). The future profile changes that materially — once API keys land, the bridge's trust model needs to harden.

### 1.2 Trust boundaries

Today's architecture has four trust boundaries, all currently treated as "fully trusted localhost":

```
                ┌──────────────────────────────────────────────────────┐
                │  User's machine (per SECURITY.md, "trusted")        │
                │                                                       │
                │   ┌────────────┐     stdio       ┌─────────────┐    │
                │   │ MCP server │ ─────────────► │ Agent (CLI) │    │
                │   │ (Node)     │ ◄───────────── │             │    │
                │   └─────┬──────┘                 └─────────────┘    │
                │         │ WebSocket on 127.0.0.1:29170               │
                │         │ ◄── ❶ NO AUTH                              │
                │   ┌─────▼─────────────────────┐                      │
                │   │ Vite dev server :3000     │                      │
                │   │  ┌─────────────────────┐  │                      │
                │   │  │ bridge-server plug. │  │                      │
                │   │  │ ◄── ❶ NO AUTH       │  │                      │
                │   │  └──────────┬──────────┘  │                      │
                │   │             │ relay        │                      │
                │   │  ┌──────────▼──────────┐  │                      │
                │   │  │ canvas (React SPA)  │  │                      │
                │   │  │ window.__designjs   │ ◄── ❷ EXPOSED in prod │
                │   │  └─────────────────────┘  │                      │
                │   │                            │                      │
                │   │ ┌─────────────────────┐   │                      │
                │   │ │ persistence-middlw. │   │                      │
                │   │ │ HTTP /__designjs/   │ ◄── ❶ NO AUTH         │
                │   │ │ ❸ reads/writes .designjs.json                │
                │   │ └─────────────────────┘   │                      │
                │   └─────────────────────────────┘                    │
                │                                                       │
                │   ┌──────────────────────────┐                       │
                │   │ Chrome extension          │                       │
                │   │ ◄── ❹ Well-configured     │                       │
                │   └──────────────────────────┘                       │
                └──────────────────────────────────────────────────────┘
```

❶ **WS bridge + HTTP middleware: no auth, no Origin check.** §3 + §4.
❷ **`window.__designjs` in production builds.** Carried over from F.09.
❸ **Persistence endpoint reads/writes user's project file.** §4.
❹ **Chrome extension is a bright spot.** §6.

### 1.3 Attacker capabilities

Per SECURITY.md: *"Vulnerabilities that require an attacker to already control the user's machine — the bridge binds to 127.0.0.1 by design."*

This is **partially right but misses a real class of attackers**. The localhost trust assumption breaks down for:

1. **Malicious / compromised browser extensions** the user installed willingly. They run in the user's browser, can reach `127.0.0.1:29170`, and don't "control the machine" — they run with the user's consent under the browser's permission model.
2. **Other locally-running services** the user is testing (a vulnerable npm dev server, a malicious dev tool the user audited but missed something). These connect to localhost trivially.
3. **Cross-origin requests from web pages the user visits.** Modern browsers block most cross-origin WS connects from web origins via the same-origin policy, but `Origin` headers are not validated server-side; bypass via misconfigured CORS proxies, Electron-style hosts, or browser flag combinations remains possible.
4. **Other users on the same machine** (multi-user systems, shared dev environments).

These attackers can:
- Read the user's canvas state (`.designjs.json`)
- Modify the user's canvas state arbitrarily
- Inject malicious HTML/CSS the user thinks they authored
- Block the legitimate canvas from connecting (DoS via role-impersonation)
- **In v0.2+:** read/exfiltrate the user's API keys + GitHub OAuth tokens

**Threat model recommendation for the synthesis:** SECURITY.md should add a "considered, currently out of scope" section that explicitly names browser extensions and other local processes, and articulates the planned mitigation path (token-based hello handshake, see F.51 remediation).

## 2. The WebSocket bridge: zero auth, zero origin check

### 2.1 The contract today

[`packages/app/plugins/bridge-server.ts`](../../packages/app/plugins/bridge-server.ts) (144 LOC) is the Vite plugin that runs the bridge WebSocket server. Boot:

```ts
wss = new WebSocketServer({
  host: BRIDGE_HOST,       // "127.0.0.1"
  port: BRIDGE_PORT,       // 29170
  path: BRIDGE_PATH,       // "/designjs-bridge"
});
```

Connection handler:

```ts
wss.on("connection", (socket) => {
  socket.on("message", (raw) => {
    const msg = BridgeMessage.safeParse(JSON.parse(raw.toString()));
    if (!msg.success) return;

    if (msg.data.type === "hello") {
      if (msg.data.role === "canvas") {
        const existing = peerByRole("canvas");
        if (existing && existing.socket !== socket) {
          existing.socket.close(4000, "replaced by new canvas");
          peers.delete(existing.socket);
        }
      }
      peers.set(socket, { role: msg.data.role, socket });
      // ...
    }
    // request / response routing
  });
});
```

**There is no:**
- `verifyClient(info, cb)` callback to inspect `info.req.headers.origin`
- Shared secret / nonce / token in the `hello` message
- Per-peer fingerprinting to verify only the legitimate canvas / mcp-server reconnects
- TLS (defensible for localhost dev)
- Rate limiting

### 2.2 [F.51] Critical: bridge accepts arbitrary role claims

Any process that can reach `127.0.0.1:29170/designjs-bridge` can send:

```json
{ "type": "hello", "role": "canvas" }
```

…and **become the canvas.** The current code explicitly disconnects the existing canvas:

```ts
if (existing && existing.socket !== socket) {
  existing.socket.close(4000, "replaced by new canvas");
  peers.delete(existing.socket);
}
```

This is intentional behavior for legitimate reconnects (HMR restarts the canvas; the new connection should replace the stale one). **Combined with the absence of auth, it's an attack primitive:** a malicious connection becomes the canvas, kicks the real one off, and intercepts every MCP tool call from every connected agent.

A different attack uses `role: "mcp-server"`:

```json
{ "type": "hello", "role": "mcp-server" }
{ "type": "request", "id": "a1", "tool": "add_components", "params": { "html": "<script>...</script>" } }
{ "type": "request", "id": "a2", "tool": "set_variables", "params": { "variables": { "--theme": "evil" } } }
```

…and **drive every tool on the user's canvas** without any authentication.

### 2.3 Severity and exploitability

**Severity: High** for v0.2+ (when API keys land); **Medium** today.

- The attack requires localhost network access (the WS server binds to 127.0.0.1 only — no LAN exposure)
- A malicious browser extension or co-resident process can reach it trivially
- No exotic configuration required — the moment `pnpm dev` is running, port 29170 is open

**Exploitability today: medium.** The attacker can only manipulate the user's canvas content. Annoying but not catastrophic; the canvas writes to a local `.designjs.json` which the user can inspect with `git diff`.

**Exploitability in v0.2+: high.** Once the chat panel reads keys from `~/.designjs/secrets.json` and feeds them through MCP-tool-shaped calls, an unauthenticated `mcp-server` peer can:
- Issue prompts that exfiltrate canvas contents to attacker-controlled URLs
- Trigger GitHub commit/push operations via the planned repo-connection MCP tools
- Read the `projects.json` index to enumerate user's projects

### 2.4 [F.51] Remediation

The fix is small. On `hello`, require a token that's:
- Generated by the Vite dev server at boot, written to a file the canvas can read (e.g. `node_modules/.designjs/bridge.token`, mode 0o600)
- Shared with the canvas via `window.__designjs_bridge_token__` (gated on `import.meta.env.DEV` to prevent the production exposure compounding with F.09)
- Shared with the MCP server via `--token` flag, env var, or a `.mcp.json` field that resolves the same file at spawn time
- Shared with the Chrome extension via `chrome.storage.local` after a first-time pairing UX (user clicks "pair extension" in the canvas, copies a code)

Pseudo-code:

```ts
// bridge-server.ts (proposed)
const BRIDGE_TOKEN = generateToken();             // crypto.randomBytes(32).toString('hex')
writeFileSync(TOKEN_PATH, BRIDGE_TOKEN, { mode: 0o600 });

const wss = new WebSocketServer({
  host: BRIDGE_HOST, port: BRIDGE_PORT, path: BRIDGE_PATH,
  verifyClient: (info, cb) => {
    // Defense in depth: also check Origin if the connection is browser-origin
    const origin = info.req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin)) return cb(false, 403);
    cb(true);
  },
});

// In the hello handler:
if (msg.data.type === "hello") {
  if (msg.data.token !== BRIDGE_TOKEN) {
    socket.close(4001, "invalid token");
    return;
  }
  // ... existing role logic
}
```

Schema change: add `token: z.string()` to `HelloMessage` in `packages/bridge/src/protocol.ts`. Schema bump (this and F.07 from codebase deep dive can ship in one bridge release).

**Coordinated with F.07 (protocol versioning):** if both land at once, the bridge schema gets `protocolVersion` + `token` in one change. Minimal-effort, high-impact bump.

### 2.5 The `BridgeRole` confusion

The protocol already has `BridgeRole = "mcp-server" | "canvas" | "browser-extension"`. **The browser-extension role can also issue `request` messages** (per the bridge-server code):

```ts
if (
  msg.data.type === "request" &&
  (me.role === "mcp-server" || me.role === "browser-extension")
) { /* route to canvas */ }
```

The chrome-extension uses this — its `transport/ws-client.ts` connects as `role: "browser-extension"` and issues `add_components`, `add_css_rules`, etc. to deliver captured pages. **The extension and an MCP-server peer have identical capabilities.** With the token gate (§2.4), the extension would also need to know the token — see §6 for the pairing UX.

## 3. Persistence middleware: unauthenticated HTTP

[`packages/app/plugins/persistence-middleware.ts`](../../packages/app/plugins/persistence-middleware.ts) (82 LOC) exposes:

```
GET  /__designjs/project  → { exists, project? }   (reads .designjs.json)
POST /__designjs/project  → { ok: true }            (overwrites .designjs.json)
```

mounted on the Vite dev server (port 3000).

### 3.1 [F.52] No auth on read or write

Same trust assumption as the WS bridge: any localhost process can:

```
curl http://localhost:3000/__designjs/project
# → user's full design state, in JSON
```

```
curl -X POST http://localhost:3000/__designjs/project \
  -H "Content-Type: application/json" \
  -d '{"pages":[{...attacker payload...}]}'
# → user's .designjs.json silently overwritten
```

**No mitigation today.** Same remediation: token gate. The token from §2.4 can double as the auth here — the canvas sends it as `X-DesignJS-Token` header, persistence-middleware checks it.

### 3.2 [F.53] No Origin check on POST — potential CSRF

A malicious webpage the user visits could (in theory) issue:

```js
// On https://evil.example/page.html
fetch("http://localhost:3000/__designjs/project", {
  method: "POST",
  body: JSON.stringify({ /* destructive payload */ }),
  // The "simple request" CORS exception triggers if Content-Type is text/plain
  headers: { "Content-Type": "text/plain" },
});
```

Modern browsers send a CORS preflight for non-simple Content-Types, and the persistence middleware doesn't include CORS headers, so the preflight fails and the browser refuses. **The middleware is incidentally protected** by Vite's default CORS posture. But this is luck, not design. Explicit `Origin` allowlisting + a CSRF token would harden this against future Vite version changes that flip CORS defaults, plus Electron-style embedding where same-origin policy is more permissive.

### 3.3 Path-traversal: bounded

`findProjectRoot` walks up from `viteRoot` to nearest `pnpm-workspace.yaml` or `.git`, then writes `<that>/.designjs.json`. **No untrusted-input path components** — the filename is a literal constant. ✅ Safe.

## 4. `window.__designjs` revisited (F.09 from codebase)

The codebase deep dive flagged this; the security implications are worth restating here.

```ts
// packages/app/src/App.tsx:212
(window as unknown as { __designjs?: unknown }).__designjs = {
  editor, addHtml, getHtml, getProjectData, save, load, clear, paste,
  getVariables, setVariables,
};
```

**Unconditionally set on every page load — including production builds.**

Combined with §2 (bridge auth absence), an attacker who can run JS in the canvas tab — via a vulnerable iframe content, a content script injected by another extension, a `javascript:` URL pasted into the address bar, an XSS via captured page content from the Chrome extension — has direct access to mutate, save/load, paste, and read the editor state. They don't even need the WS bridge.

**The fix is one line:** gate the assignment behind `import.meta.env.DEV`. E2E tests run under `pnpm dev` (DEV is true); production builds don't expose it. Token-based bridge access still enables programmatic control where needed.

**Compounds with [F.51]:** the production exposure of `__designjs` + the unauthenticated bridge means a malicious-extension-only attack has *two* entry points to the editor state instead of one.

## 5. MCP tool capabilities — no scoping

### 5.1 All 22 tools available to all peers

Per `bridge-server.ts`, any peer with `role: "mcp-server"` or `role: "browser-extension"` can call any of the 22 tools. There is no:
- Per-tool authorization
- Read-only mode (the planned chat "Ask" mode has no bridge-level enforcement)
- Per-artboard scoping (the planned SWARM `agentScope` is canvas-side enforcement)

**For v0.1 this is intentional and fine.** Every connected peer is presumed trusted in the localhost-only model. As soon as v0.2 lands the chat panel with its Build/Ask modes, the dispatcher needs role-aware tool filtering.

### 5.2 Capability scoping shape for v0.2

Recommended pattern (for the synthesis):

```ts
// Proposed: bridge.ts capability types
type ToolCapability =
  | "inspect"      // get_tree, get_html, get_css, get_screenshot, get_selection, get_jsx,
                   //   get_variables, list_artboards
  | "mutate"       // add_components, add_css_rules, update_styles, delete_nodes,
                   //   set_text, set_variables, add_classes, remove_classes
  | "artboard"    // create_artboard, find_placement, fit_artboard
  | "selection";  // select, deselect

// At connection time, the peer declares its scope (and the server validates
// the token + scope combination matches what's allowed for that token).
type HelloMessage = {
  type: "hello";
  role: BridgeRole;
  token: string;
  capabilities?: ToolCapability[];  // omitted = all
};
```

Ask-mode chat connects with `capabilities: ["inspect"]`. Build mode adds `mutate` + `selection`. SWARM's per-agent tokens carry per-artboard scopes additionally.

**[F.54]** This pattern is the bridge-side enforcement for the chat spec's Build/Ask UX. Should land alongside [F.51]'s token gate.

## 6. Chrome extension — the bright spot

`packages/chrome-extension/manifest.json`:

```json
{
  "manifest_version": 3,
  "permissions": ["activeTab", "scripting", "storage"],
  "host_permissions": [
    "http://127.0.0.1:29170/*",
    "http://localhost:29170/*"
  ],
  "content_scripts": [{ "matches": ["<all_urls>"], "run_at": "document_idle" }],
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'; connect-src 'self' ws://127.0.0.1:29170 ws://localhost:29170;"
  }
}
```

**This is exemplary.**

- **MV3** — required for new Chrome Web Store submissions, blocks `eval`, restricts remote code
- **Permissions** — `activeTab` (no broad tab access, only the one the user clicks the icon on), `scripting` (for content-script injection), `storage` (for pairing state when F.51 lands)
- **`host_permissions`** — limited to the bridge port. NOT `<all_urls>` or `https://*` — the extension can't make arbitrary network requests
- **`content_scripts`** matches `<all_urls>` (required: user needs to be able to capture any page) but `run_at: "document_idle"` defers injection until the page is loaded — no race with page load handlers
- **CSP `extension_pages`** restricts to `'self'` for both script and object, plus a specific allowlist for WS connections. **No `'unsafe-eval'`, no `'unsafe-inline'`, no remote scripts.** Far cleaner than the typical MV3 extension.

**[F.55] Chrome extension manifest is exemplary.** Worth referencing in any future docs about secure browser-extension authoring.

### 6.1 Pairing UX recommendation (for F.51 follow-through)

When the bridge token lands, the extension can't read the canvas-side token file. Pairing flow:

1. User clicks the extension icon for the first time
2. Extension shows "Pair with DesignJS canvas" — generates a one-time code
3. User enters the code in the canvas's Settings → MCP tab
4. Canvas signs the code with its `BRIDGE_TOKEN` and stores `{ extensionId, sharedSecret }` in `chrome.storage.local` via a postMessage handshake
5. Subsequent connections present the shared secret in the `hello` message

The `storage` permission in the manifest already supports this.

## 7. Supply chain (recap + new context)

From the CI/DX deep dive:

- ✅ **Dependabot npm + actions** weekly Monday, grouped, with `grapesjs` ignored (corrected from recon)
- ❌ **No CodeQL / SAST** in CI (F.46)
- ❌ **No `pnpm audit` step** in CI (F.47)
- ❌ **No PR-time secret scanning** (F.48)

New security-specific observations:

### 7.1 `@modelcontextprotocol/sdk@1.29.0`

Current version. No known advisories as of late May 2026 (verified against the lockfile, not against a live registry — Phase 2.5 deployment deep dive can check `npm view` for current advisories at synthesis time). The SDK is maintained by Anthropic; tracking the [`modelcontextprotocol/typescript-sdk`](https://github.com/modelcontextprotocol/typescript-sdk) repo for security advisories is the relevant signal.

**[F.56] Track `@modelcontextprotocol/sdk` advisories explicitly.** Dependabot will surface advisories; the security policy should commit to a same-day-patch SLA for any SDK CVE that affects the bridge dispatcher. Document in SECURITY.md.

### 7.2 `ws@^8.20.0`

Current `ws` package (Node WebSocket). Past CVEs exist for ws versions < 7.x; v8.x is patched. ✅ no concern.

### 7.3 GrapesJS at `^0.22.16`

Pinned + Dependabot-ignored. Per the CI/DX deep dive: "the project is one CVE-in-grapesjs-or-its-deps away from a manual fire-drill." GrapesJS has a Backbone runtime; jQuery is a transitive dep. Worth a per-quarter advisory check via `pnpm audit @grapesjs/*` or watching the [`GrapesJS/grapesjs`](https://github.com/GrapesJS/grapesjs) security advisories tab.

### 7.4 Vendored reference projects

`onlook/`, `penpot/`, `flux/`, `Blipshot/`, `SingleFile/`, `chrome-devtools-mcp/`, `screenshot-capture/`, `design.md/` — all out-of-scope per SECURITY.md. Confirmed via spot-check that the project's build paths don't reach into them (`pnpm-workspace.yaml` is `packages/*` only).

**[F.57] SECURITY.md's vendored-projects list is partial.** Names `SingleFile/`, `Blipshot/`, `onlook/`, `penpot/`, `flux/` but doesn't name `chrome-devtools-mcp/`, `screenshot-capture/`, `design.md/`. One-line addition; closes the ambiguity for future contributors.

## 8. Forward-looking: securing v0.2 / v0.3

### 8.1 BYO key storage (Track A — ai-chat.md)

The spec describes a three-tier storage strategy:

1. OS keychain (desktop wrapper — not relevant for v0.2)
2. `~/.designjs/secrets.json` mode 0o600 (the v0.2 path)
3. `apiKeyHelper` shell command (advanced)

**Threat model considerations:**

- **Never persist in `.designjs.json`, exports, screenshots, or telemetry** — the spec already says this. Enforce via a serialization-time redaction list. Add a unit test that round-trips a project with `cssVariables: { "--api-key": "sk-..." }` and asserts the value is redacted from exports.
- **Never appear in process titles** — Node CLI tools sometimes pass keys via argv (visible in `ps`). Read from `~/.designjs/secrets.json` only; never accept via argv or env var that gets logged.
- **Bridge token must not gate the key surface.** Compromise of one shouldn't compromise the other. Keep secrets.json access entirely server-side (Node process); never expose to the renderer. The renderer asks Node "make this OpenRouter call" with parameters; Node decorates the request with the key.

**[F.58] Recommend an ADR for the secrets module before implementation.** Capture: storage path + permissions + read/write API + redaction list + threat model. Will sit alongside [F.51]'s bridge auth ADR.

### 8.2 OAuth-PKCE for GitHub (Track B — repo-connection.md)

PKCE is the right choice here (no client_secret, browser can do the full flow). Considerations:

- **Storage of `code_verifier` between authorize redirect and callback** — must be in browser memory only (sessionStorage works but persists across tabs; in-memory closure is cleaner). Never persisted to disk.
- **Callback handler URL** — the spec talks about a Vite plugin extension for the callback. Must validate `state` parameter to prevent CSRF.
- **Token storage** — same `~/.designjs/secrets.json` pattern. Same redaction rules.
- **Refresh token rotation** — GitHub's OAuth Apps don't issue refresh tokens for the PKCE flow with `repo` scope (they're long-lived tokens). When the cloud tier lands with GitHub Apps (per the spec), refresh-token rotation becomes a real consideration.

**[F.59] OAuth-PKCE state validation** — the spec doesn't currently call out the CSRF protection via `state`. Add to the spec's security section before implementation.

### 8.3 SWARM mode multi-peer trust

Per the SWARM spec (`DesignJS-Notes/swarm.md`):

- Up to 6 concurrent agents
- Each gets per-artboard scoping
- All flow through the same MCP dispatcher with `origin: 'agent:<agent-id>'` tags

**Today's bridge** has zero peer-to-peer trust enforcement. Two concurrent `mcp-server` peers can issue conflicting tool calls and the bridge will route both to the canvas; per-artboard locking lives canvas-side.

**For SWARM:** lift the locking decision to the bridge dispatcher (so it can serialize per-artboard before the canvas sees concurrent calls). Combine with token+scope from §5.2 — each agent gets a different token with a different scope. This is exactly the "single MCP dispatcher with origin tagging" pattern from the chat spec; SWARM is its highest-throughput consumer.

### 8.4 Sandbox preview (Track B — sandbox-preview.md)

WebContainers run in the browser tab in a sandboxed iframe. The threat model:

- **WebContainers process the user's repo code.** Untrusted user code is fine (it's *the user's* code, not third-party).
- **The iframe is same-origin with the canvas.** It can call `parent.postMessage`. The spec already proposes a `postMessage` RPC for SET_URL / RELOAD / SERVER_READY / HMR_ERROR / CONSOLE_LOG. **Allowlist message types** and validate sender (`event.origin === sandboxOrigin`) — the spec doesn't explicitly call this out.
- **HMR errors forwarded to chat panel as "fix this" suggestions** — make sure error messages from the user's app don't get treated as instructions to the LLM (prompt injection). Sanitize / structure-tag the error before injecting.

**[F.60] Sandbox iframe postMessage handler needs origin + type validation.** Add to the spec before implementation.

### 8.5 CodeSandbox SDK as paid tier

The spec proposes `@codesandbox/sdk` with user-provided `CSB_API_KEY`. Same secrets storage pattern as OpenRouter keys. Same redaction rules.

**One additional concern:** the `getSession` callback hits the user's backend (or the local Node process) to refresh sandbox sessions. The callback executes whenever the SDK decides — must be idempotent and rate-limited. Otherwise an attacker can exhaust the user's CodeSandbox quota.

## 9. SECURITY.md assessment

Re-read in this context. It's solid as a baseline but four expansions would close the v0.2-ready gap:

### 9.1 What it gets right

- Clear reporting path (email, 72h ack, 14-day fix target for high-severity)
- Per-package scope statement
- Honest acknowledgment of the localhost-trust assumption
- Lists supported versions (current + main)

### 9.2 What's missing

- **The browser-extension threat vector** (§1.3 above)
- **WS bridge auth model statement** — even "currently no auth; localhost-trust assumed" is more useful than silence
- **Secrets storage policy** for v0.2 (currently nothing to protect; will be everything to protect)
- **MCP SDK CVE response policy** (F.56)
- **Vendored-projects list completeness** (F.57)

**[F.61] SECURITY.md additions before v0.2 ships:** the four items above. ~30 minutes of writing; significant trust signal for users about to give DesignJS API keys.

## 10. Findings rollup

| # | Finding | Severity | Effort |
|---|---|---|---|
| F.51 | **Critical: Bridge WS server has no auth or role validation** | **High** | M (~half day for token gate + protocol bump) |
| F.52 | Persistence middleware HTTP unauthenticated | High | XS (same token from F.51) |
| F.53 | Persistence POST has no explicit Origin check (incidentally protected) | Med | XS (~30 min) |
| F.54 | All 22 MCP tools available to all peers — no capability scoping | Med (today) / High (v0.2 with chat Ask mode) | M (schema + dispatcher) |
| F.55 | Chrome extension manifest is exemplary (positive) | n/a | n/a |
| F.56 | No documented `@modelcontextprotocol/sdk` advisory SLA | Low | XS (SECURITY.md addition) |
| F.57 | SECURITY.md's vendored-projects list missing `chrome-devtools-mcp/`, `screenshot-capture/`, `design.md/` | Low | XS |
| F.58 | Recommend ADR for secrets module before v0.2 implementation | Med | M (ADR drafting) |
| F.59 | OAuth-PKCE state validation not called out in repo-connection spec | Med | XS (spec edit) |
| F.60 | Sandbox iframe postMessage handler needs origin + type validation; spec doesn't say | Med | XS (spec edit) |
| F.61 | SECURITY.md gaps before v0.2 ships (browser-ext threat, secrets policy, MCP SDK SLA) | Med | XS (~30 min) |

Plus reinforcement of earlier security-relevant findings:

| # | From | Note |
|---|---|---|
| F.09 | Codebase | `window.__designjs` in production builds — compounds with F.51 |
| F.07 | Codebase | Bridge protocol versioning — can ship in same release as F.51 token gate |
| F.46 | CI/DX | No CodeQL / SAST — security baseline missing |
| F.47 | CI/DX | No `pnpm audit` in CI |
| F.48 | CI/DX | No PR-time secret scanning |

## 11. Risk tiers

**Tier 0 — fix-this-sprint (genuinely needs attention):**
- **F.51** — Bridge auth via token gate. The biggest single security finding. ~half day with [F.07] coordinated in the same bridge release.
- **F.52** — Persistence middleware shares the same token. Trivial add once F.51 lands.
- **F.09** — `window.__designjs` production gate. One-line fix; can land independently this week.

**Tier 1 — fix-in-the-week:**
- **F.46 + F.47** — Add CodeQL workflow + `pnpm audit` step (from CI/DX). Security baseline.
- **F.57** — SECURITY.md vendored-projects list completeness. 5 minutes.
- **F.61** — SECURITY.md gaps update. ~30 min.

**Tier 2 — fix-this-quarter (before v0.2 ships):**
- **F.54** — Capability scoping for chat Ask mode. Cleanly fits with F.51.
- **F.58** — Secrets-module ADR. Before chat panel's settings modal lands.
- **F.59 + F.60** — Spec edits for OAuth-PKCE state validation and sandbox postMessage origin checks. Touch the specs in `DesignJS-Notes/` rather than waiting for implementation.

**Tier 3 — keep an eye on:**
- **F.53** — Origin check on persistence POST (incidentally protected today).
- **F.55** — Chrome extension exemplary; keep it that way as v0.3 expands its capabilities.
- **F.56** — `@modelcontextprotocol/sdk` advisory tracking.

**Tier 4 — strategic:**
- The synthesis should consider a single **"v0.2 security gate"** umbrella that bundles F.51 + F.09 + F.46 + F.47 + F.57 + F.58 + F.61 as the security posture upgrade that must land before any v0.2 API-key-handling code merges.

---

**Next:** Phase 2.5 — Deployment deep dive.
