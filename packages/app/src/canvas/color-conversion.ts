/**
 * CSS color → OKLCH canonicalisation — ADR-0009 §2 OKLCH-canonical
 * storage. Inputs in any supported CSS color format come out as OKLCH
 * strings + a `sourceSpace` annotation captured for graceful
 * degradation (e.g. ADR-0008 relay export to Figma's sRGB).
 *
 * Math follows CSS Color 4 (https://www.w3.org/TR/css-color-4/) —
 * sRGB → linear sRGB → XYZ (D65) → OKLab → OKLCH. Pure functions, no
 * deps, fully testable from jsdom. Lab and named-color inputs land in
 * a follow-up; v0.3 covers hex / rgb() / hsl() / oklch() — the formats
 * Tailwind v4 (`@theme` canonical OKLCH) and existing `cssVariables`
 * stores (typically hex / rgb) actually emit.
 */

/** ADR-0009 §2 colorSpace tracker — stored as `$extensions.designjs.colorSpace`. */
export type ColorSpace = "oklch" | "srgb" | "p3";

export interface CanonicalColor {
  /** OKLCH string, e.g. `oklch(0.628 0.258 29.234)`. */
  value: string;
  /** Format the user supplied. Drives lossy-conversion warnings on export. */
  sourceSpace: ColorSpace;
}

// ────────────────────────────────────────────────────────────────────
// Parsers — extract sRGB triples (or OKLCH passthrough) from each
// supported CSS color format. Return null on unrecognised input.
// ────────────────────────────────────────────────────────────────────

/** Returns `{r,g,b}` channels in 0..1 range, or null if not a hex string. */
function parseHex(input: string): { r: number; g: number; b: number } | null {
  const m = /^#([0-9a-f]{3,8})$/i.exec(input.trim());
  if (!m) return null;
  const hex = m[1]!;
  let r: number, g: number, b: number;
  if (hex.length === 3 || hex.length === 4) {
    r = parseInt(hex[0]! + hex[0]!, 16);
    g = parseInt(hex[1]! + hex[1]!, 16);
    b = parseInt(hex[2]! + hex[2]!, 16);
  } else if (hex.length === 6 || hex.length === 8) {
    r = parseInt(hex.slice(0, 2), 16);
    g = parseInt(hex.slice(2, 4), 16);
    b = parseInt(hex.slice(4, 6), 16);
  } else {
    return null;
  }
  return { r: r / 255, g: g / 255, b: b / 255 };
}

function parseRGB(input: string): { r: number; g: number; b: number } | null {
  const m = /^rgba?\(\s*([^)]+)\s*\)$/i.exec(input.trim());
  if (!m) return null;
  // Accept comma-separated or whitespace-separated; alpha-slash supported.
  const inner = m[1]!.replace(/\//g, " ");
  const parts = inner.split(/[,\s]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const channelToUnit = (s: string): number | null => {
    const trimmed = s.trim();
    if (trimmed.endsWith("%")) {
      const n = parseFloat(trimmed);
      return Number.isFinite(n) ? n / 100 : null;
    }
    const n = parseFloat(trimmed);
    return Number.isFinite(n) ? n / 255 : null;
  };
  const r = channelToUnit(parts[0]!);
  const g = channelToUnit(parts[1]!);
  const b = channelToUnit(parts[2]!);
  if (r == null || g == null || b == null) return null;
  return { r, g, b };
}

function parseHSL(input: string): { r: number; g: number; b: number } | null {
  const m = /^hsla?\(\s*([^)]+)\s*\)$/i.exec(input.trim());
  if (!m) return null;
  const inner = m[1]!.replace(/\//g, " ");
  const parts = inner.split(/[,\s]+/).filter(Boolean);
  if (parts.length < 3) return null;
  // Hue: deg / rad / turn / unitless number → degrees.
  const parseHue = (s: string): number | null => {
    const trimmed = s.trim().toLowerCase();
    let n: number;
    if (trimmed.endsWith("turn")) {
      n = parseFloat(trimmed) * 360;
    } else if (trimmed.endsWith("rad")) {
      n = (parseFloat(trimmed) * 180) / Math.PI;
    } else if (trimmed.endsWith("grad")) {
      n = parseFloat(trimmed) * 0.9;
    } else {
      n = parseFloat(trimmed); // deg or unitless
    }
    if (!Number.isFinite(n)) return null;
    return ((n % 360) + 360) % 360;
  };
  const h = parseHue(parts[0]!);
  const sStr = parts[1]!.trim();
  const lStr = parts[2]!.trim();
  if (!sStr.endsWith("%") || !lStr.endsWith("%")) return null;
  const s = parseFloat(sStr) / 100;
  const l = parseFloat(lStr) / 100;
  if (h == null || !Number.isFinite(s) || !Number.isFinite(l)) return null;
  return hslToRgb(h, s, l);
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  // Standard HSL → sRGB (CSS Color 3, used by Color 4 too).
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: f(0), g: f(8), b: f(4) };
}

/** Returns the OKLCH triple in canonical units (L 0..1, C ≥0, H 0..360). */
function parseOKLCH(input: string): { l: number; c: number; h: number } | null {
  const m = /^oklch\(\s*([^)]+)\s*\)$/i.exec(input.trim());
  if (!m) return null;
  const inner = m[1]!.replace(/\//g, " ");
  const parts = inner.split(/[,\s]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const parseL = (s: string): number | null => {
    const t = s.trim();
    const n = t.endsWith("%") ? parseFloat(t) / 100 : parseFloat(t);
    return Number.isFinite(n) ? n : null;
  };
  const parseC = (s: string): number | null => {
    const t = s.trim();
    // Chroma: 0..0.4 typically; CSS allows percent (100% = 0.4).
    if (t.endsWith("%")) {
      const n = parseFloat(t);
      return Number.isFinite(n) ? (n / 100) * 0.4 : null;
    }
    const n = parseFloat(t);
    return Number.isFinite(n) ? n : null;
  };
  const parseHueDeg = (s: string): number | null => {
    const t = s.trim().toLowerCase();
    let n: number;
    if (t.endsWith("turn")) n = parseFloat(t) * 360;
    else if (t.endsWith("rad")) n = (parseFloat(t) * 180) / Math.PI;
    else if (t.endsWith("grad")) n = parseFloat(t) * 0.9;
    else n = parseFloat(t);
    if (!Number.isFinite(n)) return null;
    return ((n % 360) + 360) % 360;
  };
  const l = parseL(parts[0]!);
  const c = parseC(parts[1]!);
  const h = parseHueDeg(parts[2]!);
  if (l == null || c == null || h == null) return null;
  return { l, c, h };
}

// ────────────────────────────────────────────────────────────────────
// sRGB → OKLCH conversion math (CSS Color 4)
// ────────────────────────────────────────────────────────────────────

/** sRGB gamma-decode (channels 0..1, both sides). */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Linear sRGB → OKLab. Composes the sRGB→XYZ(D65) and XYZ→OKLab
 * matrices (Björn Ottosson, https://bottosson.github.io/posts/oklab/).
 */
function linearSrgbToOKLab(r: number, g: number, b: number): {
  L: number;
  a: number;
  b: number;
} {
  // Pre-composed M1 (XYZ→LMS) ∘ (linear sRGB→XYZ) per CSS Color 4 §16.
  const lms_l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const lms_m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const lms_s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const lp = Math.cbrt(lms_l);
  const mp = Math.cbrt(lms_m);
  const sp = Math.cbrt(lms_s);

  return {
    L: 0.2104542553 * lp + 0.793617785 * mp - 0.0040720468 * sp,
    a: 1.9779984951 * lp - 2.428592205 * mp + 0.4505937099 * sp,
    b: 0.0259040371 * lp + 0.7827717662 * mp - 0.808675766 * sp,
  };
}

function oklabToOKLCH(L: number, a: number, b: number): {
  l: number;
  c: number;
  h: number;
} {
  const c = Math.sqrt(a * a + b * b);
  // Atan2 returns -π..π; convert to 0..360 deg. When chroma ≈ 0 hue is
  // meaningless — emit 0 to avoid NaN propagation through downstream
  // string formatting.
  const h = c < 1e-6 ? 0 : (((Math.atan2(b, a) * 180) / Math.PI) % 360 + 360) % 360;
  return { l: L, c, h };
}

function srgbToOKLCH(r: number, g: number, b: number): {
  l: number;
  c: number;
  h: number;
} {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const oklab = linearSrgbToOKLab(lr, lg, lb);
  return oklabToOKLCH(oklab.L, oklab.a, oklab.b);
}

function formatOKLCH(l: number, c: number, h: number): string {
  // Three significant digits is enough for visual fidelity and keeps
  // the emitted CSS readable. CSS Color 4 specifies OKLCH lightness as
  // 0..1 (not %) when bare; we emit bare numbers for stable round-trip.
  const round = (n: number, digits: number) => {
    const factor = 10 ** digits;
    return Math.round(n * factor) / factor;
  };
  return `oklch(${round(l, 4)} ${round(c, 4)} ${round(h, 3)})`;
}

// ────────────────────────────────────────────────────────────────────
// Top-level — canonicaliseColor
// ────────────────────────────────────────────────────────────────────

/**
 * Canonicalise any supported CSS color string to OKLCH, returning the
 * canonical value plus the source-space tag for round-trip annotations.
 *
 * Returns null when the input is not a recognised color literal —
 * named colors, `currentColor`, `var(...)`, system colors, etc. fall
 * through. Callers should treat null as "store as-is, log warning."
 *
 * Pure function; no side effects, no logging. Side-effecting wrappers
 * (e.g. the migration helper) handle the `console.info` notice for
 * non-OKLCH inputs.
 */
export function canonicaliseColor(input: string): CanonicalColor | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed === "") return null;

  // Already OKLCH — passthrough, but renormalise format (round digits,
  // strip extra whitespace) so equality checks downstream are stable.
  const oklchHit = parseOKLCH(trimmed);
  if (oklchHit) {
    return {
      value: formatOKLCH(oklchHit.l, oklchHit.c, oklchHit.h),
      sourceSpace: "oklch",
    };
  }

  // Try sRGB family — hex, rgb(), hsl().
  const rgb = parseHex(trimmed) ?? parseRGB(trimmed) ?? parseHSL(trimmed);
  if (rgb) {
    const oklch = srgbToOKLCH(rgb.r, rgb.g, rgb.b);
    return {
      value: formatOKLCH(oklch.l, oklch.c, oklch.h),
      sourceSpace: "srgb",
    };
  }

  return null;
}
