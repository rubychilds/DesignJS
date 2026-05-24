/**
 * DTCG JSON import / export — ADR-0009 §7.
 *
 * Pure data-layer plumbing: parse a DTCG-shaped JSON document into a
 * {@link TokenTree} (with shape validation + type-aware
 * canonicalisation for color tokens), and serialise a TokenTree back
 * to the same on-disk shape. Phase 1 ships this as a library only —
 * the Topbar `Cmd+Shift+E` export affordance and `tokens.json`
 * project-root auto-discovery are Phase 3 (§9 surfaces).
 *
 * Round-trip target: Tokens Studio + Style Dictionary parse our output
 * without translation. We don't import their proprietary extensions
 * ($extensions.com.tokens-studio.*); they pass through opaquely
 * because DTCG's $extensions field is by-design a typed-by-the-emitter
 * escape hatch.
 */

import { canonicaliseColor } from "./color-conversion.js";
import {
  isToken,
  type DTCGType,
  type Token,
  type TokenTree,
} from "./tokens.js";

const KNOWN_TYPES: ReadonlySet<DTCGType> = new Set([
  "color",
  "dimension",
  "number",
  "duration",
  "cubicBezier",
  "fontFamily",
  "fontWeight",
]);

export interface ParseResult {
  /** Parsed tree, even when warnings exist (best-effort recovery). */
  tree: TokenTree;
  /** Non-fatal issues — unknown $types, malformed extensions, etc. */
  warnings: string[];
}

/**
 * Parse a DTCG JSON document into a TokenTree. Accepts either a JSON
 * string (parses internally) or a plain object (skip parsing).
 *
 * Color tokens whose `$value` is an sRGB/HSL/hex literal are
 * canonicalised to OKLCH per ADR §2 and tagged with
 * `$extensions.designjs.colorSpace` — same behaviour as
 * {@link inflateFromCssVariables}. Already-OKLCH values pass through
 * (renormalised to stable precision).
 *
 * Throws on malformed JSON; returns warnings for non-fatal recovery
 * (unknown types, drop-with-note unrecognised shapes).
 */
export function parseDTCG(input: string | object): ParseResult {
  const raw = typeof input === "string" ? JSON.parse(input) : input;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("parseDTCG: input must be a JSON object");
  }
  const warnings: string[] = [];
  const tree = walkAndNormalise(raw as Record<string, unknown>, [], warnings);
  return { tree, warnings };
}

function walkAndNormalise(
  node: Record<string, unknown>,
  path: string[],
  warnings: string[],
): TokenTree {
  const out: TokenTree = {};
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("$")) {
      // Skip top-level metadata at this layer (e.g. $description on a
      // group). DTCG allows it; we don't model it explicitly in v0.3.
      continue;
    }
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
      // Bare scalar / array at a non-leaf position is a malformed input.
      warnings.push(
        `Dropped non-object node at ${[...path, key].join(".")}: expected group or token`,
      );
      continue;
    }
    const child = value as Record<string, unknown>;
    if ("$value" in child) {
      const token = normaliseToken(child, [...path, key], warnings);
      if (token) out[key] = token;
    } else {
      out[key] = walkAndNormalise(child, [...path, key], warnings);
    }
  }
  return out;
}

function normaliseToken(
  raw: Record<string, unknown>,
  path: string[],
  warnings: string[],
): Token | null {
  const $value = raw.$value as Token["$value"];
  const $type = typeof raw.$type === "string" ? (raw.$type as DTCGType) : undefined;
  const $description = typeof raw.$description === "string" ? raw.$description : undefined;
  const $extensions =
    raw.$extensions != null && typeof raw.$extensions === "object" && !Array.isArray(raw.$extensions)
      ? ({ ...(raw.$extensions as Record<string, unknown>) })
      : undefined;

  if ($type && !KNOWN_TYPES.has($type)) {
    warnings.push(
      `Unknown $type "${$type}" at ${path.join(".")} — preserved as-is, no validation applied`,
    );
  }

  // Color canonicalisation per §2 — matches inflateFromCssVariables.
  if ($type === "color" && typeof $value === "string") {
    const canon = canonicaliseColor($value);
    if (canon) {
      // Preserve an existing `designjs.colorSpace` annotation if the
      // import file already carried one — that's the *original* source
      // space, which we need to keep across round-trips. Add the
      // annotation only when missing (e.g. importing from a foreign
      // DTCG file that didn't tag it).
      const ext = { ...($extensions ?? {}) };
      if (ext["designjs.colorSpace"] == null) {
        ext["designjs.colorSpace"] = canon.sourceSpace;
      }
      const token: Token = {
        $type: "color",
        $value: canon.value,
        $extensions: ext,
      };
      if ($description) token.$description = $description;
      return token;
    }
    // Unrecognised literal — preserve raw, emit warning.
    warnings.push(
      `Color value at ${path.join(".")} is not a recognised CSS color literal; preserved as-is`,
    );
  }

  const token: Token = { $value };
  if ($type) token.$type = $type;
  if ($description) token.$description = $description;
  if ($extensions) token.$extensions = $extensions;
  return token;
}

/**
 * Serialise a TokenTree back to a JSON string ready to write to a
 * `tokens.json` file or hand to the user via Topbar export. Output is
 * pretty-printed with 2-space indent for diff-friendliness.
 *
 * Round-trips losslessly: parseDTCG(serialiseDTCG(tree)) ≡ tree, modulo
 * color canonicalisation (which is idempotent for already-OKLCH input,
 * the post-Chunk-B storage format).
 */
export function serialiseDTCG(tree: TokenTree): string {
  return JSON.stringify(toJSON(tree), null, 2);
}

function toJSON(node: TokenTree | Token): Record<string, unknown> | unknown {
  if (isToken(node)) {
    const out: Record<string, unknown> = { $value: node.$value };
    if (node.$type) out.$type = node.$type;
    if (node.$description) out.$description = node.$description;
    if (node.$extensions) out.$extensions = node.$extensions;
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(node)) {
    out[key] = toJSON(child);
  }
  return out;
}
