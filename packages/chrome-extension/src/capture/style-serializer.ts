/**
 * Style serializer — Story 8.2 computed-style inlining with the
 * hybrid inline / inherited-diff strategy from ADR-0011 §2.
 *
 *   - Non-inherited properties (layout, dimensions, background,
 *     border, shadow, transform, opacity, flex/grid, position):
 *     always inline on every element.
 *   - Inherited properties (font-*, line-height, color, letter-
 *     spacing, text-align, cursor, direction): only inline when
 *     computed value differs from parent's.
 *   - Shorthand properties expanded to per-side longhands.
 *   - CSS custom properties (var(--…)) already resolve to concrete
 *     values inside getComputedStyle, so no special handling needed.
 *   - Cross-origin <img src> + <link rel=stylesheet> + <script> are
 *     stripped to keep the canvas safe.
 *
 * Watchdog: tracks cumulative output size. Warns at 400KB, aborts
 * at 500KB.
 */

export interface SerializeResult {
  html: string;
  nodeCount: number;
  byteCount: number;
  warnings: string[];
}

export interface SerializeError {
  error: "too-large" | "empty-input" | "walker-exhausted";
  nodeCount: number;
  byteCount: number;
}

/**
 * Serialization mode.
 *
 *  - `"computed"` (default) — `getComputedStyle` per element, hoisted
 *    to auto-generated `._djN` classes in a single `<style data-designjs-
 *    capture>` block. Class-keyed; GrapesJS' CSS Manager re-IDs them
 *    into per-rule entries on import.
 *  - `"inline"` — same computed values, but written directly to each
 *    element's `style=""` attribute. Experiment C in the v0.3.5
 *    research+experiment track — tests whether bypassing the
 *    `<style>` block fights GrapesJS' parser less. Subject to per-
 *    component `stylable` allowlist strip (the very allowlist we
 *    designed the class-hoist around).
 *
 * v0.4 will add `"author"` (source-stylesheet preservation) and
 * `"hybrid"` (cascade-fallback) per ADR-0012 §4 — passing those
 * still throws so we don't silently ship a no-op.
 */
export type SerializeMode = "computed" | "inline";

export interface SerializeOptions {
  /** Hard abort threshold in bytes. Defaults to 500KB (element selection). Whole-page captures pass a larger cap. */
  hardLimit?: number;
  /** Soft warning threshold. Defaults to 80% of hardLimit. */
  softLimit?: number;
  /** Serialization mode. See SerializeMode. */
  mode?: SerializeMode;
  /**
   * IDs to drop from the captured tree (children-loop check, same as
   * DROP_ELEMENTS). Whole-page capture from `documentElement` passes
   * the overlay's `designjs-capture-root` here so the extension's own
   * UI doesn't end up in the captured artboard.
   */
  excludeIds?: readonly string[];
  /**
   * Hoist frequently-repeated computed-style blocks (mode:"inline")
   * into shared classes inside a wrapper-stylable `<style data-designjs-
   * dedup>` block. Reduces payload + GrapesJS rule count + parse time
   * on long pages (Wikipedia-class articles emit ~15k rules per 7k
   * elements without dedup). Off by default; the page-capture path
   * opts in. Element capture should stay off — small selections rarely
   * repeat blocks enough to dedup, and fidelity matters more there.
   */
  dedup?: boolean;
  /** Promote a block to a class after this many occurrences. Default 5. */
  dedupThreshold?: number;
  /** Minimum estimated bytes saved per promotion. Default 500. */
  dedupMinSavings?: number;
  /** Hard cap on hoisted class count — keeps the GrapesJS CSS Manager
   * surface small (the scale fight that mode:"inline" originally bypassed
   * to win the v0.3.5 fidelity baseline). Default 100. */
  dedupClassCap?: number;
}

const DEFAULT_SOFT_LIMIT = 400 * 1024;
const DEFAULT_HARD_LIMIT = 500 * 1024;

/**
 * Properties we always inline on every element — layout/dimension/
 * appearance stuff that isn't inherited in CSS. The canvas renders
 * these independently per-node, so we emit them per-node.
 */
const NON_INHERITED: readonly string[] = [
  // Layout + positioning
  "display", "position", "top", "right", "bottom", "left",
  "float", "clear", "z-index", "overflow", "overflow-x", "overflow-y",
  "visibility",
  // Dimensions
  "width", "height", "min-width", "min-height", "max-width", "max-height",
  "aspect-ratio", "box-sizing",
  // Spacing (longhand)
  "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  // Border (longhand)
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "border-top-style", "border-right-style", "border-bottom-style", "border-left-style",
  "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  "border-top-left-radius", "border-top-right-radius",
  "border-bottom-left-radius", "border-bottom-right-radius",
  // Background
  "background-color", "background-image", "background-repeat",
  "background-position", "background-size", "background-attachment",
  "background-clip", "background-origin",
  // Effects
  "box-shadow", "opacity", "transform", "transform-origin",
  "filter", "backdrop-filter", "mix-blend-mode",
  // Flex
  "flex-direction", "flex-wrap", "gap", "row-gap", "column-gap",
  "justify-content", "align-items", "align-content",
  "flex-grow", "flex-shrink", "flex-basis", "align-self", "order",
  // Grid
  "grid-template-columns", "grid-template-rows", "grid-template-areas",
  "grid-auto-columns", "grid-auto-rows", "grid-auto-flow",
  "grid-column", "grid-row",
  "justify-self", "place-self",
  // CSS Multi-column Layout — Wikipedia's references / see-also / category
  // footer collapses to single-column without these. column-gap is already
  // covered in the flex section above (shared property).
  "column-count", "column-width", "column-fill", "column-span",
  "column-rule-color", "column-rule-style", "column-rule-width",
  "break-inside", "break-before", "break-after",
];

/**
 * Inherited properties — emit only when the computed value differs
 * from the parent's. Browser cascade fills in the rest.
 */
const INHERITED_DIFF: readonly string[] = [
  "font-family", "font-size", "font-weight", "font-style", "font-variant",
  "font-stretch",
  "line-height", "letter-spacing", "word-spacing", "word-break", "white-space",
  "color",
  "text-align", "text-decoration-line", "text-decoration-color",
  "text-decoration-style", "text-transform", "text-indent", "text-shadow",
  "direction", "writing-mode",
  "cursor",
];

/**
 * Attributes to strip from the cloned tree on the way out. Event
 * handlers could execute on the canvas; `src` on scripts would load
 * arbitrary code; `href` on stylesheets would pull external CSS.
 */
// HEAD is dropped because Experiment A (capture-from-html) puts the
// captured root at <html>, so HEAD becomes a child of the captured
// tree. After the html/body→div swap the head's children (META,
// TITLE, etc.) would suddenly land inside a visible <div> and some
// would render (TITLE in particular shows its text content when
// outside <head>). Dropping HEAD wholesale keeps the visible tree
// clean. Element-capture on HEAD itself returns empty-input, which
// is the right behaviour anyway.
const DROP_ELEMENTS = new Set(["SCRIPT", "NOSCRIPT", "STYLE", "LINK", "HEAD"]);
const DROP_ATTRS_PREFIX = ["on"] as const;

/**
 * Hostnames known to serve `@font-face` CSS for web fonts. We re-emit
 * matching `<link rel="stylesheet">` tags into the captured HTML so the
 * canvas iframe can fetch them and register the font-face rules — without
 * this, captured text falls back to system fonts even though the
 * computed `font-family` is correct (epic-8-followups §3.1).
 *
 * Allowlist deliberately narrow: only services that exclusively ship
 * font CSS. Adding `cdn.jsdelivr.net` etc. would pull arbitrary
 * stylesheets into the canvas, which is exactly what the LINK strip
 * was protecting against.
 */
const FONT_LINK_HOSTS: readonly string[] = [
  "fonts.googleapis.com",
  "fonts.bunny.net",
  "use.typekit.net",
  "p.typekit.net",
];

function shouldDropAttr(name: string): boolean {
  if (name === "style") return true; // replaced by our computed style
  if (name === "class") return false; // keep — useful for debugging on canvas
  if (name.startsWith("data-designjs-")) return true;
  for (const p of DROP_ATTRS_PREFIX) if (name.startsWith(p)) return true;
  return false;
}

/**
 * srcset entries are comma-separated `"<url> <descriptor>"` pairs; URLs
 * may be relative. Rewrite each to absolute.
 */
function resolveSrcset(srcset: string, baseURI: string): string {
  return srcset
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = entry.match(/^(\S+)(?:\s+(.+))?$/);
      if (!match) return entry;
      const [, url, descriptor] = match;
      try {
        const abs = new URL(url!, baseURI).href;
        return descriptor ? `${abs} ${descriptor}` : abs;
      } catch {
        return entry;
      }
    })
    .join(", ");
}

/**
 * Images / video / audio / anchors can carry relative URLs that resolve
 * against the host page's document base. On the DesignJS canvas (a
 * different origin entirely) those paths would 404. Resolve to absolute
 * URLs before emission — the DOM properties (img.src, a.href, etc.)
 * return the absolute-resolved value, unlike getAttribute which
 * returns the as-authored string.
 *
 * Computed-style URLs (background-image, list-style-image, cursor, etc.)
 * already resolve to absolute in getComputedStyle's return value, so no
 * extra handling needed for those — buildInlineStyle picks up the
 * resolved form naturally.
 */
function normalizeMediaAttrs(clone: Element, src: Element): void {
  const baseURI = document.baseURI;

  if (src instanceof HTMLImageElement && clone instanceof HTMLImageElement) {
    if (src.src) clone.setAttribute("src", src.src);
    if (src.srcset) clone.setAttribute("srcset", resolveSrcset(src.srcset, baseURI));
    return;
  }
  if (src instanceof HTMLSourceElement && clone instanceof HTMLSourceElement) {
    if (src.src) clone.setAttribute("src", src.src);
    if (src.srcset) clone.setAttribute("srcset", resolveSrcset(src.srcset, baseURI));
    return;
  }
  if (src instanceof HTMLVideoElement && clone instanceof HTMLVideoElement) {
    if (src.src) clone.setAttribute("src", src.src);
    if (src.poster) {
      try {
        clone.setAttribute("poster", new URL(src.poster, baseURI).href);
      } catch {
        /* keep as-is */
      }
    }
    return;
  }
  if (src instanceof HTMLAudioElement && clone instanceof HTMLAudioElement) {
    if (src.src) clone.setAttribute("src", src.src);
    return;
  }
  if (src instanceof HTMLAnchorElement && clone instanceof HTMLAnchorElement) {
    if (src.href) clone.setAttribute("href", src.href);
    return;
  }
  if (
    typeof SVGImageElement !== "undefined" &&
    src instanceof SVGImageElement &&
    clone instanceof SVGImageElement
  ) {
    const href = src.href?.baseVal || src.getAttribute("xlink:href");
    if (href) {
      try {
        clone.setAttribute("href", new URL(href, baseURI).href);
      } catch {
        /* keep as-is */
      }
    }
  }
}

/**
 * Tags where user-agent default margin/padding should be stripped
 * rather than faithfully captured. Source `<body>` ships with 8px
 * margin from the UA stylesheet and `<html>` may carry small
 * defaults too; if we serialize them under Experiment A (capture from
 * `documentElement`) they propagate as inline `margin: 8px` on the
 * captured root, pushing the content off the artboard's top-left
 * corner by 7-18px. Source pages don't intend body margin (it's a
 * UA default), so suppressing it on capture is correct in practice.
 */
const STRIP_MARGIN_PADDING_TAGS = new Set(["HTML", "BODY"]);

function buildInlineStyle(
  computed: CSSStyleDeclaration,
  parentComputed: CSSStyleDeclaration | null,
  srcTag: string,
): string {
  const stripMarginPadding = STRIP_MARGIN_PADDING_TAGS.has(srcTag);
  const parts: string[] = [];

  for (const prop of NON_INHERITED) {
    if (stripMarginPadding && (prop.startsWith("margin-") || prop.startsWith("padding-"))) {
      continue;
    }
    const v = computed.getPropertyValue(prop);
    // `display: none` is semantic — it intentionally hides elements
    // (Sphinx breadcrumb-nav h3's, ARIA-only landmarks, mobile-only UI
    // shown via media queries, etc.). Must emit, never skip. The
    // skip-"none" rule is for properties where "none" === browser-
    // default (border-*-style, outline-style, background-image, etc.).
    if (prop === "display" && v === "none") {
      parts.push("display:none");
      continue;
    }
    if (!v || v === "normal" || v === "none" || v === "auto") {
      // Keep layout-critical "auto"s (e.g. width:auto on flex children).
      // For these other properties, "none" / "normal" / "auto" === browser
      // default and skipping is safe.
      continue;
    }
    parts.push(`${prop}:${v}`);
  }

  for (const prop of INHERITED_DIFF) {
    const v = computed.getPropertyValue(prop);
    if (!v) continue;
    const parentV = parentComputed?.getPropertyValue(prop) ?? "";
    if (v === parentV) continue;
    parts.push(`${prop}:${v}`);
  }

  return parts.join(";");
}

interface HoistedStyle {
  /** Canonical (sorted) style declarations. Same input → same hash. */
  canon: string;
  count: number;
  /** Assigned when the block crosses the promotion threshold. */
  className: string | null;
  /** Clone elements that emitted this block before it was promoted. On
   * promotion we walk this list and swap their `style=""` for `class=""`. */
  pendingRefs: HTMLElement[];
}

interface DedupState {
  threshold: number;
  minSavings: number;
  classCap: number;
  /** key = fnv1a(canon). */
  hoistMap: Map<string, HoistedStyle>;
  /** CSS class definitions, in promotion order. */
  hoistBuffer: string[];
  nextClassN: number;
}

/**
 * Order-invariant canonicalization of a style block. `mode:"inline"`
 * builds blocks like `width:100px;height:50px;color:red` in property-
 * iteration order; two elements with the same computed style might emit
 * the same properties in different orders depending on browser quirks
 * (rare but possible across iframes / shadow roots). Sorting puts both
 * on the same hash so dedup catches them.
 */
export function canonicalizeStyleBlock(decls: string): string {
  return decls
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .sort()
    .join(";");
}

/** 32-bit FNV-1a — fast, no allocations, plenty of bits for ~10⁴ distinct
 * style blocks. Returns 8-char hex so Map keys stay compact. */
function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

interface Counters {
  nodes: number;
  bytes: number;
  warnings: string[];
  softLimit: number;
  hardLimit: number;
  /**
   * Shared rule → auto-generated class cache. Every unique style string
   * gets exactly one class; elements that share a style share the class.
   * This is load-bearing — GrapesJS' parser strips properties not in
   * each component type's `stylable` allowlist from `style=""` attrs
   * (wrapper only keeps 7 background props; h1/p/section etc. strip
   * display/flex/grid/width/height/etc.), so we MUST write styles via
   * classes + a hoisted <style> block to survive the parse.
   */
  styleToClass: Map<string, string>;
  classCounter: { n: number };
  /**
   * Monotonic UID handed to each cloned element via `data-dj-uid`. Lays
   * the foundation for the snapshot UID system in ADR-0012 §3 — v0.4
   * `take_snapshot` keys results by these IDs so re-captures can address
   * the same element across requests. v0.3 just emits them; nothing
   * reads them yet.
   */
  uidCounter: { n: number };
  /** IDs to drop from the captured tree (see SerializeOptions.excludeIds). */
  excludeIds?: readonly string[];
  /** Serialization mode (see SerializeMode). */
  mode: SerializeMode;
  /** Style-dedup state — present iff SerializeOptions.dedup is true and
   * mode is "inline". See SerializeOptions.dedup for the rationale. */
  dedup?: DedupState;
}

/**
 * Same-origin iframe content is reachable via `iframe.contentDocument`
 * (cross-origin throws `SecurityError`). When the source iframe is
 * same-origin we recursively serialize its document body and re-emit
 * the result on the cloned iframe's `srcdoc` attribute — preserving
 * the iframe's host-page positioning while making its content survive
 * the trip to the canvas. Cross-origin iframes pass through unchanged
 * with the absolute `src` that `normalizeMediaAttrs` already wrote.
 *
 * Closes part of the v0.3 capability gap that ADR-0012 §2 (CDP) was
 * written to address — specifically the same-origin half. Cross-origin
 * iframes still need CDP's `DOM.getDocument` to traverse, so they
 * remain out of reach until §2 ships.
 *
 * Each inlined iframe gets a `data-designjs-inlined-iframe="<bytes>"`
 * marker so the canvas inspector / future tooling can find them. The
 * inlined HTML counts against the parent capture's size budget; if
 * there's <4KB of headroom we skip inlining rather than abort the
 * whole capture for a tracking-pixel iframe with no visible content.
 */
const IFRAME_INLINE_HARD_LIMIT = 200 * 1024;
const IFRAME_INLINE_MIN_HEADROOM = 4 * 1024;

function inlineSameOriginIframe(
  cloneIframe: HTMLIFrameElement,
  srcIframe: HTMLIFrameElement,
  counters: Counters,
): void {
  let contentDoc: Document | null = null;
  try {
    contentDoc = srcIframe.contentDocument;
  } catch {
    // Cross-origin — `contentDocument` accessor throws SecurityError.
    return;
  }
  if (!contentDoc || !contentDoc.body || contentDoc.body.children.length === 0) {
    return;
  }

  const remaining = Math.max(0, counters.hardLimit - counters.bytes);
  const iframeHard = Math.min(IFRAME_INLINE_HARD_LIMIT, remaining);
  if (iframeHard < IFRAME_INLINE_MIN_HEADROOM) return;

  const result = serialize(contentDoc.body, {
    mode: "computed",
    hardLimit: iframeHard,
    softLimit: Math.floor(iframeHard * 0.8),
  });
  if ("error" in result) return;

  cloneIframe.setAttribute("srcdoc", result.html);
  cloneIframe.setAttribute(
    "data-designjs-inlined-iframe",
    String(result.byteCount),
  );
  counters.bytes += result.byteCount;
}

/**
 * Style-dedup: record this element's emitted block and, once a block
 * crosses the promotion threshold, hoist it into a shared `_djhN` class.
 *
 * Single-pass: the first `threshold-1` occurrences keep their inline
 * `style=""`. The Nth (= threshold) occurrence triggers promotion —
 * we walk the pending-refs list and retroactively rewrite each prior
 * element's `style=""` to `class="_djhN"`. Subsequent occurrences are
 * rewritten in-line as they're seen.
 *
 * No-op when `counters.dedup` is undefined (caller didn't opt in).
 *
 * Why we promote based on a savings estimate AND a class-count cap:
 *  - Savings estimate gates promotion of tiny blocks where the per-
 *    element class-attr overhead (~13 bytes) eats the inline-savings.
 *  - Class-count cap bounds the GrapesJS CSS Manager surface area — the
 *    very scale problem mode:"inline" originally bypassed (Experiment C
 *    win was 247→102 mismatches; restoring full class-hoist regressed
 *    that). 100 classes is small enough to keep the CSS Manager fight
 *    bounded but large enough to dedup the top-K patterns on a page
 *    like Wikipedia where ~5-10 patterns account for most bytes.
 */
function recordForDedup(
  el: HTMLElement,
  styleBlock: string,
  counters: Counters,
): void {
  const dedup = counters.dedup;
  if (!dedup) return;

  const canon = canonicalizeStyleBlock(styleBlock);
  const key = fnv1a32(canon);
  let entry = dedup.hoistMap.get(key);
  if (!entry) {
    entry = { canon, count: 0, className: null, pendingRefs: [] };
    dedup.hoistMap.set(key, entry);
  }
  entry.count++;

  if (entry.className !== null) {
    // Already promoted — swap this element's inline style for the class.
    swapStyleForClass(el, entry.className);
    return;
  }

  // Hold a ref so we can retroactively swap if this block gets promoted.
  entry.pendingRefs.push(el);

  if (entry.count < dedup.threshold) return;
  if (dedup.nextClassN >= dedup.classCap) return;

  // Estimate savings: each future occurrence costs `classCost` instead of
  // `inlineCost`; minus a one-time `canon` + class-def overhead. Account
  // for the elements we've already seen (count - 1 retroactive swaps).
  const classNameLen = `_djh${dedup.nextClassN}`.length;
  const inlineCost = styleBlock.length + 9; // ` style="..."`
  const classCost = classNameLen + 9;       // ` class="..."`
  const classDefOverhead = canon.length + 3; // `.X{...}` (X = class name; ≈)
  const savings = entry.count * (inlineCost - classCost) - classDefOverhead;
  if (savings < dedup.minSavings) return;

  // Promote.
  const className = `_djh${dedup.nextClassN++}`;
  entry.className = className;
  dedup.hoistBuffer.push(`.${className}{${entry.canon}}`);
  for (const ref of entry.pendingRefs) swapStyleForClass(ref, className);
  entry.pendingRefs = [];
}

function swapStyleForClass(el: HTMLElement, className: string): void {
  el.removeAttribute("style");
  el.classList.add(className);
}

function stripAndInline(
  clone: Element,
  src: Element,
  parentSrc: Element | null,
  counters: Counters,
): boolean {
  counters.nodes += 1;

  // Compute the element's style. Two emission strategies based on mode:
  //   "computed" (default) — attach as a generated class, deduped via
  //     styleToClass; rules hoisted to a single <style> block at the end.
  //   "inline" — write directly to the element's style="" attribute.
  //     Experiment C in the v0.3.5 research+experiment track.
  const computed = window.getComputedStyle(src);
  const parentComputed = parentSrc ? window.getComputedStyle(parentSrc) : null;
  const style = buildInlineStyle(computed, parentComputed, src.tagName);
  if (style && counters.mode === "computed") {
    let className = counters.styleToClass.get(style);
    if (!className) {
      className = `_dj${(counters.classCounter.n++).toString(36)}`;
      counters.styleToClass.set(style, className);
    }
    (clone as HTMLElement).classList.add(className);
  }
  // Drop any pre-existing style attribute from the source. In computed
  // mode our class covers the same ground; in inline mode we'll
  // overwrite below with our own composed style after the strip loop.
  (clone as HTMLElement).removeAttribute("style");

  // Stamp a monotonic UID per element. Reserved for ADR-0012 §3 re-
  // capture addressing; ignored by v0.3 consumers.
  const uid = counters.uidCounter.n++;
  (clone as HTMLElement).setAttribute("data-dj-uid", String(uid));

  // Strip dangerous attributes from the clone. shouldDropAttr returns
  // true for "style" — we already cleared it above, and we'll re-set
  // it after this loop for inline mode (it'd otherwise be stripped).
  for (const attr of Array.from(clone.attributes)) {
    if (shouldDropAttr(attr.name)) clone.removeAttribute(attr.name);
  }

  // Inline-mode style write goes AFTER the strip loop so shouldDropAttr's
  // "style" → drop rule (correct for the captured source style) doesn't
  // wipe our composed inline style.
  if (style && counters.mode === "inline") {
    (clone as HTMLElement).setAttribute("style", style);
    // Style-dedup record-and-maybe-promote. Mutates `clone` in place if
    // the block crosses the promotion threshold (swaps style="" for
    // class="_djhN"). Inert when counters.dedup is undefined.
    recordForDedup(clone as HTMLElement, style, counters);
  }

  // Rewrite relative src/srcset/href on media elements to absolute URLs
  // so the canvas (different origin) can actually load them.
  normalizeMediaAttrs(clone, src);

  // Rough running-size estimate — conservative but cheap (we
  // recompute properly from outerHTML at the end).
  counters.bytes += 48 + style.length;

  if (counters.bytes > counters.hardLimit) return false;
  if (counters.bytes > counters.softLimit && counters.warnings.length === 0) {
    counters.warnings.push(
      `Payload crossed ${Math.round(counters.softLimit / 1024)}KB — capture may get close to the ${Math.round(counters.hardLimit / 1024)}KB cap.`,
    );
  }

  // Recurse through element children, walking src + clone in parallel.
  const srcChildren = Array.from(src.children);
  const cloneChildren = Array.from(clone.children);
  for (let i = 0; i < srcChildren.length; i++) {
    const srcChild = srcChildren[i]!;
    const cloneChild = cloneChildren[i];
    if (!cloneChild) break;

    if (DROP_ELEMENTS.has(srcChild.tagName)) {
      cloneChild.remove();
      continue;
    }

    if (srcChild.id && counters.excludeIds && counters.excludeIds.includes(srcChild.id)) {
      cloneChild.remove();
      continue;
    }

    const ok = stripAndInline(cloneChild, srcChild, src, counters);
    if (!ok) return false;
  }

  // Iframes are leaves in the DOM-children walk (their content lives
  // in a separate document). Try to inline same-origin content as
  // srcdoc; cross-origin falls through with the absolute src already
  // written by normalizeMediaAttrs.
  if (
    src.tagName === "IFRAME" &&
    src instanceof HTMLIFrameElement &&
    clone instanceof HTMLIFrameElement
  ) {
    inlineSameOriginIframe(clone, src, counters);
    if (counters.bytes > counters.hardLimit) return false;
  }

  return true;
}

export function serialize(
  root: Element,
  opts: SerializeOptions = {},
): SerializeResult | SerializeError {
  if (!root) {
    return { error: "empty-input", nodeCount: 0, byteCount: 0 };
  }

  // v0.3.5 ships `"computed"` and `"inline"`. v0.4's `"author"` /
  // `"hybrid"` modes (ADR-0012 §4) are NOT implemented — passing them
  // throws rather than silently returning a computed-mode result.
  const mode: SerializeMode = opts.mode ?? "computed";
  if (mode !== "computed" && mode !== "inline") {
    throw new Error(
      `serialize: mode "${mode}" is reserved for ADR-0012 §4 (not yet implemented). v0.3.5 supports "computed" and "inline".`,
    );
  }

  const hardLimit = opts.hardLimit ?? DEFAULT_HARD_LIMIT;
  const softLimit = opts.softLimit ?? Math.min(DEFAULT_SOFT_LIMIT, Math.floor(hardLimit * 0.8));

  // If the root itself is a dropped element type, bail immediately.
  if (DROP_ELEMENTS.has(root.tagName)) {
    return { error: "empty-input", nodeCount: 0, byteCount: 0 };
  }

  const clone = root.cloneNode(true) as Element;
  // Dedup only makes sense in inline mode (computed mode already hoists
  // every unique block by definition). Silently ignore the flag in
  // computed mode rather than erroring — keeps callers from having to
  // branch on mode.
  const dedup: DedupState | undefined =
    opts.dedup && mode === "inline"
      ? {
          threshold: opts.dedupThreshold ?? 5,
          minSavings: opts.dedupMinSavings ?? 500,
          classCap: opts.dedupClassCap ?? 100,
          hoistMap: new Map(),
          hoistBuffer: [],
          nextClassN: 0,
        }
      : undefined;
  const counters: Counters = {
    nodes: 0,
    bytes: 0,
    warnings: [],
    softLimit,
    hardLimit,
    styleToClass: new Map(),
    classCounter: { n: 0 },
    uidCounter: { n: 0 },
    excludeIds: opts.excludeIds,
    mode,
    dedup,
  };

  // Pass `null` as parentSrc for the captured root so buildInlineStyle's
  // INHERITED_DIFF logic emits ALL inherited properties (color, font-*,
  // line-height, letter-spacing, etc.) on the root unconditionally.
  //
  // Why: the source root inherits these from its source-page parent
  // (typically <html> + <body>, sharing the same color baseline), so a
  // naive parent-diff at capture time finds them equal and emits
  // nothing. But in the canvas iframe the captured root is reparented
  // under the GrapesJS default <body> with a DIFFERENT baseline
  // (light theme regardless of source). Dark-themed sites with white
  // text then inherit black on light — text becomes invisible against
  // the captured backgrounds.
  //
  // Passing parentSrc=null forces `parentV` to "" inside buildInlineStyle,
  // which is never equal to any real computed value, so every inherited
  // property gets pinned on the root. Descendants still inherit-diff
  // against their own parents in the captured tree, so payload growth
  // is bounded.
  const ok = stripAndInline(clone, root, null, counters);
  if (!ok) {
    return {
      error: "too-large",
      nodeCount: counters.nodes,
      byteCount: counters.bytes,
    };
  }

  // The next two passes are computed-mode only:
  //  - flattenPassThroughWrappers reads styleToClass to identify
  //    no-op wrapper divs by their auto-generated class; inline mode
  //    leaves styleToClass empty so nothing flattens.
  //  - The hoisted <style data-designjs-capture> block has no rules
  //    to emit in inline mode.
  if (mode === "computed") {
    flattenPassThroughWrappers(clone, counters.styleToClass);

    // Emit a <style> block with one rule per unique computed-style signature.
    // Prepended inside the clone so GrapesJS' parser finds it via parseCss and
    // registers the rules in the canvas cascade — classes on elements resolve
    // against these rules just like regular class-based CSS.
    const cssRules: string[] = [];
    for (const [style, className] of counters.styleToClass) {
      cssRules.push(`.${className}{${style}}`);
    }
    const cssText = cssRules.join("");
    const styleEl = clone.ownerDocument.createElement("style");
    styleEl.setAttribute("data-designjs-capture", "");
    styleEl.textContent = cssText;
    (clone as HTMLElement).insertBefore(styleEl, (clone as HTMLElement).firstChild);
  }

  // Dedup hoist block (inline mode + dedup opt-in). Same wrapper-stylable
  // pattern as the computed-mode block above — `data-designjs-dedup`
  // marker, prepended as firstChild so GrapesJS' parseCss picks it up
  // before any element references the classes. Order vs author/computed
  // styles: dedup goes BEFORE the author block (which is prepended after
  // this), so author CSS still wins on cascade ties — same precedence
  // as if these were per-element inline styles in the captured tree.
  if (counters.dedup && counters.dedup.hoistBuffer.length > 0) {
    const dedupEl = clone.ownerDocument.createElement("style");
    dedupEl.setAttribute("data-designjs-dedup", "");
    dedupEl.textContent = counters.dedup.hoistBuffer.join("");
    (clone as HTMLElement).insertBefore(dedupEl, (clone as HTMLElement).firstChild);
  }

  // Author CSS supplement (A.2). Inserted as firstChild so it appears
  // *before* the computed-style block in source order — computed wins
  // on conflicts (cascade is order-based for equal specificity), and
  // author CSS adds @keyframes / @font-face / ::before / ::after /
  // @supports rules the computed walker can't see. See
  // collectAuthorCss for the cascade-note caveat on @media reflow.
  const author = collectAuthorCss(root.ownerDocument);
  if (author.cssText) {
    const authorEl = clone.ownerDocument.createElement("style");
    authorEl.setAttribute("data-designjs-author", "");
    authorEl.textContent = author.cssText;
    (clone as HTMLElement).insertBefore(
      authorEl,
      (clone as HTMLElement).firstChild,
    );
  }

  const html = (clone as HTMLElement).outerHTML;
  const byteCount = new Blob([html]).size;

  if (byteCount > hardLimit) {
    return { error: "too-large", nodeCount: counters.nodes, byteCount };
  }
  if (byteCount > softLimit && counters.warnings.length === 0) {
    counters.warnings.push(
      `Final payload is ${(byteCount / 1024).toFixed(0)}KB — near the ${Math.round(hardLimit / 1024)}KB cap.`,
    );
  }

  return {
    html,
    nodeCount: counters.nodes,
    byteCount,
    warnings: counters.warnings,
  };
}

/**
 * Walk the source page's `<head>` for `<link rel="stylesheet">` whose
 * URL hostname is in {@link FONT_LINK_HOSTS}, and emit a deduplicated
 * sequence of clean `<link>` tags as HTML.
 *
 * Caller injects the result inside the captured page's outer wrapper
 * (post `<body>` → `<div>` swap) so the canvas iframe fetches them and
 * registers `@font-face` rules — closes epic-8-followups §3.1 (text
 * rendering in system fallback fonts instead of the source page's
 * fonts).
 *
 * Returns the empty string when there's nothing to emit; callers can
 * always splice the result in unconditionally.
 */
/**
 * Walks `document.styleSheets`, extracts author CSS from same-origin
 * sheets, and rewrites relative `url(...)` references to absolute so
 * background images / cursors / etc. still load when the captured HTML
 * is rendered on the canvas (different origin).
 *
 * **Why this matters:** the computed-style walker can only see styles
 * on real elements via `getComputedStyle`. It misses:
 *
 *  - `@keyframes` blocks (animations referenced by `animation-name`)
 *  - `@font-face` rules beyond the narrow font-CDN allowlist
 *  - `::before` / `::after` pseudo-element rules (Axios icons,
 *    Bootstrap-style decorative content, ...)
 *  - `@media` rules (text only; see "Cascade note" below for the
 *    practical limitation)
 *  - `@supports` / `@layer` / `@page` blocks
 *
 * **Cascade note:** the author block is emitted *before* the existing
 * computed-style block in the captured HTML. Both layers use class
 * selectors with equal specificity, so the later block (computed)
 * wins on conflicting properties. That means author CSS is additive —
 * it brings along the things computed misses but does **not** unlock
 * `@media` reflow (computed values captured at the host viewport
 * override any narrower-width media rule on the canvas). True
 * `@media` reflow requires the author/hybrid modes from ADR-0012 §4,
 * which are deliberately out of scope here.
 *
 * **Scope:** same-origin only. Cross-origin sheets throw `SecurityError`
 * on `.cssRules` access — those need ADR-0012 §2's CDP path. `@import`
 * and `@charset` rules are skipped (the former would need recursive
 * fetch we don't do; the latter is noise once inlined).
 */
export interface CollectedAuthorCss {
  cssText: string;
  collectedSheets: number;
  skippedSheets: number;
}

const URL_REWRITE_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
const ABSOLUTE_URL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

function absolutizeCssUrls(cssText: string, baseUrl: string): string {
  return cssText.replace(URL_REWRITE_RE, (match, quote: string, url: string) => {
    if (ABSOLUTE_URL_RE.test(url)) return match;
    try {
      return `url(${quote}${new URL(url, baseUrl).href}${quote})`;
    } catch {
      return match;
    }
  });
}

export function collectAuthorCss(doc: Document | null | undefined): CollectedAuthorCss {
  if (!doc) return { cssText: "", collectedSheets: 0, skippedSheets: 0 };
  const parts: string[] = [];
  let collected = 0;
  let skipped = 0;
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList | null = null;
    try {
      rules = sheet.cssRules;
    } catch {
      // Cross-origin — `.cssRules` access throws SecurityError. The
      // sheet's content is only reachable via CDP (ADR-0012 §2).
      skipped++;
      continue;
    }
    if (!rules) {
      skipped++;
      continue;
    }
    collected++;
    const baseUrl = sheet.href ?? doc.baseURI;
    for (const rule of Array.from(rules)) {
      // CSSRule.CHARSET_RULE = 2, IMPORT_RULE = 3 — these constants
      // exist on CSSRule in browsers and jsdom, but guard with a
      // numeric check for forward-compat.
      const t = rule.type;
      if (t === 2 || t === 3) continue;
      parts.push(absolutizeCssUrls(rule.cssText, baseUrl));
    }
  }
  return {
    cssText: parts.join("\n"),
    collectedSheets: collected,
    skippedSheets: skipped,
  };
}

export function collectFontLinks(head: HTMLHeadElement | null | undefined): string {
  if (!head) return "";
  const out: string[] = [];
  const seen = new Set<string>();
  for (const el of Array.from(head.querySelectorAll('link[rel~="stylesheet"]'))) {
    const href = (el as HTMLLinkElement).href;
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      continue;
    }
    if (!FONT_LINK_HOSTS.includes(url.hostname)) continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    out.push(
      `<link rel="stylesheet" href="${escapeAttr(url.href)}" crossorigin="anonymous">`,
    );
  }
  return out.join("");
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Allowlist of `property:value` pairs that, taken together, render as
 * "no visible change vs the unstyled browser default for a block
 * element." Used by {@link flattenPassThroughWrappers} to detect divs
 * that are pure framework artifacts (Next.js / React injects them by
 * the hundreds for layout, accessibility, and data-attribute wiring).
 *
 * Conservative by design: ANY unknown declaration → not pass-through →
 * div preserved. This produces false negatives (some genuinely-empty
 * wrappers stay) but zero false positives (no div with meaningful
 * styling gets collapsed).
 *
 * Per epic-8-followups §3.4 — MEDIUM impact (15–30% payload size on
 * marketing pages), unblocks shallower component trees in the canvas
 * inspector.
 */
const PASS_THROUGH_DECLS = new Set([
  "display:block",
  "position:static",
  "top:0px",
  "right:0px",
  "bottom:0px",
  "left:0px",
  "z-index:auto",
  "margin-top:0px",
  "margin-right:0px",
  "margin-bottom:0px",
  "margin-left:0px",
  "padding-top:0px",
  "padding-right:0px",
  "padding-bottom:0px",
  "padding-left:0px",
  "border-top-width:0px",
  "border-right-width:0px",
  "border-bottom-width:0px",
  "border-left-width:0px",
  "border-top-left-radius:0px",
  "border-top-right-radius:0px",
  "border-bottom-left-radius:0px",
  "border-bottom-right-radius:0px",
  "background-color:rgba(0, 0, 0, 0)",
  "background-color:transparent",
  "background-image:none",
  "background-repeat:repeat",
  "background-position:0% 0%",
  "background-size:auto",
  "background-attachment:scroll",
  "background-clip:border-box",
  "background-origin:padding-box",
  "box-shadow:none",
  "opacity:1",
  "transform:none",
  "transform-origin:50% 50%",
  "filter:none",
  "backdrop-filter:none",
  "mix-blend-mode:normal",
  "overflow:visible",
  "overflow-x:visible",
  "overflow-y:visible",
  "visibility:visible",
  "float:none",
  "clear:none",
  "aspect-ratio:auto",
  "box-sizing:content-box",
  "flex-grow:0",
  "flex-shrink:1",
  "flex-basis:auto",
  "order:0",
]);

export function isPassThroughStyle(style: string): boolean {
  if (style === "") return true;
  const parts = style.split(";");
  for (const part of parts) {
    if (!part) continue;
    if (!PASS_THROUGH_DECLS.has(part.trim())) return false;
  }
  return true;
}

/**
 * Walk the cloned tree and unwrap pass-through `<div>` wrappers in-
 * place. A div is unwrappable iff:
 *
 *   - tag is `<div>` (no other elements — `<section>` / `<article>` /
 *     etc. carry semantic weight even when visually empty)
 *   - has exactly one element child and zero text-node children
 *   - has no attributes besides `class` (no id, no `data-*`, no
 *     `aria-*`, no role, no event handlers — those are stripped, but
 *     `data-dj-uid` we just stamped IS preserved on the survivor)
 *   - its class's CSS rule is pass-through per
 *     {@link isPassThroughStyle}
 *
 * Survivor inherits the unwrapped div's `data-dj-uid` so re-capture
 * addressing still resolves to a stable id at this position in the
 * tree (UID is reserved for ADR-0012 §3 — survivor's choice is
 * arbitrary today).
 *
 * Idempotent — runs in passes until a full walk produces zero
 * changes, since each unwrap can expose a new pass-through wrapper one
 * level up.
 */
function flattenPassThroughWrappers(
  root: Element,
  styleToClass: Map<string, string>,
): void {
  const classToStyle = new Map<string, string>();
  for (const [style, cls] of styleToClass) classToStyle.set(cls, style);

  let changed = true;
  while (changed) {
    changed = false;
    const candidates: Element[] = [];
    collectFlattenCandidates(root, candidates);
    for (const div of candidates) {
      // The candidate may have been removed in a prior iteration of this
      // pass — skip if no longer attached.
      if (!div.parentNode) continue;
      const cls = (div as HTMLElement).getAttribute("class") ?? "";
      const style = cls ? classToStyle.get(cls.trim()) ?? "" : "";
      if (!isPassThroughStyle(style)) continue;

      const child = div.firstElementChild;
      if (!child) continue;

      // Preserve the unwrapped div's data-dj-uid on the survivor — pick
      // the ancestor's id, since that's what callers will have observed
      // on the first capture.
      const uid = (div as HTMLElement).getAttribute("data-dj-uid");
      if (uid != null && !(child as HTMLElement).hasAttribute("data-dj-uid")) {
        (child as HTMLElement).setAttribute("data-dj-uid", uid);
      }

      div.parentNode.replaceChild(child, div);
      changed = true;
    }
  }
}

function collectFlattenCandidates(node: Element, out: Element[]): void {
  // Pre-order traversal so outer wrappers are considered first; if an
  // outer wrapper unwraps, the inner becomes a candidate in the next
  // pass.
  if (isStructurallyPassThrough(node)) out.push(node);
  for (let child: Element | null = node.firstElementChild; child; child = child.nextElementSibling) {
    collectFlattenCandidates(child, out);
  }
}

function isStructurallyPassThrough(el: Element): boolean {
  if (el.tagName !== "DIV") return false;
  if (el.children.length !== 1) return false;
  // No raw text nodes (would dump text content into parent if unwrapped).
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3 /* TEXT_NODE */) {
      const text = (n.nodeValue ?? "").trim();
      if (text !== "") return false;
    }
  }
  for (const attr of Array.from(el.attributes)) {
    if (attr.name === "class") continue;
    if (attr.name === "data-dj-uid") continue;
    return false;
  }
  return true;
}
