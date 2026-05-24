import { describe, it, expect, beforeEach } from "vitest";
import { serialize } from "../style-serializer";

/**
 * A.1 — same-origin iframe walker.
 *
 * Closes the same-origin half of the iframe gap from ADR-0011 Open Q
 * §1 + ADR-0012 §2 — cross-origin iframes still need CDP and stay out
 * of reach here. The walker re-emits the inlined content as `srcdoc`
 * on the cloned iframe so the canvas can render it without re-fetching.
 */
describe("style-serializer — same-origin iframe walker", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("inlines a same-origin iframe's body as srcdoc on the clone", () => {
    document.body.innerHTML = `<div id="root"><iframe id="f"></iframe></div>`;
    const iframe = document.getElementById("f") as HTMLIFrameElement;
    // jsdom exposes an empty same-origin document on a srcless iframe;
    // we populate it directly to simulate post-load content.
    const doc = iframe.contentDocument!;
    doc.body.innerHTML = `<p class="inner">embedded content</p>`;

    const result = serialize(document.getElementById("root")!, { mode: "computed" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);

    const parsed = new DOMParser().parseFromString(result.html, "text/html");
    const out = parsed.querySelector("iframe") as HTMLIFrameElement;
    expect(out).toBeTruthy();
    const srcdoc = out.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain("embedded content");
    expect(srcdoc).toContain('class="inner');
    expect(out.hasAttribute("data-designjs-inlined-iframe")).toBe(true);
    const recordedBytes = Number(out.getAttribute("data-designjs-inlined-iframe"));
    expect(recordedBytes).toBeGreaterThan(0);
  });

  it("skips iframes whose body is empty", () => {
    document.body.innerHTML = `<div id="root"><iframe id="f"></iframe></div>`;
    // Don't populate contentDocument — it stays empty.

    const result = serialize(document.getElementById("root")!, { mode: "computed" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);

    const parsed = new DOMParser().parseFromString(result.html, "text/html");
    const out = parsed.querySelector("iframe") as HTMLIFrameElement;
    expect(out.hasAttribute("srcdoc")).toBe(false);
    expect(out.hasAttribute("data-designjs-inlined-iframe")).toBe(false);
  });

  it("does not throw when contentDocument access throws (cross-origin sim)", () => {
    document.body.innerHTML = `<div id="root"><iframe id="f"></iframe></div>`;
    const iframe = document.getElementById("f") as HTMLIFrameElement;
    // Simulate the SecurityError that real browsers throw on cross-
    // origin contentDocument access. jsdom can't actually load a
    // cross-origin frame, so we stub the accessor.
    Object.defineProperty(iframe, "contentDocument", {
      get() {
        throw new DOMException("Blocked a frame from accessing", "SecurityError");
      },
      configurable: true,
    });

    const result = serialize(document.getElementById("root")!, { mode: "computed" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);

    const parsed = new DOMParser().parseFromString(result.html, "text/html");
    const out = parsed.querySelector("iframe") as HTMLIFrameElement;
    // Iframe survives; srcdoc not set — cross-origin gap stays open
    // until ADR-0012 §2 lands.
    expect(out).toBeTruthy();
    expect(out.hasAttribute("srcdoc")).toBe(false);
  });

  it("skips inlining when remaining size budget is below the headroom floor", () => {
    document.body.innerHTML = `<div id="root"><iframe id="f"></iframe></div>`;
    const iframe = document.getElementById("f") as HTMLIFrameElement;
    iframe.contentDocument!.body.innerHTML = `<p>some content</p>`;

    // Cap so tight that there's <4KB headroom by the time we hit the
    // iframe. The iframe stays — we don't abort the whole capture for
    // a tracking-pixel iframe with no meaningful payload.
    const result = serialize(document.getElementById("root")!, {
      mode: "computed",
      hardLimit: 3 * 1024,
    });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);

    const parsed = new DOMParser().parseFromString(result.html, "text/html");
    const out = parsed.querySelector("iframe") as HTMLIFrameElement;
    expect(out.hasAttribute("srcdoc")).toBe(false);
  });
});
