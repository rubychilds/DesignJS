import type { Component } from "grapesjs";
import {
  CaseLower,
  CaseSensitive,
  CaseUpper,
  TextAlignCenter,
  TextAlignJustify,
  TextAlignLeft,
  TextAlignRight,
  TextStrikethrough,
  TextUnderline,
} from "../../canvas/chrome-icons.js";
import { cn } from "../../lib/utils.js";
import {
  clearStyle,
  readEffectiveStyle,
  readStyle,
  writeStyle,
} from "../../canvas/component-style.js";
import { InspectorSection } from "./InspectorSection.js";
import { NumberInput } from "../ui/number-input.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.js";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group.js";

const TEXT_TAGS = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "span",
  "a",
  "strong",
  "em",
  "small",
  "code",
  "label",
  "button",
  "li",
  "blockquote",
]);

export function isTypographyTarget(component: Component): boolean {
  const tag = String(component.get?.("tagName") ?? "").toLowerCase();
  return TEXT_TAGS.has(tag);
}

const FONT_FAMILY_PRESETS = [
  { label: "System sans", value: "system-ui, sans-serif" },
  { label: "System serif", value: "ui-serif, Georgia, serif" },
  { label: "System mono", value: "ui-monospace, SFMono-Regular, Menlo, monospace" },
  { label: "Inter", value: "Inter, system-ui, sans-serif" },
  { label: "Helvetica", value: "Helvetica, Arial, sans-serif" },
  { label: "Georgia", value: "Georgia, serif" },
] as const;

// Numeric CSS font-weight with the standard name used in type systems.
// We store the numeric value on the component (broadest font compatibility)
// but show the name to the user.
const WEIGHT_OPTIONS = [
  { value: "100", label: "Thin" },
  { value: "200", label: "Extra Light" },
  { value: "300", label: "Light" },
  { value: "400", label: "Regular" },
  { value: "500", label: "Medium" },
  { value: "600", label: "Semi Bold" },
  { value: "700", label: "Bold" },
  { value: "800", label: "Extra Bold" },
  { value: "900", label: "Black" },
] as const;

const TEXT_ALIGN_OPTIONS = [
  { value: "left", label: "Left", Icon: TextAlignLeft },
  { value: "center", label: "Center", Icon: TextAlignCenter },
  { value: "right", label: "Right", Icon: TextAlignRight },
  { value: "justify", label: "Justify", Icon: TextAlignJustify },
] as const;

// "None" options render a simple `-` glyph rather than an icon — consistent
// treatment wherever "no value" is a selectable state (Case, Deco, future
// additions). Non-"none" options carry an icon or text glyph.
//
// Case semantics split across two CSS properties:
//   - uppercase / lowercase / title-case → `text-transform`
//   - small-caps / all-small-caps → `font-variant-caps`
// The ToggleGroup below hides that split behind a single control.
const CASE_OPTIONS = [
  { value: "none", label: "None", Icon: null as null | typeof CaseUpper, glyph: "-" },
  { value: "uppercase", label: "Upper", Icon: CaseUpper, glyph: null },
  { value: "lowercase", label: "Lower", Icon: CaseLower, glyph: null },
  { value: "capitalize", label: "Title case", Icon: CaseSensitive, glyph: null },
  { value: "small-caps", label: "Small caps", Icon: null, glyph: "Aᴀ" },
  { value: "all-small-caps", label: "Forced small caps", Icon: null, glyph: "ᴀᴀ" },
] as const;

type CaseValue = (typeof CASE_OPTIONS)[number]["value"];

function readCaseValue(component: Component): CaseValue {
  const variant =
    readStyle(component, "font-variant-caps") || readStyle(component, "font-variant");
  if (variant === "small-caps" || variant === "all-small-caps") return variant;
  const transform = readStyle(component, "text-transform");
  if (transform === "uppercase" || transform === "lowercase" || transform === "capitalize") {
    return transform;
  }
  return "none";
}

function writeCaseValue(component: Component, next: CaseValue): void {
  if (next === "none") {
    clearStyle(component, "text-transform");
    clearStyle(component, "font-variant-caps");
    clearStyle(component, "font-variant");
    return;
  }
  if (next === "small-caps" || next === "all-small-caps") {
    clearStyle(component, "text-transform");
    writeStyle(component, "font-variant-caps", next);
    return;
  }
  // uppercase / lowercase / capitalize
  clearStyle(component, "font-variant-caps");
  clearStyle(component, "font-variant");
  writeStyle(component, "text-transform", next);
}

const TEXT_DECORATION_OPTIONS = [
  { value: "none", label: "None", Icon: null as null | typeof TextUnderline, glyph: "-" },
  { value: "underline", label: "Underline", Icon: TextUnderline, glyph: null },
  { value: "line-through", label: "Strikethrough", Icon: TextStrikethrough, glyph: null },
] as const;

export function TypographySection({ component }: { component: Component }) {
  // readEffectiveStyle: prefer set styles, fall back to computed when
  // captured-page elements route their styles via GrapesJS' CSS Manager
  // instead of the component model (extension capture path). Important
  // for things like font-weight where headings render bold (700) but
  // the component model has no explicit weight set.
  const fontFamily = readEffectiveStyle(component, "font-family");
  const fontWeight = readEffectiveStyle(component, "font-weight") || "400";
  // Effective fall back also handles the default case (an unstyled <p>
  // shows the iframe's computed 16px rather than blank).
  const fontSize = readEffectiveStyle(component, "font-size");
  const lineHeight = readEffectiveStyle(component, "line-height");
  const letterSpacing = readEffectiveStyle(component, "letter-spacing");
  // No explicit text-align → the browser default is "left" (for LTR locales,
  // which is what DesignJS targets today). Surface that in the inspector
  // so the Left toggle shows as selected rather than the whole group sitting
  // in a "no selection" state.
  const textAlign = readStyle(component, "text-align") || "left";
  const caseValue = readCaseValue(component);
  const textDecoration = readStyle(component, "text-decoration") || "none";

  return (
    <InspectorSection title="Typography">
      {/* Family on its own row; weight on a row below (both without a small
          caption label — the options themselves are self-descriptive). */}
      <select
        value={matchPreset(fontFamily)}
        onChange={(e) => {
          const v = e.target.value;
          if (!v) clearStyle(component, "font-family");
          else writeStyle(component, "font-family", v);
        }}
        className={cn(
          "h-7 w-full rounded-md bg-chip px-2 text-xs text-foreground",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-oc-accent",
        )}
        data-testid="oc-ins-font-family"
        aria-label="Font family"
      >
        <option value="">Inherit</option>
        {FONT_FAMILY_PRESETS.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
        {fontFamily && !FONT_FAMILY_PRESETS.some((p) => p.value === fontFamily) ? (
          <option value={fontFamily}>{fontFamily}</option>
        ) : null}
      </select>
      {/* Weight + size + LH + LS share one uniform 2-column grid — each chip
          the same width so the block reads as a cohesive typography block
          rather than a tapered weight + compact size + separate LH/LS row. */}
      <div className="grid grid-cols-2 gap-2">
        <select
          value={fontWeight}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "400") clearStyle(component, "font-weight");
            else writeStyle(component, "font-weight", v);
          }}
          className={cn(
            "h-7 min-w-0 rounded-md bg-chip px-2 text-xs text-foreground",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-oc-accent",
          )}
          data-testid="oc-ins-font-weight"
          aria-label="Font weight"
        >
          {WEIGHT_OPTIONS.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
        </select>
        <NumberInput
          value={fontSize}
          onChange={(n) => writeStyle(component, "font-size", `${n}px`)}
          unit="px"
          label=""
          min={1}
          step={1}
          data-testid="oc-ins-font-size"
        />
        <NumberInput
          value={lineHeight}
          onChange={(n) => writeStyle(component, "line-height", String(n))}
          label="LH"
          min={0}
          step={0.1}
          data-testid="oc-ins-line-height"
        />
        <NumberInput
          value={letterSpacing}
          onChange={(n) => {
            if (n === 0) clearStyle(component, "letter-spacing");
            else writeStyle(component, "letter-spacing", `${n}px`);
          }}
          unit="px"
          label="LS"
          step={0.5}
          data-testid="oc-ins-letter-spacing"
        />
      </div>

      {/* Alignment shares a row with the text-decoration "stroke decorator"
          group — both are short, high-frequency toggles and read naturally
          side-by-side. Case stays on its own row because it carries six
          options. Each icon's tooltip disambiguates. */}
      <div className="flex items-center gap-2">
        <ToggleGroup
          type="single"
          value={textAlign}
          onValueChange={(v) => {
            if (!v) clearStyle(component, "text-align");
            else writeStyle(component, "text-align", v);
          }}
          data-testid="oc-ins-text-align"
        >
          {TEXT_ALIGN_OPTIONS.map(({ value, label, Icon }) => (
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

        <ToggleGroup
          type="single"
          value={textDecoration}
          onValueChange={(v) => {
            if (!v || v === "none") clearStyle(component, "text-decoration");
            else writeStyle(component, "text-decoration", v);
          }}
          data-testid="oc-ins-text-decoration"
        >
          {TEXT_DECORATION_OPTIONS.map(({ value, label, Icon, glyph }) => (
            <Tooltip key={value}>
              <TooltipTrigger asChild>
                <ToggleGroupItem value={value} aria-label={label}>
                  {Icon ? (
                    <Icon />
                  ) : (
                    <span className="text-[11px] font-semibold tabular-nums">{glyph}</span>
                  )}
                </ToggleGroupItem>
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          ))}
        </ToggleGroup>
      </div>

      <ToggleGroup
        type="single"
        value={caseValue}
        onValueChange={(v) => {
          if (!v) writeCaseValue(component, "none");
          else writeCaseValue(component, v as CaseValue);
        }}
        data-testid="oc-ins-text-transform"
      >
        {CASE_OPTIONS.map(({ value, label, Icon, glyph }) => (
          <Tooltip key={value}>
            <TooltipTrigger asChild>
              <ToggleGroupItem value={value} aria-label={label}>
                {Icon ? (
                  <Icon />
                ) : (
                  <span className="text-[11px] font-semibold tabular-nums">{glyph}</span>
                )}
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        ))}
      </ToggleGroup>
    </InspectorSection>
  );
}

function matchPreset(value: string): string {
  if (!value) return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  const match = FONT_FAMILY_PRESETS.find((p) => p.value === normalized);
  return match ? match.value : value;
}
