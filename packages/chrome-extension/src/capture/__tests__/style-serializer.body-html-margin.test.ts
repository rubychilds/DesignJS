import { describe, it, expect, beforeEach } from "vitest";
import { serialize } from "../style-serializer";

/**
 * User-agent default margin/padding on <body> (and <html>) should be
 * stripped on capture, not faithfully preserved. Source pages don't
 * intend the 8px body margin — it's a browser default — but if we
 * inline it, the captured root sits offset from the artboard's
 * top-left corner by 7-18px ("first div not at 0,0" symptom).
 */
describe("serialize — strip body/html margin & padding", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("strips margin from a captured <body>", () => {
    // Force body to have an explicit margin (jsdom reliably reports inline)
    document.body.style.marginTop = "8px";
    document.body.style.marginLeft = "8px";
    document.body.style.paddingTop = "4px";
    const result = serialize(document.body, { mode: "computed" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    // The hoisted style block (computed mode) shouldn't include margin
    // or padding declarations on the body's class.
    expect(result.html).not.toMatch(/margin-top:\s*8px/);
    expect(result.html).not.toMatch(/margin-left:\s*8px/);
    expect(result.html).not.toMatch(/padding-top:\s*4px/);
  });

  it("strips margin/padding from a captured <html> (Experiment A path)", () => {
    // jsdom's documentElement is HTML — set inline margin/padding on it.
    document.documentElement.style.margin = "8px";
    document.documentElement.style.padding = "4px";
    const result = serialize(document.documentElement, { mode: "computed" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.html).not.toMatch(/margin-top:\s*8px/);
    expect(result.html).not.toMatch(/padding-top:\s*4px/);
  });

  it("does NOT strip margin from non-body/html elements (regression guard)", () => {
    document.body.innerHTML = `<div id="root" style="margin-top: 20px; padding-left: 12px">x</div>`;
    const result = serialize(document.getElementById("root")!, { mode: "computed" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    // The div's margin/padding must survive.
    expect(result.html).toMatch(/margin-top:\s*20px/);
    expect(result.html).toMatch(/padding-left:\s*12px/);
  });

  it("strip applies in inline mode too", () => {
    document.body.style.marginTop = "8px";
    const result = serialize(document.body, { mode: "inline" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.html).not.toMatch(/margin-top:\s*8px/);
  });
});
