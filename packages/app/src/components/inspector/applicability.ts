import type { Component } from "grapesjs";
import { hasOnlyTextContent } from "../../canvas/primitives.js";

/**
 * Applicability predicates used by the inspector to decide whether a given
 * style control should render as enabled or greyed-out-disabled. The rule
 * of thumb: hide a section entirely only when it carries nothing meaningful
 * for the selection (e.g. Typography on a <div>); grey out an individual
 * control when the surrounding section is still relevant but the specific
 * property produces no visible effect for this kind of element.
 *
 * Predicates are tag-keyed for cheapness, but the text-object checks also
 * verify the component actually contains text — otherwise <a> and <button>
 * wrapping images (think the Wikipedia logo) get treated as text and the
 * inspector hides auto-layout while showing typography that does nothing.
 */

/**
 * Inline text tags where the box model collapses onto the glyph run: a
 * `border-radius` on an <em> without a background or border produces no
 * visible change, so the control would mislead. We treat these as "text
 * objects" in the Figma/Penpot sense.
 *
 * Block-level text containers (<h1>–<h6>, <p>, <blockquote>, <button>, <li>)
 * stay eligible because pill-shaped buttons and rounded callouts are a
 * routine pattern.
 */
const INLINE_TEXT_TAGS = new Set([
  "span",
  "a",
  "strong",
  "em",
  "small",
  "code",
  "label",
]);

/**
 * Any tag whose primary purpose is rendering text — both inline runs and
 * block-level headings / paragraphs. Auto-layout doesn't make sense on
 * these: Figma and Penpot both treat text as a terminal leaf node, not a
 * flex container. The user can still apply `display: flex` via Raw CSS
 * for advanced cases.
 */
const TEXT_TAGS = new Set([
  ...INLINE_TEXT_TAGS,
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "li",
  "button",
]);

function tagOf(component: Component): string {
  return String(component.get?.("tagName") ?? "").toLowerCase();
}

/** Is this an inline text run where box-model visuals typically do nothing? */
export function isInlineTextObject(component: Component): boolean {
  return INLINE_TEXT_TAGS.has(tagOf(component)) && hasOnlyTextContent(component);
}

/** Is this component a text-bearing tag (inline or block text container)? */
export function isTextObject(component: Component): boolean {
  return TEXT_TAGS.has(tagOf(component)) && hasOnlyTextContent(component);
}

/**
 * Border radius is N/A on bare inline text — no background or border for
 * the radius to round. Consumers should grey out the radius control in
 * this case rather than hide it, so the row stays visible and the user
 * understands why it's unresponsive.
 */
export function isRadiusApplicable(component: Component): boolean {
  return !isInlineTextObject(component);
}

/**
 * Auto-layout (flex / grid on the parent) isn't meaningful on a text
 * element — text objects are leaves in the design model. Consumers should
 * hide the auto-layout toggle entirely rather than grey it, since there's
 * no analogue the user is missing out on.
 */
export function isAutoLayoutApplicable(component: Component): boolean {
  return !isTextObject(component);
}
