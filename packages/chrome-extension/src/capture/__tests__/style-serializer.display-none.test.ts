import { describe, it, expect, beforeEach } from "vitest";
import { serialize } from "../style-serializer";

/**
 * `display: none` must be preserved on capture — it's semantic, not
 * a browser default. The general skip-"none" rule in buildInlineStyle
 * was designed for properties like `border-style: none` where "none"
 * === browser default and skipping is safe; it shouldn't catch
 * display.
 *
 * Real-world trigger: Sphinx documentation generates `<h3>Navigation</h3>`
 * elements with `display: none` for screen-reader accessibility. Without
 * this fix, those headings render as visible "Navigation" text in the
 * captured artboard.
 */
describe("serialize — preserves display:none", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("emits display:none on a hidden element (computed mode)", () => {
    document.body.innerHTML = `<div id="root"><h3 style="display: none">Navigation</h3></div>`;
    const result = serialize(document.getElementById("root")!, { mode: "computed" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    // The hoisted style block should include a display:none rule
    // for the h3's class.
    expect(result.html).toMatch(/display:\s*none/);
  });

  it("emits display:none on a hidden element (inline mode)", () => {
    document.body.innerHTML = `<div id="root"><h3 style="display: none">Navigation</h3></div>`;
    const result = serialize(document.getElementById("root")!, { mode: "inline" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.html).toMatch(/<h3[^>]*style="[^"]*display:\s*none/);
  });

  it("still skips border-style:none (regression guard for the original skip rule)", () => {
    // border-style:none IS the browser default and should still be
    // skipped — that was the original intent of the skip-none rule.
    document.body.innerHTML = `<div id="root" style="border-top-style: none">x</div>`;
    const result = serialize(document.getElementById("root")!, { mode: "computed" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.html).not.toMatch(/border-top-style:\s*none/);
  });
});
