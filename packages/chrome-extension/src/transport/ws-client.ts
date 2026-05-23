/**
 * WebSocket client to the DesignJS canvas bridge.
 *
 * Per ADR-0011 §1: the extension is a `browser-extension` peer on the
 * existing `ws://127.0.0.1:29170/designjs-bridge` multi-peer protocol.
 * Talks to the canvas directly via the bridge; no MCP-server dependency.
 *
 * Protocol (@designjs/bridge):
 *   Client → bridge: { type: "hello", role: "browser-extension" }
 *                    { type: "request", id, tool, params }
 *   Bridge → client: { type: "response", id, ok, result | error }
 *
 * Reconnect: exponential backoff 1s → 2s → 4s → 8s → capped at 30s.
 * Status: onStatus fires on every transition so the overlay can reflect
 * connection state in real time.
 */

export type BridgeStatus = "connected" | "connecting" | "disconnected";

export interface ConnectOptions {
  url?: string;
  onStatus?: (status: BridgeStatus) => void;
}

export interface BridgeConnection {
  send(payload: {
    tool: string;
    params?: Record<string, unknown>;
    /** Per-call timeout override. Default 15s; long-running tools (large
     * `add_components` payloads, full GrapesJS reparse) can request more. */
    timeoutMs?: number;
  }): Promise<unknown>;
  currentStatus(): BridgeStatus;
  dispose(): void;
}

const DEFAULT_URL = "ws://127.0.0.1:29170/designjs-bridge";
const BACKOFFS_MS = [1000, 2000, 4000, 8000, 15000, 30000];

type PendingResolver = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

export function connectToBridge(opts: ConnectOptions = {}): BridgeConnection {
  const url = opts.url ?? DEFAULT_URL;
  let status: BridgeStatus = "disconnected";
  let socket: WebSocket | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let nextRequestId = 1;
  const pending = new Map<string, PendingResolver>();

  const setStatus = (next: BridgeStatus) => {
    if (status === next) return;
    status = next;
    opts.onStatus?.(next);
  };

  const open = () => {
    if (disposed) return;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    setStatus("connecting");
    try {
      socket = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }

    socket.addEventListener("open", () => {
      reconnectAttempt = 0;
      socket?.send(
        JSON.stringify({ type: "hello", role: "browser-extension" }),
      );
      setStatus("connected");
    });

    socket.addEventListener("message", (ev) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object") return;
      const m = parsed as {
        type?: string;
        id?: string;
        ok?: boolean;
        result?: unknown;
        error?: string;
      };
      if (m.type !== "response" || typeof m.id !== "string") return;
      const waiter = pending.get(m.id);
      if (!waiter) return;
      pending.delete(m.id);
      if (m.ok === true) waiter.resolve(m.result);
      else waiter.reject(new Error(m.error ?? "unknown bridge error"));
    });

    socket.addEventListener("close", () => {
      setStatus("disconnected");
      // Drop any in-flight requests — the other side can't respond now.
      for (const waiter of pending.values()) {
        waiter.reject(new Error("bridge connection closed"));
      }
      pending.clear();
      scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      // The close handler will run next and schedule the reconnect.
      // We don't surface a separate "error" status — the connection-state
      // enum is just connected/connecting/disconnected.
    });
  };

  const scheduleReconnect = () => {
    if (disposed) return;
    const delay =
      BACKOFFS_MS[Math.min(reconnectAttempt, BACKOFFS_MS.length - 1)]!;
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(open, delay);
  };

  open();

  return {
    async send(payload) {
      if (status !== "connected" || !socket) {
        throw new Error("bridge not connected");
      }
      const id = String(nextRequestId++);
      const request = {
        type: "request",
        id,
        tool: payload.tool,
        params: payload.params ?? {},
      };
      const timeoutMs = payload.timeoutMs ?? 15_000;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket!.send(JSON.stringify(request));
        // Fire-and-forget timeout so a silently-dropped response doesn't
        // hang forever. Default 15s matches the bridge's get_screenshot
        // budget. Whole-page captures pass a longer value for the main
        // add_components — GrapesJS' parse + render of a 2MB+ payload
        // (Wikipedia-class articles) can run well past 15s.
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`bridge request "${payload.tool}" timed out`));
          }
        }, timeoutMs);
      });
    },
    currentStatus: () => status,
    dispose: () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socket && socket.readyState === WebSocket.OPEN) socket.close();
      socket = null;
    },
  };
}
