import * as React from "react";
import type { Component } from "grapesjs";
import { Eye, EyeClosed, Minus, PlusOutline } from "../../canvas/chrome-icons.js";
import { cn } from "../../lib/utils.js";
import { clearStyle, readEffectiveStyle, readStyle, writeStyle } from "../../canvas/component-style.js";
import { InspectorSection } from "./InspectorSection.js";
import { NumberInput } from "../ui/number-input.js";
import { ColorField } from "./controls/ColorField.js";
import { formatColor, parseColor, splitTopLevel } from "./controls/color-utils.js";
import { isTypographyTarget } from "./TypographySection.js";

interface FillLayer {
  id: string;
  hex: string;
  opacity: number;
  hidden: boolean;
}

function newLayer(hex = "#808080", opacity = 1): FillLayer {
  return {
    id: `f_${Math.random().toString(36).slice(2, 9)}`,
    hex,
    opacity,
    hidden: false,
  };
}

/**
 * Parse the component's `background-image` + `background-color` back into an
 * ordered stack. Only recognises our own output shape — comma-separated
 * `linear-gradient(colour, colour)` tokens, or a single solid `background-color`.
 * Returns null when the CSS is something we didn't author (complex gradients,
 * angles, images), signalling "fall back to Raw CSS".
 */
function parseStack(bgImage: string, bgColor: string): FillLayer[] | null {
  const img = (bgImage || "").trim();
  const col = (bgColor || "").trim();

  if (!img || img === "none") {
    if (!col) return [];
    const c = parseColor(col);
    // Computed `background-color` on an unstyled element returns
    // `rgba(0, 0, 0, 0)` (browser default), which parseColor reads as
    // opacity:0. That's not a user-set fill — treat it as empty so
    // addLayer doesn't seed every new row with opacity:0 (the bug that
    // produced `linear-gradient(rgba(R,G,B,0), …)` stacks).
    if (c.opacity === 0) return [];
    return [newLayer(c.hex, c.opacity)];
  }

  const tokens = splitTopLevel(img);
  const layers: FillLayer[] = [];
  for (const tok of tokens) {
    const m = /^linear-gradient\s*\((.+)\)\s*$/i.exec(tok);
    if (!m) return null;
    const inner = splitTopLevel(m[1]!);
    // Accept either a single colour or two copies of the same colour.
    if (inner.length === 0 || inner.length > 2) return null;
    if (inner.length === 2 && inner[0] !== inner[1]) return null;
    const c = parseColor(inner[0]!);
    layers.push(newLayer(c.hex, c.opacity));
  }
  return layers;
}

function compileStack(layers: FillLayer[]): { bgColor: string; bgImage: string } {
  const visible = layers.filter((l) => !l.hidden);
  if (visible.length === 0) return { bgColor: "", bgImage: "" };
  if (visible.length === 1) {
    const l = visible[0]!;
    return { bgColor: formatColor(l.hex, l.opacity), bgImage: "" };
  }
  const gradients = visible.map((l) => {
    const c = formatColor(l.hex, l.opacity);
    return `linear-gradient(${c}, ${c})`;
  });
  return { bgColor: "", bgImage: gradients.join(", ") };
}

function FillRow({
  layer,
  onChange,
  onRemove,
  testIdBase,
}: {
  layer: FillLayer;
  onChange: (next: FillLayer) => void;
  onRemove: () => void;
  testIdBase: string;
}) {
  return (
    // -mr-5 extends the row 20px past the content wrapper's right edge so
    // the minus button lands in the same column as the section-header `+`.
    // Eye sits immediately left of minus, consistent with Effects rows.
    <div className="flex items-center gap-1 -mr-5" data-testid={testIdBase}>
      <ColorField
        value={layer.hex}
        onChange={(hex) => onChange({ ...layer, hex })}
        data-testid={`${testIdBase}-color`}
        className="flex-1"
      />
      <div className="w-[52px] shrink-0">
        <NumberInput
          value={Math.round(layer.opacity * 100)}
          onChange={(n) => onChange({ ...layer, opacity: Math.max(0, Math.min(100, n)) / 100 })}
          min={0}
          max={100}
          step={1}
          unit="%"
          label=""
          data-testid={`${testIdBase}-opacity`}
        />
      </div>
      <button
        type="button"
        className={cn(
          "flex items-center justify-center h-5 w-5 rounded-sm shrink-0",
          "text-muted-foreground hover:text-foreground hover:bg-background",
          layer.hidden && "text-foreground",
        )}
        onClick={() => onChange({ ...layer, hidden: !layer.hidden })}
        aria-label={layer.hidden ? "Show fill" : "Hide fill"}
        data-testid={`${testIdBase}-visibility`}
      >
        {layer.hidden ? <EyeClosed className="size-3.5" /> : <Eye className="size-3.5" />}
      </button>
      <button
        type="button"
        className={cn(
          "flex items-center justify-center h-5 w-5 rounded-sm shrink-0",
          "text-muted-foreground hover:text-foreground hover:bg-background",
        )}
        onClick={onRemove}
        aria-label="Remove fill"
        data-testid={`${testIdBase}-remove`}
      >
        <Minus className="size-3.5" />
      </button>
    </div>
  );
}

/**
 * Multi-layer fill stack per ADR-0003. Renders an ordered list of solid-colour
 * fills; first item is the top of the stack (drawn on top in CSS). Opacity is
 * per-layer via `rgba()`. Hidden layers are excluded from the compiled CSS but
 * retained in the local stack so the user can toggle them back on.
 *
 * For *text* components, Fill drives the CSS `color` property instead of the
 * background stack — that's the intuitive mental model for "what colour is
 * this text?". Single-layer only in text mode (gradients on text are rare
 * and require background-clip workarounds we don't model).
 *
 * Limitation: only our own output shape round-trips. Angled or multi-stop
 * gradients set via Raw CSS collapse to the Raw CSS note.
 */
export function FillSection({ component }: { component: Component }) {
  const isText = isTypographyTarget(component);

  // readEffectiveStyle: prefer set styles, fall back to computed when
  // captured-page elements route their styles via GrapesJS' CSS Manager
  // instead of the component model (extension capture path).
  //
  // textColor intentionally uses readStyle (not effective) — when the
  // element has no explicit color, falling back to computed returns
  // the inherited value (often black), which renders as "100% opacity
  // color set" in the picker even though the user hasn't set anything.
  // Better to show empty / unset for inherited color.
  const bgImage = readEffectiveStyle(component, "background-image");
  const bgColor = readEffectiveStyle(component, "background-color");
  const textColor = readStyle(component, "color");
  const parsed = React.useMemo(() => {
    if (isText) {
      if (!textColor) return [];
      const c = parseColor(textColor);
      return [newLayer(c.hex, c.opacity)];
    }
    return parseStack(bgImage, bgColor);
  }, [isText, textColor, bgImage, bgColor, component]);

  // Local stack state mirrors the component's style but keeps hidden layers
  // across edits that would otherwise be invisible to a reader that only saw
  // the compiled CSS.
  const [localStack, setLocalStack] = React.useState<FillLayer[]>(() => parsed ?? []);
  const lastComponentRef = React.useRef<Component | null>(component);

  React.useEffect(() => {
    // Re-seed from CSS whenever the selection changes (component identity
    // flip) or when the compiled CSS diverges from what we last emitted.
    if (lastComponentRef.current !== component) {
      lastComponentRef.current = component;
      setLocalStack(parsed ?? []);
      return;
    }
    if (parsed === null) return;
    const externalMatches = parsedEquals(parsed, localStack);
    if (!externalMatches) setLocalStack(parsed);
  }, [parsed, component, localStack]);

  const commit = (next: FillLayer[]) => {
    setLocalStack(next);
    if (isText) {
      const visible = next.find((l) => !l.hidden);
      if (!visible) clearStyle(component, "color");
      else writeStyle(component, "color", formatColor(visible.hex, visible.opacity));
      return;
    }
    const { bgColor: bc, bgImage: bi } = compileStack(next);
    if (bc) writeStyle(component, "background-color", bc);
    else clearStyle(component, "background-color");
    if (bi) writeStyle(component, "background-image", bi);
    else clearStyle(component, "background-image");
  };

  if (parsed === null) {
    return (
      <InspectorSection title="Fill">
        <p className="text-[11px] text-muted-foreground py-1" data-testid="oc-ins-fill-rawcss-note">
          Fill uses a value we can't represent as a stack (complex gradient or
          image). Edit in Raw CSS below.
        </p>
      </InspectorSection>
    );
  }

  const addLayer = () => {
    const top = localStack[0];
    const seed = top ? newLayer(top.hex, top.opacity) : newLayer();
    commit([seed, ...localStack]);
  };

  // Text components can only hold one fill (their `color`); hide the add
  // button once that one layer is present.
  const canAdd = !isText || localStack.length === 0;
  const action = canAdd ? (
    <button
      type="button"
      onClick={addLayer}
      className={cn(
        "inline-flex items-center justify-center h-5 w-5 rounded-sm",
        "text-muted-foreground hover:text-foreground hover:bg-background",
      )}
      aria-label="Add fill"
      data-testid="oc-ins-fill-add"
    >
      <PlusOutline className="size-3.5" />
    </button>
  ) : null;

  return (
    <InspectorSection title="Fill" action={action} muted={localStack.length === 0}>
      {localStack.map((layer, i) => (
        <FillRow
          key={layer.id}
          layer={layer}
          onChange={(next) => {
            const copy = localStack.slice();
            copy[i] = next;
            commit(copy);
          }}
          onRemove={() => {
            const copy = localStack.slice();
            copy.splice(i, 1);
            commit(copy);
          }}
          testIdBase={`oc-ins-fill-row-${i}`}
        />
      ))}
    </InspectorSection>
  );
}

function parsedEquals(a: FillLayer[], b: FillLayer[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.hex !== y.hex || x.opacity !== y.opacity || x.hidden !== y.hidden) return false;
  }
  return true;
}
