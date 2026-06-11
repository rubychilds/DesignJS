# create-designjs

Project scaffolder for AI-driven design with [DesignJS](https://github.com/rubychilds/DesignJS) — the open-source MCP design canvas that gives AI coding agents eyes on a live HTML/CSS canvas.

## Quick start

```bash
npm create designjs@latest my-app
cd my-app
```

(Also works with `pnpm create designjs my-app` and `yarn create designjs my-app`.)

Then open your agent in the project directory:

```bash
claude          # Claude Code — picks up .mcp.json automatically
# or
cursor .
# or
code .
```

## What it creates

`my-app/` contains:

| File | Purpose |
|------|---------|
| `.mcp.json` | MCP config pointing at `npx -y @designjs/mcp-server`. Claude Code, Cursor, and VS Code agents discover this automatically. |
| `CLAUDE.md` | Agent guidance — biases the agent toward DesignJS's visual MCP tools instead of writing React files blind. |
| `README.md` | Per-project quickstart + prerequisites. |

Nothing else — no `package.json`, no `node_modules`, no framework choice. The scaffold drops in next to whatever app code you already have (or none yet).

## Prerequisites

The DesignJS canvas app runs locally (it's not hosted). Clone it once and leave it running:

```bash
git clone https://github.com/rubychilds/DesignJS.git
cd DesignJS && pnpm install && pnpm dev
```

The canvas opens at <http://localhost:3000>; the WebSocket bridge listens on `127.0.0.1:29170`. Point your agent at the scaffolded project and start prompting:

> "Create a Desktop artboard, then add a pricing section with three tier cards."

## See also

- Repo root: [DesignJS](https://github.com/rubychilds/DesignJS) — architecture, agent setup, full MCP tool reference
- [`@designjs/mcp-server`](https://www.npmjs.com/package/@designjs/mcp-server) — the stdio MCP server this scaffold wires up

## License

MIT — see [LICENSE](LICENSE) (or the LICENSE in the repo root).
