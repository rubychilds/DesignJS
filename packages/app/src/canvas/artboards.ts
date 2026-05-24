import type { Editor, Frame } from "grapesjs";

export type ArtboardCategory =
  | "mobile"
  | "tablet"
  | "desktop"
  | "presentation"
  | "watch";

export interface ArtboardPreset {
  id: string;
  label: string;
  width: number;
  height: number;
  category: ArtboardCategory;
}

/**
 * Device presets matching the Figma shape. Used by the inspector's Frame
 * type-switcher dropdown (per user direction 2026-04-19) and by the MCP
 * `create_artboard` tool as preset shortcuts. Order inside a category matters
 * — it's the display order in the dropdown.
 */
export const ARTBOARD_PRESETS: ArtboardPreset[] = [
  // Mobile
  { id: "iphone-17-pro-max", label: "iPhone 17 Pro Max", width: 440, height: 956, category: "mobile" },
  { id: "iphone-17", label: "iPhone 17", width: 402, height: 874, category: "mobile" },
  { id: "iphone-16-plus", label: "iPhone 16 Plus", width: 430, height: 932, category: "mobile" },
  { id: "iphone-16", label: "iPhone 16", width: 393, height: 852, category: "mobile" },
  { id: "iphone-air", label: "iPhone Air", width: 420, height: 912, category: "mobile" },
  { id: "iphone-14-15", label: "iPhone 14 & 15", width: 393, height: 852, category: "mobile" },
  { id: "iphone-13-14", label: "iPhone 13 & 14", width: 390, height: 844, category: "mobile" },
  { id: "android-compact", label: "Android Compact", width: 412, height: 917, category: "mobile" },
  { id: "android-medium", label: "Android Medium", width: 700, height: 840, category: "mobile" },

  // Tablet
  { id: "ipad-mini", label: 'iPad mini 8.3"', width: 744, height: 1133, category: "tablet" },
  { id: "ipad-pro-11", label: 'iPad Pro 11"', width: 834, height: 1194, category: "tablet" },
  { id: "ipad-pro-129", label: 'iPad Pro 12.9"', width: 1024, height: 1366, category: "tablet" },
  { id: "surface-pro-8", label: "Surface Pro 8", width: 1440, height: 960, category: "tablet" },

  // Desktop
  { id: "macbook-air", label: "MacBook Air", width: 1280, height: 832, category: "desktop" },
  { id: "macbook-pro-14", label: 'MacBook Pro 14"', width: 1512, height: 982, category: "desktop" },
  { id: "macbook-pro-16", label: 'MacBook Pro 16"', width: 1728, height: 1117, category: "desktop" },
  { id: "desktop", label: "Desktop", width: 1440, height: 1024, category: "desktop" },
  { id: "wireframes", label: "Wireframes", width: 1440, height: 1024, category: "desktop" },
  { id: "android-expanded", label: "Android Expanded", width: 1280, height: 800, category: "desktop" },
  { id: "tv", label: "TV", width: 1280, height: 720, category: "desktop" },

  // Presentation
  { id: "slide-16-9", label: "Slide 16:9", width: 1920, height: 1080, category: "presentation" },
  { id: "slide-4-3", label: "Slide 4:3", width: 1024, height: 768, category: "presentation" },

  // Watch
  { id: "apple-watch-45", label: "Apple Watch 45mm", width: 198, height: 242, category: "watch" },
  { id: "apple-watch-41", label: "Apple Watch 41mm", width: 176, height: 215, category: "watch" },
  { id: "apple-watch-44", label: "Apple Watch 44mm", width: 184, height: 224, category: "watch" },
  { id: "apple-watch-40", label: "Apple Watch 40mm", width: 162, height: 197, category: "watch" },
];

export const ARTBOARD_CATEGORIES: { id: ArtboardCategory; label: string }[] = [
  { id: "mobile", label: "Mobile" },
  { id: "tablet", label: "Tablet" },
  { id: "desktop", label: "Desktop" },
  { id: "presentation", label: "Presentation" },
  { id: "watch", label: "Watch" },
];

export const DEFAULT_ARTBOARD_GAP = 80;

/**
 * Event name panels subscribe to for artboard mutations. Emitted after every
 * createArtboard / deleteArtboard / rename. Using a custom event on the
 * editor's bus is more reliable than Backbone's collection `add`/`remove`
 * events in this GrapesJS version (they don't consistently fire for
 * programmatic addFrame).
 */
export const ARTBOARDS_CHANGED = "designjs:artboards-changed";

function notifyChange(editor: Editor): void {
  (editor as unknown as { trigger?: (ev: string) => void }).trigger?.(ARTBOARDS_CHANGED);
}

interface FrameData {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function readFrameData(frame: Frame): FrameData {
  // GrapesJS Frame extends a Backbone-style model: cid is the stable per-
  // session id; id is optional (only set if you save the model server-side).
  const id =
    (frame as unknown as { cid?: string }).cid ??
    (frame as unknown as { id?: string }).id ??
    "";
  const attrs = (frame as unknown as { attributes?: Record<string, unknown> }).attributes ?? {};
  const getAttr = (key: string): unknown =>
    (frame as unknown as { get?: (k: string) => unknown }).get?.(key) ?? attrs[key];
  return {
    id,
    name: String(getAttr("name") ?? "Untitled"),
    x: Number(getAttr("x") ?? 0),
    y: Number(getAttr("y") ?? 0),
    width: Number(getAttr("width") ?? 1440),
    height: Number(getAttr("height") ?? 900),
  };
}

export function listArtboards(editor: Editor): FrameData[] {
  return editor.Canvas.getFrames().map(readFrameData);
}

/**
 * Given a desired width/height, suggest a canvas-world position that doesn't
 * overlap any existing artboard. Places new artboards on a horizontal "top
 * row" strip (`y: 0`) extending rightward from the rightmost-edge of any
 * existing artboard, separated by DEFAULT_ARTBOARD_GAP.
 *
 * Pinning every placement to `y: 0` is deliberate: prior versions tracked
 * the y of whichever existing artboard happened to be rightmost, which
 * caused vertical drift across multiple captures of varying heights. The
 * "captures pile on top of each other" user report traced to that drift —
 * with one tall existing artboard, the next capture would land far below
 * the visible canvas area. Top-row placement is predictable and easy to
 * find via Cmd+0 fit-to-content.
 */
export function findPlacement(
  editor: Editor,
  // width / height kept in the signature for API stability (callers in
  // handlers.ts + createArtboard pass them) but no longer consulted —
  // top-row placement doesn't depend on the new artboard's dimensions.
  _width: number,
  _height: number,
): { x: number; y: number } {
  const existing = listArtboards(editor);
  if (existing.length === 0) return { x: 0, y: 0 };

  let rightmost = -Infinity;
  for (const f of existing) {
    const right = f.x + f.width;
    if (right > rightmost) rightmost = right;
  }
  return {
    x: rightmost + DEFAULT_ARTBOARD_GAP,
    y: 0,
  };
}

export interface CreateArtboardOptions {
  name?: string;
  width: number;
  height: number;
  x?: number;
  y?: number;
}

/**
 * Base style applied to every new frame's body. White background so frames
 * pop against the off-white canvas void.
 *
 * Applied directly to the wrapper component's styles — not via addFrame's
 * `styles: "html,body{…}"` string — because GrapesJS's CSS parser strips
 * element-name selectors like `html` and `body`, causing the injected
 * defaults to silently vanish on re-render. The component-level style
 * survives because it renders as `#<wrapper-id> { … }` (ID selector).
 *
 * Height is NOT set here. `html,body { height: 100% }` is injected into
 * the iframe document via `PRIMITIVE_BASE_CSS` on `canvas:frame:load`
 * (see editor-options.ts) — that's low specificity and doesn't fight
 * with user-authored styles. Setting `min-height: 100%` on the wrapper
 * collapses to zero when `<html>` has no explicit height, which caused
 * the "appears instantly, then fades bottom-to-top" regression.
 */
const DEFAULT_FRAME_BODY_STYLE = {
  margin: "0",
  padding: "0",
  background: "#ffffff",
} as const;

/**
 * Apply the frame's width/height as explicit CSS on the wrapper component.
 *
 * In `infiniteCanvas: true` mode the frame model's `width` field propagates
 * to the rendered `.gjs-frame-wrapper` (GrapesJS reads it somewhere in the
 * positioning pipeline) but `height` does NOT — the `.gjs-frames` container
 * and every descendant collapse to `height: 0`, which is why an empty frame
 * paints as nothing despite the frame model claiming 1280×800.
 *
 * Setting width+height on the wrapper component's styles gives GrapesJS the
 * sizing signal it needs to give the wrapper real dimensions. Verified live
 * 2026-04-19: calling wrapper.addStyle({ width, height }) in the console
 * made a previously-invisible frame render correctly.
 */
function applyFrameDimensions(frame: Frame): void {
  const f = frame as unknown as {
    get?: (k: string) => unknown;
  };
  const width = Number(f.get?.("width") ?? 0);
  const height = Number(f.get?.("height") ?? 0);
  const wrapper = f.get?.("component") as
    | { addStyle?: (s: Record<string, string>) => void }
    | undefined;
  if (!wrapper || !width || !height) return;
  wrapper.addStyle?.({ width: `${width}px`, height: `${height}px` });
}

function applyDefaultFrameStyle(frame: Frame): void {
  const wrapper = (frame as unknown as { get?: (k: string) => unknown }).get?.("component") as
    | { addStyle?: (s: Record<string, string>) => void }
    | undefined;
  wrapper?.addStyle?.({ ...DEFAULT_FRAME_BODY_STYLE });
  applyFrameDimensions(frame);
}

/**
 * A "scratch" frame is the empty default frame from `ensureDefaultArtboard`
 * — always named exactly "Frame 1" with no components inside. When the user
 * (or an agent) creates their first real artboard, we want the scratch
 * frame to be replaced, not left behind as clutter. Named frames and frames
 * with any content are left alone.
 */
function isScratchFrame(frame: unknown): boolean {
  const f = frame as { get?: (k: string) => unknown };
  const name = String(f.get?.("name") ?? "");
  if (name !== "Frame 1") return false;
  const wrapper = f.get?.("component") as
    | { components?: () => { length?: number } }
    | undefined;
  const children = wrapper?.components?.();
  const childCount = Number(children?.length ?? 0);
  return childCount === 0;
}

export function createArtboard(editor: Editor, opts: CreateArtboardOptions): FrameData {
  // If the canvas only has an empty scratch frame sitting around, delete it
  // so `create_artboard({ name: "Desktop" })` on a fresh canvas yields one
  // Desktop frame rather than a Desktop next to a lingering "Frame 1".
  const existing = editor.Canvas.getFrames();
  for (const f of existing) {
    if (isScratchFrame(f)) {
      const page = (editor.Pages as unknown as {
        getSelected?: () => { getFrames?: () => { remove?: (x: unknown) => void } } | undefined;
      }).getSelected?.();
      page?.getFrames?.()?.remove?.(f);
    }
  }

  const { x, y } = opts.x != null && opts.y != null
    ? { x: opts.x, y: opts.y }
    : findPlacement(editor, opts.width, opts.height);
  const name = opts.name ?? `Artboard ${listArtboards(editor).length + 1}`;

  const frame = editor.Canvas.addFrame({
    name,
    x,
    y,
    width: opts.width,
    height: opts.height,
    components: "",
  });
  applyDefaultFrameStyle(frame);
  notifyChange(editor);
  return readFrameData(frame);
}

/**
 * Remove an artboard by id. The last remaining frame *can* be deleted — the
 * canvas renders a blank void in that state, and users can re-add a frame
 * via the Layers header's + action. Emits ARTBOARDS_CHANGED on success.
 */
export function deleteArtboard(editor: Editor, id: string): boolean {
  const frames = editor.Canvas.getFrames();
  const frame = (frames as unknown as Array<{ cid?: string; id?: string }>).find(
    (f) => String(f.cid ?? f.id ?? "") === id,
  );
  if (!frame) return false;
  const page = (editor.Pages as unknown as {
    getSelected?: () => { getFrames?: () => { remove?: (x: unknown) => void } } | undefined;
  }).getSelected?.();
  const collection = page?.getFrames?.();
  if (!collection?.remove) return false;
  collection.remove(frame);
  notifyChange(editor);
  return true;
}

/** Pixel threshold inside which an artboard edge snaps to another artboard's edge. */
export const SNAP_THRESHOLD = 8;

/**
 * Given a prospective (x, y) for `movingId`, return the nearest snap-adjusted
 * position where the moving artboard's left/right/top/bottom edges align with
 * any other artboard's left/right/top/bottom edges within SNAP_THRESHOLD.
 *
 * Returns `{ x, y, snappedX, snappedY }` — the snapped coordinates plus
 * booleans indicating whether each axis was actually snapped (so callers can
 * draw an alignment guide if desired). When nothing is in range, returns the
 * input unchanged with both snap flags false.
 */
export function findSnapOffset(
  editor: Editor,
  movingId: string,
  x: number,
  y: number,
  threshold: number = SNAP_THRESHOLD,
): { x: number; y: number; snappedX: boolean; snappedY: boolean } {
  const others = listArtboards(editor).filter((f) => f.id !== movingId);
  const moving = listArtboards(editor).find((f) => f.id === movingId);
  if (!moving) return { x, y, snappedX: false, snappedY: false };

  const movingLeft = x;
  const movingRight = x + moving.width;
  const movingTop = y;
  const movingBottom = y + moving.height;

  let bestDx = Infinity;
  let snapDx = 0;
  for (const other of others) {
    for (const otherEdge of [other.x, other.x + other.width]) {
      for (const movingEdge of [movingLeft, movingRight]) {
        const delta = otherEdge - movingEdge;
        if (Math.abs(delta) < Math.abs(bestDx) && Math.abs(delta) <= threshold) {
          bestDx = delta;
          snapDx = delta;
        }
      }
    }
  }

  let bestDy = Infinity;
  let snapDy = 0;
  for (const other of others) {
    for (const otherEdge of [other.y, other.y + other.height]) {
      for (const movingEdge of [movingTop, movingBottom]) {
        const delta = otherEdge - movingEdge;
        if (Math.abs(delta) < Math.abs(bestDy) && Math.abs(delta) <= threshold) {
          bestDy = delta;
          snapDy = delta;
        }
      }
    }
  }

  return {
    x: snapDx !== 0 ? x + snapDx : x,
    y: snapDy !== 0 ? y + snapDy : y,
    snappedX: snapDx !== 0,
    snappedY: snapDy !== 0,
  };
}

/**
 * Move an artboard to an absolute canvas-world position. Applies snap-to-edge
 * alignment with sibling frames when `snap` is true (default). Emits
 * ARTBOARDS_CHANGED on success.
 *
 * The `noUndo` option suppresses the per-step undo entry that GrapesJS would
 * otherwise record. Drag handlers pass `noUndo: true` on every pointermove
 * and emit a single trackable commit on pointerup — without this, a 100px
 * drag produces ~30 undo entries instead of one. Honored by GrapesJS' undo
 * lib (grapesjs@0.22.16 source, `noUndo:!0`).
 */
export function moveArtboard(
  editor: Editor,
  id: string,
  x: number,
  y: number,
  snap: boolean = true,
  opts: { noUndo?: boolean } = {},
): { x: number; y: number; snappedX: boolean; snappedY: boolean } | false {
  const frames = editor.Canvas.getFrames();
  const frame = (frames as unknown as Array<{
    cid?: string;
    id?: string;
    set?: (a: Record<string, unknown>, opts?: Record<string, unknown>) => void;
  }>).find((f) => String(f.cid ?? f.id ?? "") === id);
  if (!frame || typeof frame.set !== "function") return false;

  const final = snap
    ? findSnapOffset(editor, id, x, y)
    : { x, y, snappedX: false, snappedY: false };
  frame.set({ x: final.x, y: final.y }, opts.noUndo ? { noUndo: true } : undefined);
  notifyChange(editor);
  return final;
}

/**
 * Shrink/grow an artboard's height to match its content's actual bounding
 * box. Reads the wrapper element's `scrollHeight` (browser-native content
 * height, includes padding, excludes margins). Width is preserved.
 *
 * Use case: agent creates a Desktop artboard (1440×900), drops a pricing
 * section in, then calls `fit_artboard` so the frame shrinks to the real
 * content height — no blank space below. Returns the new height, or null
 * when the frame can't be resolved or has no measurable content.
 */
export function fitArtboardToContent(editor: Editor, id: string): number | null {
  const frames = editor.Canvas.getFrames();
  const frame = (frames as unknown as Array<{ cid?: string; id?: string }>).find(
    (f) => String(f.cid ?? f.id ?? "") === id,
  );
  if (!frame) return null;

  // Measure content extent. Body + the wrapper div we've applied explicit
  // `height: Xpx` to (via applyFrameDimensions) need that height cleared
  // during the measurement — otherwise scrollHeight reports the frame
  // height, not the content height. Temporarily unset height on body + all
  // descendants that carry an inline height, read body.scrollHeight (which
  // now reflects only real content), then restore the originals.
  const view = (frame as unknown as {
    view?: {
      getWindow?: () => Window | undefined;
      frame?: { el?: HTMLIFrameElement };
      el?: HTMLIFrameElement;
    };
  }).view;
  const iframeEl: HTMLIFrameElement | undefined =
    view?.frame?.el ?? view?.el ?? undefined;
  const doc =
    view?.getWindow?.()?.document ?? iframeEl?.contentDocument ?? undefined;
  const body = doc?.body;
  if (!body) return null;

  // Override the frame-height inline on body + the wrapper div (GrapesJS
  // renders the wrapper component as a div inside body with id matching
  // `wrapper.getId()`; applyFrameDimensions sizes it via `#<id> { height }`
  // which an inline `style.height = "auto"` beats by specificity). Body
  // gets `height: 100%` from PRIMITIVE_BASE_CSS, which inline also wins.
  // Other descendants (user content with explicit heights) are untouched.
  const restore: Array<() => void> = [];
  const clearHeight = (el: HTMLElement) => {
    const prev = el.style.height;
    el.style.height = "auto";
    restore.push(() => {
      el.style.height = prev;
    });
  };
  clearHeight(body);
  const wrapperComponent = (frame as unknown as { get?: (k: string) => unknown }).get?.(
    "component",
  ) as { getId?: () => string } | undefined;
  const wrapperId = wrapperComponent?.getId?.();
  if (wrapperId) {
    const wrapperEl = doc?.getElementById(wrapperId);
    if (wrapperEl) clearHeight(wrapperEl as HTMLElement);
  }

  const contentHeight = Math.ceil(body.scrollHeight);
  for (const fn of restore) fn();

  if (contentHeight < 1) return null;
  const width = Number(
    (frame as unknown as { get?: (k: string) => unknown }).get?.("width") ?? 0,
  );
  if (!resizeArtboard(editor, id, width, contentHeight)) return null;
  return contentHeight;
}

/**
 * Resize an artboard by id. Width is required; height is optional and left
 * untouched when omitted (Story 7.2 breakpoint toolbar only cares about the
 * horizontal axis — it's what controls Tailwind's `md:` / `lg:` prefixes).
 * Emits ARTBOARDS_CHANGED on success.
 */
export function resizeArtboard(
  editor: Editor,
  id: string,
  width: number,
  height?: number,
): boolean {
  const frames = editor.Canvas.getFrames();
  const frame = (frames as unknown as Array<{
    cid?: string;
    id?: string;
    set?: (a: Record<string, unknown>) => void;
  }>).find((f) => String(f.cid ?? f.id ?? "") === id);
  if (!frame || typeof frame.set !== "function") return false;
  const attrs: Record<string, unknown> = { width };
  if (typeof height === "number") attrs.height = height;
  frame.set(attrs);
  // Mirror the new dimensions onto the wrapper component's CSS so the
  // infiniteCanvas layout actually updates — without this the frame model
  // updates but the rendered .gjs-frames container stays at old (or zero)
  // height. See applyFrameDimensions docstring for why.
  applyFrameDimensions(frame as unknown as Frame);
  notifyChange(editor);
  return true;
}

/**
 * Return the "active" artboard — the one whose wrapper is an ancestor of the
 * currently-selected component. Falls back to the first frame when nothing
 * is selected or the selected component's frame can't be resolved. Returns
 * null when the canvas has zero frames — a legitimate state on a fresh
 * canvas before the user adds the first frame.
 */
export function getActiveArtboardId(editor: Editor): string | null {
  const frames = editor.Canvas.getFrames();
  if (frames.length === 0) return null;
  const frameId = (f: unknown): string =>
    String(
      (f as { cid?: string; id?: string }).cid ??
        (f as { cid?: string; id?: string }).id ??
        "",
    );

  const selected = (editor as unknown as { getSelected?: () => unknown }).getSelected?.();
  if (selected) {
    // Climb to the top-level component (the frame's wrapper root).
    let node = selected as { parent?: () => unknown } | undefined;
    let root: unknown = node;
    while (node && typeof node.parent === "function") {
      const p = node.parent();
      if (!p) break;
      root = p;
      node = p as typeof node;
    }
    for (const frame of frames) {
      const wrapper = (frame as unknown as { get?: (k: string) => unknown }).get?.("component");
      if (wrapper && wrapper === root) return frameId(frame);
    }
  }
  return frameId(frames[0]);
}

/**
 * Rename an artboard by id. Emits ARTBOARDS_CHANGED on success.
 */
export function renameArtboard(editor: Editor, id: string, name: string): boolean {
  const frames = editor.Canvas.getFrames();
  const frame = (frames as unknown as Array<{
    cid?: string;
    id?: string;
    set?: (a: Record<string, unknown>) => void;
  }>).find((f) => String(f.cid ?? f.id ?? "") === id);
  if (!frame || typeof frame.set !== "function") return false;
  frame.set({ name });
  notifyChange(editor);
  return true;
}

/**
 * Given a component, return the id of the frame whose root wrapper is that
 * component (or whose tree contains it, optionally). Returns null when the
 * component is not a frame wrapper.
 *
 * Used by the SemanticInspector to decide whether to render the Frame
 * type-switcher (with device-preset dropdown) vs a plain type label.
 *
 * `wrapperOnly` mode (default): only returns an id when the component is
 * *exactly* the frame's top-level wrapper, not a nested descendant.
 */
export function getFrameIdForComponent(
  editor: Editor,
  component: unknown,
): string | null {
  if (!component) return null;
  const frames = editor.Canvas.getFrames();
  const frameId = (f: unknown): string =>
    String(
      (f as { cid?: string; id?: string }).cid ??
        (f as { cid?: string; id?: string }).id ??
        "",
    );
  for (const frame of frames) {
    const wrapper = (frame as unknown as { get?: (k: string) => unknown }).get?.("component");
    if (wrapper && wrapper === component) return frameId(frame);
  }
  return null;
}

/** Neutral first-frame default — used by `ensureDefaultArtboard` when the
 * auto-created boot frame has degenerate (0×0 / unpositioned) geometry. We
 * deliberately pick "Frame 1" (not "Desktop") + 1280×800 (not 1440×900) so
 * we don't bias the user toward a specific device class. They can rename + resize
 * in the Measures section or via `create_artboard`. */
const DEFAULT_FIRST_FRAME = {
  name: "Frame 1",
  x: 0,
  y: 0,
  width: 1280,
  height: 800,
} as const;

/**
 * Ensures the canvas has at least one usable frame at first boot.
 *
 * In `infiniteCanvas: true` mode GrapesJS auto-creates one frame at init, but
 * that frame often has degenerate geometry (0×0 or unpositioned), which
 * renders as nothing on the canvas and makes "Fit all" no-op because the
 * bounding box has zero area. This function:
 *   - 0 frames → create one with DEFAULT_FIRST_FRAME
 *   - ≥1 frames and the first has no name + no/degenerate size → replace it
 *   - ≥1 frames with a named first frame → trust it (saved-project restore)
 *
 * Idempotent. Safe to call after `loadProjectData`. Only mutates when the
 * first frame is the unopinionated auto-frame.
 *
 * Implementation note: we delete + recreate rather than `frame.set(…)` on
 * the existing auto-frame. Empirically `frame.set({ height })` doesn't
 * reliably apply to GrapesJS's auto-frame (width and name do stick, but
 * height stays at 0), so we route through the verified `addFrame` path
 * that `createArtboard` uses for every other frame-creation call site.
 */
/**
 * Boolean attribute set on the wrapper Component of the frame that is
 * the "Page root" — the implicit canvas container that loose-canvas
 * primitives attach to (ADR-0006 §4). Stored as a Component attribute
 * so it round-trips through `loadProjectData` / `getProjectData`.
 *
 * Only one frame should carry this at a time; `ensurePageRoot` is the
 * single writer. Readers (`getPageRootWrapper` in primitives.ts) prefer
 * the marked frame, falling back to first-frame-in-document-order for
 * legacy projects without the marker.
 */
export const PAGE_ROOT_ATTR = "data-designjs-page-root";

/**
 * Idempotent — closes ADR-0006 Open Question §1 (was: "first frame in
 * document order" was load-bearing but fragile to drag-reorder /
 * deletion / non-deterministic load order).
 *
 * If any frame's wrapper already carries the {@link PAGE_ROOT_ATTR},
 * does nothing. Otherwise stamps the attribute on the first frame so
 * the page-root identity survives reorders, deletions of subsequent
 * frames, and round-trips through saved projects.
 */
export function ensurePageRoot(editor: Editor): void {
  const frames = editor.Canvas.getFrames?.() ?? [];
  if (frames.length === 0) return;
  for (const f of frames) {
    const wrapper = (f as unknown as { get?: (k: string) => unknown }).get?.(
      "component",
    ) as
      | { getAttributes?: () => Record<string, unknown> }
      | undefined;
    const attrs = wrapper?.getAttributes?.() ?? {};
    if (attrs[PAGE_ROOT_ATTR] != null) return;
  }
  const first = frames[0]!;
  const wrapper = (first as unknown as { get?: (k: string) => unknown }).get?.(
    "component",
  ) as
    | { addAttributes?: (a: Record<string, string>) => void }
    | undefined;
  wrapper?.addAttributes?.({ [PAGE_ROOT_ATTR]: "" });
}

export function ensureDefaultArtboard(editor: Editor): void {
  const frames = editor.Canvas.getFrames();
  if (frames.length === 0) {
    createArtboard(editor, { ...DEFAULT_FIRST_FRAME });
    return;
  }
  const first = frames[0]!;
  const mutable = first as unknown as { get?: (k: string) => unknown };
  const existingName = mutable.get?.("name");
  const existingWidth = Number(mutable.get?.("width") ?? 0);
  const existingHeight = Number(mutable.get?.("height") ?? 0);
  const degenerate = !existingName && (existingWidth < 1 || existingHeight < 1);
  if (!degenerate) return;

  const page = (editor.Pages as unknown as {
    getSelected?: () => { getFrames?: () => { remove?: (x: unknown) => void } } | undefined;
  }).getSelected?.();
  page?.getFrames?.()?.remove?.(first);
  createArtboard(editor, { ...DEFAULT_FIRST_FRAME });
}

/**
 * Remove every frame on the canvas. Used by App.tsx when no saved project
 * exists on disk — GrapesJS auto-creates one frame at init and the product
 * direction is "fresh canvas starts empty." Walks through the active Page's
 * frames collection (the Canvas module doesn't expose a remove API directly;
 * Page.getFrames() returns a Backbone collection with .remove on it).
 */
export function clearAllFrames(editor: Editor): void {
  const page = (editor.Pages as unknown as {
    getSelected?: () => { getFrames?: () => { remove?: (x: unknown) => void } } | undefined;
  }).getSelected?.();
  const collection = page?.getFrames?.();
  const frames = editor.Canvas.getFrames();
  if (frames.length === 0 || !collection?.remove) return;
  // Iterate a snapshot — Backbone collections mutate under you otherwise.
  const snapshot = [...frames];
  for (const frame of snapshot) collection.remove(frame);
  notifyChange(editor);
}

/**
 * Heal any frames whose persisted state is missing `width` / `height` /
 * `x` / `y`.
 *
 * Background: a previous bug (since fixed) saved captured artboards to
 * `.designjs.json` without their dimensions. On reload, GrapesJS's Frame
 * constructor sees a falsy `width`/`height` and flips on the internal
 * `__aw` / `__ah` "auto-size" flags (grapesjs@0.22.16 source, search
 * `__aw`). In auto-size mode, the iframe sizes to `view.el.offsetWidth`
 * — i.e. it stretches to fill whatever canvas viewport is available.
 * Side effect: dragging *any other* artboard causes a layout shift in
 * `.gjs-frames`, the captured iframe re-stretches to the new available
 * width, and the user perceives a "narrowing" of the artboard.
 *
 * This heal step measures the iframe's current `offsetWidth` /
 * `scrollHeight` and writes them back to the frame model + the wrapper
 * component CSS (via {@link applyFrameDimensions}). Idempotent — frames
 * with valid dims are left alone. Must run *after* `loadProjectData`
 * AND after iframes have mounted (give it a setTimeout in the caller).
 */
export function healFrameDimensions(editor: Editor): number {
  const frames = editor.Canvas.getFrames();
  let healed = 0;
  for (const f of frames) {
    const m = f as unknown as {
      get?: (k: string) => unknown;
      set?: (a: Record<string, unknown>) => void;
      view?: { frame?: { el?: HTMLIFrameElement }; el?: HTMLIFrameElement };
    };
    const currentW = m.get?.("width");
    const currentH = m.get?.("height");
    const needsW = !currentW || currentW === "" || Number(currentW) === 0;
    const needsH = !currentH || currentH === "" || Number(currentH) === 0;
    if (!needsW && !needsH) continue;
    const iframeEl = m.view?.frame?.el ?? m.view?.el;
    const doc = iframeEl?.contentDocument;
    if (!iframeEl) continue;
    const measuredW = needsW ? iframeEl.offsetWidth || 1440 : Number(currentW);
    // For height, prefer body.scrollHeight (captured content's full extent)
    // over offsetHeight (which is clipped to viewport when __ah is on).
    const measuredH = needsH
      ? doc?.body?.scrollHeight || iframeEl.offsetHeight || 900
      : Number(currentH);
    const next: Record<string, unknown> = {};
    if (needsW) next.width = measuredW;
    if (needsH) next.height = measuredH;
    m.set?.(next);
    applyFrameDimensions(f as Frame);
    healed += 1;
  }
  if (healed > 0) notifyChange(editor);
  return healed;
}
