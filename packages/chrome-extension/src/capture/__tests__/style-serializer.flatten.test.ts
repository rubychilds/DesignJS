import { describe, it, expect } from "vitest";
import { isPassThroughStyle, serialize } from "../style-serializer";

/**
 * Wrapper-flattening conservative pass — epic-8-followups §3.4.
 * Verifies the pass-through allowlist + the structural safety
 * checks (single child, no text, no extra attrs, div only).
 *
 * The bar is asymmetric: false negatives are acceptable (some
 * genuinely-empty wrappers stay), false positives are not (no div
 * with meaningful styling gets unwrapped).
 */
describe("isPassThroughStyle", () => {
  it("accepts the empty string", () => {
    expect(isPassThroughStyle("")).toBe(true);
  });

  it("accepts a string of only allowlisted defaults", () => {
    expect(
      isPassThroughStyle(
        "display:block;margin-top:0px;margin-right:0px;margin-bottom:0px;margin-left:0px",
      ),
    ).toBe(true);
  });

  it("rejects when any declaration is not in the allowlist", () => {
    expect(isPassThroughStyle("display:block;color:red")).toBe(false);
    expect(isPassThroughStyle("display:block;padding-top:8px")).toBe(false);
    expect(isPassThroughStyle("display:flex")).toBe(false);
    expect(isPassThroughStyle("position:absolute")).toBe(false);
    expect(isPassThroughStyle("opacity:0.5")).toBe(false);
    expect(isPassThroughStyle("transform:translate(1px, 0)")).toBe(false);
    expect(isPassThroughStyle("background-color:rgb(255, 0, 0)")).toBe(false);
  });

  it("accepts background-color:transparent and rgba(0, 0, 0, 0)", () => {
    expect(isPassThroughStyle("background-color:rgba(0, 0, 0, 0)")).toBe(true);
    expect(isPassThroughStyle("background-color:transparent")).toBe(true);
  });
});

describe("flattenPassThroughWrappers (via serialize)", () => {
  function fixture(html: string): HTMLElement {
    const container = document.createElement("div");
    container.id = "test-root";
    container.innerHTML = html;
    document.body.replaceChildren(container);
    return container;
  }

  function captured(root: Element): Document {
    const result = serialize(root, { mode: "computed" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    return new DOMParser().parseFromString(result.html, "text/html");
  }

  it("preserves a div whose class CSS contains meaningful styling", () => {
    // jsdom doesn't compute box-shadow / opacity as standardised, but the
    // serializer always emits *some* class for content elements — the only
    // path to flatten is when the class CSS is purely pass-through.
    const root = fixture(`
      <div style="background: red; padding: 8px;">
        <p>kept</p>
      </div>
    `);
    const doc = captured(root);
    // The styled wrapper survives; the <p> is its descendant.
    const wrapper = doc.querySelector('div > div');
    expect(wrapper).not.toBeNull();
    expect(doc.querySelector("p")?.textContent).toBe("kept");
  });

  it("preserves divs with a non-class attribute (id / data-* / aria-* / role)", () => {
    // Even if the div's class is pass-through, an attribute marker
    // (id, role, aria-*, data-*) means the div is semantically meaningful
    // — keep it.
    const root = fixture(`
      <div id="hero">
        <p>kept</p>
      </div>
    `);
    const doc = captured(root);
    expect(doc.querySelector("#hero")).not.toBeNull();
  });

  it("preserves divs with multiple children (would change semantics on unwrap)", () => {
    const root = fixture(`
      <div>
        <p>first</p>
        <p>second</p>
      </div>
    `);
    const doc = captured(root);
    // The wrapper-with-two-children stays; both <p>s preserved.
    const ps = doc.querySelectorAll("p");
    expect(ps.length).toBe(2);
  });

  it("preserves divs that wrap raw text (would dump text into parent on unwrap)", () => {
    const root = fixture(`
      <div>
        <span>before</span>and-trailing-text
      </div>
    `);
    const doc = captured(root);
    expect(doc.body.innerHTML).toContain("and-trailing-text");
  });

  it("preserves non-<div> single-child wrappers (section / article carry semantic weight)", () => {
    const root = fixture(`
      <section><p>kept</p></section>
    `);
    const doc = captured(root);
    expect(doc.querySelector("section")).not.toBeNull();
  });
});
