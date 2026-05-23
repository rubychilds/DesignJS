/**
 * Background service worker — DesignJS capture extension.
 *
 * Responsibilities per ADR-0011:
 * - Owns the WebSocket connection to the DesignJS canvas bridge
 *   (ws://127.0.0.1:29170/designjs-bridge), identifying as a
 *   `browser-extension` peer.
 * - Relays capture payloads from the content script → canvas.
 * - On extension-icon click, asks the active tab's content script to
 *   toggle the injected overlay. No browser-action popup is used —
 *   see ADR-0011 §UX for the rationale.
 *
 * Kept deliberately thin — the heavy lifting (DOM walk, style
 * serializer, overlay rendering) lives in the content script.
 */

import { connectToBridge, type BridgeStatus } from "../transport/ws-client.js";

const bridge = connectToBridge({
  onStatus: (status: BridgeStatus) => {
    // Broadcast to any content scripts / overlays that are listening.
    // No tab id — the runtime delivers to all extension views.
    chrome.runtime.sendMessage({ type: "bridge-status", status }).catch(() => {
      // No listeners — ignore.
    });
  },
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  chrome.tabs
    .sendMessage(tab.id, { type: "toggle-overlay" })
    .catch(() => {
      // Content script not injected on this tab (e.g. chrome:// pages,
      // the Chrome Web Store, new-tab pages). Nothing we can do — the
      // content-script matcher excludes these by default.
    });
});

/**
 * Land a capture on the canvas. When `newArtboard` is set (whole-page
 * capture), first create the artboard, append the HTML, then fit the
 * artboard height to the actually-rendered content. Source-page
 * scrollHeight is unreliable when images lazy-load without aspect-
 * ratio placeholders (collapses to text-only height), and CSS layout
 * inside the GrapesJS iframe won't match the source site anyway — so
 * we let the canvas measure itself.
 *
 * Element capture keeps its simpler single-call path: it appends into
 * the first existing frame, and sizing is the user's concern.
 */
/**
 * Hybrid backplate styling — ADR-0012 §1. Wrapper sits at z-index:-1
 * below the in-flow HTML tree (negative z-index keeps it behind without
 * requiring the HTML tree to declare a stacking context). Inline styles
 * are stripped by GrapesJS' parseHtml on most components, so we hoist
 * the rules into a `<style>` block and target via class — same load-
 * bearing pattern as the structural serializer (commit 959331d).
 */
const BACKPLATE_STYLE_BLOCK =
  '<style data-designjs-backplate-css="">' +
  ".designjs-backplate-wrapper{position:absolute;inset:0;z-index:-1;pointer-events:none;}" +
  ".designjs-backplate-img{display:block;width:100%;height:100%;opacity:0.15;}" +
  "</style>";

function buildBackplateHtml(dataUrl: string): string {
  return (
    BACKPLATE_STYLE_BLOCK +
    `<div class="designjs-backplate-wrapper" data-designjs-backplate-wrapper="">` +
    `<img class="designjs-backplate-img" data-designjs-backplate="" src="${dataUrl}">` +
    `</div>`
  );
}

type RenderingSub =
  | "creating-artboard"
  | "adding-backplate"
  | "adding-components"
  | "fitting";

function postRenderingPhase(
  tabId: number | undefined,
  sub: RenderingSub,
  nodeCount?: number,
  byteCount?: number,
): void {
  if (tabId == null) return;
  // Fire-and-forget; if the tab closed mid-capture, ignore the rejection.
  chrome.tabs
    .sendMessage(tabId, {
      type: "designjs:capture:progress",
      phase: "rendering",
      sub,
      nodeCount,
      byteCount,
    })
    .catch(() => {});
}

async function relayCapture(
  msg: {
    html: string;
    newArtboard?: { name?: string; width: number; height: number };
    /** Optional full-page screenshot data URL — ADR-0012 §1 hybrid backplate. */
    screenshotDataUrl?: string;
    nodeCount?: number;
    byteCount?: number;
  },
  tabId: number | undefined,
): Promise<unknown> {
  if (msg.newArtboard) {
    postRenderingPhase(tabId, "creating-artboard", msg.nodeCount, msg.byteCount);
    const { artboard } = (await bridge.send({
      tool: "create_artboard",
      params: msg.newArtboard,
    })) as { artboard: { id: string } };

    // Backplate goes in first so it sits *behind* the HTML tree in
    // document order. The actual stacking is handled by z-index:-1 on
    // the wrapper; document order matters because the artboard's
    // wrapper isn't itself a stacking context.
    if (msg.screenshotDataUrl) {
      postRenderingPhase(tabId, "adding-backplate", msg.nodeCount, msg.byteCount);
      try {
        await bridge.send({
          tool: "add_components",
          params: {
            html: buildBackplateHtml(msg.screenshotDataUrl),
            artboardId: artboard.id,
          },
        });
      } catch (err) {
        // Backplate is best-effort — if it fails the structural capture
        // still lands. No silent corruption either way.
        console.warn("[designjs] backplate insertion failed:", err);
      }
    }

    postRenderingPhase(tabId, "adding-components", msg.nodeCount, msg.byteCount);
    const addResult = await bridge.send({
      tool: "add_components",
      params: { html: msg.html, artboardId: artboard.id },
      // 90s — GrapesJS parse + paint on Wikipedia-class articles (~2-4MB
      // payload, ~2k nodes) regularly runs 20-60s. Default 15s falsely
      // fails captures that the canvas would still complete.
      timeoutMs: 90_000,
    });
    // fit_artboard measures the iframe content and resizes the frame
    // accordingly. Best-effort — if it fails (iframe slow to mount,
    // content not measurable) we still return the add_components result
    // so the capture isn't lost.
    postRenderingPhase(tabId, "fitting", msg.nodeCount, msg.byteCount);
    try {
      await bridge.send({
        tool: "fit_artboard",
        params: { artboardId: artboard.id },
      });
    } catch (err) {
      console.warn("[designjs] fit_artboard failed after page capture:", err);
    }
    return addResult;
  }
  postRenderingPhase(tabId, "adding-components", msg.nodeCount, msg.byteCount);
  return bridge.send({ tool: "add_components", params: { html: msg.html } });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "capture:send") {
    relayCapture(msg, sender.tab?.id)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
    return true; // async response
  }
  if (msg?.type === "capture:visible-tab") {
    // chrome.tabs.captureVisibleTab can only run from the background
    // context. Capture the originating tab's window so multi-window
    // setups don't capture the wrong viewport.
    const windowId = sender.tab?.windowId;
    chrome.tabs.captureVisibleTab(
      windowId ?? chrome.windows.WINDOW_ID_CURRENT,
      { format: "png" },
      (dataUrl?: string) => {
        if (chrome.runtime.lastError) {
          sendResponse({
            ok: false,
            error: chrome.runtime.lastError.message ?? "captureVisibleTab failed",
          });
          return;
        }
        sendResponse({ ok: true, dataUrl });
      },
    );
    return true; // async response
  }
  if (msg?.type === "bridge-status:request") {
    sendResponse({ status: bridge.currentStatus() });
    return false;
  }
  return false;
});
