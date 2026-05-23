import type { EditorConfig } from "grapesjs";
import { DEFAULT_BLOCKS } from "./blocks.js";
import { STYLE_MANAGER_CONFIG } from "./style-sectors.js";

const TAILWIND_V4_CDN = "https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4";

/**
 * CSS that forces Figma/Penpot "point-text" sizing on text primitives —
 * injected into every frame via {@link attachPrimitiveBaseCss} once the
 * frame's iframe document is live. Kept out of `canvas.styles` (which
 * would need a `data:` URL the headless CI browser sometimes stalls on)
 * so the editor's `canvas:frame:load` never blocks on stylesheet load.
 *
 *   - `display: inline-block` so the box sizes to its content.
 *   - `white-space: nowrap` so glyphs never stack one-per-line when the
 *     parent transiently reports zero width (mount tick, contenteditable
 *     swap, resize handles, etc.).
 *   - `min-width: 1ch` so an empty text box still carries a caret slot.
 *
 * `!important` on display + white-space because GrapesJS's RTE writes
 * its own inline styles when it takes over the element for editing,
 * and without the override those win. `width: max-content` is only
 * `!important` while the user hasn't written an inline width — that
 * way setting width via the inspector still switches the element into
 * wrapping-paragraph mode.
 */
export const PRIMITIVE_BASE_CSS = `
html, body {
  height: 100%;
  margin: 0;
  padding: 0;
}
body {
  background: #ffffff;
}
[data-oc-shape="text"] {
  display: inline-block !important;
  white-space: nowrap !important;
  min-width: 1ch;
}
[data-oc-shape="text"]:not([style*="width"]) {
  width: max-content !important;
}
`;

export const editorOptions: EditorConfig = {
  height: "100%",
  width: "auto",
  storageManager: false,
  canvas: {
    scripts: [TAILWIND_V4_CDN],
    styles: [],
    // Spatial, pannable/zoomable canvas that hosts multiple artboard frames
    // at their own world-coordinates (x/y/width/height per addFrame call).
    // Flagged experimental in GrapesJS 0.22 but is load-bearing for Epic 5.
    infiniteCanvas: true,
  },
  blockManager: {
    blocks: DEFAULT_BLOCKS,
    custom: true,
  },
  styleManager: {
    ...STYLE_MANAGER_CONFIG,
    custom: true,
  },
  layerManager: {
    custom: true,
  },
  traitManager: {
    custom: true,
  },
  panels: { defaults: [] },
  // Honour newline-only text nodes when parsing imported HTML. Without
  // this GrapesJS strips text nodes whose content is purely whitespace
  // (PR https://github.com/GrapesJS/grapesjs/pull/6571 in v0.22.12 made
  // the option actually work — before that it was silently ignored).
  // Load-bearing for captured `<pre>` code blocks whose newlines live
  // in text nodes between syntax-highlighted `<span>` children — without
  // this, code blocks render on a single mashed line.
  parser: {
    optionsHtml: {
      keepEmptyTextNodes: true,
    },
  },
};
