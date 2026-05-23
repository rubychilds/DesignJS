import type { Component } from "grapesjs";
import {
  AlignCenterVertical,
  AlignEndVertical,
  AlignStartVertical,
  StretchHorizontal,
} from "../../canvas/chrome-icons.js";
import { cn } from "../../lib/utils.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.js";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group.js";
import { NumberInput } from "../ui/number-input.js";
import {
  clearStyle,
  readBoundingBox,
  readStyle,
  rotationFromTransform,
  transformWithRotation,
  writeStyle,
} from "../../canvas/component-style.js";
import { FieldGroup, InspectorSection } from "./InspectorSection.js";
import { RotationDial } from "./controls/RotationDial.js";

const POSITION_MODES = ["static", "relative", "absolute", "fixed", "sticky"] as const;

/**
 * Position — alignment, X/Y coordinates, and rotation. Carved out of the
 * former MeasuresSection per user direction ("position (alignment, x, y,
 * rotate)"). W/H moved to LayoutSection; border-radius moved to
 * AppearanceSection.
 */
export function PositionSection({ component }: { component: Component }) {
  const positionMode = (readStyle(component, "position") || "static") as
    (typeof POSITION_MODES)[number];
  // X/Y are always rendered — they have no visual effect on static-positioned
  // elements, but users typically set them first and then flip position mode.
  // The Mode row is the hint that the values only take effect once position
  // is non-static.

  return (
    <InspectorSection title="Position">
      <ModeRow component={component} mode={positionMode} />
      <AlignItemsRow component={component} />
      <XYRow component={component} />
      <RotationRow component={component} />
    </InspectorSection>
  );
}

function ModeRow({
  component,
  mode,
}: {
  component: Component;
  mode: (typeof POSITION_MODES)[number];
}) {
  return (
    <FieldGroup label="Mode">
      <select
        value={mode}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "static") clearStyle(component, "position");
          else writeStyle(component, "position", v);
        }}
        className={cn(
          "h-7 w-full rounded-md bg-chip px-2 text-xs text-foreground",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-oc-accent",
        )}
        data-testid="oc-ins-position-mode"
        aria-label="Position mode"
      >
        {POSITION_MODES.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </FieldGroup>
  );
}

function AlignItemsRow({ component }: { component: Component }) {
  const value = readStyle(component, "align-items");
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(v) => v && writeStyle(component, "align-items", v)}
      data-testid="oc-ins-align-items"
    >
      {[
        { value: "flex-start", label: "Top", Icon: AlignStartVertical },
        { value: "center", label: "Middle", Icon: AlignCenterVertical },
        { value: "flex-end", label: "Bottom", Icon: AlignEndVertical },
        { value: "stretch", label: "Stretch", Icon: StretchHorizontal },
        { value: "baseline", label: "Baseline", Icon: AlignStartVertical, glyph: "B" },
      ].map(({ value: v, label, Icon, glyph }) => (
        <Tooltip key={v}>
          <TooltipTrigger asChild>
            <ToggleGroupItem value={v} aria-label={label}>
              {glyph ? (
                <span className="text-[11px] font-semibold">{glyph}</span>
              ) : (
                <Icon />
              )}
            </ToggleGroupItem>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      ))}
    </ToggleGroup>
  );
}

function XYRow({ component }: { component: Component }) {
  const left = readStyle(component, "left");
  const top = readStyle(component, "top");
  // When the element has no explicit `left`/`top` (typical for
  // statically-positioned elements — including the entire captured tree
  // from the Chrome extension's whole-page capture), fall back to the
  // rendered offsetLeft/offsetTop so the inspector shows a meaningful
  // position rather than blank inputs. Typing a value still writes
  // `left`/`top` styles (caller is expected to flip Mode to non-static
  // for those to take effect).
  const bbox = !left || !top ? readBoundingBox(component) : null;
  const onChange = (prop: "left" | "top") => (n: number) => writeStyle(component, prop, `${n}px`);
  return (
    <div className="grid grid-cols-2 gap-2">
      <NumberInput
        value={left || (bbox ? `${bbox.x}` : "")}
        onChange={onChange("left")}
        unit="px"
        label="X"
        step={1}
        data-testid="oc-ins-x"
      />
      <NumberInput
        value={top || (bbox ? `${bbox.y}` : "")}
        onChange={onChange("top")}
        unit="px"
        label="Y"
        step={1}
        data-testid="oc-ins-y"
      />
    </div>
  );
}

function RotationRow({ component }: { component: Component }) {
  const transform = readStyle(component, "transform");
  const deg = rotationFromTransform(transform);
  const onChange = (n: number) => {
    const next = transformWithRotation(transform, n);
    if (!next) clearStyle(component, "transform");
    else writeStyle(component, "transform", next);
  };
  return (
    <FieldGroup label="Rotate">
      <RotationDial value={deg} onChange={onChange} data-testid="oc-ins-rotate" />
    </FieldGroup>
  );
}
