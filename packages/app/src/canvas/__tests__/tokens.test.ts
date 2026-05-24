import { describe, it, expect } from "vitest";
import {
  cssVariableToPath,
  deleteToken,
  flattenToCssVariables,
  getToken,
  inferType,
  inflateFromCssVariables,
  isToken,
  pathToCssVariable,
  setToken,
  validateValue,
  walkTokens,
  type Token,
  type TokenTree,
} from "../tokens";

/**
 * Phase 1 Chunk A — DTCG-shaped tokens store. Covers type validators,
 * dot-path operations, CSS-variable mapping, migration inference, and
 * the legacy-flat ↔ DTCG round-trip used by the variables.ts adapter.
 */

describe("validateValue", () => {
  it("accepts each color shape", () => {
    expect(validateValue("color", "#fff")).toBe(true);
    expect(validateValue("color", "#ff3366")).toBe(true);
    expect(validateValue("color", "rgb(255, 0, 0)")).toBe(true);
    expect(validateValue("color", "rgba(0, 0, 0, 0.5)")).toBe(true);
    expect(validateValue("color", "hsl(0deg 100% 50%)")).toBe(true);
    expect(validateValue("color", "oklch(0.7 0.15 30)")).toBe(true);
    expect(validateValue("color", "lab(50% 40 -20)")).toBe(true);
    expect(validateValue("color", "transparent")).toBe(true);
  });

  it("rejects non-color values for color type", () => {
    expect(validateValue("color", "16px")).toBe(false);
    expect(validateValue("color", 16)).toBe(false);
    expect(validateValue("color", "")).toBe(false);
    expect(validateValue("color", null)).toBe(false);
  });

  it("accepts each dimension unit", () => {
    expect(validateValue("dimension", "16px")).toBe(true);
    expect(validateValue("dimension", "1.5rem")).toBe(true);
    expect(validateValue("dimension", "100%")).toBe(true);
    expect(validateValue("dimension", "50vh")).toBe(true);
    expect(validateValue("dimension", "1fr")).toBe(true);
    expect(validateValue("dimension", "0")).toBe(true);
  });

  it("rejects unitless numbers (except 0) for dimension", () => {
    expect(validateValue("dimension", "16")).toBe(false);
    expect(validateValue("dimension", "")).toBe(false);
    expect(validateValue("dimension", "px")).toBe(false);
  });

  it("accepts duration in s and ms", () => {
    expect(validateValue("duration", "200ms")).toBe(true);
    expect(validateValue("duration", "0.3s")).toBe(true);
    expect(validateValue("duration", "1S")).toBe(true);
  });

  it("rejects duration without unit", () => {
    expect(validateValue("duration", "200")).toBe(false);
    expect(validateValue("duration", "fast")).toBe(false);
  });

  it("accepts cubicBezier in array and string forms", () => {
    expect(validateValue("cubicBezier", [0.25, 0.1, 0.25, 1])).toBe(true);
    expect(validateValue("cubicBezier", "cubic-bezier(0.4, 0, 0.2, 1)")).toBe(true);
  });

  it("rejects malformed cubicBezier", () => {
    expect(validateValue("cubicBezier", [0.25, 0.1, 0.25])).toBe(false);
    expect(validateValue("cubicBezier", "ease")).toBe(false);
  });

  it("accepts fontWeight as numeric (1-1000) or named", () => {
    expect(validateValue("fontWeight", 400)).toBe(true);
    expect(validateValue("fontWeight", "700")).toBe(true);
    expect(validateValue("fontWeight", "bold")).toBe(true);
    expect(validateValue("fontWeight", "normal")).toBe(true);
  });

  it("rejects fontWeight out of range or invalid keyword", () => {
    expect(validateValue("fontWeight", 0)).toBe(false);
    expect(validateValue("fontWeight", 1500)).toBe(false);
    expect(validateValue("fontWeight", "extra-bold")).toBe(false);
  });

  it("accepts fontFamily as string or array", () => {
    expect(validateValue("fontFamily", "Inter")).toBe(true);
    expect(validateValue("fontFamily", ["Inter", "system-ui"])).toBe(true);
  });

  it("accepts number as numeric", () => {
    expect(validateValue("number", 1.618)).toBe(true);
    expect(validateValue("number", "0.5")).toBe(true);
  });
});

describe("cssVariableToPath / pathToCssVariable", () => {
  it("treats a CSS variable name as a single path segment", () => {
    // Hyphens in CSS variable names aren't hierarchy separators (see
    // header comment in tokens.ts) — `--color-brand-primary` is one
    // token with one name, not three nested groups.
    expect(cssVariableToPath("--color-brand-primary")).toBe("color-brand-primary");
    expect(pathToCssVariable("color-brand-primary")).toBe("--color-brand-primary");
  });

  it("handles a single-word variable", () => {
    expect(cssVariableToPath("--brand")).toBe("brand");
    expect(pathToCssVariable("brand")).toBe("--brand");
  });

  it("is bijective for kebab-case input", () => {
    const samples = [
      "--color-fg",
      "--space-4",
      "--font-weight-bold",
      "--radius-lg",
      "--brand-primary",
      "--brand-primary-hover",
    ];
    for (const cssVar of samples) {
      expect(pathToCssVariable(cssVariableToPath(cssVar))).toBe(cssVar);
    }
  });

  it("preserves prefix-overlapping CSS variable names without collision", () => {
    // Regression: previously `--brand-primary` was split into the path
    // `brand.primary` and `--brand-primary-hover` into `brand.primary.hover`,
    // causing the second write to silently destroy the first when both
    // landed in the same tree (Figma → DesignJS relay payloads routinely
    // mix names like these).
    expect(cssVariableToPath("--brand-primary")).not.toBe(
      cssVariableToPath("--brand-primary-hover"),
    );
  });
});

describe("getToken / setToken / deleteToken", () => {
  it("sets and reads a leaf token", () => {
    const tree: TokenTree = {};
    const token: Token = { $type: "color", $value: "#ff3366" };
    setToken(tree, "color.brand.primary", token);
    expect(getToken(tree, "color.brand.primary")).toEqual(token);
  });

  it("returns null for missing paths", () => {
    const tree: TokenTree = {};
    expect(getToken(tree, "color.brand.primary")).toBeNull();
  });

  it("returns null when path traverses through a leaf", () => {
    const tree: TokenTree = {};
    setToken(tree, "color.brand", { $value: "#fff" });
    // Trying to read a sub-path of a leaf token returns null.
    expect(getToken(tree, "color.brand.primary")).toBeNull();
  });

  it("setToken overwrites a leaf with a group when the path extends past it", () => {
    const tree: TokenTree = {};
    setToken(tree, "color.brand", { $value: "#fff" });
    setToken(tree, "color.brand.primary", { $value: "#ff3366" });
    expect(getToken(tree, "color.brand.primary")?.$value).toBe("#ff3366");
  });

  it("deleteToken removes a leaf and reports success", () => {
    const tree: TokenTree = {};
    setToken(tree, "color.brand.primary", { $value: "#ff3366" });
    expect(deleteToken(tree, "color.brand.primary")).toBe(true);
    expect(getToken(tree, "color.brand.primary")).toBeNull();
  });

  it("deleteToken returns false for missing paths", () => {
    const tree: TokenTree = {};
    expect(deleteToken(tree, "color.brand.primary")).toBe(false);
  });
});

describe("walkTokens", () => {
  it("yields every leaf with its dot-path", () => {
    const tree: TokenTree = {};
    setToken(tree, "color.brand.primary", { $value: "#ff3366" });
    setToken(tree, "color.brand.secondary", { $value: "#3366ff" });
    setToken(tree, "spacing.lg", { $value: "16px" });

    const paths = Array.from(walkTokens(tree)).map((entry) => entry.path);
    expect(paths.sort()).toEqual([
      "color.brand.primary",
      "color.brand.secondary",
      "spacing.lg",
    ]);
  });

  it("ignores non-leaf nodes (groups)", () => {
    const tree: TokenTree = {};
    setToken(tree, "color.brand.primary", { $value: "#ff3366" });
    const entries = Array.from(walkTokens(tree));
    expect(entries.every((e) => isToken(e.token))).toBe(true);
  });
});

describe("inferType", () => {
  it("uses key prefix first (color)", () => {
    expect(inferType("--color-brand-primary", "#ff3366")).toBe("color");
    expect(inferType("--bg-surface", "#ffffff")).toBe("color");
    expect(inferType("--ring", "rgba(0, 0, 0, 0.1)")).toBe("color");
  });

  it("uses key prefix first (dimension)", () => {
    expect(inferType("--space-4", "16px")).toBe("dimension");
    expect(inferType("--radius-lg", "8px")).toBe("dimension");
    expect(inferType("--gap", "1rem")).toBe("dimension");
  });

  it("uses key prefix first (fontWeight / fontFamily)", () => {
    expect(inferType("--font-weight-bold", "700")).toBe("fontWeight");
    expect(inferType("--font-family-sans", "Inter")).toBe("fontFamily");
  });

  it("falls back to value-shape sniffing when key has no recognised prefix", () => {
    expect(inferType("--brand-primary", "#ff3366")).toBe("color");
    expect(inferType("--gutter", "16px")).toBe("dimension");
    expect(inferType("--ease-standard", "cubic-bezier(0.4, 0, 0.2, 1)")).toBe("cubicBezier");
  });

  it("returns undefined for genuinely unrecognised values", () => {
    expect(inferType("--mystery", "some-arbitrary-string")).toBeUndefined();
  });
});

describe("inflateFromCssVariables / flattenToCssVariables (legacy round-trip)", () => {
  it("preserves keys and non-color values across a round trip", () => {
    // Non-color values round-trip losslessly. Color values get OKLCH-
    // canonicalised on inflation per ADR-0009 §2 (Chunk B), so round-
    // trip equality is asserted only on the non-color subset here; the
    // color-canonicalisation behaviour is covered separately below.
    const flat: Record<string, string> = {
      "--space-4": "16px",
      "--font-weight-bold": "700",
    };
    const tree = inflateFromCssVariables(flat);
    expect(flattenToCssVariables(tree)).toEqual(flat);
  });

  it("canonicalises color values to OKLCH on inflation (ADR-0009 §2)", () => {
    const tree = inflateFromCssVariables({
      "--color-brand-primary": "#ff3366",
    });
    const token = getToken(tree, "color-brand-primary");
    expect(token?.$type).toBe("color");
    expect(String(token?.$value)).toMatch(/^oklch\(/);
    expect(token?.$extensions).toEqual({ "designjs.colorSpace": "srgb" });
  });

  it("passes already-OKLCH color values through with sourceSpace=oklch", () => {
    const tree = inflateFromCssVariables({
      "--color-brand-primary": "oklch(0.65 0.23 13.3)",
    });
    const token = getToken(tree, "color-brand-primary");
    expect(token?.$extensions).toEqual({ "designjs.colorSpace": "oklch" });
  });

  it("preserves unrecognised color literals (e.g. var() refs) without colorSpace", () => {
    const tree = inflateFromCssVariables({
      "--color-aliased": "var(--color-brand-primary)",
    });
    const token = getToken(tree, "color-aliased");
    expect(token?.$value).toBe("var(--color-brand-primary)");
    expect(token?.$extensions).toBeUndefined();
  });

  it("attaches inferred $type during inflation", () => {
    const tree = inflateFromCssVariables({
      "--color-brand-primary": "#ff3366",
      "--space-4": "16px",
    });
    expect(getToken(tree, "color-brand-primary")?.$type).toBe("color");
    expect(getToken(tree, "space-4")?.$type).toBe("dimension");
  });

  it("leaves $type undefined when nothing matches", () => {
    const tree = inflateFromCssVariables({ "--mystery": "some-arbitrary-string" });
    expect(getToken(tree, "mystery")?.$type).toBeUndefined();
  });

  it("handles empty input as empty tree", () => {
    expect(inflateFromCssVariables({})).toEqual({});
    expect(flattenToCssVariables({})).toEqual({});
  });

  it("preserves all keys when names share a hyphenated prefix (ADR-0008 relay regression)", () => {
    // The Figma → DesignJS Path A relay routinely emits names like
    // `--brand-primary` alongside `--brand-primary-hover`. Earlier path-
    // inference logic split both into a tree where the longer name
    // overwrote the shorter one. Both must survive the round-trip
    // (values are colour-canonicalised, so we assert presence + key
    // distinctness rather than byte equality).
    const tree = inflateFromCssVariables({
      "--brand-primary": "oklch(0.55 0.2 260)",
      "--brand-primary-hover": "oklch(0.5 0.22 260)",
    });
    const restored = flattenToCssVariables(tree);
    expect(restored["--brand-primary"]).toBeDefined();
    expect(restored["--brand-primary-hover"]).toBeDefined();
    expect(restored["--brand-primary"]).not.toBe(restored["--brand-primary-hover"]);
  });
});
