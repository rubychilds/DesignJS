/* Does scrolling rubychilds.com actually trigger more sections to mount?
   Measures scrollHeight at three points: initial, after scroll-to-bottom,
   after settle. If scroll doesn't grow scrollHeight, the page isn't
   IntersectionObserver-lazy and our scroll-to-bottom workaround can't help. */

import { chromium } from "@playwright/test";

const URL = process.argv[2] ?? "https://www.rubychilds.com/";
const browser = await chromium.launch({ channel: "chrome" });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
});
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: "load", timeout: 30_000 });
await page.waitForTimeout(2000);

const measure = async (label) =>
  page.evaluate((label) => ({
    label,
    scrollHeight: document.documentElement.scrollHeight,
    scrollY: window.scrollY,
    bodyChildren: document.body.children.length,
    totalElements: document.querySelectorAll("*").length,
  }), label);

console.log("[step 1] initial:", await measure("initial"));

// Mimic the same scroll-to-bottom logic the extension just shipped.
const settleResult = await page.evaluate(async () => {
  const scroller = document.scrollingElement ?? document.documentElement;
  const heights = [{ tick: 0, h: scroller.scrollHeight }];
  const MAX_TICKS = 30;
  const TICK_MS = 200;
  let lastHeight = scroller.scrollHeight;
  let stableTicks = 0;
  for (let i = 0; i < MAX_TICKS; i++) {
    scroller.scrollTo(0, scroller.scrollHeight);
    await new Promise((r) => setTimeout(r, TICK_MS));
    const h = scroller.scrollHeight;
    heights.push({ tick: i + 1, h });
    if (h === lastHeight) {
      stableTicks++;
      if (stableTicks >= 2) break;
    } else {
      stableTicks = 0;
      lastHeight = h;
    }
  }
  return { heights, finalScrollHeight: scroller.scrollHeight };
});
console.log("[step 2] scroll progression:");
for (const { tick, h } of settleResult.heights) {
  console.log(`         tick ${tick.toString().padStart(2)}: scrollHeight=${h}`);
}

console.log("[step 3] after settle:", await measure("after settle"));

await browser.close();
