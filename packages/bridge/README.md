# @designjs/bridge

Shared [Zod](https://zod.dev/) schemas and WebSocket protocol constants for [DesignJS](https://github.com/rubychilds/DesignJS) — the open-source MCP design canvas that gives AI coding agents eyes.

This package is consumed by both halves of DesignJS so they agree on the wire shape:

- [`@designjs/mcp-server`](https://www.npmjs.com/package/@designjs/mcp-server) — the stdio MCP binary agents spawn
- The DesignJS canvas runtime (browser-side WebSocket bridge client)

You typically don't install this directly. It ships as a dependency of `@designjs/mcp-server`. Install it explicitly only if you're building a third-party canvas, a custom MCP client, or another bridge peer.

## Install

```bash
npm install @designjs/bridge
```

## What's in this package

### Tool schemas

| Export | Purpose |
|--------|---------|
| `TOOL_SCHEMAS` | Map of every MCP tool name → `{ input, output }` Zod schemas. `Object.keys(TOOL_SCHEMAS).length` is the source of truth for the tool count (currently 22). |
| `TOOL_DESCRIPTIONS` | Map of tool name → human description string. These are what gets advertised to agents via MCP's `tools/list`. |
| `ToolName` | `keyof typeof TOOL_SCHEMAS` — the type-safe union of tool identifiers. |

Per-tool Zod schemas (e.g. `GetTreeInput`, `AddComponentsOutput`, `CreateArtboardInput`) are also exported individually for direct use.

### Protocol envelope

| Export | Purpose |
|--------|---------|
| `BridgeMessage` | Discriminated union of every message type on the wire. |
| `HelloMessage` | First message each peer sends — declares its role. |
| `RequestMessage` | Tool invocation envelope (`{ id, tool, params }`). |
| `ResponseMessage` | Result envelope, discriminated on `ok: true \| false`. |
| `BridgeRole` | `"mcp-server" \| "canvas" \| "browser-extension"`. |

### Protocol constants

| Export | Value |
|--------|-------|
| `BRIDGE_HOST` | `"127.0.0.1"` |
| `BRIDGE_PORT` | `29170` |
| `BRIDGE_PATH` | `"/designjs-bridge"` |

## Example

```ts
import {
  TOOL_SCHEMAS,
  BRIDGE_HOST,
  BRIDGE_PORT,
  BRIDGE_PATH,
  RequestMessage,
} from "@designjs/bridge";

// Validate an incoming request from the wire
const parsed = RequestMessage.parse(JSON.parse(rawFrame));

// Validate the tool's params against its registered schema
const schema = TOOL_SCHEMAS[parsed.tool as keyof typeof TOOL_SCHEMAS];
const params = schema.input.parse(parsed.params);

// Connect to the running canvas
const ws = new WebSocket(`ws://${BRIDGE_HOST}:${BRIDGE_PORT}${BRIDGE_PATH}`);
```

Both halves of DesignJS import from here. When the two sides need to agree on a wire shape, it's defined here once and validated at every boundary.

## See also

- Repo root: [DesignJS](https://github.com/rubychilds/DesignJS) — architecture, agent setup, full MCP tool reference, comparison table
- [`@designjs/mcp-server`](https://www.npmjs.com/package/@designjs/mcp-server) — the published stdio server that uses this package

## License

MIT — see [LICENSE](LICENSE) (or the LICENSE in the repo root).
