import { describe, it, expect } from "vitest";
import {
  emitTokens,
  isTailwindNamespace,
  formatTokenValue,
} from "../token-emit";
import type { TokenTree, Token } from "../tokens";

describe("isTailwindNamespace", () => {
  it("matches mainstream namespaces", () => {
    expect(isTailwindNamespace("--color-brand-primary")).toBe(true);
    expect(isTailwindNamespace("--spacing-4")).toBe(true);
    expect(isTailwindNamespace("--radius-lg")).toBe(true);
    expect(isTailwindNamespace("--shadow-md")).toBe(true);
    expect(isTailwindNamespace("--text-base")).toBe(true);
    expect(isTailwindNamespace("--font-sans")).toBe(true);
    expect(isTailwindNamespace("--font-weight-bold")).toBe(true);
    expect(isTailwindNamespace("--ease-in-out")).toBe(true);
    expect(isTailwindNamespace("--breakpoint-md")).toBe(true);
  });

  it("rejects custom namespaces", () => {
    expect(isTailwindNamespace("--my-custom-var")).toBe(false);
    expect(isTailwindNamespace("--brand-name")).toBe(false);
    expect(isTailwindNamespace("--app-density")).toBe(false);
  });

  it("requires the trailing dash to avoid prefix collisions", () => {
    // "--color" alone is not a Tailwind namespace — only --color-* is.
    expect(isTailwindNamespace("--color")).toBe(false);
    expect(isTailwindNamespace("--colorscheme")).toBe(false);
  });
});

describe("formatTokenValue", () => {
  it("returns string values verbatim", () => {
    expect(formatTokenValue({ $type: "color", $value: "oklch(0.5 0 0)" })).toBe(
      "oklch(0.5 0 0)",
    );
  });

  it("converts number values to string", () => {
    expect(formatTokenValue({ $type: "fontWeight", $value: 700 })).toBe("700");
  });

  it("formats cubicBezier 4-tuples as CSS cubic-bezier()", () => {
    expect(
      formatTokenValue({ $type: "cubicBezier", $value: [0.25, 0.1, 0.25, 1] }),
    ).toBe("cubic-bezier(0.25, 0.1, 0.25, 1)");
  });

  it("joins fontFamily arrays with commas, quoting multi-word names", () => {
    expect(
      formatTokenValue({ $type: "fontFamily", $value: ["Inter", "Helvetica Neue", "sans-serif"] }),
    ).toBe('Inter, "Helvetica Neue", sans-serif');
  });
});

describe("emitTokens", () => {
  it("emits an empty result for an empty tree", () => {
    const out = emitTokens({});
    expect(out.css).toBe("");
    expect(out.emittedCount).toBe(0);
    expect(out.collisions).toEqual([]);
  });

  it("buckets a Tailwind-namespaced token into the @theme block", () => {
    const tree: TokenTree = {
      color: { brand: { primary: { $type: "color", $value: "oklch(0.65 0.23 13)" } } },
    };
    const out = emitTokens(tree);
    expect(out.themeBlock).toContain("--color-brand-primary: oklch(0.65 0.23 13);");
    expect(out.rootBlock).toBe("");
  });

  it("buckets a non-Tailwind token into the :root block", () => {
    const tree: TokenTree = {
      app: { density: { $type: "number", $value: 1 } },
    };
    const out = emitTokens(tree);
    expect(out.rootBlock).toContain("--app-density: 1;");
    expect(out.themeBlock).toBe("");
  });

  it("emits both blocks separated by a blank line when both are non-empty", () => {
    const tree: TokenTree = {
      color: { primary: { $type: "color", $value: "oklch(0.6 0.2 30)" } },
      app: { density: { $type: "number", $value: 1 } },
    };
    const out = emitTokens(tree);
    expect(out.css).toMatch(/@theme \{[\s\S]+\}\n\n:root \{[\s\S]+\}/);
  });

  it("emits Tailwind utilities for colors, spacing, and radii", () => {
    const tree: TokenTree = {
      color: { brand: { primary: { $type: "color", $value: "oklch(0.65 0.23 13)" } } },
      spacing: { "4": { $type: "dimension", $value: "16px" } },
      radius: { lg: { $type: "dimension", $value: "12px" } },
    };
    const out = emitTokens(tree);
    expect(out.themeBlock).toContain("--color-brand-primary:");
    expect(out.themeBlock).toContain("--spacing-4:");
    expect(out.themeBlock).toContain("--radius-lg:");
    expect(out.emittedCount).toBe(3);
  });

  it("produces deterministic output (sorted by CSS variable name)", () => {
    const tree: TokenTree = {
      color: {
        brand: { primary: { $type: "color", $value: "oklch(0.65 0.23 13)" } },
        accent: { $type: "color", $value: "oklch(0.7 0.2 200)" },
      },
    };
    const out = emitTokens(tree);
    const lines = out.themeBlock.split("\n").filter((l) => l.includes("--"));
    expect(lines[0]).toContain("--color-accent");
    expect(lines[1]).toContain("--color-brand-primary");
  });

  describe("collision detection", () => {
    it("detects two paths that collapse to the same CSS variable", () => {
      // `color.brand.primary` → --color-brand-primary
      // `color.brand-primary` → --color-brand-primary
      const tree: TokenTree = {
        color: {
          brand: {
            primary: { $type: "color", $value: "oklch(0.65 0.23 13)" },
          },
          "brand-primary": { $type: "color", $value: "oklch(0.5 0.2 13)" },
        },
      };
      const out = emitTokens(tree);
      expect(out.collisions).toHaveLength(1);
      expect(out.collisions[0]!.cssVariable).toBe("--color-brand-primary");
      expect(out.collisions[0]!.paths.sort()).toEqual([
        "color.brand-primary",
        "color.brand.primary",
      ]);
    });

    it("omits colliding paths from emitted CSS (no last-write-wins ambiguity)", () => {
      const tree: TokenTree = {
        color: {
          brand: { primary: { $type: "color", $value: "oklch(0.65 0.23 13)" } },
          "brand-primary": { $type: "color", $value: "oklch(0.5 0.2 13)" },
        },
      };
      const out = emitTokens(tree);
      expect(out.themeBlock).toBe("");
      expect(out.emittedCount).toBe(0);
    });

    it("emits non-colliding tokens even when other paths collide", () => {
      const tree: TokenTree = {
        color: {
          brand: { primary: { $type: "color", $value: "oklch(0.65 0.23 13)" } },
          "brand-primary": { $type: "color", $value: "oklch(0.5 0.2 13)" },
        },
        spacing: { "4": { $type: "dimension", $value: "16px" } },
      };
      const out = emitTokens(tree);
      expect(out.collisions).toHaveLength(1);
      expect(out.themeBlock).toContain("--spacing-4: 16px;");
      expect(out.themeBlock).not.toContain("--color-brand-primary");
      expect(out.emittedCount).toBe(1);
    });

    it("reports an empty collisions array when no clashes exist", () => {
      const tree: TokenTree = {
        color: { brand: { primary: { $type: "color", $value: "oklch(0.65 0.23 13)" } } },
        spacing: { "4": { $type: "dimension", $value: "16px" } },
      };
      expect(emitTokens(tree).collisions).toEqual([]);
    });
  });

  it("handles all 7 v0.3 DTCG types in a realistic tree", () => {
    const tree: TokenTree = {
      color: { primary: { $type: "color", $value: "oklch(0.6 0.2 30)" } },
      spacing: { "4": { $type: "dimension", $value: "1rem" } },
      "font-weight": { bold: { $type: "fontWeight", $value: 700 } },
      duration: { fast: { $type: "duration", $value: "150ms" } },
      ease: {
        "in-out": { $type: "cubicBezier", $value: [0.4, 0, 0.2, 1] },
      },
      font: {
        sans: {
          $type: "fontFamily",
          $value: ["Inter", "system-ui", "sans-serif"],
        },
      },
      app: { density: { $type: "number", $value: 1.25 } },
    };
    const out = emitTokens(tree);
    expect(out.collisions).toEqual([]);
    expect(out.emittedCount).toBe(7);
    // Tailwind-namespaced — go to @theme.
    expect(out.themeBlock).toContain("--color-primary: oklch(0.6 0.2 30);");
    expect(out.themeBlock).toContain("--spacing-4: 1rem;");
    expect(out.themeBlock).toContain("--font-weight-bold: 700;");
    expect(out.themeBlock).toContain("--ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);");
    expect(out.themeBlock).toContain("--font-sans: Inter, system-ui, sans-serif;");
    // Non-Tailwind namespaces — go to :root (still var()-addressable).
    expect(out.rootBlock).toContain("--duration-fast: 150ms;");
    expect(out.rootBlock).toContain("--app-density: 1.25;");
  });
});

describe("emitTokens — Token shape edge cases", () => {
  it("handles tokens without a $type (legacy / unrecognised)", () => {
    const token: Token = { $value: "raw" };
    const tree: TokenTree = { custom: { thing: token } };
    const out = emitTokens(tree);
    expect(out.rootBlock).toContain("--custom-thing: raw;");
  });
});
