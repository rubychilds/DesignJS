import { useRef, useState } from "react";
import type { Component } from "grapesjs";
import {
  AlignCenterVertical,
  AlignEndVertical,
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart,
  AlignHorizontalSpaceAround,
  AlignHorizontalSpaceBetween,
  AlignStartVertical,
  ArrowDown,
  ArrowRight,
  Columns3,
  LayoutPanelLeft,
  LockSimple,
  LockSimpleOpen,
  Move,
  Square,
  StretchHorizontal,
} from "../../canvas/chrome-icons.js";
import { cn } from "../../lib/utils.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.js";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group.js";
import { NumberInput } from "../ui/number-input.js";
import { clearStyle, readEffectiveStyle, readStyle, writeStyle } from "../../canvas/component-style.js";
import { FieldGroup, InspectorSection } from "./InspectorSection.js";
import { SizeField, type SizeMode } from "./controls/SizeField.js";
import { useInspectorContext } from "./useInspectorContext.js";
import { isAutoLayoutApplicable } from "./applicability.js";

/**
 * Layout — auto-layout (flex) parent controls + dimensions (W/H) + child-side
 * layout item controls + clip content. Replaces the earlier AutoLayout,
 * LayoutItem, Frame, and MeasuresSection's W/H rows.
 */
export function LayoutSection({ component }: { component: Component }) {
  const display = readStyle(component, "display");
  const isFlex = display === "flex" || display === "inline-flex";
  const isGrid = display === "grid" || display === "inline-grid";
  const enabled = isFlex || isGrid;
  const context = useInspectorContext(component);
  // Text elements are leaves in the design model — auto-layout (flex/grid
  // on this element as a container) has no meaning there. Hide the toggle
  // entirely rather than greying it, unless the component already carries
  // flex/grid (e.g. pasted markup) so the user still has a way to turn it
  // back off.
  const showAutoLayoutToggle = isAutoLayoutApplicable(component) || enabled;

  const toggle = () => {
    if (enabled) {
      clearStyle(component, "display");
      clearStyle(component, "flex-direction");
      clearStyle(component, "flex-wrap");
    } else {
      writeStyle(component, "display", "flex");
    }
  };

  const toggleControl = (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={toggle}
          className={cn(
            "flex items-center justify-center h-5 w-5 rounded-sm transition-colors",
            // Selected state: light-blue fill + darker-blue stroke — same
            // treatment as the blend picker in Appearance, so "this
            // section-header toggle is on" reads consistently across the
            // inspector.
            enabled
              ? "bg-oc-accent/15 text-oc-accent"
              : "text-muted-foreground hover:text-foreground hover:bg-background",
          )}
          aria-pressed={enabled}
          aria-label={enabled ? "Remove auto layout" : "Add auto layout"}
          data-testid="oc-ins-autolayout-toggle"
        >
          <LayoutPanelLeft className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{enabled ? "Remove auto layout" : "Add auto layout"}</TooltipContent>
    </Tooltip>
  );

  // Section title flips to "Auto Layout" once the flex/grid display is on —
  // makes the heading match the controls that appear below (direction,
  // justify, gap — or the grid track editor).
  const title = enabled ? "Auto Layout" : "Layout";

  return (
    <InspectorSection
      title={title}
      action={showAutoLayoutToggle ? toggleControl : undefined}
      muted={!enabled}
    >
      <WHRow
        component={component}
        selfIsFlex={isFlex}
        parentIsFlex={context.isFlexParent || context.isGridParent}
      />
      {enabled ? <DirectionRow component={component} isFlex={isFlex} isGrid={isGrid} /> : null}
      {isFlex ? <AutoLayoutRows component={component} /> : null}
      {isGrid ? <GridRows component={component} /> : null}
      <PaddingRow component={component} />
      <MarginRow component={component} />
      {context.isLayoutChild ? (
        <LayoutItemRows component={component} parentIsGrid={context.isGridParent} />
      ) : null}
      <ClipRow component={component} />
    </InspectorSection>
  );
}

/* ─────────────────────────────── W/H ─────────────────────────────── */

function readSizeMode(value: string): SizeMode {
  const trimmed = value.trim();
  if (!trimmed) return "hug";
  if (trimmed === "auto" || trimmed === "max-content" || trimmed === "fit-content")
    return "hug";
  if (trimmed === "100%" || trimmed === "stretch") return "fill";
  return "fixed";
}

/**
 * When the derived mode isn't valid for the current element+parent context
 * (e.g. `width: ""` reads as Hug, but Hug requires an auto-layout container),
 * snap to the first available mode. Prevents a dropdown from reporting a
 * disabled mode as selected.
 */
function resolveMode(value: string, available: SizeMode[]): SizeMode {
  const derived = readSizeMode(value);
  if (available.includes(derived)) return derived;
  return available[0] ?? "fixed";
}

function writeSize(
  component: Component,
  prop: "width" | "height",
  mode: SizeMode,
  fallback: number,
): void {
  if (mode === "fixed") {
    writeStyle(component, prop, `${fallback || 100}px`);
  } else if (mode === "hug") {
    clearStyle(component, prop);
  } else {
    writeStyle(component, prop, "100%");
  }
}

function WHRow({
  component,
  selfIsFlex,
  parentIsFlex,
}: {
  component: Component;
  selfIsFlex: boolean;
  parentIsFlex: boolean;
}) {
  // readEffectiveStyle: surface the *rendered* width/height for captured
  // elements (where styles route through GrapesJS' CSS Manager not the
  // component model). For elements with no explicit dimension set this
  // shows the layout-derived px value — e.g. a captured paragraph's
  // actual width instead of blank. Other Layout properties (min/max,
  // display, flex/grid) keep readStyle since their "unset" state is
  // semantically meaningful and computed defaults would mislead.
  const width = readEffectiveStyle(component, "width");
  const height = readEffectiveStyle(component, "height");
  const widthNum = parsePx(width);
  const heightNum = parsePx(height);

  // Min/Max clamps — independent of mode (a Fill axis can still carry a
  // `max-width` cap; a Fixed axis a `min-width` floor). Empty string means
  // unset; the SizeField overflow popover writes `null` to clear.
  const minWidth = readStyle(component, "min-width");
  const maxWidth = readStyle(component, "max-width");
  const minHeight = readStyle(component, "min-height");
  const maxHeight = readStyle(component, "max-height");

  const setClamp = (prop: "min-width" | "max-width" | "min-height" | "max-height") =>
    (next: number | null) => {
      if (next == null) {
        clearStyle(component, prop);
      } else {
        writeStyle(component, prop, `${next}px`);
      }
    };

  // Availability rules mirror Figma: Hug only when *this* element lays out
  // its own content (auto-layout container); Fill only when the *parent*
  // does (so "stretch to fill parent" is meaningful).
  const widthModes: SizeMode[] = [
    "fixed",
    ...(selfIsFlex ? (["hug"] as const) : []),
    ...(parentIsFlex ? (["fill"] as const) : []),
  ];
  const heightModes = widthModes;

  const widthMode = resolveMode(width, widthModes);
  const heightMode = resolveMode(height, heightModes);

  // Aspect-lock state is React-local — not persisted. Captures the W:H ratio
  // at lock-engage time. Only meaningful when both axes are Fixed.
  const [locked, setLocked] = useState(false);
  const ratioRef = useRef<number | null>(null);

  const toggleLock = () => {
    if (!locked) {
      ratioRef.current = widthNum && heightNum ? widthNum / heightNum : 1;
    } else {
      ratioRef.current = null;
    }
    setLocked((prev) => !prev);
  };

  const onWFixed = (n: number) => {
    writeStyle(component, "width", `${n}px`);
    if (locked && ratioRef.current && ratioRef.current > 0 && heightMode === "fixed") {
      writeStyle(component, "height", `${Math.round(n / ratioRef.current)}px`);
    }
  };
  const onHFixed = (n: number) => {
    writeStyle(component, "height", `${n}px`);
    if (locked && ratioRef.current && ratioRef.current > 0 && widthMode === "fixed") {
      writeStyle(component, "width", `${Math.round(n * ratioRef.current)}px`);
    }
  };

  return (
    // W and H split the row evenly; the aspect-ratio lock trails on the
    // right — same pattern as the per-corner radius toggle and per-side
    // padding toggle so "extra-action lives on the right" stays consistent
    // across the inspector.
    <div className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
      <SizeField
        axis="W"
        value={width}
        mode={widthMode}
        availableModes={widthModes}
        onModeChange={(m) => writeSize(component, "width", m, widthNum ?? 0)}
        onFixedChange={onWFixed}
        minValue={minWidth}
        maxValue={maxWidth}
        onMinChange={setClamp("min-width")}
        onMaxChange={setClamp("max-width")}
        data-testid="oc-ins-width"
      />
      <SizeField
        axis="H"
        value={height}
        mode={heightMode}
        availableModes={heightModes}
        onModeChange={(m) => writeSize(component, "height", m, heightNum ?? 0)}
        onFixedChange={onHFixed}
        minValue={minHeight}
        maxValue={maxHeight}
        onMinChange={setClamp("min-height")}
        onMaxChange={setClamp("max-height")}
        data-testid="oc-ins-height"
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={toggleLock}
            aria-label={locked ? "Unlink width and height" : "Link width and height"}
            aria-pressed={locked}
            className={cn(
              "flex items-center justify-center w-6 h-6 rounded-sm transition-colors",
              "hover:bg-background",
              locked ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
            data-testid="oc-ins-aspect-lock"
          >
            {locked ? (
              <LockSimple className="size-3.5" />
            ) : (
              <LockSimpleOpen className="size-3.5" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>{locked ? "Aspect ratio locked" : "Lock aspect ratio"}</TooltipContent>
      </Tooltip>
    </div>
  );
}

function parsePx(raw: string): number | null {
  const m = /^(-?\d*\.?\d+)/.exec(raw.trim());
  if (!m) return null;
  const n = parseFloat(m[1]!);
  return Number.isFinite(n) ? n : null;
}

/* ───────────────────── Auto Layout (flex parent) ───────────────────── */

const DIRECTION_OPTIONS = [
  { value: "row", label: "Horizontal", Icon: ArrowRight },
  { value: "column", label: "Vertical", Icon: ArrowDown },
  { value: "grid", label: "Grid", Icon: Columns3 },
  { value: "free", label: "Free form", Icon: Move },
] as const;

/**
 * Direction row lives outside AutoLayoutRows / GridRows so it can switch
 * between the two layout paradigms. Writing "grid" flips `display: grid`
 * and clears flex-* properties; picking a flex axis flips back.
 */
function DirectionRow({
  component,
  isFlex,
  isGrid,
}: {
  component: Component;
  isFlex: boolean;
  isGrid: boolean;
}) {
  const rawFlexDirection = readStyle(component, "flex-direction") || "row";
  const reversed = rawFlexDirection.endsWith("-reverse");
  const baseAxis = reversed
    ? rawFlexDirection.replace("-reverse", "")
    : rawFlexDirection;
  const direction = isGrid ? "grid" : isFlex ? baseAxis : "free";
  const wrap = readStyle(component, "flex-wrap") || "nowrap";

  const setDirection = (v: string) => {
    if (v === "free") {
      clearStyle(component, "display");
      clearStyle(component, "flex-direction");
      clearStyle(component, "flex-wrap");
      return;
    }
    if (v === "grid") {
      writeStyle(component, "display", "grid");
      clearStyle(component, "flex-direction");
      clearStyle(component, "flex-wrap");
      return;
    }
    // flex row or column
    writeStyle(component, "display", "flex");
    const next = reversed ? `${v}-reverse` : v;
    writeStyle(component, "flex-direction", next);
  };

  return (
    <FieldGroup label="Direction">
      <div className="flex items-center gap-2">
        <ToggleGroup
          type="single"
          value={direction}
          onValueChange={(v) => v && setDirection(v)}
          data-testid="oc-ins-flex-direction"
        >
          {DIRECTION_OPTIONS.map(({ value: val, label, Icon }) => (
            <Tooltip key={val}>
              <TooltipTrigger asChild>
                <ToggleGroupItem value={val} aria-label={label}>
                  <Icon />
                </ToggleGroupItem>
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          ))}
        </ToggleGroup>
        {isFlex ? (
          <>
            <label className="flex items-center gap-1 cursor-pointer text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                className="accent-oc-accent"
                checked={reversed}
                onChange={(e) => {
                  const next = e.target.checked ? `${baseAxis}-reverse` : baseAxis;
                  writeStyle(component, "flex-direction", next);
                }}
                data-testid="oc-ins-flex-reverse"
              />
              Reverse
            </label>
            <label className="flex items-center gap-1 cursor-pointer text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                className="accent-oc-accent"
                checked={wrap !== "nowrap"}
                onChange={(e) => {
                  if (e.target.checked) writeStyle(component, "flex-wrap", "wrap");
                  else clearStyle(component, "flex-wrap");
                }}
                data-testid="oc-ins-flex-wrap"
              />
              Wrap
            </label>
          </>
        ) : null}
      </div>
    </FieldGroup>
  );
}

const JUSTIFY_OPTIONS = [
  { value: "flex-start", label: "Start", Icon: AlignHorizontalJustifyStart },
  { value: "center", label: "Center", Icon: AlignHorizontalJustifyCenter },
  { value: "flex-end", label: "End", Icon: AlignHorizontalJustifyEnd },
  { value: "space-between", label: "Space between", Icon: AlignHorizontalSpaceBetween },
  { value: "space-around", label: "Space around", Icon: AlignHorizontalSpaceAround },
  { value: "space-evenly", label: "Space evenly", Icon: AlignHorizontalSpaceAround },
] as const;

function AutoLayoutRows({ component }: { component: Component }) {
  const gap = readStyle(component, "gap");
  const justify = readStyle(component, "justify-content");

  return (
    <>
      <FieldGroup label="Gap">
        <NumberInput
          value={gap}
          onChange={(n) => writeStyle(component, "gap", `${n}px`)}
          unit="px"
          label="↔"
          min={0}
          step={1}
          data-testid="oc-ins-gap"
        />
      </FieldGroup>
      <FieldGroup label="Justify">
        <ToggleGroup
          type="single"
          value={justify}
          onValueChange={(v) => v && writeStyle(component, "justify-content", v)}
          data-testid="oc-ins-justify"
        >
          {JUSTIFY_OPTIONS.map(({ value: val, label, Icon }) => (
            <Tooltip key={val}>
              <TooltipTrigger asChild>
                <ToggleGroupItem value={val} aria-label={label}>
                  <Icon />
                </ToggleGroupItem>
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          ))}
        </ToggleGroup>
      </FieldGroup>
    </>
  );
}

/* ───────────────── Grid (grid parent) ─────────────────────── */

/**
 * Minimum-viable grid controls — free-form text inputs for
 * `grid-template-columns` / `grid-template-rows` plus separate row and
 * column gaps. Matches CSS semantics directly so power users can type
 * `repeat(3, 1fr) 2fr` or `100px 1fr`. A full track editor (per-track
 * type + value UI like Penpot) is a follow-up; this stays within CSS
 * vocabulary and keeps grid reachable without Raw CSS.
 */
function GridRows({ component }: { component: Component }) {
  const columns = readStyle(component, "grid-template-columns");
  const rows = readStyle(component, "grid-template-rows");
  const rowGap = readStyle(component, "row-gap") || readStyle(component, "gap");
  const colGap =
    readStyle(component, "column-gap") || readStyle(component, "gap");

  const writeTracks = (prop: "grid-template-columns" | "grid-template-rows") =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value.trim();
      if (!v) clearStyle(component, prop);
      else writeStyle(component, prop, v);
    };

  return (
    <>
      <FieldGroup label="Columns">
        <input
          type="text"
          value={columns}
          onChange={writeTracks("grid-template-columns")}
          placeholder="1fr 1fr 1fr"
          className={cn(
            "h-7 w-full rounded-md bg-chip px-2 text-xs text-foreground tabular-nums",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-oc-accent",
          )}
          data-testid="oc-ins-grid-cols"
          aria-label="Grid columns"
        />
      </FieldGroup>
      <FieldGroup label="Rows">
        <input
          type="text"
          value={rows}
          onChange={writeTracks("grid-template-rows")}
          placeholder="auto"
          className={cn(
            "h-7 w-full rounded-md bg-chip px-2 text-xs text-foreground tabular-nums",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-oc-accent",
          )}
          data-testid="oc-ins-grid-rows"
          aria-label="Grid rows"
        />
      </FieldGroup>
      <div className="grid grid-cols-2 gap-2">
        <NumberInput
          value={parsePx(colGap) ?? 0}
          onChange={(n) => {
            if (n <= 0) clearStyle(component, "column-gap");
            else writeStyle(component, "column-gap", `${n}px`);
          }}
          unit="px"
          label="↔"
          min={0}
          step={1}
          data-testid="oc-ins-grid-col-gap"
        />
        <NumberInput
          value={parsePx(rowGap) ?? 0}
          onChange={(n) => {
            if (n <= 0) clearStyle(component, "row-gap");
            else writeStyle(component, "row-gap", `${n}px`);
          }}
          unit="px"
          label="↕"
          min={0}
          step={1}
          data-testid="oc-ins-grid-row-gap"
        />
      </div>
    </>
  );
}

/* ───────────────── Layout Item (flex child) ─────────────────── */

const ALIGN_SELF_OPTIONS = [
  { value: "flex-start", label: "Start", Icon: AlignStartVertical },
  { value: "center", label: "Center", Icon: AlignCenterVertical },
  { value: "flex-end", label: "End", Icon: AlignEndVertical },
  { value: "stretch", label: "Stretch", Icon: StretchHorizontal },
] as const;

function LayoutItemRows({
  component,
  parentIsGrid,
}: {
  component: Component;
  parentIsGrid: boolean;
}) {
  if (parentIsGrid) return <GridItemRows component={component} />;
  return <FlexItemRows component={component} />;
}

function FlexItemRows({ component }: { component: Component }) {
  const alignSelf = readStyle(component, "align-self");
  const flexGrow = readStyle(component, "flex-grow");
  const flexShrink = readStyle(component, "flex-shrink");
  const flexBasis = readStyle(component, "flex-basis");

  return (
    <>
      <FieldGroup label="Align self">
        <ToggleGroup
          type="single"
          value={alignSelf}
          onValueChange={(v) => {
            if (!v) clearStyle(component, "align-self");
            else writeStyle(component, "align-self", v);
          }}
          data-testid="oc-ins-align-self"
        >
          {ALIGN_SELF_OPTIONS.map(({ value, label, Icon }) => (
            <Tooltip key={value}>
              <TooltipTrigger asChild>
                <ToggleGroupItem value={value} aria-label={label}>
                  <Icon />
                </ToggleGroupItem>
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          ))}
        </ToggleGroup>
      </FieldGroup>
      <div className="grid grid-cols-2 gap-2">
        <NumberInput
          value={flexGrow}
          onChange={(n) => {
            if (n === 0) clearStyle(component, "flex-grow");
            else writeStyle(component, "flex-grow", String(n));
          }}
          min={0}
          step={1}
          label="G"
          data-testid="oc-ins-flex-grow"
        />
        <NumberInput
          value={flexShrink}
          onChange={(n) => {
            if (n === 1) clearStyle(component, "flex-shrink");
            else writeStyle(component, "flex-shrink", String(n));
          }}
          min={0}
          step={1}
          label="S"
          data-testid="oc-ins-flex-shrink"
        />
      </div>
      <FieldGroup label="Basis">
        <NumberInput
          value={flexBasis}
          onChange={(n) => writeStyle(component, "flex-basis", `${n}px`)}
          unit="px"
          label="B"
          step={1}
          data-testid="oc-ins-flex-basis"
        />
      </FieldGroup>
    </>
  );
}

/**
 * Grid-item controls. Accepts grid-column / grid-row as free-form CSS
 * strings — typical syntax is `1 / 3` for "span from line 1 to 3" or
 * `span 2` for "span 2 tracks." Full structured (start + end + span)
 * inputs are a follow-up.
 */
function GridItemRows({ component }: { component: Component }) {
  const column = readStyle(component, "grid-column");
  const row = readStyle(component, "grid-row");
  const writeTrack = (prop: "grid-column" | "grid-row") =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value.trim();
      if (!v) clearStyle(component, prop);
      else writeStyle(component, prop, v);
    };
  const inputClass = cn(
    "h-7 w-full rounded-md bg-chip px-2 text-xs text-foreground tabular-nums",
    "focus:outline-none focus-visible:ring-1 focus-visible:ring-oc-accent",
  );
  return (
    <>
      <FieldGroup label="Column">
        <input
          type="text"
          value={column}
          onChange={writeTrack("grid-column")}
          placeholder="auto"
          className={inputClass}
          data-testid="oc-ins-grid-column"
          aria-label="Grid column"
        />
      </FieldGroup>
      <FieldGroup label="Row">
        <input
          type="text"
          value={row}
          onChange={writeTrack("grid-row")}
          placeholder="auto"
          className={inputClass}
          data-testid="oc-ins-grid-row"
          aria-label="Grid row"
        />
      </FieldGroup>
    </>
  );
}

/* ───────────────────── Padding / Margin (SpacingRow) ─────────────────────── */

function parseSpacingPx(raw: string, allowNegative: boolean): number {
  const m = /^(-?\d*\.?\d+)/.exec(raw.trim());
  if (!m) return 0;
  const n = parseFloat(m[1]!);
  if (!Number.isFinite(n)) return 0;
  return allowNegative ? n : Math.max(0, n);
}

/**
 * Shared Padding / Margin four-side + V/H toggle row. Padding rejects negative
 * values (Figma parity); Margin accepts them (needed for overlap / pull-up
 * layouts).
 */
function SpacingRow({
  component,
  prop,
  label,
  allowNegative,
  testIdPrefix,
}: {
  component: Component;
  prop: "padding" | "margin";
  label: string;
  allowNegative: boolean;
  testIdPrefix: string;
}) {
  const [perSide, setPerSide] = useState(false);

  const pt = parseSpacingPx(readStyle(component, `${prop}-top`), allowNegative);
  const pr = parseSpacingPx(readStyle(component, `${prop}-right`), allowNegative);
  const pb = parseSpacingPx(readStyle(component, `${prop}-bottom`), allowNegative);
  const pl = parseSpacingPx(readStyle(component, `${prop}-left`), allowNegative);

  const v = pt === pb ? pt : pt;
  const h = pl === pr ? pl : pl;

  const setUnified = (nextV: number, nextH: number) => {
    const write = (side: string, n: number) => {
      if (!allowNegative && n <= 0) clearStyle(component, `${prop}-${side}`);
      else if (allowNegative && n === 0) clearStyle(component, `${prop}-${side}`);
      else writeStyle(component, `${prop}-${side}`, `${n}px`);
    };
    write("top", nextV);
    write("bottom", nextV);
    write("left", nextH);
    write("right", nextH);
    clearStyle(component, prop);
  };

  const setSide = (side: "top" | "right" | "bottom" | "left") => (n: number) => {
    if (!allowNegative && n <= 0) clearStyle(component, `${prop}-${side}`);
    else if (allowNegative && n === 0) clearStyle(component, `${prop}-${side}`);
    else writeStyle(component, `${prop}-${side}`, `${n}px`);
    clearStyle(component, prop);
  };

  const minValue = allowNegative ? -Infinity : 0;

  return (
    <FieldGroup label={label}>
      <div className="flex items-center gap-2">
        {perSide ? (
          <span className="flex-1 text-[11px] text-muted-foreground">Per side</span>
        ) : (
          <div className="grid grid-cols-2 gap-2 flex-1">
            <NumberInput
              value={v}
              onChange={(n) => setUnified(n, h)}
              unit="px"
              label="V"
              min={minValue}
              step={1}
              data-testid={`${testIdPrefix}-v`}
            />
            <NumberInput
              value={h}
              onChange={(n) => setUnified(v, n)}
              unit="px"
              label="H"
              min={minValue}
              step={1}
              data-testid={`${testIdPrefix}-h`}
            />
          </div>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setPerSide((v) => !v)}
              aria-label={perSide ? `Unified ${prop}` : `Per-side ${prop}`}
              aria-pressed={perSide}
              className={cn(
                "flex items-center justify-center w-6 h-6 rounded-sm transition-colors",
                "hover:bg-background",
                perSide ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
              data-testid={`${testIdPrefix}-mode`}
            >
              <Square className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {perSide ? `Switch to V/H ${prop}` : `Switch to per-side ${prop}`}
          </TooltipContent>
        </Tooltip>
      </div>
      {perSide ? (
        <div className="grid grid-cols-2 gap-2">
          <NumberInput
            value={pt}
            onChange={setSide("top")}
            unit="px"
            label="T"
            min={minValue}
            step={1}
            data-testid={`${testIdPrefix}-top`}
          />
          <NumberInput
            value={pr}
            onChange={setSide("right")}
            unit="px"
            label="R"
            min={minValue}
            step={1}
            data-testid={`${testIdPrefix}-right`}
          />
          <NumberInput
            value={pb}
            onChange={setSide("bottom")}
            unit="px"
            label="B"
            min={minValue}
            step={1}
            data-testid={`${testIdPrefix}-bottom`}
          />
          <NumberInput
            value={pl}
            onChange={setSide("left")}
            unit="px"
            label="L"
            min={minValue}
            step={1}
            data-testid={`${testIdPrefix}-left`}
          />
        </div>
      ) : null}
    </FieldGroup>
  );
}

function PaddingRow({ component }: { component: Component }) {
  return (
    <SpacingRow
      component={component}
      prop="padding"
      label="Padding"
      allowNegative={false}
      testIdPrefix="oc-ins-padding"
    />
  );
}

function MarginRow({ component }: { component: Component }) {
  return (
    <SpacingRow
      component={component}
      prop="margin"
      label="Margin"
      allowNegative={true}
      testIdPrefix="oc-ins-margin"
    />
  );
}

/* ───────────────────── Clip content (overflow) ────────────────────────── */

/**
 * Single-checkbox "Clip content" control — unchecked means overflow stays at
 * the browser default of `visible`; checked writes `overflow: hidden` on
 * both axes via the shorthand. Replaces the earlier dual X/Y dropdowns
 * because the full overflow taxonomy (scroll / auto / per-axis) is Raw CSS
 * territory for the tiny minority of components that need it.
 */
function ClipRow({ component }: { component: Component }) {
  const shorthand = readStyle(component, "overflow");
  const ox = readStyle(component, "overflow-x") || shorthand;
  const oy = readStyle(component, "overflow-y") || shorthand;
  // Anything that isn't "" (unset) or "visible" counts as clipping. Covers
  // legacy components where the previous per-axis UI wrote `hidden`, `scroll`,
  // or `auto` on one side.
  const clipped =
    (ox !== "" && ox !== "visible") || (oy !== "" && oy !== "visible");

  const setClipped = (next: boolean) => {
    // Clean both longhands and the shorthand before deciding — avoids the
    // shorthand + longhand mismatch the old per-axis UI had to work around.
    clearStyle(component, "overflow-x");
    clearStyle(component, "overflow-y");
    clearStyle(component, "overflow");
    if (next) writeStyle(component, "overflow", "hidden");
  };

  return (
    <label className="flex items-center gap-2 cursor-pointer text-sm text-foreground">
      <input
        type="checkbox"
        className="accent-oc-accent"
        checked={clipped}
        onChange={(e) => setClipped(e.target.checked)}
        data-testid="oc-ins-clip-content"
        aria-label="Clip content"
      />
      Clip content
    </label>
  );
}
