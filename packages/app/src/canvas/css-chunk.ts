/**
 * Split a CSS string into chunks at rule boundaries.
 *
 * Why: GrapesJS' `editor.Css.addRules(cssText)` returns 0 rules when the
 * input contains a single rule it can't handle, discarding the entire
 * batch — verified at 549KB of Wikipedia author + dedup CSS (head 5KB
 * alone parsed 43 rules; the full string yielded 0). Chunking limits each
 * `addRules` call's blast radius to one chunk; a single failing rule
 * loses only its chunk's worth of CSS rather than the whole capture's.
 *
 * Algorithm: walk the string, track brace depth, emit a chunk every time
 * depth returns to zero AND the running chunk is ≥ `maxChunkSize`. This
 * guarantees:
 *   - Every chunk ends on a top-level `}` (or is the tail).
 *   - No at-rule (`@media`, `@supports`, `@keyframes`, ...) is split
 *     across chunks — its inner braces stay above depth 0.
 *   - Chunks may exceed `maxChunkSize` when a single at-rule's body is
 *     bigger than the window. Going large beats going invalid.
 *
 * The chunk size of 32KB was chosen empirically: the failure point on
 * Wikipedia's CSS sat above 5KB but below 549KB; 32KB keeps each call
 * comfortably within what's known to parse while still bundling many
 * rules per call (~250 at typical density), so the round-trip count
 * stays reasonable.
 */
export function chunkCss(css: string, maxChunkSize = 32_000): string[] {
  if (css.length <= maxChunkSize) return [css];
  const chunks: string[] = [];
  let chunkStart = 0;
  let depth = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && i - chunkStart + 1 >= maxChunkSize) {
        chunks.push(css.slice(chunkStart, i + 1));
        chunkStart = i + 1;
      }
    }
  }
  if (chunkStart < css.length) {
    chunks.push(css.slice(chunkStart));
  }
  return chunks;
}
