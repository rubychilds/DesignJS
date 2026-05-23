/* Quick diagnostic — read the captured iframe's measured layout. */
import { chromium } from "@playwright/test";
const browser = await chromium.launch({ channel: "chrome" });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto("http://localhost:3000/", { waitUntil: "networkidle", timeout: 30_000 });
await page.waitForTimeout(2000);

const data = await page.evaluate(() => {
  const out = [];
  const frames = [...document.querySelectorAll("iframe")];
  for (const [i, f] of frames.entries()) {
    const doc = f.contentDocument;
    if (!doc?.body) continue;
    const body = doc.body;
    const tally = { total: 0, fixed: 0, absolute: 0, none: 0, zeroHeight: 0, visibleHeight: 0 };
    const elems = doc.querySelectorAll("*");
    tally.total = elems.length;
    const hiddenSamples = [];
    const hiddenByTag = {};
    elems.forEach((el) => {
      const cs = doc.defaultView.getComputedStyle(el);
      if (cs.position === "fixed") tally.fixed++;
      else if (cs.position === "absolute") tally.absolute++;
      if (cs.display === "none") {
        tally.none++;
        hiddenByTag[el.tagName] = (hiddenByTag[el.tagName] ?? 0) + 1;
        if (hiddenSamples.length < 8) {
          hiddenSamples.push({
            tag: el.tagName,
            classes: (el.getAttribute("class") ?? "").slice(0, 200),
            uid: el.getAttribute("data-dj-uid"),
            parent: el.parentElement?.tagName,
            parentClasses: (el.parentElement?.getAttribute("class") ?? "").slice(0, 100),
          });
        }
      }
      const r = el.getBoundingClientRect();
      if (r.height === 0) tally.zeroHeight++;
    });
    tally.hiddenByTag = Object.entries(hiddenByTag)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);

    // How many <style> tags? Are they in head or body? Sample one to
    // see what's inside.
    const styles = doc.querySelectorAll("style");
    const stylesInBody = body.querySelectorAll("style");
    const sample = stylesInBody[0]
      ? {
          parent: stylesInBody[0].parentElement?.tagName,
          parentClasses: (stylesInBody[0].parentElement?.getAttribute("class") ?? "").slice(0, 80),
          firstAttr: Array.from(stylesInBody[0].attributes).map(a => `${a.name}="${a.value.slice(0,40)}"`).join(" "),
          textPreview: (stylesInBody[0].textContent ?? "").slice(0, 120),
        }
      : null;
    tally.totalStyles = styles.length;
    tally.stylesInBody = stylesInBody.length;
    tally.styleSample = sample;

    // What's the depth distribution of the 6k styles, and what is the
    // common parent chain? Walk up 5 ancestors for the FIRST 5 styles
    // to see the structural pattern.
    const styleChains = [];
    for (let s = 0; s < Math.min(5, stylesInBody.length); s++) {
      const styleEl = stylesInBody[s];
      const chain = [];
      let cursor = styleEl.parentElement;
      let depth = 0;
      while (cursor && depth < 6) {
        chain.push(`${cursor.tagName}${cursor.id ? "#" + cursor.id : ""}${cursor.className ? "." + String(cursor.className).slice(0, 30).replace(/\s+/g, ".") : ""}`);
        cursor = cursor.parentElement;
        depth++;
      }
      styleChains.push(chain);
    }
    tally.styleChains = styleChains;

    // body.children breakdown — what are the 4 direct children?
    tally.bodyDirectChildren = Array.from(body.children).map(c => {
      const r = c.getBoundingClientRect();
      return {
        tag: c.tagName,
        id: c.id,
        classes: (c.getAttribute("class") ?? "").slice(0, 100),
        attrs: Array.from(c.attributes).map(a => a.name).slice(0, 8),
        rect: { w: Math.round(r.width), h: Math.round(r.height) },
        scrollHeight: c.scrollHeight,
        childCount: c.children?.length,
      };
    });

    // The page-root div is the captured user content. How tall is its
    // actual rendered content? Walk its first few descendants to see.
    const pageRoot = body.querySelector("[data-designjs-page-root]");
    if (pageRoot) {
      const r = pageRoot.getBoundingClientRect();
      tally.pageRoot = {
        rect: { w: Math.round(r.width), h: Math.round(r.height) },
        scrollHeight: pageRoot.scrollHeight,
        offsetHeight: pageRoot.offsetHeight,
        childCount: pageRoot.children.length,
        totalDescendants: pageRoot.querySelectorAll("*").length,
        firstFewChildren: Array.from(pageRoot.children).slice(0, 6).map(c => {
          const cr = c.getBoundingClientRect();
          return {
            tag: c.tagName,
            classes: (c.getAttribute("class") ?? "").slice(0, 80),
            rect: { w: Math.round(cr.width), h: Math.round(cr.height) },
            scrollHeight: c.scrollHeight,
          };
        }),
      };
    }
    const wrapper = body.firstElementChild;
    out.push({
      index: i,
      bodyScrollHeight: body.scrollHeight,
      bodyOffsetHeight: body.offsetHeight,
      bodyClientHeight: body.clientHeight,
      bodyChildCount: body.children.length,
      firstChildTag: wrapper?.tagName,
      firstChildId: wrapper?.id,
      firstChildClass: wrapper?.className?.slice(0, 100),
      firstChildScrollHeight: wrapper?.scrollHeight,
      firstChildOffsetHeight: wrapper?.offsetHeight,
      firstChildRect: wrapper?.getBoundingClientRect && {
        w: Math.round(wrapper.getBoundingClientRect().width),
        h: Math.round(wrapper.getBoundingClientRect().height),
      },
      firstChildComputed: wrapper && {
        position: doc.defaultView.getComputedStyle(wrapper).position,
        display: doc.defaultView.getComputedStyle(wrapper).display,
        height: doc.defaultView.getComputedStyle(wrapper).height,
        overflow: doc.defaultView.getComputedStyle(wrapper).overflow,
      },
      tally,
      hiddenSamples,
      docElScrollHeight: doc.documentElement.scrollHeight,
      htmlScrollHeight: doc.querySelector("html")?.scrollHeight,
    });
  }
  return out;
});
console.log(JSON.stringify(data, null, 2));
await browser.close();
