import { describe, it, expect } from "vitest";
import { extractStyleBlocks } from "../extract-styles";

describe("extractStyleBlocks", () => {
  it("returns empty cssText and unchanged html when no style blocks present", () => {
    const html = "<div data-dj-source-html><p>hi</p></div>";
    const r = extractStyleBlocks(html);
    expect(r.cssText).toBe("");
    expect(r.blockCount).toBe(0);
    expect(r.htmlWithoutStyles).toBe(html);
  });

  it("extracts a single dedup block and strips it from the html", () => {
    const html =
      '<style data-designjs-dedup="">._djh0{display:flex}</style>' +
      "<div data-dj-source-html><p>hi</p></div>";
    const r = extractStyleBlocks(html);
    expect(r.cssText).toBe("._djh0{display:flex}");
    expect(r.blockCount).toBe(1);
    expect(r.htmlWithoutStyles).toBe("<div data-dj-source-html><p>hi</p></div>");
  });

  it("extracts all three marker types in author → dedup → capture order", () => {
    // Source order in the serializer's output is author, dedup, captured-
    // computed. The cascade-priority order (concatenation order in cssText)
    // mirrors this so computed and dedup win over author on equal-specificity
    // ties, matching the implicit DOM-order cascade we'd have had if the
    // blocks were inline children of the wrapper.
    const html =
      '<style data-designjs-author="">.a{color:red}</style>' +
      '<style data-designjs-dedup="">._djh0{display:flex}</style>' +
      '<style data-designjs-capture="">._dj0{color:blue}</style>' +
      "<div data-dj-source-html></div>";
    const r = extractStyleBlocks(html);
    expect(r.cssText).toBe(
      ".a{color:red}\n._djh0{display:flex}\n._dj0{color:blue}",
    );
    expect(r.blockCount).toBe(3);
    expect(r.htmlWithoutStyles).toBe("<div data-dj-source-html></div>");
  });

  it("handles multi-line CSS bodies (the realistic Wikipedia case)", () => {
    const html =
      '<style data-designjs-author="">' +
      ".mw-parser-output a { color: blue }\n" +
      ".mw-references-columns { column-width: 30em }" +
      "</style>" +
      "<div></div>";
    const r = extractStyleBlocks(html);
    expect(r.cssText).toContain(".mw-parser-output a");
    expect(r.cssText).toContain("column-width: 30em");
    expect(r.htmlWithoutStyles).toBe("<div></div>");
  });

  it("skips empty <style> blocks (no css emitted, block not counted)", () => {
    const html =
      '<style data-designjs-dedup=""></style>' +
      '<style data-designjs-author="">.a{c:red}</style>' +
      "<div></div>";
    const r = extractStyleBlocks(html);
    expect(r.cssText).toBe(".a{c:red}");
    expect(r.blockCount).toBe(1);
  });

  it("doesn't touch <style> elements that lack our marker attribute", () => {
    // A captured page might contain a stray <style> from somewhere. Leave it
    // in the HTML so GrapesJS can do with it what it normally does.
    const html =
      '<style data-designjs-dedup="">._djh0{c:red}</style>' +
      "<div>" +
      '<style data-other="">.unrelated{c:blue}</style>' +
      "</div>";
    const r = extractStyleBlocks(html);
    expect(r.cssText).toBe("._djh0{c:red}");
    expect(r.htmlWithoutStyles).toContain('<style data-other="">.unrelated{c:blue}</style>');
  });
});
