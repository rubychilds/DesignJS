import { describe, it, expect, beforeEach } from "vitest";
import { serialize } from "../style-serializer";

/**
 * CSS Multi-column Layout — column-count / column-width et al. are
 * non-inherited and laid out by the browser's multi-col algorithm, not
 * flex/grid. Wikipedia's references / see-also / category footers rely
 * on these; without them captured, those sections collapse to a single
 * column.
 */
describe("serialize — CSS multi-column properties", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("captures column-count in inline mode", () => {
    document.body.innerHTML = `<div id="root" style="column-count: 3">a b c</div>`;
    const result = serialize(document.getElementById("root")!, { mode: "inline" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.html).toMatch(/column-count:\s*3/);
  });

  it("captures column-width in inline mode", () => {
    document.body.innerHTML = `<div id="root" style="column-width: 250px">a b c</div>`;
    const result = serialize(document.getElementById("root")!, { mode: "inline" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.html).toMatch(/column-width:\s*250px/);
  });

  it("captures break-inside (prevents fragments from splitting across columns)", () => {
    document.body.innerHTML = `<div id="root" style="break-inside: avoid">x</div>`;
    const result = serialize(document.getElementById("root")!, { mode: "inline" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.html).toMatch(/break-inside:\s*avoid/);
  });
});
