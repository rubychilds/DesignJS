import { describe, it, expect, beforeEach } from "vitest";
import { canonicalizeStyleBlock, serialize } from "../style-serializer";

/**
 * Style-dedup hoist — folds repeated computed-style blocks emitted by
 * mode:"inline" into a `<style data-designjs-dedup>` block with shared
 * `_djhN` classes. Caps total hoist count to keep the GrapesJS CSS
 * Manager surface bounded (the scale fight that Experiment C bypassed
 * to win the v0.3.5 fidelity baseline; restoring full class-hoist
 * regressed that — capped hoist preserves most of the win).
 *
 * Tests use `dedupThreshold` / `dedupMinSavings` lower than production
 * defaults so promotions trigger on small fixture DOMs.
 */
describe("serialize — style dedup", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  function makeChildren(parent: HTMLElement, count: number, style: string): void {
    for (let i = 0; i < count; i++) {
      const el = document.createElement("div");
      el.setAttribute("style", style);
      el.textContent = "x";
      parent.appendChild(el);
    }
  }

  it("promotes a style block after threshold occurrences into a single _djh class", () => {
    const root = document.createElement("div");
    makeChildren(root, 5, "color: rgb(255, 0, 0); width: 100px");
    document.body.appendChild(root);

    const result = serialize(root, {
      mode: "inline",
      dedup: true,
      dedupThreshold: 3,
      dedupMinSavings: 10,
    });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);

    // The hoist <style> block carries the data-designjs-dedup marker.
    expect(result.html).toContain('data-designjs-dedup="">');
    // Exactly one _djh class assigned for one repeated block.
    expect(result.html).toMatch(/\._djh0\{/);
    expect(result.html).not.toMatch(/\._djh1\{/);
    // All five children switched to class form — count occurrences.
    const classRefs = (result.html.match(/class="_djh0"/g) ?? []).length;
    expect(classRefs).toBe(5);
  });

  it("leaves styles inline when below threshold (4 < threshold 5)", () => {
    const root = document.createElement("div");
    makeChildren(root, 4, "color: rgb(0, 128, 255)");
    document.body.appendChild(root);

    const result = serialize(root, {
      mode: "inline",
      dedup: true,
      dedupThreshold: 5,
      dedupMinSavings: 10,
    });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);

    expect(result.html).not.toContain("data-designjs-dedup");
    expect(result.html).not.toMatch(/_djh/);
    // Four style="" attrs survive.
    const styleAttrs = (result.html.match(/style="[^"]*color:rgb\(0, 128, 255\)/g) ?? []).length;
    expect(styleAttrs).toBe(4);
  });

  it("respects dedupMinSavings — skips promotion when savings estimate is too small", () => {
    const root = document.createElement("div");
    // Short style block + low threshold should still skip if savings high.
    makeChildren(root, 3, "color: rgb(1, 1, 1)");
    document.body.appendChild(root);

    const result = serialize(root, {
      mode: "inline",
      dedup: true,
      dedupThreshold: 3,
      dedupMinSavings: 100_000, // huge — no promotion will satisfy this
    });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);

    expect(result.html).not.toContain("data-designjs-dedup");
    expect(result.html).not.toMatch(/_djh/);
  });

  it("promotes multiple distinct blocks independently", () => {
    const root = document.createElement("div");
    makeChildren(root, 4, "color: rgb(255, 0, 0); width: 100px");
    makeChildren(root, 4, "color: rgb(0, 255, 0); height: 50px");
    document.body.appendChild(root);

    const result = serialize(root, {
      mode: "inline",
      dedup: true,
      dedupThreshold: 3,
      dedupMinSavings: 10,
    });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);

    // Two distinct hoist classes — _djh0 and _djh1.
    expect(result.html).toMatch(/\._djh0\{/);
    expect(result.html).toMatch(/\._djh1\{/);
    // Eight total class references across the two patterns.
    const refs = (result.html.match(/class="_djh[01]"/g) ?? []).length;
    expect(refs).toBe(8);
  });

  it("honors dedupClassCap (no further promotions past the cap)", () => {
    const root = document.createElement("div");
    // Three distinct repeating patterns; cap at 2.
    makeChildren(root, 3, "color: rgb(255, 0, 0)");
    makeChildren(root, 3, "color: rgb(0, 255, 0)");
    makeChildren(root, 3, "color: rgb(0, 0, 255)");
    document.body.appendChild(root);

    const result = serialize(root, {
      mode: "inline",
      dedup: true,
      dedupThreshold: 3,
      dedupMinSavings: 10,
      dedupClassCap: 2,
    });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);

    // Exactly two hoisted classes; third block stays inline.
    expect(result.html).toMatch(/\._djh0\{/);
    expect(result.html).toMatch(/\._djh1\{/);
    expect(result.html).not.toMatch(/\._djh2\{/);
    // The non-hoisted blue block keeps its inline style="" attrs.
    const blueInline = (result.html.match(/style="[^"]*color:rgb\(0, 0, 255\)/g) ?? []).length;
    expect(blueInline).toBe(3);
  });

  it("dedup: false (default) emits identical output to plain inline mode", () => {
    const root = document.createElement("div");
    makeChildren(root, 5, "color: rgb(255, 0, 0)");
    document.body.appendChild(root);

    const noDedup = serialize(root, { mode: "inline" });
    if ("error" in noDedup) throw new Error("unexpected error");
    expect(noDedup.html).not.toContain("data-designjs-dedup");
    expect(noDedup.html).not.toMatch(/_djh/);
  });

  it("dedup is silently ignored in computed mode (no _djh classes, no dedup style block)", () => {
    const root = document.createElement("div");
    makeChildren(root, 5, "color: rgb(255, 0, 0)");
    document.body.appendChild(root);

    const result = serialize(root, { mode: "computed", dedup: true });
    if ("error" in result) throw new Error("unexpected error");
    expect(result.html).not.toContain("data-designjs-dedup");
    expect(result.html).not.toMatch(/_djh/);
    // Computed mode still emits its own data-designjs-capture block.
    expect(result.html).toContain("data-designjs-capture");
  });
});

describe("canonicalizeStyleBlock", () => {
  it("sorts declarations so property order doesn't fragment the hash space", () => {
    const a = canonicalizeStyleBlock("color:red;font-size:14px;width:100px");
    const b = canonicalizeStyleBlock("font-size:14px;width:100px;color:red");
    const c = canonicalizeStyleBlock("width:100px;color:red;font-size:14px");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("trims whitespace around declarations", () => {
    expect(canonicalizeStyleBlock("color:red; font-size: 14px ")).toBe(
      canonicalizeStyleBlock("font-size: 14px;color:red"),
    );
  });

  it("drops empty entries (trailing semicolons, double semicolons)", () => {
    expect(canonicalizeStyleBlock("color:red;;font-size:14px;")).toBe(
      canonicalizeStyleBlock("color:red;font-size:14px"),
    );
  });
});
