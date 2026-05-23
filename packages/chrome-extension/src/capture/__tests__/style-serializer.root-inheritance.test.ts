import { describe, it, expect, beforeEach } from "vitest";
import { serialize } from "../style-serializer";

/**
 * Captured root must carry ALL inherited properties (color, font,
 * line-height, letter-spacing, etc.) inline — *not* inherit-diff
 * against the source parent.
 *
 * Bug this guards against:
 *   When the root inherit-diffs against its source parent, properties
 *   the root shares with that parent (typical: dark-themed source
 *   body has `color: white`, source root inherits `color: white`,
 *   inherit-diff finds them equal, emits nothing) are dropped from
 *   the captured root. The captured root is then reparented under
 *   the GrapesJS default <body> (light theme, color: black baseline),
 *   inherits black, and any white-on-dark text in the source becomes
 *   black-on-light invisible against captured backgrounds — the
 *   "all text gone" symptom we hit on rubychilds.com + Python docs.
 *
 * Fix: serialize() passes `null` as parentSrc on the root call,
 * forcing buildInlineStyle to emit every inherited property
 * unconditionally on the captured root. Descendants still
 * inherit-diff against their own captured-tree parents.
 */
describe("serialize — captured root carries inherited properties", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.body.removeAttribute("style");
  });

  it("emits color on the captured root even when source root + parent share the same color", () => {
    // Both <body> and <#root> get the same color. With the old
    // parent-diff behaviour the root's color would be dropped (==
    // body's). With the fix it should be emitted on the root.
    document.body.style.color = "rgb(255, 0, 0)";
    document.body.innerHTML = `<div id="root" style="color:rgb(255, 0, 0)">x</div>`;
    document.body.style.color = "rgb(255, 0, 0)";

    const result = serialize(document.getElementById("root")!, { mode: "computed" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);

    // The hoisted <style data-designjs-capture> block should contain
    // a `color:rgb(255, 0, 0)` declaration that the root references.
    expect(result.html).toContain("color:rgb(255, 0, 0)");
  });

  it("emits font-family on the root even when shared with source parent", () => {
    document.body.style.fontFamily = "monospace";
    document.body.innerHTML = `<div id="root" style="font-family: monospace">x</div>`;
    document.body.style.fontFamily = "monospace";

    const result = serialize(document.getElementById("root")!, { mode: "computed" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.html).toContain("font-family:monospace");
  });

  it("descendants still inherit-diff (does not bloat per-element output)", () => {
    // Set color on the root only; child has the same color via
    // inheritance. Child should NOT emit color (inherit-diff still
    // applies for descendants).
    document.body.innerHTML = `<div id="root" style="color: rgb(0, 128, 0)"><span id="child">y</span></div>`;

    const result = serialize(document.getElementById("root")!, { mode: "computed" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);

    // Root has the color. We expect exactly one standalone `color:`
    // declaration (not border-*-color, which defaults to currentColor
    // and is in NON_INHERITED so always emitted per element).
    const matches = result.html.match(/[;{]color:rgb\(0, 128, 0\)/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
