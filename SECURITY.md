# Security Policy

## Reporting a vulnerability

DesignJS is pre-1.0 and does not yet have a dedicated disclosure inbox. If you
discover a security issue:

1. **Do not** open a public GitHub issue.
2. Email **ruby.childs1@gmail.com** with subject `[security] <short summary>`.
3. Include reproduction steps, the affected version / commit, and (if known)
   a suggested fix or mitigation.

We aim to acknowledge reports within **72 hours** and ship a fix or mitigation
within **14 days** for high-severity issues. Lower-severity issues are
addressed in the next regular release.

## Scope

In scope:

- `@designjs/app` — canvas, inspector, bridge client
- `@designjs/bridge` — local WebSocket protocol (default port 29170)
- `@designjs/mcp-server` — MCP stdio surface
- `@designjs/cli` and `create-designjs` — scaffolding tools
- The Chrome extension under `packages/chrome-extension/`

Out of scope:

- Vendored / reference projects checked into the repo root for research
  (`SingleFile/`, `Blipshot/`, `onlook/`, `penpot/`, `flux/`,
  `chrome-devtools-mcp/`, `screenshot-capture/`, `design.md/`, etc.) —
  report upstream.
- Vulnerabilities that require an attacker to already control the user's
  machine (the bridge binds to `127.0.0.1` by design).

## Currently out of scope (with mitigation timeline)

These are known limitations of the current (v0.1) security posture. They are
documented here so users can decide whether v0.1 fits their threat model, and
so the v0.2 work that closes them is publicly tracked. The full threat-model
deep dive lives at [docs/architecture/architecture-security.md](docs/architecture/architecture-security.md).

**1. Browser-extension threat vector.** The "vulnerabilities that require an
attacker to already control the user's machine" line above is partially right
but misses a real attacker class: malicious or compromised browser extensions
the user installed willingly. Extensions run in the user's browser with the
user's permission and can reach `127.0.0.1` trivially — including the bridge.
This is an acknowledged v0.1 limitation. The v0.2 bridge token gate
(ADR-0015, Proposed) closes the attack vector by requiring a capability token
on every bridge connection.

**2. WebSocket bridge authentication.** The bridge currently binds to
`127.0.0.1:29170` with no authentication and no Origin validation. Any
localhost process can connect as any role. This is the right default for
v0.1 (local-first, low-value assets — the canvas state and synthetic design
nodes). It becomes high-severity the moment v0.2 ships the chat panel and
secrets storage: bridge auth (ADR-0015, Proposed) must land before any v0.2
key-handling code merges.

**3. Secrets storage policy (forward-looking).** When v0.2's chat panel and
repo-connection ship, API keys and OAuth tokens live at
`~/.designjs/secrets.json` with mode `0o600`. The secrets module (ADR-0017,
Proposed) defines the contract — storage path, permissions, read/write API,
redaction list. Trust boundary: anyone who can read the user's home
directory *as the user* can read DesignJS secrets, the same boundary as the
user's SSH keys, AWS credentials, and `.npmrc`. We do not attempt to defend
against same-user-on-the-same-machine attackers.

**4. MCP SDK CVE response policy.** For advisories against
`@modelcontextprotocol/sdk` that affect the bridge dispatcher, we commit to a
**same-day-patch SLA** — a patched release goes out the day the advisory is
public (or the day we are notified privately, if earlier). The SDK is
maintained by Anthropic; we track the
[@modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk)
repository's advisories tab.

## Supported versions

Only the latest published version of each package and the `main` branch
receive security fixes while we are pre-1.0.
