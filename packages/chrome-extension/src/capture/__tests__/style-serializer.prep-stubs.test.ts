import { describe, it, expect } from "vitest";
import { serialize } from "../style-serializer";

/**
 * v0.3 prep stubs for ADR-0012 (epic-8-followups §4.1, §4.2):
 *  - data-dj-uid is stamped on every cloned element
 *  - serialize() validates the `mode` option, allowing only "computed"
 */
describe("style-serializer prep stubs", () => {
  function fixture(): HTMLElement {
    document.body.innerHTML = `
      <div id="root">
        <p>hello</p>
        <span><b>nested</b></span>
      </div>
    `;
    return document.getElementById("root")!;
  }

  it("stamps data-dj-uid on every element in the captured tree", () => {
    const result = serialize(fixture(), { mode: "computed" });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);

    const parsed = new DOMParser().parseFromString(result.html, "text/html");
    const stamped = parsed.querySelectorAll("[data-dj-uid]");
    expect(stamped.length).toBe(4);

    const ids = Array.from(stamped).map((el) =>
      Number(el.getAttribute("data-dj-uid")),
    );
    const sorted = [...ids].sort((a, b) => a - b);
    expect(sorted).toEqual([0, 1, 2, 3]);
  });

  it("defaults to mode='computed' when omitted", () => {
    const result = serialize(fixture());
    expect("error" in result).toBe(false);
  });

  it('throws when mode is anything other than "computed"', () => {
    expect(() =>
      // @ts-expect-error — intentionally passing a forbidden value to verify the runtime guard
      serialize(fixture(), { mode: "author" }),
    ).toThrow(/ADR-0012 §4/);
  });
});
