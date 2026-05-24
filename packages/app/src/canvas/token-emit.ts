/**
 * Tailwind v4 `@theme` dual-emit + collision detection — ADR-0009 §5.
 *
 * Walks the DTCG token tree and emits two CSS blocks ready to inject
 * into each frame's iframe `<head>`:
 *
 *  1. `@theme { … }` for tokens whose CSS variable name matches a
 *     Tailwind namespace (`--color-*`, `--spacing-*`, etc.). These
 *     auto-generate utilities — `bg-brand-primary`, `p-4`, `rounded-lg`
 *     — without users plumbing anything. This is the "disproportionate
 *     value prop" bullet from the Consequences section.
 *  2. `:root { --token: value; }` for everything else. Addressable via
 *     `var(--token)` in user CSS; doesn't generate utilities.
 *
 * Modes (`@theme` plus `:root[data-designjs-mode="dark"]` overrides) are
 * a Phase 2 feature per ADR §10. Phase 1 emits default-mode only.
 *
 * Collision detection (ADR §7 / §5 Name-collision-detection) — the
 * path-to-CSS-variable transform in `tokens.ts` is deterministic but
 * not injective: `color.brand.primary` and `color.brand-primary` both
 * map to `--color-brand-primary`. When detected, the colliding paths
 * are *omitted* from the emitted CSS (so no last-write-wins ambiguity
 * lands in the canvas) and surfaced in the result so UI can show the
 * conflict badge. Non-colliding tokens emit normally — a single
 * collision shouldn't break a hundred working utilities.
 */

import { pathToCssVariable, walkTokens, type Token, type TokenTree } from "./tokens.js";

/**
 * CSS variable prefixes Tailwind v4 recognises in `@theme` and uses to
 * generate utility classes. Sourced from
 * https://tailwindcss.com/docs/theme — the v0.3 set covers the
 * mainstream: color, spacing, typography, radius, shadow, easing,
 * breakpoints. Any new Tailwind namespace can be added here without
 * touching the rest of the emitter.
 */
const TAILWIND_NAMESPACES: readonly string[] = [
  "--color-",
  "--spacing-",
  "--font-",
  "--font-weight-",
  "--text-",
  "--tracking-",
  "--leading-",
  "--radius-",
  "--shadow-",
  "--inset-shadow-",
  "--drop-shadow-",
  "--blur-",
  "--perspective-",
  "--ease-",
  "--animate-",
  "--breakpoint-",
  "--container-",
];

export interface Collision {
  /** The CSS variable name two-or-more tokens collapse to. */
  cssVariable: string;
  /** Dotted paths that all transform to the same variable. */
  paths: string[];
}

export interface EmittedTokens {
  /**
   * The `@theme { … }` block, or the empty string when no Tailwind-
   * namespaced tokens are present.
   */
  themeBlock: string;
  /**
   * The `:root { … }` block, or the empty string when no
   * non-namespaced tokens are present.
   */
  rootBlock: string;
  /**
   * Combined CSS ready for injection — `themeBlock` then `rootBlock`,
   * separated by a blank line. Empty when both blocks are empty.
   */
  css: string;
  /** Number of tokens that emitted (excludes colliders). */
  emittedCount: number;
  /** Detected collisions; empty array means clean. */
  collisions: Collision[];
}

export function isTailwindNamespace(cssVariable: string): boolean {
  return TAILWIND_NAMESPACES.some((prefix) => cssVariable.startsWith(prefix));
}

/**
 * Format a token's value as it should appear in CSS. DTCG values can
 * be strings (most types), numbers (number / fontWeight), or arrays
 * (cubicBezier, fontFamily). We collapse to a CSS-friendly string.
 */
export function formatTokenValue(token: Token): string {
  const v = token.$value;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) {
    if (token.$type === "cubicBezier" && v.length === 4) {
      return `cubic-bezier(${(v as number[]).join(", ")})`;
    }
    if (token.$type === "fontFamily") {
      // Wrap multi-word names in quotes; pass through identifiers.
      return (v as string[])
        .map((s) => (/[\s"',]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s))
        .join(", ");
    }
    return v.join(", ");
  }
  return String(v);
}

/**
 * Emit `@theme` + `:root` blocks for the given tree. Default-mode only
 * (modes are a Phase 2 feature). Colliding paths are omitted from the
 * emitted CSS and reported in the `collisions` array so UI can surface
 * the conflict; non-colliding tokens emit normally.
 */
export function emitTokens(tree: TokenTree): EmittedTokens {
  // First pass — bucket every (path, token) into its target CSS
  // variable name and detect collisions. We need the full collision
  // map before emission so colliders can be excluded cleanly.
  const byVariable = new Map<string, Array<{ path: string; token: Token }>>();
  for (const { path, token } of walkTokens(tree)) {
    const cssVar = pathToCssVariable(path);
    const bucket = byVariable.get(cssVar) ?? [];
    bucket.push({ path, token });
    byVariable.set(cssVar, bucket);
  }

  const collisions: Collision[] = [];
  const themeLines: string[] = [];
  const rootLines: string[] = [];
  let emittedCount = 0;

  // Stable iteration — sort by CSS variable name for deterministic
  // output across runs. Helps test snapshots and reduces diff noise on
  // re-emission after a single token edit.
  const sortedVars = Array.from(byVariable.keys()).sort();
  for (const cssVar of sortedVars) {
    const entries = byVariable.get(cssVar)!;
    if (entries.length > 1) {
      collisions.push({
        cssVariable: cssVar,
        paths: entries.map((e) => e.path).sort(),
      });
      // Skip emission for colliders — no last-write-wins ambiguity
      // reaches the canvas.
      continue;
    }
    const entry = entries[0]!;
    const declaration = `  ${cssVar}: ${formatTokenValue(entry.token)};`;
    if (isTailwindNamespace(cssVar)) themeLines.push(declaration);
    else rootLines.push(declaration);
    emittedCount += 1;
  }

  const themeBlock = themeLines.length > 0 ? `@theme {\n${themeLines.join("\n")}\n}` : "";
  const rootBlock = rootLines.length > 0 ? `:root {\n${rootLines.join("\n")}\n}` : "";
  const css = [themeBlock, rootBlock].filter(Boolean).join("\n\n");

  return { themeBlock, rootBlock, css, emittedCount, collisions };
}

/**
 * Variant that takes a flat `Record<string, string>` (the legacy
 * `cssVariables` shape that `variables.ts` still exposes through Phase 1).
 * Inflates to a tree via `inflateFromCssVariables` and emits. Keeps
 * the existing flat-store callers operational without forcing them to
 * walk DTCG-shaped data they don't yet understand.
 */
// Re-export for callers that pass the flat shape. Implementation lives
// in `tokens.ts` to avoid a cyclic import.
export { inflateFromCssVariables, isToken } from "./tokens.js";
export type { Token, TokenTree } from "./tokens.js";
