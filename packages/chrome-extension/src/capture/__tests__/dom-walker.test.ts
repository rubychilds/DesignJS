import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createWalker, type Walker } from "../dom-walker";

/**
 * DOM walker — Story 8.1 keyboard + mouse selection UI.
 *
 * jsdom quirks worth knowing:
 *  - KeyboardEvents dispatched manually have `isTrusted=false`; the walker
 *    bails on untrusted events, so each test forces it to true.
 *  - requestAnimationFrame is stubbed to run synchronously so we can
 *    assert highlight state without waiting on the browser frame loop.
 *  - getBoundingClientRect returns zeroes in jsdom; we stub it where
 *    label content depends on the rect.
 */
describe("createWalker", () => {
  let walker: Walker;
  let onCommit: ReturnType<typeof vi.fn>;
  let onExit: ReturnType<typeof vi.fn>;

  /**
   * jsdom installs `isTrusted` as an unforgeable own getter that proxies to
   * an internal impl object stored at `Symbol(impl)`. `dispatchEvent` then
   * resets `impl.isTrusted = false` unconditionally before invoking
   * listeners. We can't override the getter (non-configurable, no
   * prototype hook), so we instead register a capture-phase listener
   * BEFORE the walker's that re-flips the impl flag to true. Because the
   * walker registers its keydown listener inside `start()` (after our
   * beforeEach hook), DOM listener ordering guarantees ours fires first.
   */
  const flipTrusted = (ev: Event) => {
    const implSym = Object.getOwnPropertySymbols(ev).find(
      (s) => s.toString() === "Symbol(impl)",
    );
    if (implSym) {
      // noUncheckedIndexedAccess makes Record[symbol] T|undefined; we just
      // verified implSym is a present own-symbol, so a non-null assertion
      // is correct here.
      (ev as unknown as Record<symbol, { isTrusted: boolean }>)[implSym]!.isTrusted = true;
    }
  };

  /** Dispatch a keydown that the walker will accept. */
  const pressKey = (key: string) => {
    const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
  };

  /** Dispatch a mouseover at `target`. The walker's mouseover handler does
   *  not gate on isTrusted (only onKeyDown does), so only target matters. */
  const hover = (target: EventTarget) => {
    const ev = new MouseEvent("mouseover", { bubbles: true });
    Object.defineProperty(ev, "target", { value: target, configurable: true });
    document.dispatchEvent(ev);
  };

  // rAF stub: defers via a microtask queue we can drain synchronously.
  // We can't run the callback inline because the source captures the
  // returned handle into `rafHandle` AFTER the call returns; an inline
  // callback would leave `rafHandle` set, blocking the next schedule.
  let rafQueue: FrameRequestCallback[] = [];
  const flushRaf = () => {
    while (rafQueue.length) {
      const cb = rafQueue.shift()!;
      cb(0);
    }
  };

  beforeEach(() => {
    document.body.innerHTML = "";
    rafQueue = [];
    let handle = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return ++handle;
    });
    vi.stubGlobal("cancelAnimationFrame", (h: number) => {
      // queued-callback removal is unnecessary for our assertions
      void h;
    });

    onCommit = vi.fn();
    onExit = vi.fn();
    // Register the isTrusted trampoline BEFORE creating the walker so it
    // fires before the walker's capture-phase keydown listener.
    document.addEventListener("keydown", flipTrusted, true);
    walker = createWalker({ onCommit, onExit });
  });

  afterEach(() => {
    walker.stop();
    document.removeEventListener("keydown", flipTrusted, true);
    vi.unstubAllGlobals();
  });

  it("ArrowUp moves focus to parentElement; no-op at root (body has no element parent above <html>)", () => {
    document.body.innerHTML = `<section id="outer"><div id="inner"></div></section>`;
    const inner = document.getElementById("inner")!;
    walker.start();
    hover(inner); // seed focus on a known node
    expect(walker.focus).toBe(inner);

    pressKey("ArrowUp");
    expect(walker.focus).toBe(document.getElementById("outer"));

    pressKey("ArrowUp"); // outer -> body
    expect(walker.focus).toBe(document.body);

    // body.parentElement === <html>, which isValidTarget rejects; focus stays.
    pressKey("ArrowUp");
    expect(walker.focus).toBe(document.body);
  });

  it("ArrowDown descends to firstElementChild; no-op on a leaf", () => {
    document.body.innerHTML = `<section id="outer"><div id="a"></div><div id="b"></div></section>`;
    walker.start();
    const outer = document.getElementById("outer")!;
    hover(outer);

    pressKey("ArrowDown");
    expect(walker.focus).toBe(document.getElementById("a"));

    // leaf: a has no element children -> focus unchanged
    pressKey("ArrowDown");
    expect(walker.focus).toBe(document.getElementById("a"));
  });

  it("ArrowLeft / ArrowRight walk siblings; no-op at first / last", () => {
    document.body.innerHTML = `<div id="p"><i id="a"></i><i id="b"></i><i id="c"></i></div>`;
    walker.start();
    const a = document.getElementById("a")!;
    hover(a);

    pressKey("ArrowLeft"); // already first
    expect(walker.focus).toBe(a);

    pressKey("ArrowRight");
    expect(walker.focus).toBe(document.getElementById("b"));

    pressKey("ArrowRight");
    expect(walker.focus).toBe(document.getElementById("c"));

    pressKey("ArrowRight"); // already last
    expect(walker.focus).toBe(document.getElementById("c"));

    pressKey("ArrowLeft");
    expect(walker.focus).toBe(document.getElementById("b"));
  });

  it("skips the DesignJS overlay subtree on mouse hover (covers the overlay-filtering fix)", () => {
    // Real page content + the extension's own overlay root, which must
    // never become a focus target via hover.
    document.body.innerHTML = `
      <main id="page"><p id="para">hi</p></main>
      <div id="designjs-capture-root"><div id="overlay-child"></div></div>`;
    walker.start();

    const para = document.getElementById("para")!;
    hover(para);
    expect(walker.focus).toBe(para);

    // Hovering the overlay or any descendant must be a no-op.
    hover(document.getElementById("overlay-child")!);
    expect(walker.focus).toBe(para);

    hover(document.getElementById("designjs-capture-root")!);
    expect(walker.focus).toBe(para);
  });

  it("Enter commits the focused element and stops the walker", () => {
    document.body.innerHTML = `<article id="target">x</article>`;
    walker.start();
    const target = document.getElementById("target")!;
    hover(target);

    pressKey("Enter");

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(target);
    expect(onExit).not.toHaveBeenCalled();
    // stop() nulls out focus
    expect(walker.focus).toBeNull();
  });

  it("Escape fires onExit and does not commit", () => {
    document.body.innerHTML = `<div id="x"></div>`;
    walker.start();
    hover(document.getElementById("x")!);

    pressKey("Escape");

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
    expect(walker.focus).toBeNull();
  });

  it("mouse hover only updates focus for element targets (not the overlay itself)", () => {
    // We can't easily dispatch a real mouseover with a Text node target —
    // jsdom event flow short-circuits non-Element targets at the listener
    // boundary. So we focus on the overlay-target branch of isValidTarget,
    // which is the meaningful guard the source ships today.
    document.body.innerHTML = `<p id="real">hi</p><div id="designjs-capture-root"></div>`;
    walker.start();
    const real = document.getElementById("real")!;
    hover(real);
    expect(walker.focus).toBe(real);

    // Overlay-targeted hover is filtered.
    hover(document.getElementById("designjs-capture-root")!);
    expect(walker.focus).toBe(real);
  });

  it("renders a highlight box + label with the focused element's tag and rounded dimensions", () => {
    document.body.innerHTML = `<section id="t"></section>`;
    const t = document.getElementById("t")!;
    Object.defineProperty(t, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        top: 50, left: 30, width: 123.4, height: 67.6,
        bottom: 117.6, right: 153.4, x: 30, y: 50,
        toJSON() {},
      }),
    });
    walker.start();
    hover(t);
    flushRaf(); // paint() reads getBoundingClientRect on the focused el

    const box = document.getElementById("designjs-capture-highlight") as HTMLDivElement;
    const label = document.getElementById("designjs-capture-highlight-label") as HTMLDivElement;
    expect(box).not.toBeNull();
    expect(label).not.toBeNull();
    expect(box.style.top).toBe("50px");
    expect(box.style.left).toBe("30px");
    expect(box.style.width).toBe("123.4px");
    expect(box.style.height).toBe("67.6px");
    // tag + rounded width × height
    expect(label.textContent).toBe("section  123×68");
  });

  it("stop() removes the highlight DOM and unbinds listeners (post-stop events are ignored)", () => {
    document.body.innerHTML = `<div id="a"></div><div id="b"></div>`;
    walker.start();
    const a = document.getElementById("a")!;
    const b = document.getElementById("b")!;
    hover(a);
    flushRaf();
    expect(document.getElementById("designjs-capture-highlight")).not.toBeNull();

    walker.stop();

    // Highlight overlay torn down.
    expect(document.getElementById("designjs-capture-highlight")).toBeNull();
    expect(document.getElementById("designjs-capture-highlight-label")).toBeNull();

    // Post-stop events must not produce callbacks or move focus.
    hover(b);
    pressKey("Enter");
    pressKey("Escape");
    expect(onCommit).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
    expect(walker.focus).toBeNull();
  });
});
