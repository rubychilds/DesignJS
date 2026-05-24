import { useCallback, useEffect, useRef, useState } from "react";
import { useEditorMaybe } from "@grapesjs/react";
import { LeftPanel } from "./LeftPanel.js";
import { RightPanel } from "./RightPanel.js";
import { CanvasArea } from "./CanvasArea.js";

/**
 * Shell layout per ADR-0003: side panels default to fixed widths, but the
 * left panel exposes a draggable gutter so users can widen it when deeply
 * nested layer rows get text-truncated (matches Figma's resizable layers
 * panel). The right panel is mounted only when a component is selected —
 * the canvas takes the full width when nothing is selected, so the empty
 * state feels open rather than cluttered with an "empty inspector" prompt.
 */
const LEFT_MIN = 240; // matches Tailwind w-60, the previous fixed width
const LEFT_MAX = 600;

export function Shell() {
  const editor = useEditorMaybe();
  const [hasSelection, setHasSelection] = useState(false);
  const [leftWidth, setLeftWidth] = useState<number>(LEFT_MIN);
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    if (!editor) return;
    const update = () => setHasSelection(Boolean(editor.getSelected()));
    update();
    // Subscribe individually — Backbone's space-separated event syntax isn't
    // reliable on the GrapesJS editor bus (see LayersPanel + FrameLayerRow).
    editor.on("component:selected", update);
    editor.on("component:deselected", update);
    return () => {
      editor.off("component:selected", update);
      editor.off("component:deselected", update);
    };
  }, [editor]);

  const onPointerDown = useCallback(
    (ev: React.PointerEvent<HTMLDivElement>) => {
      ev.preventDefault();
      dragStateRef.current = { startX: ev.clientX, startWidth: leftWidth };
      const onMove = (e: PointerEvent) => {
        const drag = dragStateRef.current;
        if (!drag) return;
        const next = Math.min(
          LEFT_MAX,
          Math.max(LEFT_MIN, drag.startWidth + (e.clientX - drag.startX)),
        );
        setLeftWidth(next);
      };
      const onUp = () => {
        dragStateRef.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [leftWidth],
  );

  return (
    <div className="flex-1 min-h-0 flex">
      <div id="oc-left" className="shrink-0 min-w-0" style={{ width: leftWidth }}>
        <LeftPanel />
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize layers panel"
        onPointerDown={onPointerDown}
        className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-border active:bg-border"
        data-testid="oc-left-resize-handle"
      />
      <div id="oc-center" className="flex-1 min-w-0">
        <CanvasArea />
      </div>
      {hasSelection ? (
        <div id="oc-right" className="w-72 shrink-0 min-w-0">
          <RightPanel />
        </div>
      ) : null}
    </div>
  );
}
