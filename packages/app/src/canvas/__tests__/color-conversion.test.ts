import { describe, it, expect } from "vitest";
import { canonicaliseColor } from "../color-conversion";

/**
 * Sanity tests for ADR-0009 §2 OKLCH-canonical color conversion.
 *
 * Numerical OKLCH outputs come from CSS Color 4 reference computations
 * (https://www.w3.org/TR/css-color-4/) — we assert to 3 decimal places
 * because formatOKLCH rounds to that precision and floating-point
 * accumulation across the matrix ops makes anything tighter brittle
 * across runtimes.
 */

function approx(actual: number, expected: number, tolerance = 0.005) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

function parseOKLCHTriple(s: string): { l: number; c: number; h: number } {
  const m = /^oklch\(([^)]+)\)$/.exec(s);
  expect(m).not.toBeNull();
  const [l, c, h] = m![1]!.trim().split(/\s+/).map(Number) as [number, number, number];
  return { l, c, h };
}

describe("canonicaliseColor", () => {
  describe("hex", () => {
    it("converts pure white to oklch(1 0 *)", () => {
      const out = canonicaliseColor("#ffffff");
      expect(out).not.toBeNull();
      expect(out!.sourceSpace).toBe("srgb");
      const { l, c } = parseOKLCHTriple(out!.value);
      approx(l, 1);
      approx(c, 0);
    });

    it("converts pure black to oklch(0 0 *)", () => {
      const out = canonicaliseColor("#000000");
      expect(out).not.toBeNull();
      const { l, c } = parseOKLCHTriple(out!.value);
      approx(l, 0);
      approx(c, 0);
    });

    it("converts pure red (#ff0000) to ~oklch(0.628 0.258 29.234)", () => {
      const out = canonicaliseColor("#ff0000");
      expect(out).not.toBeNull();
      const { l, c, h } = parseOKLCHTriple(out!.value);
      approx(l, 0.628);
      approx(c, 0.258, 0.01);
      approx(h, 29.234, 0.5);
    });

    it("expands 3-digit hex (#f00 → #ff0000)", () => {
      const long = canonicaliseColor("#ff0000")!.value;
      const short = canonicaliseColor("#f00")!.value;
      expect(short).toBe(long);
    });

    it("handles hex with hash variants and case insensitivity", () => {
      const a = canonicaliseColor("#FF0000")!.value;
      const b = canonicaliseColor("#ff0000")!.value;
      expect(a).toBe(b);
    });

    it("returns null for malformed hex", () => {
      expect(canonicaliseColor("#xyz")).toBeNull();
      expect(canonicaliseColor("#")).toBeNull();
      expect(canonicaliseColor("#12")).toBeNull();
    });
  });

  describe("rgb()", () => {
    it("converts rgb(255, 0, 0) identically to #ff0000", () => {
      const hex = canonicaliseColor("#ff0000")!.value;
      const rgb = canonicaliseColor("rgb(255, 0, 0)")!.value;
      expect(rgb).toBe(hex);
    });

    it("accepts whitespace-separated rgb(255 0 0)", () => {
      const out = canonicaliseColor("rgb(255 0 0)");
      expect(out).not.toBeNull();
      const { l } = parseOKLCHTriple(out!.value);
      approx(l, 0.628);
    });

    it("accepts percent channels", () => {
      const a = canonicaliseColor("rgb(100%, 0%, 0%)")!.value;
      const b = canonicaliseColor("#ff0000")!.value;
      expect(a).toBe(b);
    });

    it("returns null for malformed rgb()", () => {
      expect(canonicaliseColor("rgb(255, 0)")).toBeNull();
      expect(canonicaliseColor("rgb()")).toBeNull();
    });
  });

  describe("hsl()", () => {
    it("converts hsl(0, 100%, 50%) identically to #ff0000", () => {
      const hsl = canonicaliseColor("hsl(0, 100%, 50%)")!.value;
      const hex = canonicaliseColor("#ff0000")!.value;
      expect(hsl).toBe(hex);
    });

    it("converts hsl(120, 100%, 50%) to pure green", () => {
      const a = canonicaliseColor("hsl(120, 100%, 50%)")!.value;
      const b = canonicaliseColor("#00ff00")!.value;
      expect(a).toBe(b);
    });

    it("accepts hue in turns", () => {
      const turn = canonicaliseColor("hsl(0.5turn 100% 50%)")!.value;
      const deg = canonicaliseColor("hsl(180 100% 50%)")!.value;
      expect(turn).toBe(deg);
    });
  });

  describe("oklch() passthrough", () => {
    it("normalises an already-OKLCH input", () => {
      const out = canonicaliseColor("oklch(0.628 0.258 29.234)");
      expect(out).not.toBeNull();
      expect(out!.sourceSpace).toBe("oklch");
      const { l, c, h } = parseOKLCHTriple(out!.value);
      approx(l, 0.628);
      approx(c, 0.258);
      approx(h, 29.234);
    });

    it("accepts L as percent", () => {
      const out = canonicaliseColor("oklch(50% 0.1 180)");
      const { l } = parseOKLCHTriple(out!.value);
      approx(l, 0.5);
    });

    it("accepts slash-separated alpha (which we ignore for now)", () => {
      const out = canonicaliseColor("oklch(0.5 0.1 180 / 0.5)");
      expect(out).not.toBeNull();
    });
  });

  describe("graceful failure", () => {
    it("returns null for named colors (deferred to follow-up)", () => {
      expect(canonicaliseColor("red")).toBeNull();
      expect(canonicaliseColor("transparent")).toBeNull();
    });

    it("returns null for var() references", () => {
      expect(canonicaliseColor("var(--primary)")).toBeNull();
    });

    it("returns null for the empty string", () => {
      expect(canonicaliseColor("")).toBeNull();
      expect(canonicaliseColor("   ")).toBeNull();
    });

    it("returns null for non-string inputs", () => {
      // @ts-expect-error — runtime guard, not a TypeScript-time check
      expect(canonicaliseColor(null)).toBeNull();
      // @ts-expect-error
      expect(canonicaliseColor(undefined)).toBeNull();
    });
  });

  describe("source space tracking", () => {
    it("flags hex inputs as sRGB", () => {
      expect(canonicaliseColor("#ff0000")!.sourceSpace).toBe("srgb");
    });

    it("flags rgb() inputs as sRGB", () => {
      expect(canonicaliseColor("rgb(0, 128, 255)")!.sourceSpace).toBe("srgb");
    });

    it("flags hsl() inputs as sRGB", () => {
      expect(canonicaliseColor("hsl(180, 100%, 50%)")!.sourceSpace).toBe("srgb");
    });

    it("flags oklch() inputs as oklch", () => {
      expect(canonicaliseColor("oklch(0.5 0.1 180)")!.sourceSpace).toBe("oklch");
    });
  });
});
