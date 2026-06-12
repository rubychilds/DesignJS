# @designjs/cli

`designjs init` — auto-detects installed IDEs (Claude Code, Cursor, VS Code) and writes the right MCP config so they discover the [DesignJS](https://github.com/rubychilds/DesignJS) canvas. Private workspace package.

## Status: deferred from v0.1

This CLI is **not published** in v0.1. Per [RELEASING.md](../../RELEASING.md#what-gets-published), the v0.1 install paths are:

- **New projects** — use [`create-designjs`](https://www.npmjs.com/package/create-designjs): `npm create designjs@latest my-app`
- **Existing projects** — write `.mcp.json` (or `.cursor/mcp.json` / `.vscode/mcp.json`) by hand. The 5-line snippet is in the [repo root README](https://github.com/rubychilds/DesignJS#manual-mcp-config).

The `designjs init` flow is planned for v0.2 once the IDE-detection surface stabilises. Source lives in `src/` for that work.

## Binary (when published)

```
bin: designjs
```

## See also

- Repo root: [DesignJS](https://github.com/rubychilds/DesignJS)
- [`create-designjs`](https://www.npmjs.com/package/create-designjs) — the published path for v0.1

## License

MIT — see [LICENSE](LICENSE) (or the LICENSE in the repo root).
