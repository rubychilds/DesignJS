/**
 * Hybrid-backplate full-page screenshot — ADR-0012 §1.
 *
 * The structural-HTML pipeline (style-serializer.ts) gives us editable
 * DOM but loses anything the canvas iframe can't render (Shadow DOM,
 * cross-origin <img>, oddities of font kerning). The backplate is a
 * pixel screenshot of the same page composited underneath the HTML
 * tree at low opacity — when the HTML diverges from the source, the
 * difference is literally visible on the artboard.
 *
 * Algorithm follows simov/screenshot-capture (MIT) — pattern lifted,
 * code rewritten:
 *
 *  1. Hide scrollbars (full page width/height includes them otherwise).
 *  2. Walk the page in `innerHeight`-tall increments, scrolling between
 *     captures.
 *  3. After each scroll, two `requestAnimationFrame` waits let the
 *     browser repaint before we ask the background to call
 *     `chrome.tabs.captureVisibleTab` (which only captures what's
 *     currently painted).
 *  4. The trailing tile shrinks if the page height isn't a multiple of
 *     the viewport height.
 *  5. Composite all tiles onto a canvas sized `totalWidth × totalHeight`
 *     in CSS px, scaled by the device pixel ratio (DPR) since each
 *     captured tile comes back at the device's actual pixel resolution.
 *  6. Return the composite as a base64 PNG data URL.
 *
 * Throttled to ~3 captures/sec because `chrome.tabs.captureVisibleTab`
 * is rate-limited to 2/sec under MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND.
 * Going faster than that returns the cached prior frame without firing
 * a fresh capture — silent corruption.
 */

export interface CaptureTile {
  /** CSS-px y offset where this tile begins. */
  y: number;
  /** CSS-px height of the tile's useful image area. */
  height: number;
  /** Base64 data URL of the captured viewport. */
  image: string;
}

export interface StitchOptions {
  totalWidth: number;
  totalHeight: number;
  /** Device pixel ratio at capture time. */
  dpr: number;
}

/** Throttle between successive captureVisibleTab requests. */
export const CAPTURE_THROTTLE_MS = 350;

/**
 * Compositor dependencies — extracted so tests can swap in stubs for
 * `Image` and `<canvas>` (jsdom ships neither in a usable form). In
 * production these default to real DOM APIs.
 */
export interface CompositorDeps {
  loadImage?: (src: string) => Promise<{ width: number; height: number }>;
  createCanvas?: (width: number, height: number) => CompositeCanvas;
  toDataUrl?: (canvas: CompositeCanvas) => Promise<string>;
}

/**
 * Pure compositor — given a sequence of tiles and the page's full
 * dimensions, returns a base64 PNG data URL. Exported separately so
 * tests can exercise the maths without touching `chrome.tabs.*` or
 * the live DOM.
 */
export async function compositeTiles(
  tiles: readonly CaptureTile[],
  opts: StitchOptions,
  deps: CompositorDeps = {},
): Promise<string> {
  const { totalWidth, totalHeight, dpr } = opts;
  if (totalWidth <= 0 || totalHeight <= 0) {
    throw new Error("compositeTiles: totalWidth/totalHeight must be positive");
  }
  const make = deps.createCanvas ?? defaultCreateCanvas;
  const load = deps.loadImage ?? defaultLoadImage;
  const toUrl = deps.toDataUrl ?? defaultToDataUrl;

  const canvas = make(
    Math.round(totalWidth * dpr),
    Math.round(totalHeight * dpr),
  );
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error("compositeTiles: 2d context unavailable");

  for (const tile of tiles) {
    const img = await load(tile.image);
    const sourceHeightPx = Math.round(tile.height * dpr);
    // Tiles always start at x=0; full-width capture. Source rect uses
    // the actual loaded image dimensions on the X axis (viewport may be
    // narrower than scroll width on overflow:hidden pages, but the API
    // captures the visible viewport at native DPR).
    ctx.drawImage(
      img as CanvasImageSource,
      0,
      0,
      img.width,
      sourceHeightPx,
      0,
      Math.round(tile.y * dpr),
      Math.round(totalWidth * dpr),
      sourceHeightPx,
    );
  }

  return toUrl(canvas);
}

/**
 * Content-script orchestrator: scrolls the page through one viewport-
 * height at a time, requests a capture from the background per tile,
 * composites the result. Returns null on any failure (rate-limit,
 * background reply error, etc.) so the caller can fall back to the
 * structural-only capture.
 */
export async function captureFullPagePixels(
  request: () => Promise<string | null> = requestVisibleTabCapture,
): Promise<string | null> {
  const html = document.documentElement;
  const body = document.body;
  if (!html || !body) return null;

  const totalWidth = Math.max(html.scrollWidth, body.scrollWidth);
  const totalHeight = Math.max(html.scrollHeight, body.scrollHeight);
  const vh = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  if (totalWidth <= 0 || totalHeight <= 0 || vh <= 0) return null;

  const originalScrollY = window.scrollY;
  const prevHtmlOverflow = html.style.overflow;
  const prevBodyOverflow = body.style.overflow;
  html.style.overflow = "hidden";
  body.style.overflow = "hidden";

  const tiles: CaptureTile[] = [];

  try {
    let y = 0;
    let firstTile = true;
    while (y < totalHeight) {
      window.scrollTo(0, y);
      await waitTwoFrames();
      if (!firstTile) {
        await new Promise((r) => setTimeout(r, CAPTURE_THROTTLE_MS));
      }
      firstTile = false;

      const image = await request();
      if (!image) return null;

      const tileHeight = Math.min(vh, totalHeight - y);
      tiles.push({ y, height: tileHeight, image });
      y += vh;
    }
  } finally {
    html.style.overflow = prevHtmlOverflow;
    body.style.overflow = prevBodyOverflow;
    window.scrollTo(0, originalScrollY);
  }

  if (tiles.length === 0) return null;
  return compositeTiles(tiles, { totalWidth, totalHeight, dpr });
}

function requestVisibleTabCapture(): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "capture:visible-tab" },
      (res?: { ok: boolean; dataUrl?: string }) => {
        if (chrome.runtime.lastError || !res?.ok || !res.dataUrl) {
          resolve(null);
          return;
        }
        resolve(res.dataUrl);
      },
    );
  });
}

function waitTwoFrames(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

export type CompositeCanvas = HTMLCanvasElement | OffscreenCanvas;

function defaultCreateCanvas(width: number, height: number): CompositeCanvas {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

function defaultLoadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("loadImage: failed to load tile"));
    img.src = src;
  });
}

async function defaultToDataUrl(canvas: CompositeCanvas): Promise<string> {
  if ("convertToBlob" in canvas) {
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return blobToDataUrl(blob);
  }
  return canvas.toDataURL("image/png");
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
