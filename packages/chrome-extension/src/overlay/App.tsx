/**
 * DesignJS capture overlay — React component rendered into an
 * injected DOM container on the host page (not a browser-action
 * popup). See content/index.tsx for the injector.
 *
 * Uses the DesignJS editor-chrome token palette (theme.css) for
 * visual continuity with the canvas. Ships with full rounded corners
 * + shadow since we control the container — no browser-popup
 * square-backdrop issue.
 */

import { useEffect, useState } from "react";
import type { BridgeStatus } from "../transport/ws-client.js";
import { Button } from "./components/ui/button.js";
import { cn } from "../lib/utils.js";

type CaptureError =
  | "too-large"
  | "bridge-disconnected"
  | "empty-input"
  | "cancelled"
  | "unknown";

type RenderingSub =
  | "creating-artboard"
  | "adding-backplate"
  | "adding-components"
  | "fitting";

type CaptureState =
  | { kind: "idle" }
  | { kind: "capturing" }
  | { kind: "serializing"; estimatedNodes: number }
  | { kind: "screenshotting"; nodeCount: number; byteCount: number }
  | { kind: "sending"; nodeCount: number; byteCount: number }
  | { kind: "rendering"; sub: RenderingSub; nodeCount?: number; byteCount?: number }
  | { kind: "sent"; nodeCount: number; byteCount: number }
  | { kind: "error"; error: CaptureError; detail?: string };

const IN_PROGRESS_KINDS = new Set([
  "serializing",
  "screenshotting",
  "sending",
  "rendering",
] as const);

function isInProgress(state: CaptureState): boolean {
  return (IN_PROGRESS_KINDS as Set<string>).has(state.kind);
}

function StatusDot({ status }: { status: BridgeStatus }) {
  return (
    <span
      className={cn(
        "inline-block h-2 w-2 rounded-full transition-colors",
        status === "connected"
          ? "bg-oc-success"
          : status === "connecting"
            ? "bg-oc-warning animate-pulse"
            : "bg-muted-foreground/40",
      )}
      aria-hidden
    />
  );
}

export interface AppProps {
  onDismiss?: () => void;
}

export function App({ onDismiss }: AppProps = {}) {
  const [status, setStatus] = useState<BridgeStatus>("disconnected");
  const [capture, setCapture] = useState<CaptureState>({ kind: "idle" });

  useEffect(() => {
    chrome.runtime.sendMessage({ type: "bridge-status:request" }, (res) => {
      if (res?.status) setStatus(res.status);
    });
    const bgListener = (msg: { type: string; status?: BridgeStatus }) => {
      if (msg.type === "bridge-status" && msg.status) setStatus(msg.status);
    };
    chrome.runtime.onMessage.addListener(bgListener);

    const winListener = (ev: MessageEvent) => {
      if (ev.source !== window) return;
      const data = ev.data as
        | {
            type: "designjs:capture:progress";
            phase: "serializing";
            estimatedNodes: number;
          }
        | {
            type: "designjs:capture:progress";
            phase: "screenshotting" | "sending";
            nodeCount: number;
            byteCount: number;
          }
        | {
            type: "designjs:capture:progress";
            phase: "rendering";
            sub: RenderingSub;
            nodeCount?: number;
            byteCount?: number;
          }
        | {
            type: "designjs:capture:result";
            ok: boolean;
            error?: string;
            nodeCount?: number;
            byteCount?: number;
          };
      if (data?.type === "designjs:capture:progress") {
        if (data.phase === "serializing") {
          setCapture({ kind: "serializing", estimatedNodes: data.estimatedNodes });
          return;
        }
        if (data.phase === "screenshotting") {
          setCapture({
            kind: "screenshotting",
            nodeCount: data.nodeCount,
            byteCount: data.byteCount,
          });
          return;
        }
        if (data.phase === "sending") {
          setCapture({
            kind: "sending",
            nodeCount: data.nodeCount,
            byteCount: data.byteCount,
          });
          return;
        }
        if (data.phase === "rendering") {
          setCapture({
            kind: "rendering",
            sub: data.sub,
            nodeCount: data.nodeCount,
            byteCount: data.byteCount,
          });
          return;
        }
      }
      if (data?.type === "designjs:capture:result") {
        if (data.ok) {
          setCapture({
            kind: "sent",
            nodeCount: data.nodeCount ?? 0,
            byteCount: data.byteCount ?? 0,
          });
          window.setTimeout(() => setCapture({ kind: "idle" }), 2500);
        } else {
          const raw = data.error ?? "unknown";
          const known = new Set<CaptureError>([
            "too-large",
            "bridge-disconnected",
            "empty-input",
            "cancelled",
            "unknown",
          ]);
          const knownMatch = known.has(raw as CaptureError)
            ? (raw as CaptureError)
            : "unknown";
          console.error("[designjs] capture failed:", raw, data);
          setCapture({
            kind: "error",
            error: knownMatch,
            detail: knownMatch === "unknown" ? raw : undefined,
          });
        }
      }
    };
    window.addEventListener("message", winListener);

    return () => {
      chrome.runtime.onMessage.removeListener(bgListener);
      window.removeEventListener("message", winListener);
    };
  }, []);

  const start = () => {
    setCapture({ kind: "capturing" });
    window.postMessage({ type: "designjs:capture:start" }, "*");
  };

  const stop = () => {
    setCapture({ kind: "idle" });
    window.postMessage({ type: "designjs:capture:stop" }, "*");
  };

  const capturePage = () => {
    // Optimistic placeholder; real phase events from the content script
    // (serializing → screenshotting → sending → rendering) take over once
    // the page-capture pipeline starts emitting.
    setCapture({ kind: "serializing", estimatedNodes: 0 });
    window.postMessage({ type: "designjs:capture:page" }, "*");
  };

  const disconnected = status !== "connected";
  const capturing = capture.kind === "capturing";
  const inProgress = isInProgress(capture);
  const statusLabel =
    status === "connected"
      ? "Connected to canvas"
      : status === "connecting"
        ? "Connecting…"
        : "DesignJS not running";

  return (
    <div
      className={cn(
        "designjs-popup-container",
        "flex flex-col overflow-hidden",
        "bg-card text-foreground",
        "rounded-xl border border-border",
        "shadow-[0_25px_50px_-12px_rgba(0,0,0,0.25)]",
      )}
      role="dialog"
      aria-label="DesignJS capture"
    >
      <header className="flex h-9 items-center justify-between px-3 border-b border-border">
        <div
          className="font-semibold tracking-tight whitespace-nowrap"
          style={{ fontSize: "11px", lineHeight: "1" }}
        >
          DesignJS capture
        </div>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="text-muted-foreground hover:text-foreground w-5 h-5 inline-flex items-center justify-center rounded-sm hover:bg-accent transition-colors"
            style={{ fontSize: "14px", lineHeight: "1" }}
            aria-label="Close"
            title="Close (Esc)"
          >
            ×
          </button>
        )}
      </header>

      <div className="px-4 py-3 space-y-3">
        <div className="flex items-center gap-2 text-[var(--text-sm)]">
          <StatusDot status={status} />
          <span>{statusLabel}</span>
        </div>

        {disconnected && (
          <p className="text-[var(--text-xs)] text-muted-foreground leading-relaxed m-0">
            Run{" "}
            <code className="px-1 py-0.5 rounded-sm bg-muted text-foreground font-mono text-[10px]">
              pnpm dev
            </code>{" "}
            in the DesignJS repo, then reopen this overlay.
          </p>
        )}

        <div className="flex gap-2">
          <Button
            onClick={capturing ? stop : start}
            disabled={disconnected || inProgress}
            fullWidth
            variant={capturing ? "outline" : "default"}
          >
            {inProgress ? "Capturing…" : capturing ? "Stop capture" : "Start capture"}
          </Button>
          <Button
            onClick={capturePage}
            disabled={disconnected || capturing || inProgress}
            fullWidth
            variant="outline"
            title="Capture the entire page"
          >
            Capture page
          </Button>
        </div>

        {inProgress && (
          <div className="rounded-sm border border-border bg-muted/30 px-2.5 py-2 text-[var(--text-xs)] text-muted-foreground">
            {capture.kind === "serializing" && (
              <>
                Capturing
                {capture.estimatedNodes > 0
                  ? ` ~${capture.estimatedNodes.toLocaleString()} elements`
                  : " page"}
                …
              </>
            )}
            {capture.kind === "screenshotting" && (
              <>
                Taking page screenshot — {capture.nodeCount.toLocaleString()} elements,{" "}
                {(capture.byteCount / 1024).toFixed(1)} KB
              </>
            )}
            {capture.kind === "sending" && (
              <>
                Sending {capture.nodeCount.toLocaleString()} elements (
                {(capture.byteCount / 1024).toFixed(1)} KB) to canvas…
              </>
            )}
            {capture.kind === "rendering" && (
              <>
                {capture.sub === "creating-artboard"
                  ? "Creating artboard…"
                  : capture.sub === "adding-backplate"
                    ? "Compositing backplate…"
                    : capture.sub === "adding-components"
                      ? "Rendering on canvas…"
                      : "Fitting frame to content…"}
              </>
            )}
          </div>
        )}

        {capturing && (
          <p className="text-[var(--text-xs)] text-muted-foreground leading-relaxed m-0">
            Hover any element on the page.{" "}
            <kbd className="px-1 py-0.5 rounded-sm bg-background border border-border font-mono text-[10px]">
              ↑↓←→
            </kbd>{" "}
            to navigate the tree,{" "}
            <kbd className="px-1 py-0.5 rounded-sm bg-background border border-border font-mono text-[10px]">
              Enter
            </kbd>{" "}
            to capture,{" "}
            <kbd className="px-1 py-0.5 rounded-sm bg-background border border-border font-mono text-[10px]">
              Esc
            </kbd>{" "}
            to exit.
          </p>
        )}

        {capture.kind === "sent" && (
          <div
            className="rounded-sm border px-2.5 py-2 text-[var(--text-xs)]"
            style={{
              borderColor: "color-mix(in oklch, var(--color-oc-success) 30%, transparent)",
              background: "color-mix(in oklch, var(--color-oc-success) 5%, transparent)",
              color: "var(--color-oc-success)",
            }}
          >
            Sent to canvas — {capture.nodeCount} nodes,{" "}
            {(capture.byteCount / 1024).toFixed(1)} KB
          </div>
        )}

        {capture.kind === "error" && (
          <div className="rounded-sm border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-[var(--text-xs)] text-destructive">
            {capture.error === "too-large"
              ? "Selection too large. Try capturing a smaller section."
              : capture.error === "bridge-disconnected"
                ? "Lost connection to DesignJS. Check that pnpm dev is still running."
                : capture.error === "empty-input"
                  ? "Nothing captured. Try selecting a different element."
                  : capture.error === "cancelled"
                    ? "Capture cancelled."
                    : capture.detail
                      ? `Canvas rejected the capture: ${capture.detail}`
                      : "Something went wrong. Check the extension logs."}
          </div>
        )}
      </div>

      <footer className="px-4 py-2.5 bg-muted/50 text-[var(--text-xs)] text-muted-foreground text-center border-t border-border">
        Hover a web element and press{" "}
        <kbd className="px-1 py-0.5 rounded-sm bg-background border border-border font-mono text-[10px]">
          Enter
        </kbd>{" "}
        to capture.
      </footer>
    </div>
  );
}
