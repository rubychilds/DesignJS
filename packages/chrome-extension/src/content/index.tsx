/**
 * Content-script entry — DesignJS overlay injection + capture flow.
 *
 * Matches Orbis' content-script-injected pattern (packages/chrome-ext-
 * orbis/src/content/popup-injector.tsx). Rationale in ADR-0011 §UX:
 * browser-action popups have a browser-drawn square background that
 * fights with rounded cards; injecting our own container gives us
 * complete visual control.
 *
 * Responsibilities:
 * - Listens for `toggle-overlay` from the background service worker
 *   (fired by chrome.action.onClicked) and mounts / unmounts the
 *   React overlay.
 * - Listens for `capture:start` / `capture:stop` and drives the DOM
 *   walker + style serializer. Serialized HTML is forwarded to the
 *   background, which relays over the bridge to the DesignJS canvas.
 * - Dismisses the overlay on Escape or outside-click.
 */

import { createRoot, type Root } from "react-dom/client";
import { App } from "../overlay/App.js";
import "../overlay/overlay.css";
import { createWalker } from "../capture/dom-walker.js";
import { captureFullPagePixels } from "../capture/screenshot-stitcher.js";
import { collectFontLinks, serialize } from "../capture/style-serializer.js";

const ROOT_ID = "designjs-capture-root";

interface OverlayInstance {
  el: HTMLElement;
  root: Root;
  cleanupListeners: () => void;
}

let overlay: OverlayInstance | null = null;

function mountOverlay(): OverlayInstance {
  const existing = document.getElementById(ROOT_ID);
  if (existing) existing.remove();

  const el = document.createElement("div");
  el.id = ROOT_ID;
  document.documentElement.appendChild(el);

  const root = createRoot(el);
  root.render(<App onDismiss={dismissOverlay} />);

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape" && ev.isTrusted) dismissOverlay();
  };
  document.addEventListener("keydown", onKey);

  return {
    el,
    root,
    cleanupListeners: () => document.removeEventListener("keydown", onKey),
  };
}

function dismissOverlay(): void {
  if (!overlay) return;
  overlay.cleanupListeners();
  overlay.root.unmount();
  overlay.el.remove();
  overlay = null;
  stopCapture();
}

function toggleOverlay(): void {
  if (overlay) {
    dismissOverlay();
  } else {
    overlay = mountOverlay();
  }
}

// ────────────────────────────────────────────────────────────────────
// Capture flow
// ────────────────────────────────────────────────────────────────────

let walker: ReturnType<typeof createWalker> | null = null;

function startCapture(): void {
  if (walker) return;
  walker = createWalker({
    onCommit: (el) => {
      const result = serialize(el, { mode: "computed" });
      if ("error" in result) {
        window.postMessage(
          {
            type: "designjs:capture:result",
            ok: false,
            error: result.error,
            nodeCount: result.nodeCount,
            byteCount: result.byteCount,
          },
          "*",
        );
        walker = null;
        return;
      }
      // Tell the overlay we're sending — state: "sending"
      window.postMessage(
        {
          type: "designjs:capture:progress",
          phase: "sending",
          nodeCount: result.nodeCount,
          byteCount: result.byteCount,
        },
        "*",
      );
      chrome.runtime.sendMessage(
        {
          type: "capture:send",
          html: result.html,
          nodeCount: result.nodeCount,
          byteCount: result.byteCount,
        },
        (bgResponse: { ok: boolean; error?: string } | undefined) => {
          window.postMessage(
            {
              type: "designjs:capture:result",
              ok: bgResponse?.ok === true,
              error: bgResponse?.ok === false ? bgResponse.error : undefined,
              nodeCount: result.nodeCount,
              byteCount: result.byteCount,
            },
            "*",
          );
        },
      );
      walker = null;
    },
    onExit: () => {
      walker = null;
      window.postMessage({ type: "designjs:capture:result", ok: false, error: "cancelled" }, "*");
    },
  });
  walker.start();
}

function stopCapture(): void {
  walker?.stop();
  walker = null;
}

/**
 * Whole-page capture — skips the hover walker and serializes the full
 * `<body>`. The overlay is mounted at `document.documentElement` so it
 * isn't nested inside body and won't pollute the capture.
 *
 * Raises the payload cap to 2MB — whole pages routinely exceed the 500KB
 * default that's tuned for element selection.
 */
const PAGE_CAPTURE_HARD_LIMIT = 2 * 1024 * 1024;

/**
 * Modern marketing sites (Next.js / Astro / React with `next/dynamic`
 * or `loading="lazy"` + IntersectionObserver) only mount below-fold
 * sections once they scroll into view. Without this pass, the
 * serializer reaches `document.body` at whatever the user scrolled to
 * and captures only the mounted portion — anything below the user's
 * viewport at click-time is missing from the DOM and therefore from
 * the capture.
 *
 * Scroll to the bottom in repeated ticks, waiting for `scrollHeight`
 * to stabilise (two consecutive ticks with no growth), then snap back
 * to the user's original scroll position so the page doesn't visibly
 * jump after capture completes. Capped at ~6s of scrolling to avoid
 * runaway on infinite-scroll feeds; users hitting that ceiling will
 * just get an honest "what was reachable in 6s" capture.
 *
 * Matches the pre-serialize discipline that SingleFile / html.to.design
 * implement (epic-8-followups §6 reading list). Closes the lazy-mount
 * half of the v0.3 whole-page capture gap.
 */
async function scrollToBottomAndSettle(): Promise<void> {
  const scroller = document.scrollingElement ?? document.documentElement;
  if (!scroller) return;
  const originalScroll = scroller.scrollTop;
  const MAX_TICKS = 30;
  const TICK_MS = 200;
  const STABLE_THRESHOLD = 2;
  let lastHeight = scroller.scrollHeight;
  let stableTicks = 0;
  for (let i = 0; i < MAX_TICKS; i++) {
    scroller.scrollTo(0, scroller.scrollHeight);
    await new Promise((r) => setTimeout(r, TICK_MS));
    const height = scroller.scrollHeight;
    if (height === lastHeight) {
      stableTicks++;
      if (stableTicks >= STABLE_THRESHOLD) break;
    } else {
      stableTicks = 0;
      lastHeight = height;
    }
  }
  // Restore so the user isn't visually surprised. The screenshot
  // stitcher manages its own scroll for tile capture, so this snap-back
  // doesn't affect the backplate.
  scroller.scrollTo(0, originalScroll);
  await new Promise((r) => setTimeout(r, 100));
}

async function capturePage(): Promise<void> {
  if (walker) {
    walker.stop();
    walker = null;
  }
  // Experiment A: capture `<html>` (`documentElement`) instead of
  // `<body>`. The serializer's INHERITED_DIFF logic was pinning the
  // captured body to `auto`-resolved pixel widths and inheriting from
  // a different parent context once it landed in the canvas iframe.
  // Capturing one level higher preserves the html-level layout context
  // (`:root` CSS variables, html-level computed colors, etc.) and gives
  // the captured tree a body inside an html-as-div wrapper — closer to
  // the source rendering context.
  //
  // HEAD subtree is dropped at the serializer level (style-serializer.ts
  // DROP_ELEMENTS) so its children don't render after the html→div swap.
  const root = document.documentElement;
  if (!root) {
    window.postMessage(
      { type: "designjs:capture:result", ok: false, error: "empty-input" },
      "*",
    );
    return;
  }
  // Force lazy-mounted sections to materialise before we serialise.
  // See scrollToBottomAndSettle docstring.
  await scrollToBottomAndSettle();
  const t0 = performance.now();
  const result = serialize(root, { hardLimit: PAGE_CAPTURE_HARD_LIMIT, mode: "computed" });
  const t1 = performance.now();
  if ("error" in result) {
    console.warn("[designjs] page serialize failed:", result);
    window.postMessage(
      {
        type: "designjs:capture:result",
        ok: false,
        error: result.error,
        nodeCount: result.nodeCount,
        byteCount: result.byteCount,
      },
      "*",
    );
    return;
  }
  console.log(
    `[designjs] page captured: ${result.nodeCount} nodes, ${(result.byteCount / 1024).toFixed(0)}KB, serialized in ${Math.round(t1 - t0)}ms`,
  );
  // GrapesJS' HTML parser filters <html>/<body> when they appear inside
  // another body's wrapper component — the content lands in a detached
  // tree. Swap the outer <html> AND the inner <body> for <div> so the
  // inlined styles still apply but the nesting is legal. Markers retain
  // the original tag identity for inspector / future tooling.
  const swapped = result.html
    .replace(/^<html\b/, '<div data-dj-source-html=""')
    .replace(/<\/html>$/, "</div>")
    .replace(/<body\b/g, '<div data-dj-source-body=""')
    .replace(/<\/body>/g, "</div>");

  // Inject allowlisted font-CDN <link> tags right after the outer <div>'s
  // opening tag so the canvas iframe loads them before the captured text
  // renders — closes the system-fallback-font gap (epic-8-followups §3.1).
  const fontLinks = collectFontLinks(document.head);
  const openTagEnd = swapped.indexOf(">");
  const html =
    openTagEnd >= 0 && fontLinks
      ? swapped.slice(0, openTagEnd + 1) + fontLinks + swapped.slice(openTagEnd + 1)
      : swapped;

  // Whole-page capture always lands in its own fresh artboard — a page is
  // conceptually its own canvas, not content to append to whatever frame
  // happens to exist (which may be nothing, if the user deleted them all).
  const width = Math.min(document.documentElement.scrollWidth || window.innerWidth, 3840);
  const height = Math.min(
    document.documentElement.scrollHeight || window.innerHeight,
    20000,
  );
  const name = document.title || new URL(window.location.href).hostname;

  // ADR-0012 §1 hybrid backplate — best-effort full-page screenshot
  // composited under the HTML tree at low opacity. Runs after structural
  // serialization so a stitcher failure (rate-limit, hidden tab,
  // permission revoke) doesn't lose the structural capture.
  window.postMessage(
    {
      type: "designjs:capture:progress",
      phase: "screenshotting",
      nodeCount: result.nodeCount,
      byteCount: result.byteCount,
    },
    "*",
  );
  let screenshotDataUrl: string | null = null;
  try {
    screenshotDataUrl = await captureFullPagePixels();
  } catch (err) {
    console.warn("[designjs] backplate stitcher failed, continuing without:", err);
  }

  window.postMessage(
    {
      type: "designjs:capture:progress",
      phase: "sending",
      nodeCount: result.nodeCount,
      byteCount: result.byteCount,
    },
    "*",
  );
  chrome.runtime.sendMessage(
    {
      type: "capture:send",
      html,
      newArtboard: { name, width, height },
      nodeCount: result.nodeCount,
      byteCount: result.byteCount,
      screenshotDataUrl: screenshotDataUrl ?? undefined,
    },
    (bgResponse: { ok: boolean; error?: string } | undefined) => {
      if (bgResponse?.ok !== true) {
        console.error("[designjs] bridge rejected page capture:", bgResponse);
      }
      window.postMessage(
        {
          type: "designjs:capture:result",
          ok: bgResponse?.ok === true,
          error: bgResponse?.ok === false ? bgResponse.error : undefined,
          nodeCount: result.nodeCount,
          byteCount: result.byteCount,
        },
        "*",
      );
    },
  );
}

// ────────────────────────────────────────────────────────────────────
// Wiring
// ────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "toggle-overlay") toggleOverlay();
  if (msg?.type === "capture:start") startCapture();
  if (msg?.type === "capture:stop") stopCapture();
  if (msg?.type === "capture:page")
    capturePage().catch((err: Error) =>
      console.warn("[designjs] capturePage failed:", err),
    );
});

// The overlay's Start/Stop button posts via window.postMessage (simpler
// than extensions' own messaging because it stays in-script); we listen
// here and route through chrome.runtime so the background gets the echo.
window.addEventListener("message", (ev) => {
  if (ev.source !== window) return;
  if (ev.data?.type === "designjs:capture:start") startCapture();
  if (ev.data?.type === "designjs:capture:stop") stopCapture();
  if (ev.data?.type === "designjs:capture:page")
    capturePage().catch((err: Error) =>
      console.warn("[designjs] capturePage failed:", err),
    );
});
