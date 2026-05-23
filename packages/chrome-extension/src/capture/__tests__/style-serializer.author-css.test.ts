import { describe, it, expect, beforeEach } from "vitest";
import { collectAuthorCss, serialize } from "../style-serializer";

/**
 * A.2 — author CSS via `document.styleSheets`.
 *
 * Closes the same-origin half of the author-CSS gap. Pseudo-elements,
 * `@keyframes`, `@font-face`, `@supports`, and `@media` rules ride
 * along on the captured output as a `<style data-designjs-author>`
 * block. The computed-style block is emitted *after* in source order,
 * so computed inline classes still win on conflicts — author CSS is
 * additive, not replacement (true `@media` reflow needs ADR-0012 §4).
 */
describe("collectAuthorCss", () => {
  beforeEach(() => {
    // Clear any inline <style> from prior tests.
    document
      .querySelectorAll("style[data-test]")
      .forEach((el) => el.remove());
  });

  it("returns empty when the document has no readable stylesheets", () => {
    const result = collectAuthorCss(document);
    expect(result.cssText).toBe("");
  });

  it("collects rules from a same-origin <style> block", () => {
    const style = document.createElement("style");
    style.setAttribute("data-test", "");
    style.textContent = `.menu-item { color: red; } .menu-item::before { content: "★"; }`;
    document.head.appendChild(style);

    const result = collectAuthorCss(document);
    expect(result.collectedSheets).toBeGreaterThan(0);
    expect(result.cssText).toContain(".menu-item");
    expect(result.cssText).toContain('content: "★"');
  });

  it("preserves @keyframes rules (computed walker can't see these)", () => {
    const style = document.createElement("style");
    style.setAttribute("data-test", "");
    style.textContent = `@keyframes fade { from { opacity: 0 } to { opacity: 1 } }`;
    document.head.appendChild(style);

    const result = collectAuthorCss(document);
    expect(result.cssText).toContain("@keyframes");
    expect(result.cssText).toContain("fade");
  });

  it("preserves @media rule blocks", () => {
    const style = document.createElement("style");
    style.setAttribute("data-test", "");
    style.textContent = `@media (max-width: 768px) { .nav { display: none } }`;
    document.head.appendChild(style);

    const result = collectAuthorCss(document);
    expect(result.cssText).toContain("@media");
    expect(result.cssText).toContain("max-width: 768px");
  });

  it("rewrites relative url() to absolute against document.baseURI", () => {
    const style = document.createElement("style");
    style.setAttribute("data-test", "");
    style.textContent = `.hero { background-image: url(/img/hero.png) }`;
    document.head.appendChild(style);

    const result = collectAuthorCss(document);
    // jsdom's default baseURI is "about:blank"; resolution against
    // that yields "about:blank/img/hero.png" or similar. The point is
    // the relative path doesn't survive as `/img/hero.png`.
    expect(result.cssText).not.toContain("url(/img/hero.png)");
    expect(result.cssText).toContain("hero.png");
  });

  it("leaves absolute, data:, and protocol-relative URLs untouched", () => {
    const style = document.createElement("style");
    style.setAttribute("data-test", "");
    style.textContent = `
      .a { background: url(https://cdn.example.com/img.png) }
      .b { background: url(data:image/png;base64,abc) }
      .c { background: url(//cdn.example.com/img.png) }
    `;
    document.head.appendChild(style);

    const result = collectAuthorCss(document);
    expect(result.cssText).toContain("https://cdn.example.com/img.png");
    expect(result.cssText).toContain("data:image/png;base64,abc");
    expect(result.cssText).toContain("//cdn.example.com/img.png");
  });

  it("skips sheets whose .cssRules access throws (cross-origin sim)", () => {
    const style = document.createElement("style");
    style.setAttribute("data-test", "");
    style.textContent = `.x { color: red }`;
    document.head.appendChild(style);
    const sheet = style.sheet!;
    Object.defineProperty(sheet, "cssRules", {
      get() {
        throw new DOMException(
          "Cannot access rules of a cross-origin stylesheet",
          "SecurityError",
        );
      },
      configurable: true,
    });

    const result = collectAuthorCss(document);
    expect(result.skippedSheets).toBeGreaterThan(0);
    // The blocked rule must not appear in the output.
    expect(result.cssText).not.toContain(".x");
  });

  it("returns empty on a null/undefined document", () => {
    expect(collectAuthorCss(null).cssText).toBe("");
    expect(collectAuthorCss(undefined).cssText).toBe("");
  });
});

describe("serialize — author-CSS supplement", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document
      .querySelectorAll("style[data-test]")
      .forEach((el) => el.remove());
  });

  it("emits a <style data-designjs-author> block alongside the computed block", () => {
    const style = document.createElement("style");
    style.setAttribute("data-test", "");
    style.textContent = `.menu::before { content: "•" }`;
    document.head.appendChild(style);

    document.body.innerHTML = `<div id="root"><span class="menu">item</span></div>`;
    const result = serialize(document.getElementById("root")!, {
      mode: "computed",
    });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);

    const parsed = new DOMParser().parseFromString(result.html, "text/html");
    const authorEl = parsed.querySelector("style[data-designjs-author]");
    const capturedEl = parsed.querySelector("style[data-designjs-capture]");
    expect(authorEl).toBeTruthy();
    expect(capturedEl).toBeTruthy();
    expect(authorEl!.textContent).toContain(".menu");
    expect(authorEl!.textContent).toContain('content: "•"');
  });

  it("author block precedes the computed block in source order (computed wins)", () => {
    const style = document.createElement("style");
    style.setAttribute("data-test", "");
    style.textContent = `.x { color: red }`;
    document.head.appendChild(style);

    document.body.innerHTML = `<div id="root"><span class="x">x</span></div>`;
    const result = serialize(document.getElementById("root")!, {
      mode: "computed",
    });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);

    const parsed = new DOMParser().parseFromString(result.html, "text/html");
    const root = parsed.querySelector("#root")!;
    const styles = Array.from(root.children).filter(
      (el) => el.tagName === "STYLE",
    );
    // First style child should be the author block, second the captured.
    expect(styles.length).toBeGreaterThanOrEqual(2);
    expect(styles[0]!.hasAttribute("data-designjs-author")).toBe(true);
    expect(styles[1]!.hasAttribute("data-designjs-capture")).toBe(true);
  });

  it("omits the author block when no readable author CSS exists", () => {
    document.body.innerHTML = `<div id="root"><span>plain</span></div>`;
    // No <style> added — no author CSS to collect.
    const result = serialize(document.getElementById("root")!, {
      mode: "computed",
    });
    if ("error" in result) throw new Error(`unexpected: ${result.error}`);

    const parsed = new DOMParser().parseFromString(result.html, "text/html");
    expect(parsed.querySelector("style[data-designjs-author]")).toBeNull();
  });
});
