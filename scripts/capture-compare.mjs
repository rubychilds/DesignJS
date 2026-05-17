/*
 * Capture-fidelity audit: render https://www.axios.com live in Playwright
 * and grab the canvas at http://localhost:3000, then dump structural
 * metrics that map to the v0.3 content-script ceiling described in
 * ADR-0011 §Open-questions and ADR-0012 §2 (the unshipped CDP pivot).
 *
 * Outputs go to /tmp/capture-compare/.
 */

import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const OUT = "/tmp/capture-compare";

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
  // Use the real Chrome channel + realistic headers — headless Chromium's
  // fingerprint trips Cloudflare's bot wall on www.axios.com. If `HEADED=1`
  // is set, also launch visibly so you can solve the human-check once;
  // the persistent profile remembers the cf_clearance cookie afterwards.
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

  // ─── Axios (live) ───────────────────────────────────────────────────
  console.log("[axios] navigating…");
  const axios = await context.newPage();
  await axios.goto("https://www.axios.com/", {
    waitUntil: "load",
    timeout: 45_000,
  });
  // News-site networkidle never resolves (ads/analytics keep firing) —
  // give the hero section time to paint instead.
  await axios.waitForTimeout(4000);
  await axios.screenshot({ path: `${OUT}/axios-live-viewport.png`, fullPage: false });
  await axios.screenshot({ path: `${OUT}/axios-live-fullpage.png`, fullPage: true });
  const axiosStats = await structuralAudit(axios);
  console.log("[axios] stats:", JSON.stringify(axiosStats, null, 2));

  // ─── Canvas (localhost:3000) ────────────────────────────────────────
  console.log("[canvas] navigating…");
  const canvas = await context.newPage();
  await canvas.goto("http://localhost:3000/", {
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

  await writeFile(
    `${OUT}/audit.json`,
    JSON.stringify({ axios: axiosStats, canvas: canvasStats, canvasIframes: iframeStats }, null, 2),
  );

  await browser.close();
  console.log(`\n[done] outputs in ${OUT}/`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
