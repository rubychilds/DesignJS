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
import { extractStyleBlocks } from "../capture/extract-styles.js";

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
 * 8MB cap. `mode: "inline"` (Experiment C) writes a full computed-style
 * block into every element's `style=""`, which costs ~1KB/node vs ~200B/node
 * under the old class-hoist path. Long-form content (Wikipedia articles,
 * docs sites) trips a 2MB cap at ~2k nodes; 8MB covers ~8k nodes worst case.
 */
const PAGE_CAPTURE_HARD_LIMIT = 8 * 1024 * 1024;

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

  // Tell the overlay we're about to serialize. querySelectorAll("*") is
  // cheap and gives a node estimate for the progress text. Two RAFs let
  // React paint the new state before the synchronous serialize() locks
  // the JS thread for the next several hundred ms on long pages.
  const estimatedNodes = root.querySelectorAll("*").length;
  window.postMessage(
    {
      type: "designjs:capture:progress",
      phase: "serializing",
      estimatedNodes,
    },
    "*",
  );
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

  const t0 = performance.now();
  // Exclude the extension's own overlay — it's mounted on
  // `document.documentElement` (see mountOverlay above), so under
  // Experiment A (capture from documentElement) it lands in the
  // captured tree. ROOT_ID is the overlay's container id.
  //
  // Experiment C: mode: "inline" writes computed styles directly to
  // style="" attrs instead of hoisting to ._djN classes. Tests
  // whether bypassing GrapesJS' <style>-block parse path + CSS-Manager
  // re-ID improves fidelity. If the per-element drift metric doesn't
  // improve, the bug isn't where the styles live — it's the resolved
  // pixel values we capture from getComputedStyle for auto-sized
  // properties (width/height drift at 50/50 in the current baseline).
  // Dedup tuning escape hatch for sweep runs. Set
  //   window.__designjsDedup = { enabled: false }   // disable entirely
  //   window.__designjsDedup = { threshold: 3, minSavings: 200, classCap: 200 }
  // in DevTools before triggering capture. No rebuild needed.
  //
  // Default ON again as of the add_css_rules bridge tool: dedup-hoisted
  // class rules now land via editor.Css.addRules on the canvas side
  // (bypassing GrapesJS' parseHtml which silently strips <style> blocks),
  // so the dedup-class fidelity bug that motivated turning this OFF in
  // commit 6cca88b is resolved.
  const dedupOverride =
    (window as unknown as { __designjsDedup?: Record<string, unknown> })
      .__designjsDedup ?? {};
  const dedupEnabled = (dedupOverride.enabled as boolean | undefined) ?? true;
  const result = serialize(root, {
    hardLimit: PAGE_CAPTURE_HARD_LIMIT,
    mode: "inline",
    excludeIds: [ROOT_ID],
    dedup: dedupEnabled,
    dedupThreshold: dedupOverride.threshold as number | undefined,
    dedupMinSavings: dedupOverride.minSavings as number | undefined,
    dedupClassCap: dedupOverride.classCap as number | undefined,
  });
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
  // Route the serializer-emitted <style data-designjs-*> blocks to the
  // canvas via add_css_rules instead of in-band HTML — see extractStyleBlocks
  // for the rationale (GrapesJS' parseHtml strips <style> on import).
  const {
    cssText: extractedCss,
    htmlWithoutStyles: htmlNoStyles,
    blockCount,
  } = extractStyleBlocks(result.html);
  console.log(
    `[designjs] extracted ${blockCount} <style> block(s) totalling ${(extractedCss.length / 1024).toFixed(1)}KB; will route via add_css_rules`,
  );

  // Style blocks have been stripped; the captured <html> wrapper now
  // leads. Swap html / body to <div> so GrapesJS accepts the structure.
  const swapped = htmlNoStyles
    .replace(/<html\b/, '<div data-dj-source-html=""')
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
      cssText: extractedCss,
      newArtboard: { name, width, height },
      nodeCount: result.nodeCount,
      byteCount: result.byteCount,
      screenshotDataUrl: screenshotDataUrl ?? undefined,
    },
    (bgResponse: { ok: boolean; error?: string } | undefined) => {
      if (bgResponse?.ok !== true) {
        // Inline the error text so the message is informative even when
        // DevTools collapses the object arg (Chrome's brief-view shows
        // `[object Object]` rather than expanding by default).
        const errText = bgResponse?.error ?? "no response from background";
        console.error(
          `[designjs] bridge rejected page capture: ${errText}`,
          bgResponse,
        );
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
  // Background relays canvas-side progress (create_artboard / add_components /
  // fit_artboard transitions) here. Forward to the window so the React overlay,
  // which already listens on window.postMessage, can update without growing a
  // second channel.
  if (msg?.type === "designjs:capture:progress") {
    window.postMessage(msg, "*");
  }
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
