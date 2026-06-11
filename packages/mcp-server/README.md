# @designjs/mcp-server

Stdio [Model Context Protocol](https://modelcontextprotocol.io/) server that connects AI coding agents (Claude Code, Cursor, Codex, any MCP-compatible client) to the live [DesignJS](https://github.com/rubychilds/DesignJS) HTML/CSS canvas.

You almost never install this — agents spawn it on demand via `npx -y @designjs/mcp-server`.

## What it does

The server is a thin stdio ↔ WebSocket translator:

```
agent (stdio, JSON-RPC) ─▶ @designjs/mcp-server ─▶ WebSocket (127.0.0.1:29170) ─▶ DesignJS canvas
```

1. The agent dispatches an MCP tool call over stdio
2. The server validates `params` against the tool's Zod schema (shared with the canvas via [`@designjs/bridge`](https://www.npmjs.com/package/@designjs/bridge))
3. It forwards the call over the local WebSocket bridge
4. The browser-side handler runs against the GrapesJS editor and replies
5. The server returns the result to the agent

No design state is held in the server. The canvas is the single source of truth.

## Usage

Make sure the DesignJS canvas is running locally (`pnpm dev` in the [repo root](https://github.com/rubychilds/DesignJS) — listens on `http://localhost:3000`, WebSocket bridge on `127.0.0.1:29170`).

Then register the server in your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "designjs": {
      "command": "npx",
      "args": ["-y", "@designjs/mcp-server"]
    }
  }
}
```

Open your agent in the project directory:

```bash
claude          # Claude Code — picks up .mcp.json automatically
# or
cursor .
# or
code .
```

On the first tool call the agent runs `npx -y @designjs/mcp-server` and the bridge dot in the canvas Topbar flips to green.

A faster path for new projects: `npm create designjs@latest my-app` ([`create-designjs`](https://www.npmjs.com/package/create-designjs)) drops a ready-to-use `.mcp.json` and `CLAUDE.md`.

## Tools exposed

22 bidirectional tools across **inspect**, **mutate**, and **artboards** — full list with descriptions, input/output schemas, and example prompts is in the [repo root README](https://github.com/rubychilds/DesignJS#mcp-tools). The authoritative count is `Object.keys(TOOL_SCHEMAS).length` from [`@designjs/bridge`](https://www.npmjs.com/package/@designjs/bridge); the server auto-registers everything declared there, so the published tool surface and the schemas can't drift.

Categories at a glance:

- **Inspect** — `ping`, `get_tree`, `get_html`, `get_css`, `get_jsx`, `get_screenshot`, `get_selection`, `get_variables`
- **Mutate** — `add_components`, `add_css_rules`, `update_styles`, `add_classes`, `remove_classes`, `set_text`, `set_variables`, `delete_nodes`, `select`, `deselect`
- **Artboards** — `create_artboard`, `list_artboards`, `find_placement`, `fit_artboard`

## Binary

Installs a `designjs-mcp` bin. Most users never invoke it directly — the MCP client manages the lifecycle. For local debugging of the stdio protocol, you can run:

```bash
npx -y @designjs/mcp-server
```

and pipe JSON-RPC frames on stdin.

## See also

- Repo root: [DesignJS](https://github.com/rubychilds/DesignJS) — architecture, quickstart, comparison table, MCP tool reference
- [`@designjs/bridge`](https://www.npmjs.com/package/@designjs/bridge) — shared schemas and protocol constants
- [`create-designjs`](https://www.npmjs.com/package/create-designjs) — scaffolder that wires this server into a fresh project

## License

MIT — see [LICENSE](LICENSE) (or the LICENSE in the repo root).
