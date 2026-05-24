import type { Component } from "grapesjs";

/**
 * Read/write helpers that normalize GrapesJS's per-component style access so
 * the semantic-inspector sections can read a CSS property with confidence
 * (GrapesJS's Component.getStyle() returns a lowercase-keyed record but
 * values sometimes come back with trailing whitespace or quoted units).
 */

export function readStyle(component: Component, key: string): string {
  const styles = (component as unknown as { getStyle?: () => Record<string, unknown> }).getStyle?.() ?? {};
  const raw = styles[key];
  if (raw == null) return "";
  return String(raw).trim();
}

export function writeStyle(
  component: Component,
  key: string,
  value: string,
): void {
  const method = (component as unknown as {
    addStyle?: (s: Record<string, string>) => void;
  }).addStyle;
  if (typeof method !== "function") return;
  method.call(component, { [key]: value });
}

/**
 * Read a *computed* CSS property off the component's rendered DOM element
 * inside the GrapesJS iframe. Useful when the component has no explicit
 * style for the property but the inspector wants to show the inherited /
 * default value (e.g., font-size shows "16px" for an unset heading).
 * Returns empty string when the component isn't rendered yet.
 */
export function readComputedStyle(component: Component, key: string): string {
  const el = componentEl(component);
  if (!el) return "";
  const view = el.ownerDocument?.defaultView;
  if (!view) return "";
  const value = view.getComputedStyle(el).getPropertyValue(key);
  return value ? value.trim() : "";
}

/**
 * Component's rendered bounding box inside the GrapesJS iframe, using
 * `offsetLeft` / `offsetTop` (position relative to the nearest
 * positioned ancestor — typically the wrapper for top-level captured
 * content). Returns null when the component isn't rendered yet.
 *
 * Used by the inspector's X/Y row to surface a rendered position for
 * `position: static` elements (where `left` / `top` styles are
 * inactive and would otherwise leave the inputs blank).
 */
export function readBoundingBox(
  component: Component,
): { x: number; y: number; width: number; height: number } | null {
  const el = componentEl(component) as HTMLElement | null;
  if (!el || typeof el.offsetLeft !== "number") return null;
  return {
    x: el.offsetLeft,
    y: el.offsetTop,
    width: el.offsetWidth,
    height: el.offsetHeight,
  };
}

/**
 * Read the *effective* style value for a property: prefer the
 * component's set style (what `readStyle` returns), but fall back to
 * the rendered computed value when the set style is empty.
 *
 * Why: when a page is captured into the canvas via the Chrome
 * extension, GrapesJS' parser routes inline `style=""` declarations
 * into the CSS Manager (keyed by ID) instead of the component model.
 * `readStyle` reads from the component model — so it returns "" for
 * captured elements even though the element renders with the right
 * styles via the CSS Manager rules. The inspector's "what does this
 * element look like?" sections (Fill, Typography, etc.) want the
 * effective value either way.
 *
 * Use this for any property the inspector surfaces as the element's
 * appearance; keep `readStyle` for places where the inspector needs
 * to distinguish "user-set" from "inheriting" (e.g. mode toggles).
 */
export function readEffectiveStyle(component: Component, key: string): string {
  const set = readStyle(component, key);
  if (set) return set;
  return readComputedStyle(component, key);
}

// component.getEl() returns null under GrapesJS v2's multi-frame layout; the
// primary view holds the rendered element reference instead.
function componentEl(component: Component): Element | null | undefined {
  return (
    (component as unknown as { view?: { el?: Element } }).view?.el ??
    (component as unknown as { getEl?: () => Element | null | undefined }).getEl?.()
  );
}

/**
 * Remove a property entirely (as opposed to setting it to empty-string, which
 * GrapesJS treats as a valid value for some property types).
 */
export function clearStyle(component: Component, key: string): void {
  const remove = (component as unknown as {
    removeStyle?: (k: string) => void;
  }).removeStyle;
  if (typeof remove === "function") {
    remove.call(component, key);
    return;
  }
  writeStyle(component, key, "");
}

/**
 * Parse a rotation out of a CSS `transform` value like `rotate(45deg)` or a
 * compound `translateX(10px) rotate(45deg)`. Returns 0 when no rotate.
 */
export function rotationFromTransform(transform: string): number {
  if (!transform) return 0;
  const match = /rotate\((-?\d+(?:\.\d+)?)deg\)/.exec(transform);
  if (!match) return 0;
  return parseFloat(match[1]!);
}

export function transformWithRotation(existing: string, degrees: number): string {
  if (!existing || existing === "none") {
    return degrees === 0 ? "" : `rotate(${degrees}deg)`;
  }
  const replaced = existing.replace(/rotate\(-?\d+(?:\.\d+)?deg\)/g, "");
  const next = replaced.replace(/\s+/g, " ").trim();
  if (degrees === 0) return next || "";
  return next ? `${next} rotate(${degrees}deg)` : `rotate(${degrees}deg)`;
}
