/* Take a full-height screenshot of the captured iframe (no scoring-
   window clip). Splits across multiple PNGs if past Chrome's image
   limit (~16k px). */
import { chromium } from "@playwright/test";
import { writeFile, mkdir } from "node:fs/promises";

const OUT = "/tmp/capture-compare";
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1, // avoid hitting 16k px height limit at DPR 2
});
const page = await ctx.newPage();
await page.goto("http://localhost:3000/", { waitUntil: "networkidle", timeout: 30_000 });
await page.waitForTimeout(2000);

const frames = await page.locator("iframe").all();
let best = { index: -1, nodes: -1 };
for (let i = 0; i < frames.length; i++) {
  const n = await page.evaluate(
    (idx) => document.querySelectorAll("iframe")[idx]?.contentDocument?.querySelectorAll("*").length ?? 0,
    i,
  );
  if (n > best.nodes) best = { index: i, nodes: n };
}
console.log(`[dump] iframe[${best.index}] has ${best.nodes} nodes`);

// At DPR 1 the captured page (~11k CSS px) fits under Chrome's
// 16384-px screenshot limit, so we can grab the whole iframe in one
// shot via element.screenshot(). Use the elementHandle (not Locator)
// so we have direct access to .screenshot().
const iframeEl = page.locator("iframe").nth(best.index);
const meta = await iframeEl.evaluate((el) => ({
  w: el.contentDocument?.body?.scrollWidth ?? 0,
  h: el.contentDocument?.body?.scrollHeight ?? 0,
}));
console.log(`[dump] iframe natural CSS size: ${meta.w}×${meta.h}px`);

const buf = await iframeEl.screenshot();
await writeFile(`${OUT}/canvas-iframe-full.png`, buf);
console.log(`[dump] saved ${buf.length} bytes -> canvas-iframe-full.png`);
await browser.close();
