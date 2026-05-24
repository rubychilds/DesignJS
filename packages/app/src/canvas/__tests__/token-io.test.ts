import { describe, it, expect } from "vitest";
import { parseDTCG, serialiseDTCG } from "../token-io";
import type { TokenTree } from "../tokens";

describe("parseDTCG", () => {
  it("parses a simple flat tree", () => {
    const result = parseDTCG({
      color: { primary: { $type: "color", $value: "oklch(0.65 0.23 13)" } },
    });
    expect(result.warnings).toEqual([]);
    expect(result.tree.color).toBeDefined();
  });

  it("parses nested groups deeper than one level", () => {
    const result = parseDTCG({
      color: {
        brand: {
          primary: { $type: "color", $value: "oklch(0.65 0.23 13)" },
          secondary: { $type: "color", $value: "oklch(0.5 0.18 250)" },
        },
        accent: { $type: "color", $value: "oklch(0.7 0.2 30)" },
      },
    });
    expect(result.warnings).toEqual([]);
    const brandPrimary = (result.tree.color as TokenTree).brand as TokenTree;
    expect(brandPrimary.primary).toBeDefined();
  });

  it("accepts a JSON string and parses it", () => {
    const json = JSON.stringify({
      color: { primary: { $type: "color", $value: "oklch(0.5 0.1 180)" } },
    });
    const result = parseDTCG(json);
    expect(result.warnings).toEqual([]);
  });

  it("throws on malformed JSON strings", () => {
    expect(() => parseDTCG("{ not valid json")).toThrow();
  });

  it("throws on non-object roots (string, array, null)", () => {
    expect(() => parseDTCG("[]" as unknown as string)).toThrow(/object/);
    expect(() => parseDTCG("null" as unknown as string)).toThrow(/object/);
  });

  it("preserves $description and $extensions through parse", () => {
    const result = parseDTCG({
      color: {
        primary: {
          $type: "color",
          $value: "oklch(0.5 0.1 180)",
          $description: "Brand primary",
          $extensions: { "designjs.colorSpace": "oklch", "com.acme.note": "x" },
        },
      },
    });
    const token = (result.tree.color as TokenTree).primary as {
      $description?: string;
      $extensions?: Record<string, unknown>;
    };
    expect(token.$description).toBe("Brand primary");
    expect(token.$extensions).toMatchObject({ "com.acme.note": "x" });
  });

  it("canonicalises non-OKLCH color values to OKLCH on parse", () => {
    const result = parseDTCG({
      color: { primary: { $type: "color", $value: "#ff0000" } },
    });
    const token = (result.tree.color as TokenTree).primary as {
      $value: string;
      $extensions?: Record<string, unknown>;
    };
    expect(token.$value).toMatch(/^oklch\(/);
    expect(token.$extensions?.["designjs.colorSpace"]).toBe("srgb");
  });

  it("warns (non-fatally) on unknown $type", () => {
    const result = parseDTCG({
      mystery: { something: { $type: "unicorn", $value: "✨" } },
    });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/Unknown \$type/);
    // Token still preserved.
    expect((result.tree.mystery as TokenTree).something).toBeDefined();
  });

  it("warns on unrecognised color literal but preserves raw value", () => {
    const result = parseDTCG({
      color: { aliased: { $type: "color", $value: "var(--external)" } },
    });
    expect(result.warnings.some((w) => /not a recognised CSS color/.test(w))).toBe(true);
    const token = (result.tree.color as TokenTree).aliased as { $value: string };
    expect(token.$value).toBe("var(--external)");
  });

  it("skips top-level $-prefixed metadata at group level", () => {
    const result = parseDTCG({
      color: {
        $description: "All the colors",
        primary: { $type: "color", $value: "oklch(0.5 0.1 180)" },
      },
    });
    expect(result.warnings).toEqual([]);
    expect((result.tree.color as TokenTree).primary).toBeDefined();
    // $description on the group is dropped (we don't model group meta in v0.3).
    expect((result.tree.color as TokenTree).$description).toBeUndefined();
  });

  it("warns on a non-object node where a token or group is expected", () => {
    // Bare scalar at a position that's neither token nor group.
    const result = parseDTCG({
      color: { primary: "this should have been a token" } as unknown as Record<string, unknown>,
    });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/Dropped non-object/);
  });
});

describe("serialiseDTCG", () => {
  it("emits a pretty-printed JSON string with 2-space indent", () => {
    const tree: TokenTree = {
      color: { primary: { $type: "color", $value: "oklch(0.5 0.1 180)" } },
    };
    const json = serialiseDTCG(tree);
    expect(json).toContain('"$type": "color"');
    expect(json).toMatch(/^{\n  "color":/);
  });

  it("preserves $description and $extensions in output", () => {
    const tree: TokenTree = {
      color: {
        primary: {
          $type: "color",
          $value: "oklch(0.5 0.1 180)",
          $description: "Brand primary",
          $extensions: { "designjs.colorSpace": "oklch" },
        },
      },
    };
    const json = serialiseDTCG(tree);
    expect(json).toContain('"$description": "Brand primary"');
    expect(json).toContain('"designjs.colorSpace": "oklch"');
  });
});

describe("parseDTCG ∘ serialiseDTCG round-trip", () => {
  it("round-trips OKLCH colors losslessly (with the colorSpace tag parseDTCG adds on first import)", () => {
    // parseDTCG tags every color token with $extensions.designjs.colorSpace;
    // a fresh import without the tag gets it added. Subsequent round-trips
    // preserve the tag (via the "preserve existing" branch).
    const original: TokenTree = {
      color: {
        primary: {
          $type: "color",
          $value: "oklch(0.5 0.1 180)",
          $extensions: { "designjs.colorSpace": "oklch" },
        },
      },
    };
    const restored = parseDTCG(serialiseDTCG(original)).tree;
    expect(restored).toEqual(original);
  });

  it("round-trips multi-type trees", () => {
    const original: TokenTree = {
      color: {
        primary: {
          $type: "color",
          $value: "oklch(0.65 0.23 13)",
          $extensions: { "designjs.colorSpace": "oklch" },
        },
      },
      spacing: { "4": { $type: "dimension", $value: "16px" } },
      "font-weight": { bold: { $type: "fontWeight", $value: 700 } },
      ease: {
        "in-out": { $type: "cubicBezier", $value: [0.4, 0, 0.2, 1] },
      },
    };
    const restored = parseDTCG(serialiseDTCG(original)).tree;
    expect(restored).toEqual(original);
  });

  it("round-trips $description and $extensions", () => {
    const original: TokenTree = {
      color: {
        primary: {
          $type: "color",
          $value: "oklch(0.5 0.1 180)",
          $description: "Brand primary",
          $extensions: {
            "designjs.colorSpace": "oklch",
            "com.tokens-studio.opaque": { foo: "bar" },
          },
        },
      },
    };
    const restored = parseDTCG(serialiseDTCG(original)).tree;
    expect(restored).toEqual(original);
  });

  it("normalises sRGB→OKLCH on first parse but is then idempotent", () => {
    const srgbInput = parseDTCG({
      color: { primary: { $type: "color", $value: "#ff0000" } },
    }).tree;
    const roundTripped = parseDTCG(serialiseDTCG(srgbInput)).tree;
    expect(roundTripped).toEqual(srgbInput);
  });
});
