# @designjs/app

Vite + React SPA hosting the GrapesJS canvas. Private workspace package — not published; run via `pnpm dev` from the [repo root](https://github.com/rubychilds/DesignJS).

The app embeds the WebSocket bridge hub on `127.0.0.1:29170` (path `/designjs-bridge`). The MCP server and the Chrome extension both connect here; the canvas relays tool calls to the GrapesJS editor and replies back. See the [repo root README](https://github.com/rubychilds/DesignJS#how-it-works) for the full diagram.

## Source layout

```
src/
├── bridge/      # WebSocket hub + per-tool handlers (one handler per TOOL_SCHEMAS entry)
├── canvas/      # GrapesJS editor wiring, artboards, primitives, persistence to .designjs.json
└── components/  # Editor chrome — Topbar, panels, LayerTree, BlockPalette, Inspector, etc.
```

When adding a new MCP tool, the handler lives in `src/bridge/handlers.ts` — see [CONTRIBUTING.md](../../CONTRIBUTING.md#workspace-layout) for the full flow.

## Run

From the repo root:

```bash
pnpm install
pnpm dev
```

Opens at <http://localhost:3000>. Bridge connection status shows top-right in the editor shell.

## Conventions

The editor chrome follows established design-tool conventions. The two load-bearing references:

- [ADR-0001 — Frontend UI stack](../../docs/adr/0001-frontend-ui-stack.md): Tailwind v4 + shadcn/ui + Radix, token-based theming, 14px max chrome type scale, Lucide-only icons.
- [ADR-0003 — Panel information architecture](../../docs/adr/0003-panel-information-architecture.md): Penpot as the reference shape for the inspector.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the wider contributor guide.

## License

MIT — see [LICENSE](LICENSE) (or the LICENSE in the repo root).
