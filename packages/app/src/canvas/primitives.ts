import type { Component, Editor } from "grapesjs";
import { createArtboard, PAGE_ROOT_ATTR } from "./artboards.js";

/**
 * Per ADR-0005: shape-shaped primitive vocabulary mapped to HTML/CSS storage.
 *
 * Each PrimitiveType is the user-facing concept (Penpot's `:rect`, Figma's
 * Rectangle); the corresponding template renders as real HTML on the canvas.
 * Identification on the wire goes through the `data-oc-shape` attribute,
 * which the Layers tree and (future) MCP tooling key off.
 *
 * `frame` is exposed here for completeness — it actually creates a new
 * GrapesJS Frame via `createArtboard` rather than appending an HTML element.
 */
export type PrimitiveType = "frame" | "rectangle" | "ellipse" | "text" | "image" | "group";

export const TEXT_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "span",
  "a",
  "label",
  "button",
]);

/** Concept name shown in the Layers tree and used as the per-frame counter key. */
export const PRIMITIVE_LABEL: Record<PrimitiveType, string> = {
  frame: "Frame",
  rectangle: "Rectangle",
  ellipse: "Ellipse",
  text: "Text",
  image: "Image",
  group: "Group",
};

/**
 * Resolve a Component's primitive concept. Reads `data-oc-shape` first
 * (authoritative per ADR-0005), then falls back to a tagName heuristic so
 * pasted HTML still gets the right icon / label without an explicit attribute.
 *
 * Returns null for components that don't map to a primitive concept (raw
 * containers, semantic-but-unmapped tags like <article>, the GrapesJS
 * wrapper itself, …). Callers fall back to tagName-based behaviour.
 */
export function primitiveTypeOf(component: Component): PrimitiveType | null {
  const attrs =
    (component as unknown as { getAttributes?: () => Record<string, unknown> }).getAttributes?.() ??
    {};
  const shape = attrs["data-oc-shape"];
  if (typeof shape === "string" && isPrimitiveType(shape)) return shape;

  const tag = ((component.get("tagName") as string | undefined) ?? "").toLowerCase();
  if (tag === "img") return "image";
  // Tag in TEXT_TAGS isn't enough — captured pages routinely use <a>, <span>,
  // <button>, <label> as inline containers for non-text content (think the
  // Wikipedia logo: <a> wrapping two <img> children). Promoting those to our
  // `text` primitive mislabels them in the layer tree and surfaces typography
  // controls in the inspector that don't apply. Require actual text content.
  if (TEXT_TAGS.has(tag) && hasOnlyTextContent(component)) return "text";
  return null;
}

/**
 * True if the component's direct children are entirely textnodes (with
 * non-whitespace content) and inline-text-formatting elements (<br>, <strong>,
 * <em>, <code>). False for empty elements and for elements containing any
 * element child outside that small allow-list (<img>, <svg>, nested <div>, …).
 *
 * Used by {@link primitiveTypeOf} and by the inspector's typography /
 * auto-layout applicability checks to distinguish "this is actually text"
 * from "this is a container that happens to use a text-default tag".
 */
const INLINE_TEXT_FORMATTING_TAGS = new Set([
  "br",
  "strong",
  "em",
  "b",
  "i",
  "u",
  "s",
  "small",
  "code",
  "mark",
  "sub",
  "sup",
]);

export function hasOnlyTextContent(component: Component): boolean {
  const children =
    (component.components() as unknown as { toArray: () => Component[] }).toArray();
  if (children.length === 0) return false;
  let sawText = false;
  for (const child of children) {
    const childType = (child.get("type") as string | undefined) ?? "";
    if (childType === "textnode") {
      const content = ((child.get("content") as string | undefined) ?? "").trim();
      if (content) sawText = true;
      continue;
    }
    const childTag = ((child.get("tagName") as string | undefined) ?? "").toLowerCase();
    if (INLINE_TEXT_FORMATTING_TAGS.has(childTag)) {
      // Recurse — inline formatting tags can still wrap real text.
      if (hasOnlyTextContent(child)) sawText = true;
      continue;
    }
    return false;
  }
  return sawText;
}

/**
 * Single source of truth for "is this component actually a text object?"
 * Combines the tag heuristic with a content check so callers (layer tree
 * iconography, typography inspector applicability, auto-layout hiding) all
 * agree on what counts as text. Trusts an explicit `data-oc-shape="text"`
 * marker over the heuristic.
 */
export function isActualTextComponent(component: Component): boolean {
  const attrs =
    (component as unknown as { getAttributes?: () => Record<string, unknown> }).getAttributes?.() ??
    {};
  if (attrs["data-oc-shape"] === "text") return true;
  const tag = ((component.get("tagName") as string | undefined) ?? "").toLowerCase();
  if (!TEXT_TAGS.has(tag)) return false;
  return hasOnlyTextContent(component);
}

/**
 * Tag-based human label used by the Layers tree when no primitive concept
 * applies. Replaces GrapesJS's `getName()` which auto-labels any element with
 * textnode children as "Text", causing a "Text + div icon" mismatch.
 */
const TAG_LABELS: Record<string, string> = {
  div: "Div",
  section: "Section",
  article: "Article",
  aside: "Aside",
  header: "Header",
  footer: "Footer",
  nav: "Nav",
  main: "Main",
  a: "Link",
  button: "Button",
  span: "Span",
  label: "Label",
  ul: "List",
  ol: "List",
  li: "List item",
  p: "Paragraph",
  blockquote: "Quote",
  h1: "Heading 1",
  h2: "Heading 2",
  h3: "Heading 3",
  h4: "Heading 4",
  h5: "Heading 5",
  h6: "Heading 6",
  form: "Form",
  input: "Input",
  textarea: "Textarea",
  select: "Select",
  video: "Video",
  svg: "SVG",
};

export function labelForTag(tag: string | undefined | null): string {
  if (!tag) return "Node";
  const lower = tag.toLowerCase();
  return TAG_LABELS[lower] ?? lower;
}

function isPrimitiveType(s: string): s is PrimitiveType {
  return (
    s === "frame" || s === "rectangle" || s === "ellipse" || s === "text" || s === "image" || s === "group"
  );
}

/**
 * HTML / Tailwind template for each primitive. Exported for tests; the
 * canonical entry-point for production code is {@link createPrimitive}.
 */
export const PRIMITIVE_HTML: Record<Exclude<PrimitiveType, "frame">, string> = {
  rectangle: `<div data-oc-shape="rectangle" class="w-32 h-32 bg-neutral-200"></div>`,
  ellipse: `<div data-oc-shape="ellipse" class="w-32 h-32 rounded-full bg-neutral-200"></div>`,
  // `inline-block w-max` = "point text" in Figma / Penpot parlance: the
  // <p> sizes to its own content width and doesn't participate in the
  // parent's block flow. This is critical on the edit-mode path — a plain
  // block <p> in an unsized parent wrapper (or mid-layout contenteditable
  // swap) collapses to width:0 and wraps one glyph per line. Point-text
  // sizing makes the box self-measuring so editing just grows/shrinks the
  // <p> width against its content, no vertical-glyph meltdown.
  text: `<p data-oc-shape="text" class="inline-block w-max text-base leading-relaxed">Text</p>`,
  image: `<img data-oc-shape="image" src="" alt="" class="max-w-full h-auto" />`,
  // `display: contents` keeps the group invisible to the box model — Figma's
  // Group flattens at export, Penpot's :group is organisational. Same shape.
  group: `<div data-oc-shape="group" class="contents"></div>`,
};

export interface CreatePrimitiveOptions {
  /** Override the auto-generated `"{Concept} {N}"` name. */
  name?: string;
  /** Frame-creation only: width / height / position. */
  width?: number;
  height?: number;
}

export interface CreatedPrimitive {
  type: PrimitiveType;
  /** The primary new component (or, for frames, the new frame's wrapper). */
  component: Component | null;
  /** The chosen display name. */
  name: string;
}

/**
 * Insert a fresh primitive at the canvas. Routes Frame through the existing
 * artboards.ts helper; everything else parses the HTML template into the
 * editor's active wrapper. Tags the new component with `custom-name` set to
 * `"{Concept} {N}"` (per-frame counter) unless the caller overrides via
 * `options.name`.
 */
export function createPrimitive(
  editor: Editor,
  type: PrimitiveType,
  options: CreatePrimitiveOptions = {},
): CreatedPrimitive {
  if (type === "frame") {
    const name = options.name ?? nextNameInScope(editor, "frame");
    const frame = createArtboard(editor, {
      name,
      width: options.width ?? 1440,
      height: options.height ?? 900,
    });
    const wrapper =
      (frame as unknown as { id?: string }) &&
      ((frame as unknown as { component?: Component }).component ?? null);
    return { type, component: wrapper as Component | null, name };
  }

  const html = PRIMITIVE_HTML[type];
  // Per ADR-0006 §4 (canvas model): primitives insert at the Page root — the
  // first Frame on the canvas, which we treat as "the page." Previously
  // `editor.addComponents` targeted the active frame's wrapper, so creating
  // a text inside a just-selected Frame would nest it there; users report
  // that as a bug because the mental model is "text on the canvas, not in
  // a frame." Dragging into a specific Frame after-the-fact is how users
  // opt in to framed placement.
  const pageRoot = getPageRootWrapper(editor);
  const added = pageRoot
    ? ((pageRoot as unknown as { append?: (h: string) => unknown }).append?.(html) as unknown)
    : (editor.addComponents(html) as unknown);
  const list = Array.isArray(added) ? added : [added];
  const created = (list[0] as Component | undefined) ?? null;
  const name = options.name ?? nextNameInScope(editor, type, created ?? undefined);
  if (created) {
    (created as unknown as { set?: (k: string, v: unknown) => void }).set?.("custom-name", name);
  }
  return { type, component: created, name };
}

/**
 * Page-root wrapper lookup — the wrapper Component of the frame marked
 * with {@link PAGE_ROOT_ATTR}. Per ADR-0006 the page-root frame is
 * semantically "the page"; loose primitives attach there instead of the
 * currently-active frame.
 *
 * Closes ADR-0006 Open Question §1 — the previous "first frame in
 * document order" rule was fragile to drag-reorder / deletion / non-
 * deterministic load order. {@link ensurePageRoot} is the single writer
 * of the marker; this is the reader, with a first-frame fallback for
 * legacy projects whose saved data predates the flag.
 */
function getPageRootWrapper(editor: Editor): Component | null {
  const frames = editor.Canvas.getFrames?.() ?? [];
  if (frames.length === 0) return null;
  for (const f of frames) {
    const wrapper = (f as unknown as { get?: (k: string) => unknown }).get?.(
      "component",
    ) as
      | (Component & { getAttributes?: () => Record<string, unknown> })
      | undefined;
    const attrs = wrapper?.getAttributes?.() ?? {};
    if (attrs[PAGE_ROOT_ATTR] != null) return wrapper ?? null;
  }
  // Legacy fallback — pre-`ensurePageRoot` projects don't carry the
  // marker. Treat the first frame in document order as the page root,
  // matching the original behaviour.
  const first = frames[0] as unknown as { get?: (k: string) => unknown };
  const wrapper = first.get?.("component");
  return (wrapper as Component | undefined) ?? null;
}

/**
 * `"{Concept} {N}"` where N is the count of existing primitives of the same
 * type within the same frame's wrapper, plus one. Walks the wrapper that
 * contains the new component (not the editor-level wrapper) so multi-frame
 * scenes count per-frame.
 */
function nextNameInScope(
  editor: Editor,
  type: PrimitiveType,
  reference?: Component,
): string {
  const wrapper = scopeWrapperFor(editor, reference);
  const concept = PRIMITIVE_LABEL[type];

  let count = 0;
  if (wrapper) {
    walk(wrapper, (c) => {
      if (c === reference) return; // exclude the just-inserted node from the count
      if (primitiveTypeOf(c) === type) count += 1;
    });
  }

  // For frames, count via Canvas.getFrames() since they aren't children of any
  // single wrapper.
  if (type === "frame") {
    const frames = editor.Canvas.getFrames?.() ?? [];
    return `${concept} ${frames.length + 1}`;
  }

  return `${concept} ${count + 1}`;
}

function scopeWrapperFor(editor: Editor, reference?: Component): Component | null {
  if (reference) {
    const parent = (reference as unknown as { parent?: () => Component | undefined }).parent?.();
    if (parent) return parent;
  }
  return (editor.getWrapper?.() as Component | null) ?? null;
}

function walk(root: Component, visit: (c: Component) => void): void {
  const stack: Component[] = [root];
  while (stack.length > 0) {
    const c = stack.pop()!;
    visit(c);
    const children = (c.components() as unknown as { toArray: () => Component[] }).toArray();
    for (const child of children) stack.push(child);
  }
}

/**
 * For text-bearing components, return the literal text content (first
 * textnode child's content, or the component's own `content` field if it
 * IS a textnode). Used by the Layers tree to derive a row label like
 * "Text · Hello, world".
 */
export function textContentOf(component: Component): string {
  const type = (component.get("type") as string | undefined) ?? "";
  if (type === "textnode") {
    const content = (component.get("content") as string | undefined) ?? "";
    return content.trim();
  }
  const childArray = (component.components() as unknown as { toArray: () => Component[] }).toArray();
  if (childArray.length === 1) {
    const child = childArray[0]!;
    if ((child.get("type") as string | undefined) === "textnode") {
      const content = (child.get("content") as string | undefined) ?? "";
      return content.trim();
    }
  }
  return "";
}
