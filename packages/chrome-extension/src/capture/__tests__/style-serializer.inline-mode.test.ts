import { describe, it, expect, beforeEach } from "vitest";
import { serialize } from "../style-serializer";

/**
 * Experiment C: mode: "inline" writes computed styles directly to
 * each element's `style=""` attribute instead of hoisting them as
 * generated `._djN` classes in a `<style data-designjs-capture>`
 * block. Tests bypassing GrapesJS' parser strip + CSS-Manager re-ID.
 */
describe("serialize — mode: 'inline'", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("writes computed styles to style='' instead of a class+rule", () => {
    // jsdom reliably reports inline-set color via getComputedStyle (the
    // existing root-inheritance test relies on this same fact).
    document.body.innerHTML = `<div id="root" style="color: rgb(255, 0, 0)">x</div>`;
    const result = serialize(document.getElementById("root")!, { mode: "inline" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    // No hoisted <style data-designjs-capture> block in inline mode.
    expect(result.html).not.toContain("data-designjs-capture");
    // No auto-generated `_dj` class in inline mode.
    expect(result.html).not.toMatch(/class="_dj/);
    // Color landed as an inline style="" declaration.
    expect(result.html).toMatch(/style="[^"]*color:rgb\(255, 0, 0\)/);
  });

  it("captured root still carries inherited properties (root fix applies in inline mode too)", () => {
    document.body.innerHTML = `<div id="root" style="color: rgb(0, 128, 255)">x</div>`;
    const result = serialize(document.getElementById("root")!, { mode: "inline" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.html).toContain("color:rgb(0, 128, 255)");
  });

  it("skips the wrapper-flattening pass in inline mode (no styleToClass to read)", () => {
    // A pass-through wrapper that would normally be flattened in
    // computed mode. In inline mode flattening doesn't run, so the
    // wrapper survives.
    document.body.innerHTML = `<div id="root"><div><span>x</span></div></div>`;
    const result = serialize(document.getElementById("root")!, { mode: "inline" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    // The inner div should still be present — count opening div tags.
    // (root) + (inner div) = 2.
    const divOpens = (result.html.match(/<div\b/g) ?? []).length;
    expect(divOpens).toBeGreaterThanOrEqual(2);
  });

  it("computed mode (default) still hoists classes", () => {
    document.body.innerHTML = `<div id="root"><span>x</span></div>`;
    const result = serialize(document.getElementById("root")!, { mode: "computed" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.html).toContain("data-designjs-capture");
    expect(result.html).toMatch(/class="[^"]*_dj/);
  });

  it("rejects unknown mode values", () => {
    document.body.innerHTML = `<div id="root">x</div>`;
    expect(() =>
      // @ts-expect-error — intentional invalid mode
      serialize(document.getElementById("root")!, { mode: "author" }),
    ).toThrow(/ADR-0012 §4/);
  });
});
