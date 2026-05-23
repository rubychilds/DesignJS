/*
 * Capture-fidelity scorecard for the Chrome-extension capture path.
 *
 * Two parts:
 *  1. Structural audit — renders the reference URL live and the canvas
 *     at http://localhost:3000, dumps node counts / iframe types /
 *     shadow roots / pseudo-element-bearing tags etc., side by side
 *     in `audit.json`.
 *  2. Visual diff (E) — element-screenshots the canvas iframe with
 *     the most captured content, re-sizes the reference page to match,
 *     runs pixelmatch, emits diff.png + a single "X% pixels different"
 *     number you can track across fidelity-work iterations.
 *
 * Prerequisites for the visual-diff half to produce a meaningful number:
 *  - The canvas dev server is running (`pnpm dev` at repo root → :3000).
 *  - A capture of the reference URL has already been pushed onto the
 *    canvas via the extension (the script reads whatever's currently
 *    on the artboard; if nothing matches the diff is ≈100% by definition).
 *  - The real Chrome channel is installed locally (needed to get past
 *    Cloudflare-style bot walls — Chromium's headless fingerprint fails
 *    that check on many sites).
 *
 * Usage:
 *  node scripts/capture-compare.mjs                          # default: rubychilds.com
 *  node scripts/capture-compare.mjs https://example.com/     # custom reference URL
 *  HEADED=1 node scripts/capture-compare.mjs <url>           # visible browser (solve
 *                                                              Cloudflare manually if
 *                                                              cookies have expired)
 *
 * The default reference is rubychilds.com — a static personal site
 * whose content doesn't rotate, so successive scorecard runs measure
 * fidelity change rather than article-rotation noise. Pass any URL as
 * the first positional arg to compare against a different site.
 *
 * Outputs land in /tmp/capture-compare/:
 *  - ref-live-{viewport,fullpage}.png   — reference URL as initially loaded
 *  - canvas-{viewport,fullpage}.png     — the canvas page (chrome + iframe)
 *  - canvas-iframe.png                  — element-screenshot of the captured iframe
 *  - ref-matched.png                    — reference re-rendered at the iframe's width
 *  - diff.png                           — pixelmatch output (red = changed)
 *  - audit.json                         — structural metrics + diff stats
 */

import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

const OUT = "/tmp/capture-compare";
const CANVAS_URL = "http://localhost:3000/";
const REFERENCE_URL = process.argv[2] ?? "https://rubychilds.com/";

async function isCanvasReachable() {
  try {
    const res = await fetch(CANVAS_URL, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function structuralAudit(page) {
  return page.evaluate(() => {
    const all = document.querySelectorAll("*");
    let shadowRoots = 0;
    let webComponents = 0;
    const tagCounts = {};
    all.forEach((el) => {
      if (el.shadowRoot) shadowRoots++;
      if (el.tagName.includes("-")) webComponents++;
      tagCounts[el.tagName] = (tagCounts[el.tagName] || 0) + 1;
    });
    const iframes = [...document.querySelectorAll("iframe")];
    let crossOriginIframes = 0;
    let sameOriginIframes = 0;
    iframes.forEach((f) => {
      try {
        const _ = f.contentDocument;
        if (_) sameOriginIframes++;
        else crossOriginIframes++;
      } catch {
        crossOriginIframes++;
      }
    });
    const images = [...document.querySelectorAll("img")];
    const externalImages = images.filter((i) => {
      try {
        return new URL(i.currentSrc || i.src).host !== location.host;
      } catch {
        return false;
      }
    }).length;
    const inlineSvgs = document.querySelectorAll("svg").length;
    const cssVarRoot = (() => {
      const cs = getComputedStyle(document.documentElement);
      const arr = [];
      for (let i = 0; i < cs.length; i++) {
        const p = cs.item(i);
        if (p.startsWith("--")) arr.push(p);
      }
      return arr.length;
    })();
    return {
      url: location.href,
      totalNodes: all.length,
      shadowRoots,
      webComponents,
      iframes: iframes.length,
      crossOriginIframes,
      sameOriginIframes,
      images: images.length,
      externalImages,
      inlineSvgs,
      cssVarsOnRoot: cssVarRoot,
      topTags: Object.entries(tagCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12),
      bodyDimensions: {
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
      },
    };
  });
}

async function probeCanvasIframe(page) {
  // GrapesJS renders the captured page inside its own iframe — peek inside.
  return page.evaluate(() => {
    const frames = [...document.querySelectorAll("iframe")];
    const out = [];
    for (const [i, frame] of frames.entries()) {
      try {
        const doc = frame.contentDocument;
        if (!doc) {
          out.push({ index: i, src: frame.src, status: "no-document" });
          continue;
        }
        const all = doc.querySelectorAll("*");
        out.push({
          index: i,
          src: frame.src,
          status: "same-origin",
          totalNodes: all.length,
          bodyChildCount: doc.body?.children.length ?? 0,
          firstNodeOuterHtmlPreview: doc.body?.firstElementChild?.outerHTML?.slice(0, 240),
        });
      } catch (e) {
        out.push({ index: i, src: frame.src, status: "cross-origin", error: String(e) });
      }
    }
    return out;
  });
}

async function run() {
  await mkdir(OUT, { recursive: true });

  if (!(await isCanvasReachable())) {
    console.error(
      `\nCanvas not reachable at ${CANVAS_URL}.\n` +
        `Start it with \`pnpm dev\` at the repo root, then ensure a\n` +
        `capture of ${REFERENCE_URL} is loaded on the artboard before\n` +
        `re-running.\n`,
    );
    process.exit(1);
  }
  // Use the real Chrome channel + realistic headers — headless Chromium's
  // fingerprint trips Cloudflare-style bot walls on news sites. If
  // `HEADED=1` is set, also launch visibly so you can solve the human-
  // check once; the persistent profile remembers the cf_clearance cookie
  // afterwards.
  const browser = await chromium.launch({
    channel: "chrome",
    headless: process.env.HEADED !== "1",
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
  });

  // ─── Reference (live) ───────────────────────────────────────────────
  console.log(`[ref] navigating to ${REFERENCE_URL}…`);
  const refPage = await context.newPage();
  await refPage.goto(REFERENCE_URL, {
    waitUntil: "load",
    timeout: 45_000,
  });
  // News sites' networkidle never resolves (ads/analytics keep firing).
  // Static sites usually settle in <1s. Universal 4s wait is safe for
  // both.
  await refPage.waitForTimeout(4000);
  await refPage.screenshot({ path: `${OUT}/ref-live-viewport.png`, fullPage: false });
  await refPage.screenshot({ path: `${OUT}/ref-live-fullpage.png`, fullPage: true });
  const refStats = await structuralAudit(refPage);
  console.log("[ref] stats:", JSON.stringify(refStats, null, 2));

  // ─── Canvas (localhost:3000) ────────────────────────────────────────
  console.log("[canvas] navigating…");
  const canvas = await context.newPage();
  await canvas.goto(CANVAS_URL, {
    waitUntil: "networkidle",
    timeout: 30_000,
  });
  await canvas.waitForTimeout(2000);
  await canvas.screenshot({ path: `${OUT}/canvas-viewport.png`, fullPage: false });
  await canvas.screenshot({ path: `${OUT}/canvas-fullpage.png`, fullPage: true });
  const canvasStats = await structuralAudit(canvas);
  console.log("[canvas] top stats:", JSON.stringify(canvasStats, null, 2));
  const iframeStats = await probeCanvasIframe(canvas);
  console.log("[canvas] iframe contents:", JSON.stringify(iframeStats, null, 2));

  // ─── Visual diff (E) ────────────────────────────────────────────────
  // Pick the canvas iframe with the most content — empty iframe[1] is
  // a placeholder artboard; iframe[0] (or whichever has the highest
  // body-node count) holds the actual captured page. Element-screenshot
  // it, set the reference page to a matching viewport width, capture again, and run
  // pixelmatch to get a single "X% different" number that can be
  // tracked across fidelity iterations.
  //
  // Caveats baked in:
  //  - GrapesJS renders inside a different iframe context than the source page
  //    (no scroll-triggered animations, no hydrated React state). Some
  //    diff is unavoidable even with perfect capture.
  //  - The diff is cropped to the smaller of the two screenshot
  //    dimensions — padding bias is on the side of fewer diff pixels.
  //  - Single-shot diff. For statistical scorecards run repeatedly and
  //    average; one number can wobble with ad rotation.
  const ranked = iframeStats
    .filter((s) => s.status === "same-origin" && (s.totalNodes ?? 0) > 10)
    .sort((a, b) => (b.totalNodes ?? 0) - (a.totalNodes ?? 0));
  let visualDiff = null;
  if (ranked.length === 0) {
    console.log("[diff] no captured content found in any canvas iframe — skipping");
  } else {
    const targetIndex = ranked[0].index;
    console.log(
      `[diff] using canvas iframe[${targetIndex}] (${ranked[0].totalNodes} nodes)`,
    );
    const iframeEl = canvas.locator("iframe").nth(targetIndex);
    const iframeBox = await iframeEl.boundingBox();
    if (!iframeBox || iframeBox.width < 100 || iframeBox.height < 100) {
      console.log(`[diff] iframe bbox too small (${iframeBox?.width}×${iframeBox?.height}) — skipping`);
    } else {
      // Cap scorecard window — Chrome's Page.captureScreenshot maxes out
      // around 16384px (DPR-scaled), so a 21,000px+ captured artboard
      // blows up. 4000px CSS height is well above the fold and well
      // below the limit even at DPR 2. The scorecard is about visible
      // fidelity above the fold; full-page comparison is a different
      // problem (would need scroll-tile-stitch on both sides).
      const SCORECARD_MAX_HEIGHT = 4000;
      const clipHeight = Math.min(iframeBox.height, SCORECARD_MAX_HEIGHT);
      const clipWidth = iframeBox.width;
      console.log(
        `[diff] iframe natural size ${iframeBox.width}×${iframeBox.height}px; scoring window ${clipWidth}×${clipHeight}px`,
      );

      const iframeBuf = await canvas.screenshot({
        clip: {
          x: iframeBox.x,
          y: iframeBox.y,
          width: clipWidth,
          height: clipHeight,
        },
      });
      const iframePng = PNG.sync.read(iframeBuf);

      // Re-size the reference page to match the scoring window width so any author-mode
      // @media reflow lands at the right viewport. (Today this still
      // doesn't help — see ADR-0011 2026-05-04 addendum cascade note —
      // but the comparison is honest if we ever ship §4.)
      const targetWidth = Math.round(clipWidth);
      const targetHeight = Math.round(clipHeight);
      await refPage.setViewportSize({ width: targetWidth, height: targetHeight });
      // cf_clearance cookie from earlier in this run persists in the
      // context, so reloading shouldn't re-trigger the challenge.
      await refPage.reload({ waitUntil: "load", timeout: 45_000 });
      await refPage.waitForTimeout(3000);
      const refBuf = await refPage.screenshot({ fullPage: false });
      const refPng = PNG.sync.read(refBuf);
      console.log(
        `[diff] canvas window: ${iframePng.width}×${iframePng.height}px; ref re-rendered: ${refPng.width}×${refPng.height}px`,
      );

      // Crop both to the common (min) rectangle. Diffing different-sized
      // PNGs would require resize machinery (sharp / canvas) we don't
      // want to pull in for this scorecard; a min-rect crop is biased
      // toward fewer diff pixels but is honest about what overlaps.
      const w = Math.min(iframePng.width, refPng.width);
      const h = Math.min(iframePng.height, refPng.height);
      const a = cropPng(iframePng, w, h);
      const b = cropPng(refPng, w, h);
      const diff = new PNG({ width: w, height: h });
      const numDiff = pixelmatch(a.data, b.data, diff.data, w, h, {
        threshold: 0.1,
        includeAA: false,
      });
      const total = w * h;
      const pct = (numDiff / total) * 100;
      await writeFile(`${OUT}/diff.png`, PNG.sync.write(diff));
      await writeFile(`${OUT}/canvas-iframe.png`, iframeBuf);
      await writeFile(`${OUT}/ref-matched.png`, refBuf);

      visualDiff = {
        widthPx: w,
        heightPx: h,
        diffPixels: numDiff,
        totalPixels: total,
        percentDifferent: Number(pct.toFixed(2)),
      };
      console.log(
        `\n[diff] ${pct.toFixed(2)}% pixels different (${numDiff.toLocaleString()} of ${total.toLocaleString()}) — diff.png saved`,
      );
    }
  }

  await writeFile(
    `${OUT}/audit.json`,
    JSON.stringify(
      {
        reference: { url: REFERENCE_URL, ...refStats },
        canvas: canvasStats,
        canvasIframes: iframeStats,
        visualDiff,
      },
      null,
      2,
    ),
  );

  await browser.close();
  console.log(`\n[done] outputs in ${OUT}/`);
}

function cropPng(png, w, h) {
  if (png.width === w && png.height === h) return png;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const srcIdx = (png.width * y + x) << 2;
      const dstIdx = (w * y + x) << 2;
      out.data[dstIdx] = png.data[srcIdx];
      out.data[dstIdx + 1] = png.data[srcIdx + 1];
      out.data[dstIdx + 2] = png.data[srcIdx + 2];
      out.data[dstIdx + 3] = png.data[srcIdx + 3];
    }
  }
  return out;
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
