/**
 * Pull the `<style data-designjs-*>` blocks out of the serializer's output
 * HTML so they can be routed to the canvas via the `add_css_rules` bridge
 * tool instead of travelling inside the import HTML.
 *
 * Why: GrapesJS' `parseHtml` silently strips `<style>` elements during
 * import (verified live on Wikipedia "Love": 0 of 1,949 iframe stylesheets
 * carried any of our author or dedup rule when the blocks rode in the HTML).
 * The only path that lands captured CSS in the canvas iframe is the
 * editor's CSS Manager API. This helper is the load-bearing connection
 * between the serializer's output and the new bridge tool — if the regex
 * stops matching, dedup CSS silently stops landing and Wikipedia anchors
 * fall back to UA defaults again.
 *
 * Markers extracted (in cascade-priority order — author first so computed/
 * dedup wins on ties, matching the implicit DOM-order cascade we'd have
 * had if the blocks were inline children of the captured wrapper):
 *
 *   - data-designjs-author  — collected from source page's stylesheets
 *   - data-designjs-dedup   — promoted classes from mode:"inline" dedup
 *   - data-designjs-capture — computed-mode hoist (mode:"computed" only)
 */

const STYLE_MARKERS = ["author", "dedup", "capture"] as const;

export interface ExtractedStyles {
  /** Concatenated CSS bodies (with `\n` joins) from all matched blocks. */
  cssText: string;
  /** Original HTML with the `<style data-designjs-*>` blocks removed. */
  htmlWithoutStyles: string;
  /** Number of matched blocks — useful for logging / diagnostics. */
  blockCount: number;
}

export function extractStyleBlocks(html: string): ExtractedStyles {
  const cssBlocks: string[] = [];
  let htmlWithoutStyles = html;
  for (const marker of STYLE_MARKERS) {
    const re = new RegExp(
      `<style data-designjs-${marker}="">([\\s\\S]*?)<\\/style>`,
      "g",
    );
    htmlWithoutStyles = htmlWithoutStyles.replace(re, (_match, css: string) => {
      if (css && css.length > 0) cssBlocks.push(css);
      return "";
    });
  }
  return {
    cssText: cssBlocks.join("\n"),
    htmlWithoutStyles,
    blockCount: cssBlocks.length,
  };
}
