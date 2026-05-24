import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CAPTURE_THROTTLE_MS,
  captureFullPagePixels,
  compositeTiles,
  type CaptureTile,
  type CompositeCanvas,
} from "../screenshot-stitcher";

/**
 * Compositor maths — ADR-0012 §1 hybrid backplate. Verifies tiles are
 * drawn at the correct DPR-scaled offsets and that the canvas is sized
 * `totalWidth × totalHeight` in CSS px (DPR scaling preserved).
 *
 * Uses the injected `loadImage` / `createCanvas` / `toDataUrl` deps so
 * we don't need a real DOM canvas2d implementation (jsdom doesn't ship
 * one). Production callers pass no deps and get the real DOM ones.
 */
describe("compositeTiles", () => {
  function makeStubs(imageDimensions = { width: 1280, height: 720 }) {
    const drawCalls: unknown[][] = [];
    const recordedSize = { width: 0, height: 0 };

    const ctx = {
      drawImage: (...args: unknown[]) => {
        drawCalls.push(args);
      },
    } as unknown as CanvasRenderingContext2D;

    const fakeCanvas = {
      get width() {
        return recordedSize.width;
      },
      set width(v: number) {
        recordedSize.width = v;
      },
      get height() {
        return recordedSize.height;
      },
      set height(v: number) {
        recordedSize.height = v;
      },
      getContext: () => ctx,
      toDataURL: () => "data:image/png;base64,STUB",
    } as unknown as HTMLCanvasElement;

    return {
      drawCalls,
      size: recordedSize,
      deps: {
        createCanvas: (w: number, h: number): CompositeCanvas => {
          (fakeCanvas as { width: number }).width = w;
          (fakeCanvas as { height: number }).height = h;
          return fakeCanvas;
        },
        loadImage: async (_src: string) => imageDimensions,
        toDataUrl: async (_c: CompositeCanvas) => "data:image/png;base64,STUB",
      },
    };
  }

  it("sizes the canvas to totalWidth × totalHeight scaled by DPR", async () => {
    const stubs = makeStubs();
    const tiles: CaptureTile[] = [
      { y: 0, height: 720, image: "data:image/png;base64,A" },
    ];
    await compositeTiles(
      tiles,
      { totalWidth: 1280, totalHeight: 720, dpr: 2 },
      stubs.deps,
    );
    expect(stubs.size.width).toBe(2560);
    expect(stubs.size.height).toBe(1440);
  });

  it("draws each tile at its DPR-scaled y offset", async () => {
    const stubs = makeStubs();
    const tiles: CaptureTile[] = [
      { y: 0, height: 720, image: "data:image/png;base64,A" },
      { y: 720, height: 720, image: "data:image/png;base64,B" },
      { y: 1440, height: 360, image: "data:image/png;base64,C" }, // trailing partial
    ];
    await compositeTiles(
      tiles,
      { totalWidth: 1280, totalHeight: 1800, dpr: 1 },
      stubs.deps,
    );
    expect(stubs.drawCalls).toHaveLength(3);
    // ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) — index 6 is dy
    expect(stubs.drawCalls[0]![6]).toBe(0);
    expect(stubs.drawCalls[1]![6]).toBe(720);
    expect(stubs.drawCalls[2]![6]).toBe(1440);
  });

  it("applies DPR to both source and destination heights so trailing partial tiles render correctly", async () => {
    const stubs = makeStubs();
    const tiles: CaptureTile[] = [
      { y: 0, height: 480, image: "data:image/png;base64,trailing" },
    ];
    await compositeTiles(
      tiles,
      { totalWidth: 1280, totalHeight: 480, dpr: 2 },
      stubs.deps,
    );
    // drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)
    expect(stubs.drawCalls[0]![4]).toBe(960); // sh — 480 css-px × 2 dpr
    expect(stubs.drawCalls[0]![8]).toBe(960); // dh
  });

  it("throws on zero or negative dimensions", async () => {
    const stubs = makeStubs();
    await expect(
      compositeTiles([], { totalWidth: 0, totalHeight: 100, dpr: 1 }, stubs.deps),
    ).rejects.toThrow(/positive/);
  });

  it("returns the data URL produced by the toDataUrl dep", async () => {
    const stubs = makeStubs();
    const out = await compositeTiles(
      [{ y: 0, height: 100, image: "data:image/png;base64,A" }],
      { totalWidth: 100, totalHeight: 100, dpr: 1 },
      stubs.deps,
    );
    expect(out).toBe("data:image/png;base64,STUB");
  });
});

/**
 * Orchestrator — ADR-0012 §1 hybrid backplate. Exercises the scroll /
 * scrollbar-hide / capture loop in `captureFullPagePixels`. Stubs out
 * page geometry and the per-tile `request()` callback so we can assert
 * orchestration (call args, count, ordering) without rasterizing.
 *
 * jsdom doesn't paint, so we override `innerHeight`, `scrollY`,
 * `documentElement.scrollHeight`, etc. with `Object.defineProperty`.
 * `window.scrollTo` is stubbed to update the mocked `scrollY` so the
 * source's read-back after the loop returns whatever we last scrolled
 * to.
 */
describe("captureFullPagePixels", () => {
  type PageGeometry = {
    innerHeight: number;
    scrollHeight: number;
    scrollWidth: number;
    bodyScrollHeight?: number;
    bodyScrollWidth?: number;
    dpr?: number;
    initialScrollY?: number;
  };

  // Tracks mock scrollY so window.scrollTo() updates can be read back.
  let currentScrollY = 0;
  // Restorers for properties we patched per-test.
  const restorers: Array<() => void> = [];

  function override<T extends object>(
    target: T,
    prop: PropertyKey,
    descriptor: PropertyDescriptor,
  ): void {
    const original = Object.getOwnPropertyDescriptor(target, prop);
    Object.defineProperty(target, prop, { configurable: true, ...descriptor });
    restorers.push(() => {
      if (original) Object.defineProperty(target, prop, original);
      else delete (target as Record<PropertyKey, unknown>)[prop as string];
    });
  }

  function setupPage(g: PageGeometry): void {
    currentScrollY = g.initialScrollY ?? 0;
    override(window, "innerHeight", { value: g.innerHeight, writable: true });
    override(window, "devicePixelRatio", { value: g.dpr ?? 1, writable: true });
    override(window, "scrollY", { get: () => currentScrollY });
    override(window, "scrollTo", {
      value: (_x: number, y: number) => {
        currentScrollY = y;
      },
      writable: true,
    });
    override(document.documentElement, "scrollHeight", {
      get: () => g.scrollHeight,
    });
    override(document.documentElement, "scrollWidth", {
      get: () => g.scrollWidth,
    });
    override(document.body, "scrollHeight", {
      get: () => g.bodyScrollHeight ?? g.scrollHeight,
    });
    override(document.body, "scrollWidth", {
      get: () => g.bodyScrollWidth ?? g.scrollWidth,
    });
  }

  beforeEach(() => {
    // Make rAF synchronous so we don't wait on real frames; the loop
    // awaits two nested rAFs per tile and we want the test to be fast.
    override(window, "requestAnimationFrame", {
      value: (cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      },
      writable: true,
    });
    // Reset documentElement/body overflow before each case.
    document.documentElement.style.overflow = "";
    document.body.style.overflow = "";
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    while (restorers.length) restorers.pop()!();
  });

  type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

  /**
   * Wrap `captureFullPagePixels` so the returned promise is *already*
   * being observed when we hand it back — vitest's unhandled-rejection
   * detector fires the moment a rejecting promise has no `.then`/
   * `.catch` attached in the same microtask, which would otherwise
   * spam the run with the "compositor 2d context unavailable" error
   * (jsdom has no canvas 2d backend, and we deliberately don't stub
   * the inner compositeTiles call — the orchestration side effects
   * are what we test here).
   */
  function start<T>(
    fn: () => Promise<T>,
  ): { outcome: Promise<Outcome<T>> } {
    const promise = fn();
    const outcome = promise.then<Outcome<T>, Outcome<T>>(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    );
    return { outcome };
  }

  /**
   * Drive both the microtask queue (awaits) and the macrotask queue
   * (setTimeout for CAPTURE_THROTTLE_MS) until the tracked outcome
   * resolves. Returns the settled outcome — never rethrows.
   */
  async function flush<T>(
    handle: { outcome: Promise<Outcome<T>> },
  ): Promise<Outcome<T>> {
    let settled: Outcome<T> | undefined;
    const tracker = handle.outcome.then((o) => {
      settled = o;
    });
    for (let i = 0; i < 50 && !settled; i++) {
      await vi.advanceTimersByTimeAsync(CAPTURE_THROTTLE_MS + 10);
    }
    await tracker;
    return settled!;
  }

  function makeCompositorStubs() {
    // Replaces real canvas / Image with no-ops so compositeTiles can
    // run under jsdom.
    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => {} }),
      toDataURL: () => "data:image/png;base64,COMPOSITE",
    } as unknown as HTMLCanvasElement;
    return {
      createCanvas: (_w: number, _h: number): CompositeCanvas => fakeCanvas,
      loadImage: async (_src: string) => ({ width: 100, height: 100 }),
      toDataUrl: async (_c: CompositeCanvas) => "data:image/png;base64,COMPOSITE",
    };
  }

  /**
   * Wrap `captureFullPagePixels` so we can stub the compositor too —
   * the source currently doesn't accept compositor deps on the outer
   * call, but we can monkey-patch by capturing tiles via the
   * `request` callback and reconstructing a composite externally.
   * For these tests we don't care about the returned URL; we only
   * assert on side effects. Where we DO assert on the result, we use
   * `it.skip` (jsdom canvas 2d unavailable).
   */

  it("restores scrollY after a successful capture", async () => {
    setupPage({
      innerHeight: 800,
      scrollHeight: 800, // single viewport — one slice
      scrollWidth: 1280,
      initialScrollY: 250,
    });
    const request = vi.fn(async () => "data:image/png;base64,TILE");
    const handle = start(() => captureFullPagePixels(request));
    await flush(handle); // compositor may fail under jsdom; we only care about scroll.
    expect(window.scrollY).toBe(250);
  });

  it("restores scrollY AND overflow if the capture callback throws", async () => {
    setupPage({
      innerHeight: 800,
      scrollHeight: 2400,
      scrollWidth: 1280,
      initialScrollY: 123,
    });
    document.documentElement.style.overflow = "scroll";
    document.body.style.overflow = "auto";

    const boom = new Error("capture failed mid-stitch");
    const request = vi.fn(async () => {
      throw boom;
    });

    const handle = start(() => captureFullPagePixels(request));
    const outcome = await flush(handle);
    expect(outcome.ok).toBe(false);
    expect((outcome as { ok: false; error: Error }).error.message).toBe(
      "capture failed mid-stitch",
    );

    expect(window.scrollY).toBe(123);
    expect(document.documentElement.style.overflow).toBe("scroll");
    expect(document.body.style.overflow).toBe("auto");
  });

  it("hides scrollbars during capture and restores prior overflow values after", async () => {
    setupPage({
      innerHeight: 800,
      scrollHeight: 800,
      scrollWidth: 1280,
    });
    document.documentElement.style.overflow = "visible";
    document.body.style.overflow = ""; // empty — should round-trip to empty
    const seenOverflow: Array<{ html: string; body: string }> = [];

    const request = vi.fn(async () => {
      seenOverflow.push({
        html: document.documentElement.style.overflow,
        body: document.body.style.overflow,
      });
      return "data:image/png;base64,TILE";
    });

    const handle = start(() => captureFullPagePixels(request));
    await flush(handle);

    // During the capture both should have been "hidden".
    expect(seenOverflow).toHaveLength(1);
    expect(seenOverflow[0]).toEqual({ html: "hidden", body: "hidden" });

    // After the capture prior values are restored.
    expect(document.documentElement.style.overflow).toBe("visible");
    expect(document.body.style.overflow).toBe("");
  });

  it("produces exactly one slice when page height ≤ innerHeight", async () => {
    setupPage({
      innerHeight: 800,
      scrollHeight: 600, // short page
      scrollWidth: 1280,
    });
    const request = vi.fn(async () => "data:image/png;base64,TILE");
    const handle = start(() => captureFullPagePixels(request));
    await flush(handle);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("produces N slices for page height = N × innerHeight at the expected scroll positions", async () => {
    setupPage({
      innerHeight: 800,
      scrollHeight: 2400, // 3 viewports
      scrollWidth: 1280,
    });
    const observedScrollYs: number[] = [];
    const request = vi.fn(async () => {
      observedScrollYs.push(window.scrollY);
      return "data:image/png;base64,TILE";
    });

    const handle = start(() => captureFullPagePixels(request));
    await flush(handle);

    expect(request).toHaveBeenCalledTimes(3);
    expect(observedScrollYs).toEqual([0, 800, 1600]);
  });

  it("aborts and returns null if request() returns null mid-stitch (rate-limit)", async () => {
    setupPage({
      innerHeight: 800,
      scrollHeight: 2400,
      scrollWidth: 1280,
      initialScrollY: 42,
    });
    let call = 0;
    const request = vi.fn(async () => {
      call += 1;
      return call === 1 ? "data:image/png;base64,A" : null;
    });

    const handle = start(() => captureFullPagePixels(request));
    const outcome = await flush(handle);

    expect(outcome).toEqual({ ok: true, value: null });
    // Still restores scroll position via try/finally.
    expect(window.scrollY).toBe(42);
  });

  it("returns null if document geometry is non-positive", async () => {
    setupPage({
      innerHeight: 800,
      scrollHeight: 0, // pathological
      scrollWidth: 0,
    });
    const request = vi.fn(async () => "data:image/png;base64,TILE");
    const result = await captureFullPagePixels(request);
    expect(result).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("uses Math.max(html, body) for total dimensions so a tall body still drives the loop", async () => {
    setupPage({
      innerHeight: 500,
      scrollHeight: 400, // html shorter than body
      scrollWidth: 1280,
      bodyScrollHeight: 1500, // body drives the height
      bodyScrollWidth: 1280,
    });
    const request = vi.fn(async () => "data:image/png;base64,TILE");
    const handle = start(() => captureFullPagePixels(request));
    await flush(handle);
    // ceil(1500 / 500) = 3 tiles
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("scrolls before each capture so lazy-rendered viewport content is in frame when request() is invoked", async () => {
    /**
     * Captures the relationship the orchestrator promises: scrollY is
     * already at the slice's `y` by the time `request()` fires. This is
     * the load-bearing invariant for lazy-rendered tiles — if request
     * fires before the scroll lands, the captured pixels are stale.
     *
     * (The pre-serialize `scrollToBottomAndSettle` from commit 59491e6
     * lives in `content/index.tsx`, not in this module — it isn't
     * exported, so we exercise the in-loop scroll guarantee here.)
     */
    setupPage({
      innerHeight: 400,
      scrollHeight: 1200, // 3 tiles at 0, 400, 800
      scrollWidth: 1280,
    });
    const order: Array<{ scrollY: number }> = [];
    const request = vi.fn(async () => {
      order.push({ scrollY: window.scrollY });
      return "data:image/png;base64,TILE";
    });

    const handle = start(() => captureFullPagePixels(request));
    await flush(handle);

    expect(order).toEqual([
      { scrollY: 0 },
      { scrollY: 400 },
      { scrollY: 800 },
    ]);
  });

  it("throttles between tiles — no second request() before CAPTURE_THROTTLE_MS elapses", async () => {
    setupPage({
      innerHeight: 800,
      scrollHeight: 1600, // 2 tiles
      scrollWidth: 1280,
    });
    const request = vi.fn(async () => "data:image/png;base64,TILE");

    const handle = start(() => captureFullPagePixels(request));

    // First tile fires inside microtask cascade after rAFs.
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);

    // Just before the throttle window expires, still one call.
    await vi.advanceTimersByTimeAsync(CAPTURE_THROTTLE_MS - 10);
    expect(request).toHaveBeenCalledTimes(1);

    // After the throttle window the second tile fires.
    await vi.advanceTimersByTimeAsync(20);
    expect(request).toHaveBeenCalledTimes(2);

    await flush(handle);
  });

  it.skip("returns a composite data URL on the happy path (skipped: jsdom canvas 2d unavailable)", () => {
    // Would assert that captureFullPagePixels resolves to the
    // base64 PNG produced by compositeTiles. Needs a real canvas
    // backend or a deps-injection seam at the outer call site.
  });
});
