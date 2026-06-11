#!/usr/bin/env node
/**
 * Smoke test for the MCP server over stdio.
 *
 * Spawns `tsx src/index.ts` in packages/mcp-server, performs the MCP
 * `initialize` handshake, then calls `tools/list` and asserts that all v0.1+
 * tools are registered (currently 22).
 *
 * The expected tool list is derived from `TOOL_SCHEMAS` in
 * `packages/bridge/dist/tools.js` — the single source of truth that the
 * mcp-server itself imports. This makes the smoke self-updating: any new tool
 * registered in `TOOL_SCHEMAS` is automatically asserted here, and any tool
 * that silently stops registering will fail the smoke.
 *
 * Requires `@designjs/bridge` to be built (`pnpm --filter @designjs/bridge
 * build`). CI already does this before invoking this script.
 *
 * Does NOT require a canvas peer — just exercises the stdio layer.
 * Exits 0 on success, 1 on failure.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { TOOL_SCHEMAS } from "../packages/bridge/dist/tools.js";

const TIMEOUT_MS = 10_000;
const EXPECTED_TOOLS = Object.keys(TOOL_SCHEMAS);

const mcpDir = resolve(new URL(".", import.meta.url).pathname, "..", "packages/mcp-server");
const child = spawn("pnpm", ["exec", "tsx", "src/index.ts"], {
  cwd: mcpDir,
  stdio: ["pipe", "pipe", "pipe"],
});

const rl = createInterface({ input: child.stdout });
const pending = new Map();

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id != null && pending.has(msg.id)) {
    const { resolve: r } = pending.get(msg.id);
    pending.delete(msg.id);
    r(msg);
  }
});

child.stderr.on("data", (b) => {
  process.stderr.write(b);
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`${method} timed out`)), TIMEOUT_MS);
    pending.set(id, {
      resolve: (m) => {
        clearTimeout(timer);
        res(m);
      },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

async function main() {
  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.0.1" },
  });
  if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);

  notify("notifications/initialized");

  const list = await request("tools/list", {});
  if (list.error) throw new Error(`tools/list failed: ${JSON.stringify(list.error)}`);

  const names = (list.result?.tools ?? []).map((t) => t.name).sort();
  const expected = [...EXPECTED_TOOLS].sort();
  const missing = expected.filter((t) => !names.includes(t));
  if (missing.length > 0) throw new Error(`missing tools: ${missing.join(", ")}`);

  console.log(`OK mcp-server registered ${names.length} tools: ${names.join(", ")}`);
}

main()
  .then(() => {
    child.kill("SIGTERM");
    process.exit(0);
  })
  .catch((err) => {
    console.error("FAIL:", err.message);
    child.kill("SIGTERM");
    process.exit(1);
  });
