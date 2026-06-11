/**
 * Typed escape hatches for GrapesJS's Backbone-shaped runtime.
 *
 * GrapesJS exports types for Editor, Component, Frame etc., but the runtime
 * returns shapes those types don't capture — `Component.get('field')` is
 * typed `unknown`, `Frame` carries both `cid` and `id` properties depending
 * on which collection you walk, `Component.getClasses()` returns either
 * `string[]` or Selector models, `component.components()` returns a Backbone
 * collection whose `.toArray()` isn't on the public type, etc.
 *
 * The codebase pays for this via inline `as unknown as { ... }` casts
 * scattered through `bridge/handlers.ts` and several `canvas/*` modules.
 * This module localises the unsafety — call sites use the typed helpers
 * instead of rewriting the cast.
 *
 * Per F.06 from docs/architecture/architecture-codebase.md § 3.2 + § 5.4.
 */
import type { Component, Editor, Frame } from "grapesjs";

/**
 * Read a Backbone-style field off a Component (or Frame) as a known type.
 * GrapesJS's runtime stores model fields under `.get(key)` returning unknown;
 * this helper casts the result to the caller's expected type via a generic.
 *
 * Returns `undefined` when the model has no `get` method (defensive — some
 * mock fixtures and edge cases in the multi-frame layout produce stripped
 * objects). Callers that need to distinguish "field absent" from "field
 * present but undefined" should check the underlying shape directly.
 */
export function getComponentField<T = unknown>(
  c: Component | Frame,
  key: string,
): T | undefined {
  const fn = (c as unknown as { get?: (k: string) => unknown }).get;
  return typeof fn === "function" ? (fn.call(c, key) as T) : undefined;
}

/**
 * Pull the wrapper Component off a Frame (`frame.get("component")`).
 *
 * Under the multi-frame v0.22 layout, `add_components` with an artboardId
 * lands content in this wrapper for the specific frame — which may not be
 * the wrapper `editor.getWrapper()` returns. Most cross-frame walks need
 * this helper to reach into each frame's tree.
 */
export function getFrameWrapper(f: Frame): Component | undefined {
  return getComponentField<Component>(f, "component");
}

/**
 * Pull every plausible id for a Frame: getId(), cid, id — in order, deduped.
 *
 * Backbone models carry a `cid` (e.g. `"c69"`), an optional model `id`, and
 * a `getId()` that may return either. Phase B's `artboards.ts.readFrameData`
 * reads them in one order; the bridge sometimes sees a different one back.
 * Match against the union to be robust.
 */
export function getFrameIds(f: Frame): string[] {
  const ids: string[] = [];
  const get = (f as unknown as { getId?: () => unknown }).getId;
  if (typeof get === "function") {
    const v = get.call(f);
    if (typeof v === "string" && v) ids.push(v);
  }
  const cid = (f as unknown as { cid?: unknown }).cid;
  if (typeof cid === "string" && cid && !ids.includes(cid)) ids.push(cid);
  const id = (f as unknown as { id?: unknown }).id;
  if (typeof id === "string" && id && !ids.includes(id)) ids.push(id);
  return ids;
}

/**
 * The "primary" id for a Frame: cid first (stable per-session), then id,
 * empty string if neither resolves. Mirrors the shape `artboards.ts` uses
 * for its frame-by-id lookups (`String(frame.cid ?? frame.id ?? "")`).
 *
 * Prefer this over `getFrameIds()[0]` when you want exactly one id — the
 * ordering here matches the artboards-listing path so ids stay stable
 * across callers.
 */
export function getFrameId(f: Frame): string {
  const cid = (f as unknown as { cid?: unknown }).cid;
  if (typeof cid === "string" && cid) return cid;
  const id = (f as unknown as { id?: unknown }).id;
  if (typeof id === "string" && id) return id;
  return "";
}

/**
 * Pull a stable string list of class names off a GrapesJS Component.
 *
 * `component.getClasses()` returns either `string[]` or Selector-model
 * objects (each with `.get("name")`) depending on which collection it
 * traverses; this coerces both shapes to a plain `string[]`.
 */
export function classNamesOf(c: Component): string[] {
  const raw = c.getClasses() as unknown as Array<
    string | { get: (k: string) => unknown }
  >;
  return raw
    .map((x) => (typeof x === "string" ? x : (x.get("name") as string | undefined)))
    .filter((x): x is string => typeof x === "string");
}

/**
 * Read the rendered DOM element for a Component, with multi-frame fallback.
 *
 * Pre-multi-frame, `component.getEl()` returned the element; under multi-
 * frame v0.22 it returns null and the actual element is at
 * `component.view.el`. Try the view path first since that's the more-
 * current code path; fall back to `getEl()` for any older fixture.
 */
export function getComponentEl(c: Component): Element | null | undefined {
  const fromView = (c as unknown as { view?: { el?: Element } }).view?.el;
  if (fromView) return fromView;
  const fn = (c as unknown as { getEl?: () => Element | null | undefined }).getEl;
  return typeof fn === "function" ? fn.call(c) : null;
}

/**
 * Materialize a Component's child list as a plain array.
 *
 * `component.components()` returns a Backbone collection; the public
 * GrapesJS type doesn't expose `.toArray()` even though the runtime
 * always provides it. Several walk/serialize routines need a plain array
 * to iterate.
 */
export function componentsToArray(c: Component): Component[] {
  const collection = c.components() as unknown as { toArray: () => Component[] };
  return collection.toArray();
}

/**
 * Fire a custom event on the Editor's Backbone-style event bus.
 *
 * `editor.trigger(name)` isn't on the public Editor type but is the
 * runtime API for dispatching events panels subscribe to (the autosave
 * `"update"` hook, `ARTBOARDS_CHANGED`, etc.). Centralising the cast
 * keeps the unsafe field-poke in one place.
 */
export function triggerEditorEvent(editor: Editor, name: string): void {
  (editor as unknown as { trigger?: (ev: string) => void }).trigger?.(name);
}

/**
 * Remove a Frame from the currently-selected Page's frame collection.
 *
 * The Canvas module doesn't expose a remove API directly; you reach the
 * remove method through `editor.Pages.getSelected().getFrames().remove`.
 * Several call sites — `clearAllFrames`, `createArtboard`'s scratch-frame
 * cleanup, `ensureDefaultArtboard`, `deleteArtboard` — walk this same
 * chain. Returns `true` when the remove method was reached and called,
 * `false` when any link in the chain was missing.
 */
export function removeFrameFromPage(editor: Editor, frame: Frame): boolean {
  const page = (editor.Pages as unknown as {
    getSelected?: () => { getFrames?: () => { remove?: (x: unknown) => void } } | undefined;
  }).getSelected?.();
  const remove = page?.getFrames?.()?.remove;
  if (typeof remove !== "function") return false;
  remove(frame);
  return true;
}
