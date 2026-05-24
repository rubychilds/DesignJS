import { useState } from "react";
import type { Component } from "grapesjs";
import { Droplet, Square } from "../../canvas/chrome-icons.js";
import { cn } from "../../lib/utils.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.js";
import { NumberInput } from "../ui/number-input.js";
import { clearStyle, readStyle, writeStyle } from "../../canvas/component-style.js";
import { FieldGroup, InspectorSection } from "./InspectorSection.js";
import { isRadiusApplicable } from "./applicability.js";

/**
 * Blend modes grouped by family — matches Figma's dropdown structure so the
 * mental model carries between tools. Separators in the dropdown render
 * between groups; no header labels (Figma ships none either — the visual
 * separator is enough).
 */
const BLEND_GROUPS: ReadonlyArray<readonly string[]> = [
  ["normal"],
  ["darken", "multiply", "color-burn"],
  ["lighten", "screen", "color-dodge"],
  ["overlay", "soft-light", "hard-light"],
  ["difference", "exclusion"],
  ["hue", "saturation", "color", "luminosity"],
];

const BLEND_MODES = BLEND_GROUPS.flat();

/**
 * Display label for a CSS `mix-blend-mode` value — drops the dash and
 * Title-Cases the parts ("color-dodge" → "Color Dodge"). Matches the casing
 * used by Figma, Sketch, and most design-tool blend pickers.
 */
function formatBlend(mode: string): string {
  return mode
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

const PER_CORNER_PROPS = [
  ["border-top-left-radius", "↖", "Top-left", "oc-ins-radius-tl"],
  ["border-top-right-radius", "↗", "Top-right", "oc-ins-radius-tr"],
  ["border-bottom-left-radius", "↙", "Bottom-left", "oc-ins-radius-bl"],
  ["border-bottom-right-radius", "↘", "Bottom-right", "oc-ins-radius-br"],
] as const;

const CURSOR_OPTIONS = [
  "auto",
  "default",
  "pointer",
  "text",
  "crosshair",
  "grab",
  "grabbing",
  "move",
  "not-allowed",
  "wait",
  "help",
  "zoom-in",
  "zoom-out",
] as const;

/**
 * Appearance — opacity, border radius, blend mode, cursor, z-index. Collapses
 * what was the Layer section's opacity/blend controls with the Radius row
 * from the former MeasuresSection, per user direction ("appearance (opacity,
 * border radius)"). Visibility + lock live on the layer tree rows now, not
 * in the inspector. Cursor + z-index live here because they're per-element
 * visual/interaction state with no other obvious home.
 */
export function AppearanceSection({ component }: { component: Component }) {
  // Blend picker lives up in the section header (mirrors the Layout
  // section's auto-layout toggle). The body-level <select> chip still
  // renders via BlendRow but only when a non-default mode is active.
  const blendMode = readStyle(component, "mix-blend-mode") || "normal";
  const hasBlend = blendMode !== "normal";
  const setBlend = (next: string) => {
    if (next === "normal") clearStyle(component, "mix-blend-mode");
    else writeStyle(component, "mix-blend-mode", next);
  };

  const blendPicker = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Choose blend mode"
          aria-pressed={hasBlend}
          className={cn(
            "flex items-center justify-center h-5 w-5 rounded-sm transition-colors",
            // Selected state: light-blue fill + darker-blue stroke so the
            // "blend is on" signal reads at a glance without wording.
            hasBlend
              ? "bg-oc-accent/15 text-oc-accent"
              : "text-muted-foreground hover:text-foreground hover:bg-background",
          )}
          data-testid="oc-ins-layer-blend-picker"
        >
          <Droplet className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      {/* min-w-40 gives the label column enough room alongside the left-
          aligned checkmark so the longest entry ("Color Dodge", "Luminosity")
          doesn't wrap. */}
      <DropdownMenuContent align="end" sideOffset={4} className="min-w-40">
        {BLEND_GROUPS.map((group, groupIndex) => (
          <div key={groupIndex}>
            {groupIndex > 0 ? <DropdownMenuSeparator /> : null}
            {group.map((m) => (
              <DropdownMenuCheckboxItem
                key={m}
                checked={m === blendMode}
                onSelect={() => setBlend(m)}
                data-testid={`oc-ins-layer-blend-option-${m}`}
              >
                {formatBlend(m)}
              </DropdownMenuCheckboxItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // Backplate row only renders when the selection is the ADR-0012 §1
  // hybrid screenshot backplate (img or its wrapper). Hidden for every
  // other selection so we don't clutter the panel with a control that
  // does nothing.
  const attrs =
    (component as unknown as { getAttributes?: () => Record<string, unknown> }).getAttributes?.() ??
    {};
  const isBackplate =
    "data-designjs-backplate" in attrs || "data-designjs-backplate-wrapper" in attrs;

  return (
    <InspectorSection title="Appearance" action={blendPicker}>
      <OpacityRadiusRow component={component} />
      {hasBlend ? <BlendRow component={component} /> : null}
      <CursorRow component={component} />
      <ZIndexRow component={component} />
      {isBackplate ? (
        <BackplateRow
          component={component}
          isImg={"data-designjs-backplate" in attrs}
        />
      ) : null}
    </InspectorSection>
  );
}

/**
 * Dedicated affordance for the ADR-0012 §1 hybrid screenshot backplate.
 * The generic Appearance opacity control above already writes
 * `opacity` on whatever's selected — but a labelled "Source screenshot
 * backplate" subsection makes the intent legible: drag from 0 (edit
 * mode) to 100 (pure pixel reference). Only renders when the selected
 * component is the backplate img or wrapper.
 *
 * The img's class CSS gives a 15% default; clearing the inline opacity
 * (slider at 15) reverts to the class-CSS value. The wrapper has no
 * default opacity — clearing reverts to 100%.
 */
function BackplateRow({
  component,
  isImg,
}: {
  component: Component;
  isImg: boolean;
}) {
  const defaultPct = isImg ? 15 : 100;
  const rawOpacity = readStyle(component, "opacity");
  const opacity =
    rawOpacity === ""
      ? defaultPct
      : Math.round(Math.max(0, Math.min(1, parseFloat(rawOpacity))) * 100);

  return (
    <FieldGroup label="Source screenshot backplate">
      <NumberInput
        value={opacity}
        onChange={(n) => {
          const v = Math.max(0, Math.min(100, Math.round(n)));
          if (v === defaultPct) clearStyle(component, "opacity");
          else writeStyle(component, "opacity", String(v / 100));
        }}
        min={0}
        max={100}
        step={1}
        unit="%"
        label="Opacity"
        data-testid="oc-ins-backplate-opacity"
      />
    </FieldGroup>
  );
}

function CursorRow({ component }: { component: Component }) {
  const cursor = readStyle(component, "cursor") || "auto";
  return (
    <FieldGroup label="Cursor">
      <select
        value={cursor}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "auto") clearStyle(component, "cursor");
          else writeStyle(component, "cursor", v);
        }}
        className={cn(
          "h-7 w-full rounded-md bg-chip px-2 text-xs text-foreground",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-oc-accent",
        )}
        data-testid="oc-ins-cursor"
        aria-label="Cursor"
      >
        {CURSOR_OPTIONS.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </FieldGroup>
  );
}

function ZIndexRow({ component }: { component: Component }) {
  const raw = readStyle(component, "z-index");
  const value = raw === "" || raw === "auto" ? 0 : parseInt(raw, 10) || 0;
  return (
    <FieldGroup label="Stack order">
      <NumberInput
        value={value}
        onChange={(n) => {
          if (n === 0) clearStyle(component, "z-index");
          else writeStyle(component, "z-index", String(Math.round(n)));
        }}
        step={1}
        label="Z"
        data-testid="oc-ins-z-index"
      />
    </FieldGroup>
  );
}

/**
 * Opacity and radius share a row — both are single-number chips and having
 * them side-by-side saves a line of vertical space in the inspector. The
 * per-corner radius toggle lives on the right; when flipped on, the four
 * per-corner inputs drop to a second row underneath.
 *
 * The opacity chip trails with the "%" unit on the right and no scrubber
 * label on the left — a leading "%" would double up with the trailing unit.
 */
function OpacityRadiusRow({ component }: { component: Component }) {
  const [perCorner, setPerCorner] = useState(false);
  // Greyed-out (not hidden) when the selection can't show a rounded corner
  // — e.g. inline text runs. Keeps the row rhythm of the panel stable
  // across selections while signalling "nothing to do here."
  const radiusEnabled = isRadiusApplicable(component);

  const rawOpacity = readStyle(component, "opacity");
  const opacity =
    rawOpacity === ""
      ? 100
      : Math.round(Math.max(0, Math.min(1, parseFloat(rawOpacity))) * 100);

  const all = readStyle(component, "border-radius");
  const tl = readStyle(component, "border-top-left-radius");
  const tr = readStyle(component, "border-top-right-radius");
  const bl = readStyle(component, "border-bottom-left-radius");
  const br = readStyle(component, "border-bottom-right-radius");
  const allDisplay = all || tl || tr || br || bl;

  const setAll = (n: number) => {
    clearStyle(component, "border-top-left-radius");
    clearStyle(component, "border-top-right-radius");
    clearStyle(component, "border-bottom-left-radius");
    clearStyle(component, "border-bottom-right-radius");
    if (n <= 0) clearStyle(component, "border-radius");
    else writeStyle(component, "border-radius", `${n}px`);
  };

  const setCorner = (prop: string) => (n: number) => {
    clearStyle(component, "border-radius");
    if (n <= 0) clearStyle(component, prop);
    else writeStyle(component, prop, `${n}px`);
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <NumberInput
          value={opacity}
          onChange={(n) => {
            const v = Math.max(0, Math.min(100, Math.round(n)));
            if (v >= 100) clearStyle(component, "opacity");
            else writeStyle(component, "opacity", String(v / 100));
          }}
          min={0}
          max={100}
          step={1}
          unit="%"
          label=""
          data-testid="oc-ins-layer-opacity"
          className="flex-1"
        />
        {perCorner ? (
          <span className="flex-1 text-[11px] text-muted-foreground">Per corner</span>
        ) : (
          <NumberInput
            value={allDisplay}
            onChange={setAll}
            unit="px"
            label="R"
            min={0}
            step={1}
            disabled={!radiusEnabled}
            data-testid="oc-ins-radius-all"
            className="flex-1"
          />
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setPerCorner((v) => !v)}
              aria-label={perCorner ? "Single radius" : "Per-corner radius"}
              aria-pressed={perCorner}
              disabled={!radiusEnabled}
              className={cn(
                "flex items-center justify-center w-6 h-6 rounded-sm transition-colors",
                "hover:bg-background",
                perCorner ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                !radiusEnabled && "opacity-50 pointer-events-none",
              )}
              data-testid="oc-ins-radius-mode"
            >
              <Square className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {!radiusEnabled
              ? "Border radius doesn't apply to this element"
              : perCorner
                ? "Switch to single radius"
                : "Switch to per-corner radius"}
          </TooltipContent>
        </Tooltip>
      </div>
      {perCorner ? (
        <div className="grid grid-cols-2 gap-2">
          {PER_CORNER_PROPS.map(([prop, glyph, label, testid]) => (
            <NumberInput
              key={prop}
              value={readStyle(component, prop)}
              onChange={setCorner(prop)}
              unit="px"
              label={glyph}
              min={0}
              step={1}
              disabled={!radiusEnabled}
              aria-label={label}
              data-testid={testid}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

/**
 * Body-level blend <select> — only rendered by AppearanceSection when a
 * non-default mode is in effect (the section-header droplet is the affordance
 * for picking the initial mode). Stays a <select> here so the current value
 * reads at-a-glance and can be changed without re-opening the picker.
 */
function BlendRow({ component }: { component: Component }) {
  const blendMode = readStyle(component, "mix-blend-mode") || "normal";
  const setBlend = (next: string) => {
    if (next === "normal") clearStyle(component, "mix-blend-mode");
    else writeStyle(component, "mix-blend-mode", next);
  };

  return (
    <FieldGroup label="Blend">
      <select
        value={blendMode}
        onChange={(e) => setBlend(e.target.value)}
        className={cn(
          "h-7 w-full rounded-md bg-chip px-2 text-xs text-foreground",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-oc-accent",
        )}
        data-testid="oc-ins-layer-blend-mode"
        aria-label="Blend"
      >
        {BLEND_MODES.map((m) => (
          <option key={m} value={m}>
            {formatBlend(m)}
          </option>
        ))}
      </select>
    </FieldGroup>
  );
}
