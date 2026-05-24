import { describe, it, expect, beforeEach } from "vitest";
import { serialize } from "../style-serializer";

/**
 * `excludeIds` option lets the caller drop specific elements from the
 * captured tree by id. Whole-page capture from `documentElement`
 * (Experiment A) needs this to keep the extension's own overlay
 * (`#designjs-capture-root`) out of the captured artboard.
 */
describe("serialize — excludeIds option", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("drops a matched-by-id element AND its subtree", () => {
    document.body.innerHTML = `
      <div id="root">
        <span>keep this</span>
        <div id="overlay-id">
          <p>drop me</p>
          <span>and me</span>
        </div>
        <span>keep this too</span>
      </div>`;
    const result = serialize(document.getElementById("root")!, {
      mode: "computed",
      excludeIds: ["overlay-id"],
    });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.html).toContain("keep this");
    expect(result.html).toContain("keep this too");
    expect(result.html).not.toContain("drop me");
    expect(result.html).not.toContain("and me");
    expect(result.html).not.toContain('id="overlay-id"');
  });

  it("supports multiple ids", () => {
    document.body.innerHTML = `
      <div id="root">
        <div id="overlay-a">A</div>
        <div id="keeper">K</div>
        <div id="overlay-b">B</div>
      </div>`;
    const result = serialize(document.getElementById("root")!, {
      mode: "computed",
      excludeIds: ["overlay-a", "overlay-b"],
    });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.html).toContain(">K<");
    expect(result.html).not.toContain(">A<");
    expect(result.html).not.toContain(">B<");
  });

  it("no-op when excludeIds is omitted", () => {
    document.body.innerHTML = `<div id="root"><div id="overlay-id">should stay</div></div>`;
    const result = serialize(document.getElementById("root")!, { mode: "computed" });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.html).toContain("should stay");
  });

  it("doesn't drop the root itself even if its id matches", () => {
    // The id-match check is in the children loop, so the root passes
    // through unconditionally. Callers should pass a root that isn't
    // in their excludeIds set.
    document.body.innerHTML = `<div id="root">payload</div>`;
    const result = serialize(document.getElementById("root")!, {
      mode: "computed",
      excludeIds: ["root"],
    });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);
    expect(result.html).toContain("payload");
  });
});
