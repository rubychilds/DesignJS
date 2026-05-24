import * as React from "react";
import { cn } from "../../../lib/utils.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover.js";

export type SizeMode = "fixed" | "hug" | "fill";

export interface SizeFieldProps {
  axis: "W" | "H";
  value: string;
  /** CSS value is a computed numeric px when mode === "fixed"; empty / "auto" / "100%" otherwise. */
  mode: SizeMode;
  onModeChange: (next: SizeMode) => void;
  onFixedChange: (next: number) => void;
  /** Available modes based on context (parent layout). Default: all three. */
  availableModes?: SizeMode[];
  /**
   * Min/Max clamps. Independent of mode: a Fill axis can still carry a
   * `max-width: 600px` cap; a Fixed axis can still carry a `min-width: 200px`
   * floor. Raw CSS values (e.g. `"200px"`) — the field surfaces only the
   * leading numeric. When undefined (no handler), the overflow trigger
   * does not render.
   */
  minValue?: string;
  maxValue?: string;
  onMinChange?: (next: number | null) => void;
  onMaxChange?: (next: number | null) => void;
  "data-testid"?: string;
  className?: string;
}

const MODE_LABEL: Record<SizeMode, string> = {
  fixed: "Fixed",
  hug: "Hug",
  fill: "Fill",
};

function leadingNumber(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^(-?\d*\.?\d+)/.exec(s.trim());
  if (!m) return null;
  const n = parseFloat(m[1]!);
  return Number.isFinite(n) ? n : null;
}

/**
 * Penpot/Figma-style sizing chip: axis label + mode pill (Fixed / Hug / Fill)
 * + numeric input (active only in Fixed) + unit. The mode dropdown is gated
 * on `availableModes`, which is derived from parent context — e.g. Hug only
 * if *this* element is an auto-layout container, Fill only if the *parent*
 * is one. See LayoutSection for the derivation.
 *
 * CSS emission strategy:
 *   - Fixed → write `<axis>: <N>px`
 *   - Hug   → clear `<axis>` (intrinsic content width / `auto`)
 *   - Fill  → write `<axis>: 100%`
 *
 * Further nuance (flex main-axis Fill via `flex: 1 1 auto`) stays on the
 * consuming LayoutItem section — SizeField writes only the `width`/`height`
 * longhand itself.
 */
export function SizeField({
  axis,
  value,
  mode,
  onModeChange,
  onFixedChange,
  availableModes = ["fixed", "hug", "fill"],
  minValue,
  maxValue,
  onMinChange,
  onMaxChange,
  "data-testid": testId,
  className,
}: SizeFieldProps) {
  const numericMatch = /^(-?\d*\.?\d+)/.exec(value.trim());
  const numeric = numericMatch ? parseFloat(numericMatch[1]!) : 0;
  const [draft, setDraft] = React.useState(String(Number.isFinite(numeric) ? numeric : ""));

  React.useEffect(() => {
    setDraft(String(Number.isFinite(numeric) ? numeric : ""));
  }, [numeric]);

  const commitDraft = () => {
    const parsed = parseFloat(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(numeric));
      return;
    }
    onFixedChange(parsed);
  };

  const label =
    mode === "fixed" ? null : mode === "hug" ? "auto" : "fill";

  // Outside auto-layout the only available mode is Fixed — rendering a
  // "Fixed ▾" dropdown that only offers the value it already shows is
  // noise. Collapse to just the axis letter + number when there is
  // nothing to choose between.
  const hasModeChoice = availableModes.length > 1;

  return (
    <div
      className={cn(
        "flex items-center h-7 min-w-0 rounded-md bg-chip",
        "focus-within:ring-1 focus-within:ring-oc-accent",
        className,
      )}
    >
      <span className="flex items-center pl-1.5 pr-0.5 text-[11px] text-muted-foreground select-none">
        {axis}
      </span>
      {hasModeChoice ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                "flex items-center justify-center h-5 px-1 rounded-sm",
                "text-[11px] text-muted-foreground hover:text-foreground hover:bg-background",
                "focus:outline-none focus-visible:ring-1 focus-visible:ring-oc-accent",
              )}
              aria-label={`${axis} mode`}
              data-testid={testId ? `${testId}-mode` : undefined}
            >
              {MODE_LABEL[mode]}
              <span aria-hidden className="ml-0.5 text-[9px]">▾</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={4} className="min-w-28">
            {(["fixed", "hug", "fill"] as const).map((m) => {
              const enabled = availableModes.includes(m);
              return (
                <DropdownMenuItem
                  key={m}
                  disabled={!enabled}
                  onSelect={() => enabled && onModeChange(m)}
                  data-testid={testId ? `${testId}-mode-${m}` : undefined}
                >
                  {MODE_LABEL[m]}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {mode === "fixed" ? (
        <>
          <input
            type="text"
            inputMode="decimal"
            size={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitDraft();
                (e.currentTarget as HTMLInputElement).blur();
              }
            }}
            className={cn(
              "flex-1 min-w-0 bg-transparent px-0.5 h-full text-xs tabular-nums text-foreground",
              "focus:outline-none",
            )}
            data-testid={testId}
          />
          <span className="pr-1 text-[11px] text-muted-foreground select-none">px</span>
        </>
      ) : (
        <span
          className="flex-1 min-w-0 px-1 text-[11px] text-muted-foreground select-none"
          data-testid={testId ? `${testId}-placeholder` : undefined}
        >
          {label}
        </span>
      )}
      {onMinChange || onMaxChange ? (
        <ClampOverflow
          axis={axis}
          minValue={minValue}
          maxValue={maxValue}
          onMinChange={onMinChange}
          onMaxChange={onMaxChange}
        />
      ) : null}
    </div>
  );
}

interface ClampOverflowProps {
  axis: "W" | "H";
  minValue?: string;
  maxValue?: string;
  onMinChange?: (next: number | null) => void;
  onMaxChange?: (next: number | null) => void;
}

function ClampOverflow({
  axis,
  minValue,
  maxValue,
  onMinChange,
  onMaxChange,
}: ClampOverflowProps) {
  const minNum = leadingNumber(minValue);
  const maxNum = leadingNumber(maxValue);
  const hasClamp = minNum != null || maxNum != null;
  const axisKey = axis === "W" ? "w" : "h";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center justify-center w-5 h-5 mr-0.5 rounded-sm",
            "text-[12px] leading-none select-none",
            "hover:bg-background hover:text-foreground",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-oc-accent",
            hasClamp ? "text-foreground" : "text-muted-foreground",
          )}
          aria-label={`${axis} min/max clamps`}
          data-testid={`oc-ins-${axisKey}-clamp-trigger`}
        >
          <span aria-hidden>⋯</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-56">
        <div className="flex flex-col gap-1.5">
          {onMinChange ? (
            <ClampRow
              label="Min"
              value={minNum}
              onChange={onMinChange}
              testid={`oc-ins-min-${axisKey}`}
            />
          ) : null}
          {onMaxChange ? (
            <ClampRow
              label="Max"
              value={maxNum}
              onChange={onMaxChange}
              testid={`oc-ins-max-${axisKey}`}
            />
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface ClampRowProps {
  label: string;
  value: number | null;
  onChange: (next: number | null) => void;
  testid: string;
}

function ClampRow({ label, value, onChange, testid }: ClampRowProps) {
  const [draft, setDraft] = React.useState(value == null ? "" : String(value));

  React.useEffect(() => {
    setDraft(value == null ? "" : String(value));
  }, [value]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      onChange(null);
      return;
    }
    const parsed = parseFloat(trimmed);
    if (!Number.isFinite(parsed)) {
      setDraft(value == null ? "" : String(value));
      return;
    }
    onChange(parsed);
  };

  return (
    <label className="flex items-center gap-2 h-7 px-1 text-[11px] text-muted-foreground">
      <span className="w-7 select-none">{label}</span>
      <div
        className={cn(
          "flex flex-1 items-center h-7 min-w-0 rounded-md bg-chip",
          "focus-within:ring-1 focus-within:ring-oc-accent",
        )}
      >
        <input
          type="text"
          inputMode="decimal"
          placeholder="—"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
          className={cn(
            "flex-1 min-w-0 bg-transparent px-2 h-full text-xs tabular-nums text-foreground",
            "focus:outline-none placeholder:text-muted-foreground/60",
          )}
          data-testid={testid}
        />
        <span className="pr-2 text-[11px] text-muted-foreground select-none">px</span>
      </div>
    </label>
  );
}
