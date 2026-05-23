/*
 * Capture-fidelity STRUCTURAL diff: source page vs captured-in-canvas
 * iframe, paired per-element via walk-order UID.
 *
 * Distinct from scripts/capture-compare.mjs:
 *  - capture-compare reports pixel diff (single number)
 *  - capture-diff reports per-element structural drift (which element
 *    lost which attribute, which property's computed value diverged,
 *    which elements are missing entirely) — *why* the pixel diff exists
 *
 * Pairing: the serializer (packages/chrome-extension/src/capture/
 * style-serializer.ts:282) already stamps `data-dj-uid` on every
 * captured element in deterministic depth-first preorder over
 * `src.children`, skipping STYLE/SCRIPT/NOSCRIPT/LINK. We mirror the
 * same walk in memory on the source page and stamp `data-source-uid`
 * so source UID N corresponds to captured UID N.
 *
 * Caveats:
 *  - Same-origin iframes get their own UID space inside the serializer
 *    (recursive serialize call); we don't descend into them on the
 *    source side. Cross-iframe drift is not measured.
 *  - Pseudo-elements (::before/::after) don't have DOM nodes; not
 *    paired. The pixel diff in capture-compare catches their absence.
 *
 * Prerequisites:
 *  - Canvas dev server reachable at http://localhost:3000/.
 *  - The reference URL has been captured into the canvas (any artboard
 *    will be auto-detected — picks the iframe with the most nodes).
 *  - `pnpm dev` running at repo root.
 *
 * Usage:
 *  node scripts/capture-diff.mjs                                      # default reference
 *  node scripts/capture-diff.mjs https://example.com/                 # custom URL
 *
 * Outputs in /tmp/capture-compare/:
 *  - audit-diff.json   — machine-readable structural delta
 *  - diff-report.html  — single-file human report (side-by-side, table)
 */

import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const OUT = "/tmp/capture-compare";
const CANVAS_URL = "http://localhost:3000/";
const REFERENCE_URL =
  process.argv[2] ?? "https://docs.python.org/3/tutorial/introduction.html";

// 30-property fingerprint for computed-style alignment.
// Covers layout, dimensions, spacing, color, type, flex/grid, overflow.
const FINGERPRINT_PROPS = [
  "display", "position", "visibility", "overflow",
  "width", "height", "min-width", "min-height", "max-width", "max-height",
  "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "color", "background-color", "opacity",
  "font-family", "font-size", "font-weight", "line-height",
  "text-align", "white-space",
  "flex-direction", "justify-content", "align-items",
];

const SAMPLE_SIZE = 50;
const DROP_TAGS = new Set(["STYLE", "SCRIPT", "NOSCRIPT", "LINK"]);

async function isCanvasReachable() {
  try {
    const res = await fetch(CANVAS_URL, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Walk source page's document.body depth-first preorder over children,
 * skipping DROP_TAGS, stamping `data-source-uid` to match serializer
 * order. Returns per-element data we'll pair against the captured side.
 */
function collectSource() {
  /* eslint-env browser */
  const DROP_TAGS_SET = new Set(["STYLE", "SCRIPT", "NOSCRIPT", "LINK"]);
  const FINGERPRINT = [
    "display", "position", "visibility", "overflow",
    "width", "height", "min-width", "min-height", "max-width", "max-height",
    "margin-top", "margin-right", "margin-bottom", "margin-left",
    "padding-top", "padding-right", "padding-bottom", "padding-left",
    "color", "background-color", "opacity",
    "font-family", "font-size", "font-weight", "line-height",
    "text-align", "white-space",
    "flex-direction", "justify-content", "align-items",
  ];
  const elements = [];
  const tagCounts = {};
  let nextUid = 0;
  function walk(el) {
    if (DROP_TAGS_SET.has(el.tagName)) return;
    const uid = nextUid++;
    el.setAttribute("data-source-uid", String(uid));
    tagCounts[el.tagName] = (tagCounts[el.tagName] || 0) + 1;
    const r = el.getBoundingClientRect();
    const cs = window.getComputedStyle(el);
    const fp = {};
    for (const p of FINGERPRINT) fp[p] = cs.getPropertyValue(p);
    elements.push({
      uid,
      tag: el.tagName,
      id: el.id || "",
      classes: el.getAttribute("class") || "",
      attrs: Array.from(el.attributes).map((a) => a.name),
      rect: { w: Math.round(r.width), h: Math.round(r.height) },
      fp,
    });
    for (const child of el.children) walk(child);
  }
  if (document.body) walk(document.body);
  const totalSheetRules = (() => {
    let n = 0;
    for (const s of document.styleSheets) {
      try { n += s.cssRules.length; } catch { /* cross-origin */ }
    }
    return n;
  })();
  return {
    url: location.href,
    totalElements: elements.length,
    tagCounts,
    elements,
    cssRuleCount: totalSheetRules,
    docHeight: document.documentElement.scrollHeight,
    docWidth: document.documentElement.scrollWidth,
  };
}

/**
 * Inside the canvas iframe with the most content, collect per-element
 * data keyed by `data-dj-uid` (already stamped by the serializer).
 */
function collectCaptured(iframeIndex) {
  /* eslint-env browser */
  const FINGERPRINT = [
    "display", "position", "visibility", "overflow",
    "width", "height", "min-width", "min-height", "max-width", "max-height",
    "margin-top", "margin-right", "margin-bottom", "margin-left",
    "padding-top", "padding-right", "padding-bottom", "padding-left",
    "color", "background-color", "opacity",
    "font-family", "font-size", "font-weight", "line-height",
    "text-align", "white-space",
    "flex-direction", "justify-content", "align-items",
  ];
  const frames = document.querySelectorAll("iframe");
  const frame = frames[iframeIndex];
  const doc = frame?.contentDocument;
  if (!doc) return null;
  const view = frame.contentWindow;
  const elements = [];
  const tagCounts = {};
  const stamped = doc.querySelectorAll("[data-dj-uid]");
  for (const el of stamped) {
    const uid = Number(el.getAttribute("data-dj-uid"));
    tagCounts[el.tagName] = (tagCounts[el.tagName] || 0) + 1;
    const r = el.getBoundingClientRect();
    const cs = view.getComputedStyle(el);
    const fp = {};
    for (const p of FINGERPRINT) fp[p] = cs.getPropertyValue(p);
    elements.push({
      uid,
      tag: el.tagName,
      id: el.id || "",
      classes: el.getAttribute("class") || "",
      attrs: Array.from(el.attributes).map((a) => a.name),
      rect: { w: Math.round(r.width), h: Math.round(r.height) },
      fp,
    });
  }
  const totalSheetRules = (() => {
    let n = 0;
    for (const s of doc.styleSheets) {
      try { n += s.cssRules.length; } catch { /* cross-origin */ }
    }
    return n;
  })();
  return {
    totalElements: elements.length,
    tagCounts,
    elements,
    cssRuleCount: totalSheetRules,
    docHeight: doc.documentElement.scrollHeight,
    bodyHeight: doc.body?.scrollHeight ?? 0,
  };
}

function diff(source, captured) {
  // Pair by UID — source-uid N ↔ captured-uid N.
  const byUidSrc = new Map(source.elements.map((e) => [e.uid, e]));
  const byUidCap = new Map(captured.elements.map((e) => [e.uid, e]));

  const pairedUids = [...byUidSrc.keys()].filter((u) => byUidCap.has(u));
  const droppedFromCapture = [...byUidSrc.keys()].filter((u) => !byUidCap.has(u));
  const addedInCapture = [...byUidCap.keys()].filter((u) => !byUidSrc.has(u));

  // Sample for per-element analysis.
  const sample = pairedUids.slice(0, SAMPLE_SIZE);
  const perElement = sample.map((uid) => {
    const s = byUidSrc.get(uid);
    const c = byUidCap.get(uid);
    // Tag match?
    const tagMatch = s.tag === c.tag;
    // Lost attributes (on source, not on captured — excluding our own marker)
    const srcAttrs = new Set(s.attrs.filter((a) => a !== "data-source-uid"));
    const capAttrs = new Set(c.attrs);
    const lostAttrs = [...srcAttrs].filter((a) => !capAttrs.has(a));
    // Per-property mismatches
    const mismatches = [];
    for (const p of FINGERPRINT_PROPS) {
      if (s.fp[p] !== c.fp[p]) {
        mismatches.push({ prop: p, src: s.fp[p], cap: c.fp[p] });
      }
    }
    // Bbox parity
    const bboxDelta = {
      w: c.rect.w - s.rect.w,
      h: c.rect.h - s.rect.h,
    };
    return {
      uid,
      tag: s.tag,
      tagMatch,
      classes: { src: s.classes, cap: c.classes },
      lostAttrs,
      mismatchCount: mismatches.length,
      mismatches: mismatches.slice(0, 8), // cap per-element for report size
      bboxDelta,
    };
  });

  // Per-tag delta
  const allTags = new Set([
    ...Object.keys(source.tagCounts),
    ...Object.keys(captured.tagCounts),
  ]);
  const tagDelta = [...allTags]
    .map((t) => ({
      tag: t,
      src: source.tagCounts[t] || 0,
      cap: captured.tagCounts[t] || 0,
      delta: (captured.tagCounts[t] || 0) - (source.tagCounts[t] || 0),
    }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  // Aggregates
  const totalMismatches = perElement.reduce((s, e) => s + e.mismatchCount, 0);
  const propMismatchTotals = {};
  for (const e of perElement) {
    for (const m of e.mismatches) {
      propMismatchTotals[m.prop] = (propMismatchTotals[m.prop] || 0) + 1;
    }
  }
  const topMismatchProps = Object.entries(propMismatchTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);

  return {
    totals: {
      sourceElements: source.totalElements,
      capturedElements: captured.totalElements,
      elementDelta: captured.totalElements - source.totalElements,
      sourceRules: source.cssRuleCount,
      capturedRules: captured.cssRuleCount,
      ruleDelta: captured.cssRuleCount - source.cssRuleCount,
      sourceDocHeight: source.docHeight,
      capturedBodyHeight: captured.bodyHeight,
      pairedCount: pairedUids.length,
      droppedFromCaptureCount: droppedFromCapture.length,
      addedInCaptureCount: addedInCapture.length,
    },
    tagDelta: tagDelta.slice(0, 25),
    sampleSize: sample.length,
    perElement,
    totalSampledMismatches: totalMismatches,
    topMismatchProps,
  };
}

function renderReport({ source, captured, audit }) {
  const t = audit.totals;
  const tagRows = audit.tagDelta
    .map(
      (r) =>
        `<tr><td>${r.tag}</td><td class="num">${r.src}</td><td class="num">${r.cap}</td><td class="num ${r.delta > 0 ? "pos" : r.delta < 0 ? "neg" : ""}">${r.delta > 0 ? "+" : ""}${r.delta}</td></tr>`,
    )
    .join("");
  const propRows = audit.topMismatchProps
    .map(([p, n]) => `<tr><td>${p}</td><td class="num">${n}</td></tr>`)
    .join("");
  const elementRows = audit.perElement
    .filter((e) => e.mismatchCount > 0 || e.lostAttrs.length > 0 || e.bboxDelta.w !== 0 || e.bboxDelta.h !== 0)
    .slice(0, 20)
    .map((e) => {
      const sample = e.mismatches.slice(0, 3)
        .map((m) => `<span class="mm">${m.prop}: ${escapeHtml(m.src)} → ${escapeHtml(m.cap)}</span>`)
        .join("<br>");
      return `<tr>
        <td>${e.uid}</td>
        <td>${e.tag}${e.tagMatch ? "" : ' ⚠'}</td>
        <td><code>${escapeHtml(e.classes.src.slice(0, 40))}</code></td>
        <td>${e.lostAttrs.length ? e.lostAttrs.join(", ") : "—"}</td>
        <td class="num">${e.bboxDelta.w}, ${e.bboxDelta.h}</td>
        <td>${e.mismatchCount}</td>
        <td>${sample || "—"}</td>
      </tr>`;
    })
    .join("");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>capture-diff: ${escapeHtml(source.url)}</title>
<style>
  body { font: 13px/1.4 -apple-system, system-ui, sans-serif; margin: 24px; color: #222; }
  h1 { font-size: 18px; }
  h2 { font-size: 14px; margin-top: 24px; padding-bottom: 4px; border-bottom: 1px solid #ddd; }
  table { border-collapse: collapse; margin: 8px 0; }
  th, td { padding: 4px 10px; text-align: left; border-bottom: 1px solid #eee; vertical-align: top; }
  th { background: #f6f6f6; font-weight: 600; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .pos { color: #d97706; }
  .neg { color: #dc2626; }
  .mm { display: inline-block; padding: 1px 4px; background: #fef3c7; border-radius: 2px; margin-bottom: 2px; font-family: ui-monospace, monospace; font-size: 11px; }
  code { font-family: ui-monospace, monospace; font-size: 11px; }
  .summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 12px 0; }
  .card { padding: 10px 14px; background: #f9fafb; border: 1px solid #eee; border-radius: 4px; }
  .card .label { font-size: 11px; color: #666; text-transform: uppercase; }
  .card .value { font-size: 20px; font-weight: 600; }
  .card .delta { font-size: 12px; }
</style>
</head><body>
<h1>capture-diff: ${escapeHtml(source.url)}</h1>
<p>Source URL: <a href="${escapeHtml(source.url)}">${escapeHtml(source.url)}</a> → captured at ${escapeHtml(CANVAS_URL)}</p>

<div class="summary">
  <div class="card"><div class="label">Source elements</div><div class="value">${t.sourceElements.toLocaleString()}</div></div>
  <div class="card"><div class="label">Captured elements</div><div class="value">${t.capturedElements.toLocaleString()}</div><div class="delta ${t.elementDelta > 0 ? "pos" : "neg"}">${t.elementDelta > 0 ? "+" : ""}${t.elementDelta.toLocaleString()}</div></div>
  <div class="card"><div class="label">Source CSS rules</div><div class="value">${t.sourceRules.toLocaleString()}</div></div>
  <div class="card"><div class="label">Captured CSS rules</div><div class="value">${t.capturedRules.toLocaleString()}</div><div class="delta ${t.ruleDelta > 0 ? "pos" : "neg"}">${t.ruleDelta > 0 ? "+" : ""}${t.ruleDelta.toLocaleString()}</div></div>
  <div class="card"><div class="label">Source doc height</div><div class="value">${t.sourceDocHeight.toLocaleString()}px</div></div>
  <div class="card"><div class="label">Captured body height</div><div class="value">${t.capturedBodyHeight.toLocaleString()}px</div></div>
  <div class="card"><div class="label">Paired by UID</div><div class="value">${t.pairedCount.toLocaleString()}</div><div class="delta">of ${t.sourceElements.toLocaleString()} source</div></div>
  <div class="card"><div class="label">Mismatches (sample)</div><div class="value">${audit.totalSampledMismatches}</div><div class="delta">${audit.sampleSize} elements × ${FINGERPRINT_PROPS.length} props</div></div>
</div>

<h2>Top mismatching properties (sample of ${audit.sampleSize} paired elements)</h2>
<table><thead><tr><th>Property</th><th>Mismatch count</th></tr></thead><tbody>${propRows}</tbody></table>

<h2>Element-count delta by tag (top 25 by |delta|)</h2>
<table><thead><tr><th>Tag</th><th>Source</th><th>Captured</th><th>Δ</th></tr></thead><tbody>${tagRows}</tbody></table>

<h2>Per-element drift (paired by UID — first 20 with any drift)</h2>
<table><thead><tr><th>UID</th><th>Tag</th><th>Src classes</th><th>Lost attrs</th><th>BBox Δ (w,h)</th><th>Style Δ</th><th>Sample mismatches</th></tr></thead><tbody>${elementRows}</tbody></table>

<p style="color: #999; margin-top: 24px;">Generated ${new Date().toISOString()} · audit-diff.json next to this file</p>
</body></html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function run() {
  await mkdir(OUT, { recursive: true });

  if (!(await isCanvasReachable())) {
    console.error(`\nCanvas not reachable at ${CANVAS_URL}.\n` +
      `Start it with \`pnpm dev\` at the repo root, then capture\n` +
      `${REFERENCE_URL} via the extension before re-running.\n`);
    process.exit(1);
  }

  const browser = await chromium.launch({
    channel: "chrome",
    headless: process.env.HEADED !== "1",
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
  });

  // Source side
  console.log(`[source] navigating to ${REFERENCE_URL}…`);
  const srcPage = await context.newPage();
  await srcPage.goto(REFERENCE_URL, { waitUntil: "load", timeout: 45_000 });
  await srcPage.waitForTimeout(4000);
  const source = await srcPage.evaluate(collectSource);
  console.log(`[source] ${source.totalElements} elements, ${source.cssRuleCount} CSS rules, ${source.docHeight}px tall`);

  // Canvas side
  console.log("[canvas] navigating…");
  const canvasPage = await context.newPage();
  await canvasPage.goto(CANVAS_URL, { waitUntil: "networkidle", timeout: 30_000 });
  await canvasPage.waitForTimeout(2000);

  // Pick the iframe with the most content (largest captured artboard).
  const iframeRanking = await canvasPage.evaluate(() => {
    const ranks = [];
    for (const [i, f] of [...document.querySelectorAll("iframe")].entries()) {
      try {
        const n = f.contentDocument?.querySelectorAll("*").length ?? 0;
        ranks.push({ i, n });
      } catch {
        ranks.push({ i, n: 0 });
      }
    }
    return ranks.sort((a, b) => b.n - a.n);
  });
  const targetIframe = iframeRanking[0]?.i ?? 0;
  console.log(`[canvas] picking iframe[${targetIframe}] (${iframeRanking[0]?.n} nodes)`);

  const captured = await canvasPage.evaluate(collectCaptured, targetIframe);
  if (!captured) {
    console.error("[canvas] no readable iframe contentDocument");
    await browser.close();
    process.exit(1);
  }
  console.log(`[canvas] ${captured.totalElements} captured (stamped) elements, ${captured.cssRuleCount} CSS rules, ${captured.bodyHeight}px body`);

  // Diff + report
  const audit = diff(source, captured);
  console.log(
    `\n[diff] paired ${audit.totals.pairedCount}/${source.totalElements} by UID — sampled ${audit.sampleSize} for property fingerprint`,
  );
  console.log(`[diff] total sampled property mismatches: ${audit.totalSampledMismatches}`);
  if (audit.topMismatchProps.length) {
    console.log(`[diff] top mismatching properties:`);
    for (const [p, n] of audit.topMismatchProps.slice(0, 5)) {
      console.log(`         ${p.padEnd(20)} ${n}`);
    }
  }

  await writeFile(
    `${OUT}/audit-diff.json`,
    JSON.stringify({ source: { url: source.url, totals: { elements: source.totalElements, rules: source.cssRuleCount, height: source.docHeight } }, captured: { totals: { elements: captured.totalElements, rules: captured.cssRuleCount, height: captured.bodyHeight } }, audit }, null, 2),
  );
  await writeFile(`${OUT}/diff-report.html`, renderReport({ source, captured, audit }));

  await browser.close();
  console.log(`\n[done] /tmp/capture-compare/audit-diff.json + diff-report.html`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
