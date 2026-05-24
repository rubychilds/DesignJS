import { useEffect, useRef, useState } from "react";
import { useEditorMaybe } from "@grapesjs/react";
import type { Editor, Frame } from "grapesjs";
import {
  ARTBOARDS_CHANGED,
  findSnapOffset,
  moveArtboard,
  renameArtboard,
} from "../canvas/artboards.js";
import { cn } from "../lib/utils.js";

/**
 * Figma-style artboard title bars: a small label floating above each frame on
 * the canvas. Click+drag repositions the frame (world coords); double-click
 * renames in place.
 *
 * The label anchors to each frame's live iframe bounding rect — already in
 * host-document screen space with pan/zoom factored in — so it follows the
 * frame through pan, zoom, and resize without us reimplementing the world→
 * screen transform.
 *
 * Smart-alignment guides light up during a drag whenever `findSnapOffset`
 * returns `snappedX` / `snappedY`. The guide is rendered in screen space as
 * a 1px dashed line across the viewport.
 */

interface FrameGeom {
  id: string;
  name: string;
  /** World-space coords (frame model). */
  worldX: number;
  worldY: number;
  worldWidth: number;
  worldHeight: number;
  /** Screen-space iframe rect, null when the iframe hasn't mounted yet. */
  screen: { left: number; top: number; width: number; height: number } | null;
}

function readFrameId(frame: Frame): string {
  return String(
    (frame as unknown as { cid?: string }).cid ??
      (frame as unknown as { id?: string }).id ??
      "",
  );
}

function readFrameGeom(frame: Frame): FrameGeom | null {
  const get = (frame as unknown as { get?: (k: string) => unknown }).get;
  if (typeof get !== "function") return null;
  const id = readFrameId(frame);
  const name = String(get.call(frame, "name") ?? "Frame");
  const worldX = Number(get.call(frame, "x") ?? 0);
  const worldY = Number(get.call(frame, "y") ?? 0);
  const worldWidth = Number(get.call(frame, "width") ?? 0);
  const worldHeight = Number(get.call(frame, "height") ?? 0);

  const view = (frame as unknown as {
    view?: {
      el?: HTMLIFrameElement;
      frame?: { el?: HTMLIFrameElement };
    };
  }).view;
  const iframeEl = view?.frame?.el ?? view?.el ?? null;
  // Walk to `.gjs-frame-wrapper` — the positioned container the iframe sits
  // inside. Its bounding rect matches the frame footprint on screen, whereas
  // the iframe itself sometimes reports a collapsed height mid-load.
  const wrapperEl =
    (iframeEl?.closest(".gjs-frame-wrapper") as HTMLElement | null) ?? iframeEl;
  const rect = wrapperEl?.getBoundingClientRect() ?? null;
  return {
    id,
    name,
    worldX,
    worldY,
    worldWidth,
    worldHeight,
    screen: rect
      ? {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        }
      : null,
  };
}

function readAllFrames(editor: Editor): FrameGeom[] {
  const raw = editor.Canvas.getFrames?.();
  const arr = Array.isArray(raw) ? raw : [];
  const out: FrameGeom[] = [];
  for (const f of arr) {
    const g = readFrameGeom(f);
    if (g) out.push(g);
  }
  return out;
}

interface DragState {
  id: string;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startWorldX: number;
  startWorldY: number;
  /** Zoom factor captured at drag-start; dividing screen delta by this gives world delta. */
  zoomFactor: number;
  /** Screen-space snap guides (updated each pointermove). */
  snapX: number | null;
  snapY: number | null;
}

const TITLE_HEIGHT = 18;
const TITLE_GAP = 4;

export function ArtboardTitleBars() {
  const editor = useEditorMaybe();
  const [frames, setFrames] = useState<FrameGeom[]>([]);
  const dragRef = useRef<DragState | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const rafRef = useRef<number | null>(null);

  // Refresh frame geometry on every tick — cheap (just reads bounding rects)
  // and catches pan, zoom, resize, and mid-drag moves without wiring to
  // each individual event. Runs unconditionally because frames are rare
  // enough (≤ a few dozen in practice) that the RAF cost is trivial.
  useEffect(() => {
    if (!editor) return;
    const tick = () => {
      setFrames(readAllFrames(editor));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [editor]);

  // ARTBOARDS_CHANGED forces a synchronous refresh in addition to the RAF tick
  // so the title-bars line up with a freshly-created/deleted frame before the
  // next frame.
  useEffect(() => {
    if (!editor) return;
    const refresh = () => setFrames(readAllFrames(editor));
    editor.on(ARTBOARDS_CHANGED, refresh);
    editor.on("canvas:frame:load", refresh);
    return () => {
      editor.off(ARTBOARDS_CHANGED, refresh);
      editor.off("canvas:frame:load", refresh);
    };
  }, [editor]);

  const onPointerDown = (ev: React.PointerEvent<HTMLButtonElement>, f: FrameGeom) => {
    if (!editor) return;
    if (ev.button !== 0) return; // left-click only
    ev.preventDefault();
    ev.stopPropagation();
    const zoomPct = Number(editor.Canvas.getZoom?.() ?? 100) || 100;
    const state: DragState = {
      id: f.id,
      pointerId: ev.pointerId,
      startClientX: ev.clientX,
      startClientY: ev.clientY,
      startWorldX: f.worldX,
      startWorldY: f.worldY,
      zoomFactor: zoomPct / 100,
      snapX: null,
      snapY: null,
    };
    dragRef.current = state;
    setDrag(state);
    (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
  };

  const onPointerMove = (ev: React.PointerEvent<HTMLButtonElement>) => {
    const state = dragRef.current;
    if (!state || state.pointerId !== ev.pointerId) return;
    const dxScreen = ev.clientX - state.startClientX;
    const dyScreen = ev.clientY - state.startClientY;
    const dxWorld = dxScreen / state.zoomFactor;
    const dyWorld = dyScreen / state.zoomFactor;
    const rawX = state.startWorldX + dxWorld;
    const rawY = state.startWorldY + dyWorld;
    if (!editor) return;
    const snapped = findSnapOffset(editor, state.id, rawX, rawY);
    // noUndo: true so a 100px drag doesn't fill the undo stack with ~30
    // per-tick entries. onPointerUp emits a single trackable commit so
    // Cmd+Z reverses the whole drag in one step.
    moveArtboard(editor, state.id, snapped.x, snapped.y, false, { noUndo: true });
    // Stash the screen-space location of each snapped edge so the guide
    // overlay can render it. Snap edges always coincide with a frame edge
    // on screen; derive from the world-space snap target + the frame's own
    // screen offset we already have via RAF.
    state.snapX = snapped.snappedX ? snapped.x : null;
    state.snapY = snapped.snappedY ? snapped.y : null;
    dragRef.current = state;
    setDrag({ ...state });
  };

  const onPointerUp = (ev: React.PointerEvent<HTMLButtonElement>) => {
    const state = dragRef.current;
    if (!state || state.pointerId !== ev.pointerId) return;
    try {
      (ev.currentTarget as HTMLElement).releasePointerCapture?.(ev.pointerId);
    } catch {
      // ignore
    }
    // Coalesce the drag into a single undo entry by pushing a synthetic
    // entry directly to backbone-undo's stack. Skip when the frame didn't
    // actually move (a click-without-drag).
    //
    // Why synthetic-push instead of rewind-and-commit: Backbone's
    // `previousAttributes()` accounting across many event-loop ticks
    // (each pointermove is its own micro-task) makes the rewind-and-commit
    // pattern unreliable in the React-driven path — by commit time
    // backbone-undo's "on change" handler captures a previousAttributes
    // that's already been overwritten by the noUndo-but-still-event-firing
    // pointermoves. A synthetic entry with explicit before/after sidesteps
    // the issue: `undo()` calls `model.set(before)` directly and frame
    // returns to its drag-start position in one Cmd+Z.
    if (editor) {
      const frames = editor.Canvas.getFrames();
      const frame = (frames as unknown as Array<{
        cid?: string;
        id?: string;
        get?: (k: string) => unknown;
      }>).find((f) => String(f.cid ?? f.id ?? "") === state.id);
      const finalX = Number(frame?.get?.("x") ?? state.startWorldX);
      const finalY = Number(frame?.get?.("y") ?? state.startWorldY);
      const moved = finalX !== state.startWorldX || finalY !== state.startWorldY;
      if (moved && frame) {
        const um = (
          editor as unknown as {
            UndoManager?: {
              um?: {
                stack?: {
                  add: (e: unknown) => void;
                  length: number;
                  pointer: number;
                };
                undoTypes?: unknown;
              };
            };
          }
        ).UndoManager?.um;
        if (um?.stack && um.undoTypes) {
          um.stack.add({
            type: "change",
            object: frame,
            before: { x: state.startWorldX, y: state.startWorldY },
            after: { x: finalX, y: finalY },
            options: {},
            magicFusionIndex: -1,
            undoTypes: um.undoTypes,
          });
          um.stack.pointer = um.stack.length - 1;
        }
      }
    }
    dragRef.current = null;
    setDrag(null);
  };

  if (!editor) return null;

  return (
    <div
      // clip-path excludes the Topbar region (--topbar-height) from this fixed
      // overlay. Without it, the full-width pointer-events-auto title buttons
      // (from d190a33) can silently swallow clicks on Topbar controls when a
      // frame sits within ~22px of the top edge of the canvas viewport.
      className="pointer-events-none fixed inset-0 z-20 [clip-path:inset(var(--topbar-height)_0_0_0)]"
      data-testid="oc-artboard-title-bars"
    >
      {frames.map((f) => {
        if (!f.screen) return null;
        const left = f.screen.left;
        const top = f.screen.top - TITLE_HEIGHT - TITLE_GAP;
        const width = f.screen.width;
        const isDragging = drag?.id === f.id;
        return (
          <div key={f.id} style={{ position: "absolute", left, top, width }}>
            {editing === f.id ? (
              <input
                autoFocus
                defaultValue={f.name}
                className={cn(
                  "pointer-events-auto h-[18px] px-1 rounded-sm text-[11px] font-medium",
                  "bg-background border border-oc-accent text-foreground",
                  "focus:outline-none",
                  "w-full min-w-0",
                )}
                data-testid={`oc-artboard-title-input-${f.id}`}
                onBlur={(ev) => {
                  const next = ev.currentTarget.value.trim() || f.name;
                  if (editor) renameArtboard(editor, f.id, next);
                  setEditing(null);
                }}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter") {
                    const next = ev.currentTarget.value.trim() || f.name;
                    if (editor) renameArtboard(editor, f.id, next);
                    setEditing(null);
                  }
                  if (ev.key === "Escape") {
                    setEditing(null);
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className={cn(
                  "pointer-events-auto flex items-center h-[18px] w-full px-1 rounded-sm",
                  "text-[11px] font-medium whitespace-nowrap truncate select-none",
                  // Transparent hit-surface across the whole title row so the
                  // grab area matches the frame width, not just the text glyphs.
                  "text-muted-foreground hover:text-foreground",
                  "bg-transparent hover:bg-background/40",
                  isDragging && "text-oc-accent cursor-grabbing",
                  !isDragging && "cursor-grab",
                )}
                style={{ touchAction: "none" }}
                data-testid={`oc-artboard-title-${f.id}`}
                data-frame-id={f.id}
                aria-label={`Move frame ${f.name}`}
                onPointerDown={(ev) => onPointerDown(ev, f)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onDoubleClick={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  // Bail out of an in-flight drag — double-click can fire after
                  // a zero-distance pointerdown-up sequence.
                  dragRef.current = null;
                  setDrag(null);
                  setEditing(f.id);
                }}
                onClick={(ev) => {
                  // Select the frame's wrapper on click so the inspector updates.
                  ev.stopPropagation();
                  const frame = editor.Canvas.getFrames?.().find(
                    (fr) => readFrameId(fr) === f.id,
                  );
                  if (!frame) return;
                  const wrapper = (frame as unknown as {
                    get?: (k: string) => unknown;
                  }).get?.("component");
                  if (wrapper) editor.select(wrapper as Parameters<Editor["select"]>[0]);
                }}
              >
                {f.name}
              </button>
            )}
          </div>
        );
      })}
      {drag ? <SnapGuides drag={drag} frames={frames} /> : null}
    </div>
  );
}

/**
 * Render 1px dashed alignment guides where the active drag has snapped.
 * Coordinates come from the moving frame's own screen rect (updated each RAF
 * tick) — we know the guide coincides with one of its edges by definition,
 * so we read those edges in screen space rather than re-deriving the world
 * transform.
 */
function SnapGuides({ drag, frames }: { drag: DragState; frames: FrameGeom[] }) {
  const moving = frames.find((f) => f.id === drag.id);
  if (!moving || !moving.screen) return null;
  // Snap X at world space means one of moving's left/right edges aligned to
  // some other frame's edge. In screen space, those are `screen.left` and
  // `screen.left + screen.width`. We can't tell which one snapped without
  // rechecking, but picking *both* (when snapped) is visually fine — any
  // other frame's edge the drag aligned to lies at the same screen x, so
  // the guide is still correct wherever the other frame is vertically.
  // Same for Y.
  return (
    <>
      {drag.snapX != null ? (
        <SnapLine
          orientation="vertical"
          screenCoord={moving.screen.left}
          testid="oc-artboard-snap-v-left"
        />
      ) : null}
      {drag.snapX != null ? (
        <SnapLine
          orientation="vertical"
          screenCoord={moving.screen.left + moving.screen.width}
          testid="oc-artboard-snap-v-right"
        />
      ) : null}
      {drag.snapY != null ? (
        <SnapLine
          orientation="horizontal"
          screenCoord={moving.screen.top}
          testid="oc-artboard-snap-h-top"
        />
      ) : null}
      {drag.snapY != null ? (
        <SnapLine
          orientation="horizontal"
          screenCoord={moving.screen.top + moving.screen.height}
          testid="oc-artboard-snap-h-bottom"
        />
      ) : null}
    </>
  );
}

function SnapLine({
  orientation,
  screenCoord,
  testid,
}: {
  orientation: "vertical" | "horizontal";
  screenCoord: number;
  testid: string;
}) {
  const style =
    orientation === "vertical"
      ? { left: screenCoord - 0.5, top: 0, width: 1, height: "100%" }
      : { top: screenCoord - 0.5, left: 0, height: 1, width: "100%" };
  return (
    <div
      className="absolute bg-oc-accent pointer-events-none"
      style={style}
      data-testid={testid}
    />
  );
}
