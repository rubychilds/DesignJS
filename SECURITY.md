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
  (`SingleFile/`, `Blipshot/`, `onlook/`, `penpot/`, `flux/`, etc.) — report
  upstream.
- Vulnerabilities that require an attacker to already control the user's
  machine (the bridge binds to `127.0.0.1` by design).

## Supported versions

Only the latest published version of each package and the `main` branch
receive security fixes while we are pre-1.0.
