import type { Editor } from "grapesjs";
import {
  cssVariableToPath,
  deleteToken,
  flattenToCssVariables,
  getTokenTree,
  inferType,
  inflateFromCssVariables,
  loadTokenTree,
  resetTokenStore,
  setToken,
  type Token,
  type TokenTree,
} from "./tokens.js";

/**
 * Legacy flat-map adapter over the DTCG tokens store
 * (`packages/app/src/canvas/tokens.ts`). Existing consumers — the
 * VariablesPopover, MCP `get_variables` / `set_variables` handlers,
 * the persistence `getExtras()` channel — read and write a
 * `Record<string, string>` keyed on `--var-name`. ADR-0009 Phase 1
 * keeps that API stable while the storage shape underneath becomes
 * DTCG-shaped. Phase 2 (§6) and Phase 3 (§9) replace these surfaces;
 * this file goes away with them.
 *
 * Writes apply to every artboard frame's iframe `:root` via the same
 * mechanism as before (Canvas.getDocument() alone returns undefined
 * under the multi-frame layout). CSS emission via Tailwind v4 `@theme`
 * (ADR §5) is Chunk C work — for Phase 1 Chunk A we keep the
 * setProperty-per-variable path so behaviour is unchanged.
 */

function frameDocs(editor: Editor): Document[] {
  const docs: Document[] = [];
  for (const frame of editor.Canvas.getFrames()) {
    const view = (frame as unknown as {
      view?: { getWindow?: () => Window | undefined };
    }).view;
    const doc = view?.getWindow?.()?.document;
    if (doc) docs.push(doc);
  }
  if (docs.length === 0) {
    const doc = editor.Canvas.getDocument();
    if (doc) docs.push(doc);
  }
  return docs;
}

export function getVariables(): Record<string, string> {
  return flattenToCssVariables(getTokenTree());
}

/**
 * Merges the supplied variables into the DTCG store and writes them to
 * each iframe `:root`. Existing keys not in `incoming` are preserved.
 * Returns the full updated map.
 */
export function setVariables(
  editor: Editor,
  incoming: Record<string, string>,
): Record<string, string> {
  const tree = getTokenTree();
  for (const [cssVar, value] of Object.entries(incoming)) {
    const path = cssVariableToPath(cssVar);
    const type = inferType(cssVar, value);
    const token: Token = type ? { $type: type, $value: value } : { $value: value };
    setToken(tree, path, token);
  }
  applyAll(editor);
  return getVariables();
}

/**
 * Replaces the in-memory store with `vars` and applies them to the
 * iframe. Used on page load to rehydrate from `.designjs.json`'s
 * legacy `cssVariables` shape — the new `tokens` shape has its own
 * loader (`loadTokenTree`) and bypasses this function.
 *
 * Polls briefly if the iframe doc isn't ready yet so the variables
 * actually land.
 */
export function loadVariables(editor: Editor, vars: Record<string, string>): void {
  loadTokenTree(inflateFromCssVariables(vars));
  applyWithRetry(editor);
}

/**
 * Load a DTCG TokenTree directly (no flat-map round-trip). Preserves
 * `$type` annotations from the saved tree — used by the App.tsx
 * persistence path when `.designjs.json` already carries the new
 * `tokens` shape (i.e. saved by a post-Phase-1 build). The legacy
 * `cssVariables` path inflates via `loadVariables` instead, paying the
 * type-inference cost once at migration time.
 */
export function loadTokens(editor: Editor, tree: TokenTree): void {
  loadTokenTree(tree);
  applyWithRetry(editor);
}

function applyWithRetry(editor: Editor): void {
  if (applyAll(editor)) return;
  let tries = 0;
  const interval = window.setInterval(() => {
    tries += 1;
    if (applyAll(editor) || tries > 50) {
      window.clearInterval(interval);
    }
  }, 100);
}

export function deleteVariable(
  editor: Editor,
  key: string,
): Record<string, string> {
  deleteToken(getTokenTree(), cssVariableToPath(key));
  for (const doc of frameDocs(editor)) {
    doc.documentElement?.style.removeProperty(key);
  }
  return getVariables();
}

export function resetVariablesStore(): void {
  resetTokenStore();
}

function applyAll(editor: Editor): boolean {
  const docs = frameDocs(editor);
  if (docs.length === 0) return false;
  let applied = false;
  const flat = flattenToCssVariables(getTokenTree());
  for (const doc of docs) {
    const root = doc.documentElement;
    if (!root) continue;
    for (const [k, v] of Object.entries(flat)) {
      root.style.setProperty(k, v);
    }
    applied = true;
  }
  return applied;
}
