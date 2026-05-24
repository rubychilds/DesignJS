import { useCallback, useEffect, useRef, useState } from "react";
import GjsEditor from "@grapesjs/react";
import grapesjs from "grapesjs";
import type { Component, Editor } from "grapesjs";
import "grapesjs/dist/css/grapes.min.css";

import { editorOptions, PRIMITIVE_BASE_CSS } from "./canvas/editor-options.js";
import { ensureDefaultArtboard, ensurePageRoot, healFrameDimensions } from "./canvas/artboards.js";
import { widenComponentStylable } from "./canvas/widen-stylable.js";
import { attachPasteImport, importPastedHtml } from "./canvas/paste-import.js";
import { attachPersistence, loadProject, saveProject } from "./canvas/persistence.js";
import {
  getVariables,
  loadTokens,
  loadVariables,
  resetVariablesStore,
  setVariables,
} from "./canvas/variables.js";
import { getTokenTree, type TokenTree } from "./canvas/tokens.js";
import { BridgeClient } from "./bridge/client.js";
import { buildHandlers } from "./bridge/handlers.js";
import { Topbar, type SaveStatus } from "./components/Topbar.js";
import { Shell } from "./components/Shell.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { TooltipProvider } from "./components/ui/tooltip.js";

/**
 * Hydrate the design-tokens store from saved data, preferring the new
 * DTCG-shaped `tokens` field and falling back to the legacy
 * `cssVariables` flat-map with a one-time migration log per
 * ADR-0009 §8. Both fields absent → no-op (fresh canvas).
 */
function applyTokenStateFromSaved(
  editor: Editor,
  tokens: TokenTree | undefined,
  cssVariables: Record<string, string> | undefined,
): void {
  if (tokens) {
    loadTokens(editor, tokens);
    return;
  }
  if (cssVariables && Object.keys(cssVariables).length > 0) {
    console.info(
      "[designjs] migrating legacy cssVariables → DTCG tokens (ADR-0009 §8). " +
        "Saved file will use the new shape on next save.",
    );
    loadVariables(editor, cssVariables);
  }
}

export function App() {
  const [connected, setConnected] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);

  const editorRef = useRef<Editor | null>(null);
  const disposersRef = useRef<Array<() => void>>([]);
  const initializedRef = useRef(false);

  useEffect(() => {
    return () => {
      disposersRef.current.forEach((fn) => {
        try {
          fn();
        } catch {
          // ignore
        }
      });
      disposersRef.current = [];
    };
  }, []);

  const handleReady = useCallback(async (editor: Editor) => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    editorRef.current = editor;
    setEditor(editor);

    // Widen the `stylable` allowlist on built-in component types so
    // captured HTML preserves width / height / display / flex / etc.
    // on import. The default `wrapper` type is the load-bearing one
    // (narrowed to 7 background props upstream); other types default to
    // `true` but we make the surface explicit and forward-compatible.
    // See widen-stylable.ts for the full set + rationale. Must run
    // before any frame creation / loadProjectData so the override
    // applies to all subsequently-built components.
    widenComponentStylable(editor);

    // Register the iframe-CSS injection listener FIRST — before loadProject
    // or ensureDefaultArtboard. Those can synchronously create frames whose
    // `canvas:frame:load` event might fire before any later-registered
    // listener attaches, causing the injection to miss that frame (no white
    // body background → frame paints transparent → canvas void shows through).
    // Must run before ensureDefaultArtboard's delete→recreate cycle.
    const injectPrimitiveCssIntoDoc = (doc: Document | null | undefined): void => {
      if (!doc || !doc.head) return;
      if (doc.getElementById("oc-primitive-base")) return;
      const style = doc.createElement("style");
      style.id = "oc-primitive-base";
      style.textContent = PRIMITIVE_BASE_CSS;
      doc.head.appendChild(style);
    };
    // canvas:frame:load fires once on iframe onload. Some frame creation
    // paths (re-mount, add-then-mount) didn't reliably trigger it for our
    // listener; canvas:frame:load:head + :body both also fire on iframe
    // life-cycle so listening to all three is the belt-and-braces fix.
    editor.on("canvas:frame:load canvas:frame:load:head canvas:frame:load:body", (ev) => {
      const { window: frameWindow, el } = (ev ?? {}) as {
        window?: Window;
        el?: HTMLIFrameElement;
      };
      injectPrimitiveCssIntoDoc(frameWindow?.document ?? el?.contentDocument);
    });
    // Cover frames that had already loaded by the time we registered the
    // listener (the auto-frame races us on initial app boot), and any
    // frames whose load events fired before listener attach. A short
    // polling pass catches re-mounts that re-create the iframe document
    // without re-firing canvas:frame:load (a known soft spot of GrapesJS
    // 0.22.x multi-frame).
    const sweepAllFrames = (): void => {
      editor.Canvas.getFrames().forEach((frame) => {
        const fAny = frame as unknown as {
          view?: {
            getWindow?: () => Window | undefined;
            el?: HTMLIFrameElement;
          };
        };
        const win = fAny.view?.getWindow?.();
        injectPrimitiveCssIntoDoc(win?.document ?? fAny.view?.el?.contentDocument);
      });
    };
    sweepAllFrames();
    // 5 polls over 2.5s catches the common create-then-mount window;
    // injection is idempotent (`getElementById` guard) so duplicate calls
    // are cheap.
    let sweepCount = 0;
    const sweepInterval = window.setInterval(() => {
      sweepAllFrames();
      sweepCount += 1;
      if (sweepCount >= 5) window.clearInterval(sweepInterval);
    }, 500);
    // Also sweep whenever a new frame is added — covers post-boot
    // captures (which are the user-visible regression case).
    editor.on("frame:add", sweepAllFrames);

    // Reset the module-scoped variables store so a Vite HMR reload doesn't
    // carry stale entries forward into the rehydration step below.
    resetVariablesStore();

    try {
      const saved = await loadProject();
      if (saved) {
        const { tokens, cssVariables, ...projectData } = saved as {
          tokens?: TokenTree;
          cssVariables?: Record<string, string>;
          [k: string]: unknown;
        };
        editor.loadProjectData(projectData);
        applyTokenStateFromSaved(editor, tokens, cssVariables);
      }
    } catch (err) {
      console.warn("[designjs] load failed:", err);
    }

    // GrapesJS's `infiniteCanvas: true` auto-frame boots with degenerate
    // geometry (0×0 / unpositioned), which renders as nothing on the canvas
    // and makes ⌘0 fit no-op. `ensureDefaultArtboard` normalizes the
    // unopinionated auto-frame to a neutral 1280×800 "Frame 1" so a fresh
    // boot shows *something*. Idempotent — no-op when the first frame is
    // already named (saved-project restore path).
    ensureDefaultArtboard(editor);

    // Stamp the page-root marker on whichever frame is the page (idempotent
    // if a saved project already carries it). Closes ADR-0006 Open Q §1 —
    // before this, getPageRootWrapper relied on first-frame-in-document-
    // order, which was fragile to drag-reorder / deletion / non-
    // deterministic load order.
    ensurePageRoot(editor);

    // Restore dimensions on any frame whose persisted state lost
    // width/height (a fixed-since legacy-corruption case — see
    // healFrameDimensions docstring). Runs after a delay so the iframes
    // have actually mounted; otherwise offsetWidth is 0 and the heal
    // measurement is garbage.
    window.setTimeout(() => {
      try {
        const healed = healFrameDimensions(editor);
        if (healed > 0) {
          console.info(`[designjs] healed ${healed} frame(s) with missing dimensions`);
        }
      } catch (err) {
        console.warn("[designjs] healFrameDimensions failed:", err);
      }
    }, 1500);

    // Fit the viewport to all frames after boot so the default 1280×800
    // frame (or whatever the saved project has) is visible from the first
    // paint. The 300ms delay lets the infiniteCanvas plugin register
    // `core:canvas-fit` (not available synchronously at handleReady) and
    // lets the replacement frame's iframe mount so `.gjs-frames` reports
    // a real bounding box. try/catch swallows the case where the command
    // still isn't registered — user can always press ⌘0 manually.
    window.setTimeout(() => {
      try {
        editor.runCommand("core:canvas-fit");
      } catch {
        /* no-op — command not yet registered */
      }
    }, 300);

    (window as unknown as { __designjs?: unknown }).__designjs = {
      editor,
      addHtml: (html: string) => {
        // Multi-frame: editor.addComponents lands the component in a detached
        // tree with no iframe mount. Route into the first frame's wrapper so
        // test/dev helpers that drive addHtml actually produce rendered DOM.
        const firstFrame = editor.Canvas.getFrames()[0];
        const wrapper = (firstFrame as unknown as { get?: (k: string) => unknown })?.get?.(
          "component",
        ) as { append?: (h: string) => unknown } | undefined;
        return wrapper?.append ? wrapper.append(html) : editor.addComponents(html);
      },
      getHtml: () => editor.getHtml(),
      getProjectData: () => editor.getProjectData(),
      save: () =>
        saveProject({
          ...(editor.getProjectData() as Record<string, unknown>),
          tokens: getTokenTree(),
        }),
      load: async () => {
        const data = await loadProject();
        if (data) {
          const { tokens, cssVariables, ...projectData } = data as {
            tokens?: TokenTree;
            cssVariables?: Record<string, string>;
            [k: string]: unknown;
          };
          editor.loadProjectData(projectData);
          applyTokenStateFromSaved(editor, tokens, cssVariables);
        }
        return data;
      },
      clear: () => editor.Components.clear(),
      paste: (html: string) => importPastedHtml(editor, html),
      getVariables: () => getVariables(),
      setVariables: (vars: Record<string, string>) => setVariables(editor, vars),
    };
    window.dispatchEvent(new CustomEvent("designjs:ready"));

    editor.Keymaps.add("oc:duplicate", "ctrl+d,command+d", () => {
      editor.runCommand("core:copy");
      editor.runCommand("core:paste");
      return undefined;
    });

    // Override the default `core:component-delete` command so that pressing
    // Backspace / Delete while a text component is in RTE (contenteditable)
    // mode doesn't nuke the whole component. The default grapes keymap
    // routes both keys to this command with `preventDefault: true`, which
    // was intercepting character-level deletes and removing the text node
    // wholesale. When RTE is active we no-op and let the native
    // contenteditable handling remove the character instead.
    const editorWithEditing = editor as unknown as {
      getEditing?: () => Component | undefined | null;
    };
    editor.Commands.add("core:component-delete", {
      run(ed) {
        if (editorWithEditing.getEditing?.()) return;
        const sel = ed.getSelected();
        (sel as unknown as { remove?: () => void } | undefined)?.remove?.();
      },
    });

    const disposePersist = attachPersistence(editor, {
      onSaveStart: () => setSaveStatus("saving"),
      onSaved: () => {
        setSaveStatus("saved");
        setSaveError(null);
      },
      onError: (err) => {
        setSaveStatus("error");
        setSaveError(err.message);
      },
      getExtras: () => ({ tokens: getTokenTree() }),
    });

    const handlers = buildHandlers(editor);
    const client = new BridgeClient(handlers, { onStatus: setConnected });
    client.connect();

    const disposePaste = attachPasteImport(editor);

    disposersRef.current.push(disposePersist, () => client.dispose(), disposePaste);

    requestAnimationFrame(() => {
      (editor.Styles as unknown as { __trgCustom?: () => void }).__trgCustom?.();
      (editor.Blocks as unknown as { __trgCustom?: () => void }).__trgCustom?.();
      (editor.Layers as unknown as { __trgCustom?: () => void }).__trgCustom?.();
      (editor.Traits as unknown as { __trgCustom?: () => void }).__trgCustom?.();
    });
  }, []);

  const handleSave = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor) return;
    setSaveStatus("saving");
    try {
      await saveProject({
        ...(editor.getProjectData() as Record<string, unknown>),
        tokens: getTokenTree(),
      });
      setSaveStatus("saved");
      setSaveError(null);
    } catch (err) {
      setSaveStatus("error");
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-col h-screen w-screen overflow-hidden">
        <Topbar
          connected={connected}
          saveStatus={saveStatus}
          saveError={saveError}
          onSave={handleSave}
          editor={editor}
        />
        <GjsEditor
          grapesjs={grapesjs}
          options={editorOptions}
          onReady={handleReady}
          className="flex-1 min-h-0 flex"
        >
          <Shell />
          <CommandPalette />
        </GjsEditor>
      </div>
    </TooltipProvider>
  );
}
