import { describe, it, expect } from "vitest";
import { htmlToJsx, mergeStylesIntoHtml } from "../jsx-export";

/**
 * Tests for the JSX export pipeline used by the `get_jsx` MCP tool.
 *
 * `htmlToJsx` takes the editor's rendered HTML string (not a live GrapesJS
 * component tree) and produces a `Component.tsx` source string. The wrapping
 * `export default function Component() { return ( ... ); }` boilerplate is
 * present on every output, so most assertions look at the body via substring
 * or regex match rather than full-string equality.
 */

describe("htmlToJsx — boilerplate", () => {
  it("wraps output in a default-exported Component function", () => {
    const out = htmlToJsx("<div></div>");
    expect(out).toMatch(/^export default function Component\(\) \{\n {2}return \(\n/);
    expect(out).toMatch(/\n {2}\);\n\}\n$/);
  });

  it("emits a fragment for empty HTML", () => {
    const out = htmlToJsx("");
    expect(out).toContain("<></>");
  });

  it("wraps multiple top-level siblings in a fragment", () => {
    const out = htmlToJsx("<div></div><span></span>");
    expect(out).toContain("<>\n");
    expect(out).toContain("</>");
    expect(out).toMatch(/<div><\/div>/);
    expect(out).toMatch(/<span><\/span>/);
  });
});

describe("htmlToJsx — void elements", () => {
  // Note: <meta>/<link>/<base> are hoisted to <head> by the HTML parser, so they
  // never appear in body content — we only test void elements that the parser
  // actually keeps in the body tree.
  it.each([
    ["br", "<br>", "<br />"],
    ["hr", "<hr>", "<hr />"],
    ["img", `<img src="x.png">`, `<img src="x.png" />`],
    ["input", `<input type="text">`, `<input type="text" />`],
    ["wbr", "<wbr>", "<wbr />"],
  ])("emits <%s> as self-closing JSX", (tag, html, expected) => {
    const out = htmlToJsx(html);
    expect(out).toContain(expected);
    // Never has a closing tag.
    expect(out).not.toMatch(new RegExp(`</${tag}>`));
  });

  it("does not self-close non-void elements with no children", () => {
    const out = htmlToJsx("<div></div>");
    expect(out).toContain("<div></div>");
    expect(out).not.toContain("<div />");
  });
});

describe("htmlToJsx — attribute renaming", () => {
  it("renames class → className and preserves multi-class strings", () => {
    const out = htmlToJsx(`<div class="a b c"></div>`);
    expect(out).toContain(`className="a b c"`);
    expect(out).not.toContain(` class=`);
  });

  it("renames for → htmlFor on label", () => {
    const out = htmlToJsx(`<label for="email">Email</label>`);
    expect(out).toContain(`htmlFor="email"`);
    expect(out).not.toContain(` for=`);
  });

  it("renames a representative sample of HTML→JSX attribute names", () => {
    const out = htmlToJsx(
      `<input tabindex="0" readonly maxlength="10" autocomplete="off" spellcheck="false">`,
    );
    expect(out).toContain("tabIndex=");
    expect(out).toContain("maxLength=");
    expect(out).toContain("autoComplete=");
    expect(out).toContain("spellCheck=");
    // `readonly` is both renamed AND a boolean attribute — should appear bare as `readOnly`.
    expect(out).toMatch(/\breadOnly\b/);
  });

  it("emits boolean attributes bare when value is empty", () => {
    const out = htmlToJsx(`<input disabled checked>`);
    expect(out).toMatch(/\bdisabled\b/);
    expect(out).toMatch(/\bchecked\b/);
    expect(out).not.toContain(`disabled=""`);
    expect(out).not.toContain(`checked=""`);
  });
});

describe("htmlToJsx — text escaping", () => {
  it("entity-encodes < and > inside text content", () => {
    const out = htmlToJsx(`<p>a &lt; b &gt; c</p>`);
    // The JSX walker re-encodes the decoded text, so we should see &lt;/&gt; (not raw < >).
    expect(out).toContain("&lt;");
    expect(out).toContain("&gt;");
    expect(out).not.toMatch(/<p>a < b > c<\/p>/);
  });

  it("escapes { and } as string-literal JSX expressions", () => {
    const out = htmlToJsx(`<p>{ raw braces }</p>`);
    // `{` and `}` are JSX-significant, so they're emitted as {'{'} / {'}'}.
    expect(out).toContain(`{'{'}`);
    expect(out).toContain(`{'}'}`);
  });

  it("escapes double-quotes inside attribute values", () => {
    // DOMParser will decode &quot; into ", and the writer should re-encode it.
    const out = htmlToJsx(`<div title="say &quot;hi&quot;"></div>`);
    expect(out).toContain(`title="say &quot;hi&quot;"`);
    // The raw unescaped quote must not leak through.
    expect(out).not.toContain(`title="say "hi""`);
  });
});

describe("htmlToJsx — nested trees", () => {
  it("nests children with two-space indentation per level", () => {
    const out = htmlToJsx(`<section><div><p>hi</p></div></section>`);
    // <section> at base indent (4 spaces), <div> at 6, <p> at 8.
    expect(out).toContain("    <section>\n");
    expect(out).toContain("      <div>\n");
    expect(out).toContain("        <p>hi</p>");
  });

  it("inlines text-only elements (text on same line as tag)", () => {
    const out = htmlToJsx(`<p>hello</p>`);
    expect(out).toContain("<p>hello</p>");
    expect(out).not.toMatch(/<p>\n\s+hello\n\s+<\/p>/);
  });
});

describe("htmlToJsx — tailwind mode", () => {
  it("passes utility classes through unchanged", () => {
    const out = htmlToJsx(`<div class="p-4 bg-red-500 text-white"></div>`, "tailwind");
    expect(out).toContain(`className="p-4 bg-red-500 text-white"`);
  });

  it("strips style declarations that have a Tailwind equivalent", () => {
    // padding, margin, color, background-color, width, height, display, flex-direction
    // should be dropped in tailwind mode because the className carries them.
    const out = htmlToJsx(
      `<div class="p-4 text-white" style="padding: 16px; color: white;"></div>`,
      "tailwind",
    );
    expect(out).not.toContain("padding");
    expect(out).not.toContain("style={{");
  });

  it("keeps non-mappable style declarations in tailwind mode", () => {
    const out = htmlToJsx(
      `<div style="padding: 8px; border-radius: 4px;"></div>`,
      "tailwind",
    );
    // padding is dropped, border-radius is kept (no mappable mapping).
    expect(out).toContain("style={{");
    expect(out).toContain("borderRadius:");
    expect(out).not.toContain("padding:");
  });
});

describe("htmlToJsx — inline mode", () => {
  it("emits all style declarations as a JSX style object", () => {
    const out = htmlToJsx(
      `<div style="padding: 16px; color: red;"></div>`,
      "inline",
    );
    expect(out).toContain("style={{");
    expect(out).toContain('padding: "16px"');
    expect(out).toContain('color: "red"');
  });

  it("camelCases multi-hyphen CSS property names", () => {
    const out = htmlToJsx(
      `<div style="font-size: 14px; background-color: blue; border-top-left-radius: 4px;"></div>`,
      "inline",
    );
    expect(out).toContain("fontSize:");
    expect(out).toContain("backgroundColor:");
    expect(out).toContain("borderTopLeftRadius:");
    // Original kebab-case names should not appear as object keys.
    expect(out).not.toMatch(/\bfont-size:/);
    expect(out).not.toMatch(/\bbackground-color:/);
  });

  it("preserves CSS custom property names as quoted string keys", () => {
    const out = htmlToJsx(
      `<div style="--brand-color: oklch(0.6 0.2 30);"></div>`,
      "inline",
    );
    // Custom props can't be camelCased — they keep their full -- name.
    expect(out).toContain(`"--brand-color"`);
  });

  it("does NOT strip mappable styles in inline mode", () => {
    const out = htmlToJsx(
      `<div style="padding: 16px; color: red;"></div>`,
      "inline",
    );
    expect(out).toContain("padding:");
    expect(out).toContain("color:");
  });

  it("ignores malformed declarations (missing colon or value)", () => {
    const out = htmlToJsx(
      `<div style="padding: 8px; ;not-a-decl; color:;"></div>`,
      "inline",
    );
    expect(out).toContain('padding: "8px"');
    expect(out).not.toContain("not-a-decl");
    // `color:` with no value is dropped.
    expect(out).not.toMatch(/color:\s*""/);
  });
});

describe("mergeStylesIntoHtml", () => {
  it("returns html unchanged when css is empty or whitespace", () => {
    const html = `<div id="abc"></div>`;
    expect(mergeStylesIntoHtml(html, "")).toBe(html);
    expect(mergeStylesIntoHtml(html, "   \n  ")).toBe(html);
  });

  it("injects per-id CSS rules as inline style on the matching element", () => {
    const merged = mergeStylesIntoHtml(
      `<div id="abc"></div>`,
      `#abc { padding: 8px; color: red; }`,
    );
    // jsdom may normalise whitespace, just check the key bits are there.
    expect(merged).toContain(`id="abc"`);
    expect(merged).toContain("padding: 8px");
    expect(merged).toContain("color: red");
  });

  it("appends to an existing style attribute (no overwrite)", () => {
    const merged = mergeStylesIntoHtml(
      `<div id="abc" style="margin: 4px"></div>`,
      `#abc { padding: 8px; }`,
    );
    expect(merged).toContain("margin: 4px");
    expect(merged).toContain("padding: 8px");
  });

  it("ignores compound selectors like #id:hover and descendant selectors", () => {
    const merged = mergeStylesIntoHtml(
      `<div id="abc"></div>`,
      `#abc:hover { color: blue; } #abc .child { color: red; }`,
    );
    // Neither rule should be inlined — both have compound selectors.
    expect(merged).not.toContain("color: blue");
    expect(merged).not.toContain("color: red");
  });

  it.each([
    ["@media", `@media (min-width: 600px) { #abc { color: green; } }`],
    ["@supports", `@supports (display: grid) { #abc { color: green; } }`],
    ["@container", `@container (min-width: 400px) { #abc { color: green; } }`],
    ["@layer", `@layer utilities { #abc { color: green; } }`],
  ])("skips id rules nested inside %s blocks", (_label, css) => {
    // Top-level walk uses brace-depth tracking + a leading-@ skip so
    // conditional rules don't get applied unconditionally. See QA-1.
    const merged = mergeStylesIntoHtml(`<div id="abc"></div>`, css);
    expect(merged).not.toContain("color: green");
    expect(merged).toBe(`<div id="abc"></div>`);
  });

  it("still applies a sibling top-level rule when an at-rule is also present", () => {
    // Sanity: at-rule skipping doesn't break parsing of subsequent top-level
    // rules in the same stylesheet.
    const merged = mergeStylesIntoHtml(
      `<div id="abc"></div>`,
      `@media (min-width: 600px) { #abc { color: green; } } #abc { padding: 8px; }`,
    );
    expect(merged).not.toContain("color: green");
    expect(merged).toContain("padding: 8px");
  });

  it("merges multiple rules for the same id", () => {
    const merged = mergeStylesIntoHtml(
      `<div id="abc"></div>`,
      `#abc { padding: 8px; } #abc { color: red; }`,
    );
    expect(merged).toContain("padding: 8px");
    expect(merged).toContain("color: red");
  });

  it("skips id rules with no matching element", () => {
    const merged = mergeStylesIntoHtml(
      `<div id="abc"></div>`,
      `#missing { padding: 8px; }`,
    );
    expect(merged).not.toContain("padding: 8px");
  });
});
