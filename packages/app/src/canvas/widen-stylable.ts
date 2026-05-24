/**
 * Widen the `stylable` allowlist on GrapesJS built-in component types so
 * captured HTML preserves more of its source styling on import.
 *
 * GrapesJS uses `stylable` two ways:
 *   - On the Style Manager UI: which properties show up in the inspector.
 *   - On the parser / CSS Manager: which properties on inline `style=""`
 *     attributes survive `parseHtml`, and which class-rule properties
 *     get retained when CSS imports through `<style>` blocks.
 *
 * The default for most types is `stylable: true` (allow all), but the
 * built-in `wrapper` type is narrowed to ~7 background-related properties.
 * Our captured-page artboard wraps its content under that wrapper, so any
 * width / height / display / flex / etc. set directly on the wrapper gets
 * dropped on import. This module overrides each built-in type's defaults
 * with a permissive but explicit allowlist — the superset of what our
 * style-serializer emits (NON_INHERITED + INHERITED_DIFF), plus common
 * properties Tailwind / Wikipedia / MDN style with.
 *
 * Why explicit rather than `stylable: true`:
 *   - `true` works at the model layer but in practice we've seen GrapesJS'
 *     CSS Manager still apply per-type filtering on imported class rules.
 *     A literal array forces the wide set through both paths.
 *   - The array also serves as documentation of the captured-fidelity
 *     surface we care about.
 */

import type { Editor } from "grapesjs";

const CAPTURED_FIDELITY_STYLABLE: readonly string[] = [
  // Layout + positioning
  "display", "position", "top", "right", "bottom", "left",
  "float", "clear", "z-index", "overflow", "overflow-x", "overflow-y",
  "visibility", "vertical-align",
  // Dimensions
  "width", "height", "min-width", "min-height", "max-width", "max-height",
  "aspect-ratio", "box-sizing",
  // Spacing (longhand + shorthands GrapesJS may parse separately)
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  // Border (longhand + shorthand)
  "border", "border-width", "border-style", "border-color",
  "border-top", "border-right", "border-bottom", "border-left",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "border-top-style", "border-right-style", "border-bottom-style", "border-left-style",
  "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  "border-radius",
  "border-top-left-radius", "border-top-right-radius",
  "border-bottom-left-radius", "border-bottom-right-radius",
  // Background
  "background", "background-color", "background-image", "background-repeat",
  "background-position", "background-size", "background-attachment",
  "background-clip", "background-origin",
  // Effects
  "box-shadow", "opacity", "transform", "transform-origin",
  "filter", "backdrop-filter", "mix-blend-mode",
  // Flex
  "flex", "flex-direction", "flex-wrap", "gap", "row-gap", "column-gap",
  "justify-content", "align-items", "align-content",
  "flex-grow", "flex-shrink", "flex-basis", "align-self", "order",
  // Grid
  "grid", "grid-template", "grid-template-columns", "grid-template-rows",
  "grid-template-areas",
  "grid-auto-columns", "grid-auto-rows", "grid-auto-flow",
  "grid-column", "grid-row", "grid-area",
  "justify-self", "place-self", "place-items", "place-content",
  // Multi-column
  "column-count", "column-width", "column-fill", "column-span",
  "column-rule", "column-rule-color", "column-rule-style", "column-rule-width",
  "break-inside", "break-before", "break-after",
  // Table
  "border-collapse", "border-spacing", "table-layout",
  "caption-side", "empty-cells",
  // List + counters
  "list-style", "list-style-type", "list-style-position", "list-style-image",
  "counter-increment", "counter-reset", "counter-set",
  // Typography (inherited but per-element overrides matter)
  "font", "font-family", "font-size", "font-weight", "font-style", "font-variant",
  "font-stretch", "font-feature-settings", "font-variation-settings",
  "line-height", "letter-spacing", "word-spacing", "word-break", "word-wrap",
  "white-space", "tab-size", "hyphens",
  "color",
  // Text
  "text-align", "text-align-last", "text-decoration", "text-decoration-line",
  "text-decoration-color", "text-decoration-style", "text-decoration-thickness",
  "text-underline-offset", "text-indent", "text-transform",
  "text-overflow", "text-shadow", "text-orientation",
  // Other
  "cursor", "direction", "writing-mode", "pointer-events", "user-select",
  "content", "appearance", "resize", "scroll-behavior",
];

/**
 * Built-in GrapesJS component types we capture HTML into. The default
 * `stylable: true` should already cover these, but explicit override
 * insures against future GrapesJS regressions and keeps a single source
 * of truth for what captured content can carry.
 *
 * Includes `wrapper` because the artboard's outer wrapper holds capture
 * dimensions (width / height) that the default 7-prop allowlist drops.
 */
const TARGET_TYPES: readonly string[] = [
  "default",
  "wrapper",
  "text",
  "textnode",
  "link",
  "label",
  "image",
  "video",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "row",
  "cell",
  "map",
  "svg",
  "svg-in",
];

export function widenComponentStylable(editor: Editor): void {
  const dom = editor.DomComponents;
  for (const typeName of TARGET_TYPES) {
    const existing = dom.getType(typeName);
    if (!existing) continue;
    // Re-register with an extended model.defaults so the existing model
    // (and View, traits, etc.) are preserved — we're only widening
    // `stylable`. addType used this way is GrapesJS' documented
    // "extend an existing type" pattern.
    dom.addType(typeName, {
      model: {
        defaults: {
          stylable: [...CAPTURED_FIDELITY_STYLABLE],
        },
      },
    });
  }
}
