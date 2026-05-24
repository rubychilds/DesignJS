import { describe, it, expect, beforeEach } from "vitest";
import { serialize } from "../style-serializer";

/**
 * Table-layout, list, counter, and vertical-align properties. These
 * came in together as a Tier-1 fidelity batch after Wikipedia Love's
 * multi-page baseline: tables drive most layout in Wikipedia infoboxes,
 * MDN reference pages, and Bootstrap demos; lists drive the article
 * body chrome; vertical-align is load-bearing in table cells and
 * inline-block layouts.
 *
 * Same shape as the multi-column test — confirm each property survives
 * the inline-mode emit. Real-world fidelity validation runs separately
 * via the multi-page baseline + capture-diff.
 */
describe("serialize — table layout properties", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("captures border-collapse in inline mode", () => {
    document.body.innerHTML = `<div id="root" style="border-collapse: collapse">x</div>`;
    const result = serialize(document.getElementById("root")!, { mode: "inline" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.html).toMatch(/border-collapse:\s*collapse/);
  });

  it("captures border-spacing", () => {
    document.body.innerHTML = `<div id="root" style="border-spacing: 4px 8px">x</div>`;
    const result = serialize(document.getElementById("root")!, { mode: "inline" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.html).toMatch(/border-spacing:\s*4px 8px/);
  });

  it("captures table-layout", () => {
    document.body.innerHTML = `<div id="root" style="table-layout: fixed">x</div>`;
    const result = serialize(document.getElementById("root")!, { mode: "inline" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.html).toMatch(/table-layout:\s*fixed/);
  });

  it("captures caption-side", () => {
    document.body.innerHTML = `<div id="root" style="caption-side: bottom">x</div>`;
    const result = serialize(document.getElementById("root")!, { mode: "inline" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.html).toMatch(/caption-side:\s*bottom/);
  });

  it("captures empty-cells", () => {
    document.body.innerHTML = `<div id="root" style="empty-cells: hide">x</div>`;
    const result = serialize(document.getElementById("root")!, { mode: "inline" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.html).toMatch(/empty-cells:\s*hide/);
  });
});

describe("serialize — list + counter properties", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("captures list-style-type", () => {
    document.body.innerHTML = `<div id="root" style="list-style-type: decimal-leading-zero">x</div>`;
    const result = serialize(document.getElementById("root")!, { mode: "inline" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.html).toMatch(/list-style-type:\s*decimal-leading-zero/);
  });

  it("captures list-style-position", () => {
    document.body.innerHTML = `<div id="root" style="list-style-position: inside">x</div>`;
    const result = serialize(document.getElementById("root")!, { mode: "inline" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.html).toMatch(/list-style-position:\s*inside/);
  });

  it("captures counter-increment", () => {
    document.body.innerHTML = `<div id="root" style="counter-increment: section 2">x</div>`;
    const result = serialize(document.getElementById("root")!, { mode: "inline" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.html).toMatch(/counter-increment:\s*section 2/);
  });

  it("captures counter-reset", () => {
    document.body.innerHTML = `<div id="root" style="counter-reset: chapter">x</div>`;
    const result = serialize(document.getElementById("root")!, { mode: "inline" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.html).toMatch(/counter-reset:\s*chapter/);
  });
});

describe("serialize — vertical-align", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("captures vertical-align in inline mode", () => {
    document.body.innerHTML = `<div id="root" style="vertical-align: middle">x</div>`;
    const result = serialize(document.getElementById("root")!, { mode: "inline" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.html).toMatch(/vertical-align:\s*middle/);
  });
});
