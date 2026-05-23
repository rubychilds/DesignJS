import { useEffect, useMemo, useRef, useState } from "react";
import { useEditorMaybe } from "@grapesjs/react";
import type { Component, Editor, Frame } from "grapesjs";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeClosed,
  FrameCorners,
  Lock,
  LockOpen,
  PlusOutline,
} from "../canvas/chrome-icons.js";
import { cn } from "../lib/utils.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.js";
import { iconForPrimitive, iconForTag } from "../canvas/icons.js";
import {
  ARTBOARDS_CHANGED,
  createArtboard,
  deleteArtboard,
  renameArtboard,
} from "../canvas/artboards.js";
import {
  PRIMITIVE_LABEL,
  primitiveTypeOf,
  textContentOf,
} from "../canvas/primitives.js";

/* ─────────────────────────────── helpers ─────────────────────────────── */

function frameId(frame: Frame): string {
  return String(
    (frame as unknown as { getId?: () => string }).getId?.() ??
      (frame as unknown as { cid?: string }).cid ??
      (frame as unknown as { id?: string }).id ??
      "",
  );
}

function frameAttr(frame: Frame, key: string): unknown {
  const get = (frame as unknown as { get?: (k: string) => unknown }).get;
  if (typeof get === "function") return get.call(frame, key);
  return (frame as unknown as { attributes?: Record<string, unknown> }).attributes?.[key];
}

function frameWrapper(frame: Frame): Component | undefined {
  const c = (frame as unknown as { get: (k: string) => unknown }).get?.("component");
  return c as Component | undefined;
}

function useFrames(editor: Editor | undefined): Frame[] {
  const [frames, setFrames] = useState<Frame[]>([]);
  useEffect(() => {
    if (!editor) return;
    const refresh = () => {
      try {
        const list = editor.Canvas.getFrames?.();
        setFrames(Array.isArray(list) ? list.filter(Boolean) : []);
      } catch {
        // ignore
      }
    };
    refresh();
    editor.on("load", refresh);
    // ARTBOARDS_CHANGED fires from artboards.ts helpers (createArtboard /
    // deleteArtboard / renameArtboard). canvas:frame:load + canvas:frame:unload
    // catch raw `editor.Canvas.addFrame` calls (e.g. from MCP tools or tests
    // that bypass the helpers).
    editor.on(ARTBOARDS_CHANGED, refresh);
    editor.on("canvas:frame:load", refresh);
    editor.on("canvas:frame:unload", refresh);
    // Bootstrap: GrapesJS may add the initial frame after this hook mounts.
    const t = setTimeout(refresh, 100);
    return () => {
      clearTimeout(t);
      editor.off("load", refresh);
      editor.off(ARTBOARDS_CHANGED, refresh);
      editor.off("canvas:frame:load", refresh);
      editor.off("canvas:frame:unload", refresh);
    };
  }, [editor]);
  return frames;
}

function readStyle(component: Component, key: string): string {
  const v = (component as unknown as { getStyle?: () => Record<string, unknown> }).getStyle?.()?.[key];
  return v == null ? "" : String(v);
}

function writeStyle(component: Component, key: string, value: string): void {
  (component as unknown as { addStyle?: (s: Record<string, string>) => void }).addStyle?.({
    [key]: value,
  });
}

function clearStyle(component: Component, key: string): void {
  const rm = (component as unknown as { removeStyle?: (k: string) => void }).removeStyle;
  if (typeof rm === "function") rm.call(component, key);
  else writeStyle(component, key, "");
}

/**
 * Lock state lives on a per-component data attribute rather than a CSS prop so
 * it round-trips in get/set attribute tooling and doesn't bleed into export.
 * A locked component has `data-oc-locked="true"`.
 */
function isLocked(component: Component): boolean {
  const a = (component as unknown as { getAttributes?: () => Record<string, unknown> }).getAttributes?.() ?? {};
  return a["data-oc-locked"] === "true";
}

function setLocked(component: Component, locked: boolean): void {
  const set = (component as unknown as {
    setAttributes?: (a: Record<string, unknown>) => void;
  }).setAttributes;
  if (typeof set !== "function") return;
  const current =
    (component as unknown as { getAttributes?: () => Record<string, unknown> }).getAttributes?.() ?? {};
  const next = { ...current };
  if (locked) next["data-oc-locked"] = "true";
  else delete next["data-oc-locked"];
  set.call(component, next);
}

/**
 * Derive the row label per ADR-0005. Order of precedence:
 *   1. Custom user-set name (existing behaviour, set via double-click rename)
 *   2. For text-bearing primitives, the trimmed content (truncated to 24 char)
 *   3. The primitive concept name ("Rectangle" / "Ellipse" / "Image" / …)
 *   4. tagName fallback for unmapped components
 */
const TEXT_LABEL_LIMIT = 24;
function derivePrimitiveLabel(
  component: Component,
  primitive: ReturnType<typeof primitiveTypeOf>,
  tag: string,
): string {
  const custom = (component as unknown as { get: (k: string) => unknown }).get?.("custom-name");
  if (typeof custom === "string" && custom.trim()) return custom.trim();

  if (primitive === "text") {
    const content = textContentOf(component);
    if (content) {
      return content.length > TEXT_LABEL_LIMIT ? `${content.slice(0, TEXT_LABEL_LIMIT)}…` : content;
    }
    return PRIMITIVE_LABEL.text;
  }

  if (primitive) return PRIMITIVE_LABEL[primitive];

  return component.getName?.() ?? tag ?? "node";
}

/* ─────────────────────────────── layer row (regular components) ─────── */

interface LayerRowProps {
  component: Component;
  depth: number;
  editor: Editor | undefined;
  selected: Component | null;
}

function LayerRow({ component, depth, editor, selected }: LayerRowProps) {
  // `tick` (the value, not the setter) is the dep that re-derives `children`
  // when GrapesJS mutates the components collection in place.
  const [tick, force] = useState(0);
  const tag = (component.get("tagName") as string | undefined) ?? "";
  const primitive = primitiveTypeOf(component);
  const label = derivePrimitiveLabel(component, primitive, tag);
  const Icon = primitive ? iconForPrimitive(primitive) : iconForTag(tag);
  const isSelected = selected?.getId() === component.getId();
  const hidden = readStyle(component, "display") === "none";
  const locked = isLocked(component);

  const children = useMemo(
    () =>
      (component.components() as unknown as { toArray: () => Component[] })
        .toArray()
        // Per ADR-0005: textnode children are an HTML-storage artifact, not a
        // user-facing concept. Their content lives in the parent's row label.
        .filter((c) => (c.get("type") as string | undefined) !== "textnode"),
    [component, tick],
  );

  // Default-collapsed beyond depth 3 to keep the layer tree responsive
  // on captured pages. A captured Python docs page has ~1700 deeply
  // nested elements; defaulting every LayerRow to expanded:true makes
  // the whole tree render thousands of React components on every
  // selection change (`selected` prop propagates down through every
  // row), which causes a visible 0.5-1s lag when clicking a layer.
  // Authored pages typically have <100 elements and barely notice —
  // depth 3 covers the top of most real component trees. Users
  // explicitly expand deeper subtrees to navigate.
  const [expanded, setExpanded] = useState(depth < 3);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);

  useEffect(() => {
    if (!editor) return;
    // Force-tick on any add / remove / update — additions and removals don't
    // reliably fire `component:update` on the parent (Backbone fires `add`
    // on the parent's collection instead), so subscribe to all three.
    const onAny = () => force((n) => n + 1);
    editor.on("component:add", onAny);
    editor.on("component:remove", onAny);
    editor.on("component:update", onAny);
    return () => {
      editor.off("component:add", onAny);
      editor.off("component:remove", onAny);
      editor.off("component:update", onAny);
    };
  }, [editor, component]);

  const commit = () => {
    const next = draft.trim();
    if (!next) {
      setEditing(false);
      setDraft(label);
      return;
    }
    (component as unknown as { set?: (k: string, v: unknown) => void }).set?.("custom-name", next);
    setEditing(false);
  };

  const hasChildren = children.length > 0;

  return (
    <div>
      <div
        className={cn(
          "group flex items-center gap-1 h-7 pr-1 transition-colors relative",
          isSelected && "bg-oc-accent/15",
          !isSelected && "hover:bg-surface-sunken",
        )}
        style={{ paddingLeft: 4 + depth * 12 }}
        data-testid={`oc-layer-row-${component.getId()}`}
        data-selected={isSelected ? "true" : "false"}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center justify-center h-4 w-4 text-muted-foreground hover:text-foreground"
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </button>
        ) : (
          <span className="h-4 w-4" />
        )}

        <Icon className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden />

        {editing ? (
          <input
            autoFocus
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
                setDraft(label);
              }
            }}
            className="flex-1 min-w-0 bg-transparent text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring rounded-sm px-1"
            data-testid="oc-layer-rename-input"
          />
        ) : (
          <button
            type="button"
            className={cn(
              "flex-1 min-w-0 text-left text-sm truncate",
              hidden && "opacity-50",
              locked && "italic",
            )}
            onClick={() => editor?.select(component)}
            onDoubleClick={() => {
              setDraft(label);
              setEditing(true);
            }}
          >
            {label}
          </button>
        )}

        {/* visibility + lock affordances: always visible when toggled on; fade in on hover otherwise */}
        <button
          type="button"
          className={cn(
            "flex items-center justify-center h-5 w-5 rounded-sm transition-opacity",
            hidden ? "opacity-100 text-foreground" : "opacity-0 group-hover:opacity-100 text-muted-foreground",
            "hover:bg-background hover:text-foreground",
          )}
          aria-label={hidden ? "Show layer" : "Hide layer"}
          onClick={() => {
            if (hidden) clearStyle(component, "display");
            else writeStyle(component, "display", "none");
            force((n) => n + 1);
          }}
          data-testid={`oc-layer-visibility-${component.getId()}`}
        >
          {hidden ? <EyeClosed className="size-4" /> : <Eye className="size-4" />}
        </button>
        <button
          type="button"
          className={cn(
            "flex items-center justify-center h-5 w-5 rounded-sm transition-opacity",
            locked ? "opacity-100 text-foreground" : "opacity-0 group-hover:opacity-100 text-muted-foreground",
            "hover:bg-background hover:text-foreground",
          )}
          aria-label={locked ? "Unlock layer" : "Lock layer"}
          onClick={() => {
            setLocked(component, !locked);
            force((n) => n + 1);
          }}
          data-testid={`oc-layer-lock-${component.getId()}`}
        >
          {locked ? <Lock className="size-4" /> : <LockOpen className="size-4" />}
        </button>
      </div>

      {expanded &&
        children.map((child) => (
          <LayerRow
            key={child.getId()}
            component={child}
            depth={depth + 1}
            editor={editor}
            selected={selected}
          />
        ))}
    </div>
  );
}

/* ─────────────────────────────── frame layer row (top-level) ────────── */

interface FrameLayerRowProps {
  frame: Frame;
  editor: Editor | undefined;
  selected: Component | null;
}

/**
 * A frame is a top-level node in the layer tree (per ADR-0004). The row uses
 * the FrameCorners icon and exposes a frame-specific delete affordance, but
 * otherwise behaves like any LayerRow — clicking selects the frame's wrapper
 * Component, double-click renames the frame, and the wrapper's children
 * recurse below using the existing LayerRow.
 */
function FrameLayerRow({ frame, editor, selected }: FrameLayerRowProps) {
  // `tick` (the value, not the setter) is the dep that re-derives the
  // wrapper's children list when GrapesJS mutates it in place.
  const [tick, force] = useState(0);
  const id = frameId(frame);
  const wrapper = frameWrapper(frame);
  const name = String(frameAttr(frame, "name") ?? "Frame");
  const isSelected = wrapper && selected?.getId() === wrapper.getId();
  const hidden = wrapper ? readStyle(wrapper, "display") === "none" : false;
  const locked = wrapper ? isLocked(wrapper) : false;

  const children = useMemo(
    () => {
      if (!wrapper) return [];
      return (wrapper.components() as unknown as { toArray: () => Component[] })
        .toArray()
        // Per ADR-0005 — textnode children are HTML-storage artifacts.
        .filter((c) => (c.get("type") as string | undefined) !== "textnode");
    },
    [wrapper, tick],
  );

  const [expanded, setExpanded] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);

  useEffect(() => {
    if (!editor) return;
    const onAny = () => force((n) => n + 1);
    // GrapesJS / Backbone events: subscribe individually (space-separated
    // strings aren't reliably supported on the editor bus).
    editor.on("component:add", onAny);
    editor.on("component:remove", onAny);
    editor.on("component:update", onAny);
    editor.on(ARTBOARDS_CHANGED, onAny);
    return () => {
      editor.off("component:add", onAny);
      editor.off("component:remove", onAny);
      editor.off("component:update", onAny);
      editor.off(ARTBOARDS_CHANGED, onAny);
    };
  }, [editor]);

  const commitRename = () => {
    if (!editor) return;
    const next = draft.trim() || "Untitled";
    setEditing(false);
    renameArtboard(editor, id, next);
  };

  const hasChildren = children.length > 0;

  return (
    <div data-testid={`oc-frame-row-${id}`}>
      <div
        className={cn(
          "group flex items-center gap-1 h-7 pr-1 transition-colors relative",
          isSelected && "bg-oc-accent/15",
          !isSelected && "hover:bg-surface-sunken",
        )}
        style={{ paddingLeft: 4 }}
        data-selected={isSelected ? "true" : "false"}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center justify-center h-4 w-4 text-muted-foreground hover:text-foreground"
            aria-label={expanded ? "Collapse frame" : "Expand frame"}
          >
            {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </button>
        ) : (
          <span className="h-4 w-4" />
        )}

        <FrameCorners
          className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground"
          aria-hidden
        />

        {editing ? (
          <input
            autoFocus
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitRename();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
                setDraft(name);
              }
            }}
            className="flex-1 min-w-0 bg-transparent text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring rounded-sm px-1"
            data-testid={`oc-frame-rename-input-${id}`}
          />
        ) : (
          <button
            type="button"
            className={cn(
              "flex-1 min-w-0 text-left text-sm truncate font-medium",
              hidden && "opacity-50",
              locked && "italic",
            )}
            onClick={() => wrapper && editor?.select(wrapper)}
            onDoubleClick={() => {
              setDraft(name);
              setEditing(true);
            }}
            data-testid={`oc-frame-name-${id}`}
            title={name}
          >
            {name}
          </button>
        )}

        {wrapper && (
          <>
            <button
              type="button"
              className={cn(
                "flex items-center justify-center h-5 w-5 rounded-sm transition-opacity",
                hidden
                  ? "opacity-100 text-foreground"
                  : "opacity-0 group-hover:opacity-100 text-muted-foreground",
                "hover:bg-background hover:text-foreground",
              )}
              aria-label={hidden ? "Show frame" : "Hide frame"}
              onClick={() => {
                if (hidden) clearStyle(wrapper, "display");
                else writeStyle(wrapper, "display", "none");
                force((n) => n + 1);
              }}
              data-testid={`oc-frame-visibility-${id}`}
            >
              {hidden ? <EyeClosed className="size-4" /> : <Eye className="size-4" />}
            </button>
            <button
              type="button"
              className={cn(
                "flex items-center justify-center h-5 w-5 rounded-sm transition-opacity",
                locked
                  ? "opacity-100 text-foreground"
                  : "opacity-0 group-hover:opacity-100 text-muted-foreground",
                "hover:bg-background hover:text-foreground",
              )}
              aria-label={locked ? "Unlock frame" : "Lock frame"}
              onClick={() => {
                setLocked(wrapper, !locked);
                force((n) => n + 1);
              }}
              data-testid={`oc-frame-lock-${id}`}
            >
              {locked ? <Lock className="size-4" /> : <LockOpen className="size-4" />}
            </button>
          </>
        )}

      </div>

      {expanded &&
        children.map((child) => (
          <LayerRow
            key={child.getId()}
            component={child}
            depth={1}
            editor={editor}
            selected={selected}
          />
        ))}
    </div>
  );
}

/* ─────────────────────────────── panel root ──────────────────────────── */

export function LayersPanel() {
  const editor = useEditorMaybe();
  const [selected, setSelected] = useState<Component | null>(null);
  const frames = useFrames(editor);

  // `force` re-renders when GrapesJS mutates the canvas (component add/remove
  // anywhere). The individual rows have their own per-component subscriptions;
  // this just keeps the top-level map of frames + their root children fresh.
  const [, force] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const onChange = () => force((n) => n + 1);
    editor.on("component:add", onChange);
    editor.on("component:remove", onChange);
    return () => {
      editor.off("component:add", onChange);
      editor.off("component:remove", onChange);
    };
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    const update = () => setSelected(editor.getSelected() ?? null);
    update();
    editor.on("component:selected component:deselected", update);
    return () => {
      editor.off("component:selected component:deselected", update);
    };
  }, [editor]);

  // Delete / Backspace deletes the selected layer or frame. Ignored when the
  // keystroke is targeting a text input (rename input, inspector fields, etc).
  useEffect(() => {
    if (!editor) return;
    const isEditable = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      if (el.isContentEditable) return true;
      const tag = el.tagName.toLowerCase();
      return tag === "input" || tag === "textarea" || tag === "select";
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Delete" && ev.key !== "Backspace") return;
      if (isEditable(ev.target)) return;
      const sel = editor.getSelected();
      if (!sel) return;
      // Is this component a frame's wrapper? If so, delete the frame.
      const frames = editor.Canvas.getFrames();
      for (const frame of frames) {
        const w = (frame as unknown as { get?: (k: string) => unknown }).get?.("component");
        if (w === sel) {
          ev.preventDefault();
          deleteArtboard(editor, frameId(frame));
          return;
        }
      }
      // Regular component — call its own remove.
      ev.preventDefault();
      (sel as unknown as { remove?: () => void }).remove?.();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [editor]);

  const addFrame = () => {
    if (!editor) return;
    createArtboard(editor, { name: "Frame", width: 1440, height: 900 });
  };

  return (
    // `[&_svg]:stroke-[1.25]` thins the hairline stroke for every lucide
    // icon inside the panel, so the layer tree reads lighter than the
    // inspector iconography (default strokeWidth=2).
    <div className="flex flex-col min-h-0 h-full overflow-auto [&_svg]:stroke-[1.25]">
        <section>
          <div className="h-(--section-title-height) pl-(--panel-padding) pr-1 flex items-center justify-between border-b border-border">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">
              Layers
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={addFrame}
                  className={cn(
                    "flex items-center justify-center h-5 w-5 rounded-sm transition-colors",
                    "text-muted-foreground hover:text-foreground hover:bg-background",
                    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  )}
                  aria-label="Add frame"
                  data-testid="oc-layers-add-frame"
                >
                  <PlusOutline className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">Add frame</TooltipContent>
            </Tooltip>
          </div>
          {frames.length === 0 ? (
            <div className="p-2 text-xs text-muted-foreground">No frames</div>
          ) : (
            <div className="flex flex-col">
              {frames.map((frame) => (
                <FrameLayerRow
                  key={frameId(frame)}
                  frame={frame}
                  editor={editor ?? undefined}
                  selected={selected}
                />
              ))}
            </div>
          )}
        </section>
      </div>
  );
}
