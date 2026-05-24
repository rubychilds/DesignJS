import { z } from "zod";

export const PingInput = z.object({}).strict();
export const PingOutput = z.object({ pong: z.literal(true), at: z.number() });

export const GetTreeInput = z
  .object({
    depth: z.number().int().positive().optional(),
    artboardId: z.string().optional(),
  })
  .strict();
export interface ComponentNodeT {
  id: string;
  type: string;
  tagName?: string;
  classes: string[];
  attributes: Record<string, string>;
  textContent?: string;
  children: ComponentNodeT[];
}
export const ComponentNode: z.ZodType<ComponentNodeT> = z.lazy(() =>
  z.object({
    id: z.string(),
    type: z.string(),
    tagName: z.string().optional(),
    classes: z.array(z.string()),
    attributes: z.record(z.string()),
    textContent: z.string().optional(),
    children: z.array(ComponentNode),
  }),
);
export const GetTreeOutput = z.object({ root: ComponentNode.nullable() });

export const GetHtmlInput = z.object({ componentId: z.string().optional() }).strict();
export const GetHtmlOutput = z.object({ html: z.string() });

export const GetCssInput = z.object({ componentId: z.string().optional() }).strict();
export const GetCssOutput = z.object({ css: z.string() });

export const GetScreenshotInput = z
  .object({
    scale: z.union([z.literal(1), z.literal(2)]).optional(),
    format: z.enum(["png", "jpeg"]).optional(),
    artboardId: z.string().optional(),
  })
  .strict();
export const GetScreenshotOutput = z.object({
  dataUrl: z.string(),
  width: z.number(),
  height: z.number(),
});

export const GetSelectionInput = z.object({}).strict();
export const GetSelectionOutput = z.object({ componentIds: z.array(z.string()) });

export const AddComponentsInput = z
  .object({
    html: z.string(),
    /** Component id to append into. Use this to insert into a nested element. */
    target: z.string().optional(),
    /**
     * Artboard/frame id (from `create_artboard` / `list_artboards`). Routes the
     * new components into that frame's root wrapper. Use this when you want
     * content at the top level of a specific artboard. `target` overrides
     * `artboardId` when both are provided.
     */
    artboardId: z.string().optional(),
  })
  .strict();
export const AddComponentsOutput = z.object({ componentIds: z.array(z.string()) });

export const AddCssRulesInput = z
  .object({
    /** Raw CSS text, one or more rules. Routed straight to the GrapesJS CSS
     * Manager via `editor.Css.addRules` — bypasses the HTML parser entirely,
     * which silently strips `<style>` elements on import. */
    cssText: z.string(),
    /**
     * Artboard/frame id. When set, rules are scoped to that frame's iframe
     * stylesheet — captured-page CSS for one artboard doesn't bleed into
     * sibling artboards. Without this, rules apply globally. The chrome-
     * extension capture pipeline always passes this.
     */
    artboardId: z.string().optional(),
  })
  .strict();
export const AddCssRulesOutput = z.object({ ruleCount: z.number().int().nonnegative() });

export const UpdateStylesInput = z
  .object({
    componentId: z.string(),
    styles: z.record(z.string()),
  })
  .strict();
export const UpdateStylesOutput = z.object({ styles: z.record(z.string()) });

export const DeleteNodesInput = z.object({ componentIds: z.array(z.string()) }).strict();
export const DeleteNodesOutput = z.object({ deleted: z.number().int().nonnegative() });

export const GetJsxInput = z
  .object({
    componentId: z.string().optional(),
    mode: z.enum(["tailwind", "inline"]).optional(),
  })
  .strict();
export const GetJsxOutput = z.object({ jsx: z.string() });

export const GetVariablesInput = z.object({}).strict();
export const GetVariablesOutput = z.object({ variables: z.record(z.string()) });

export const SetVariablesInput = z
  .object({ variables: z.record(z.string()) })
  .strict();
export const SetVariablesOutput = z.object({ variables: z.record(z.string()) });

export const ArtboardData = z.object({
  id: z.string(),
  name: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export type ArtboardDataT = z.infer<typeof ArtboardData>;

export const CreateArtboardInput = z
  .object({
    name: z.string().optional(),
    width: z.number().positive(),
    height: z.number().positive(),
    x: z.number().optional(),
    y: z.number().optional(),
  })
  .strict();
export const CreateArtboardOutput = z.object({ artboard: ArtboardData });

export const ListArtboardsInput = z.object({}).strict();
export const ListArtboardsOutput = z.object({ artboards: z.array(ArtboardData) });

export const FindPlacementInput = z
  .object({
    width: z.number().positive(),
    height: z.number().positive(),
  })
  .strict();
export const FindPlacementOutput = z.object({ x: z.number(), y: z.number() });

export const FitArtboardInput = z
  .object({ artboardId: z.string() })
  .strict();
export const FitArtboardOutput = z.object({
  artboard: ArtboardData,
  height: z.number(),
});

export const AddClassesInput = z
  .object({
    componentId: z.string(),
    classes: z.array(z.string()),
  })
  .strict();
export const AddClassesOutput = z.object({ classes: z.array(z.string()) });

export const RemoveClassesInput = z
  .object({
    componentId: z.string(),
    classes: z.array(z.string()),
  })
  .strict();
export const RemoveClassesOutput = z.object({ classes: z.array(z.string()) });

export const SetTextInput = z
  .object({
    componentId: z.string(),
    text: z.string(),
  })
  .strict();
export const SetTextOutput = z.object({ text: z.string() });

export const SelectInput = z
  .object({ componentIds: z.array(z.string()) })
  .strict();
export const SelectOutput = z.object({ componentIds: z.array(z.string()) });

export const DeselectInput = z.object({}).strict();
export const DeselectOutput = z.object({ componentIds: z.array(z.string()) });

export const TOOL_SCHEMAS = {
  ping: { input: PingInput, output: PingOutput },
  get_tree: { input: GetTreeInput, output: GetTreeOutput },
  get_html: { input: GetHtmlInput, output: GetHtmlOutput },
  get_css: { input: GetCssInput, output: GetCssOutput },
  get_screenshot: { input: GetScreenshotInput, output: GetScreenshotOutput },
  get_selection: { input: GetSelectionInput, output: GetSelectionOutput },
  add_components: { input: AddComponentsInput, output: AddComponentsOutput },
  add_css_rules: { input: AddCssRulesInput, output: AddCssRulesOutput },
  update_styles: { input: UpdateStylesInput, output: UpdateStylesOutput },
  delete_nodes: { input: DeleteNodesInput, output: DeleteNodesOutput },
  get_jsx: { input: GetJsxInput, output: GetJsxOutput },
  get_variables: { input: GetVariablesInput, output: GetVariablesOutput },
  set_variables: { input: SetVariablesInput, output: SetVariablesOutput },
  create_artboard: { input: CreateArtboardInput, output: CreateArtboardOutput },
  list_artboards: { input: ListArtboardsInput, output: ListArtboardsOutput },
  find_placement: { input: FindPlacementInput, output: FindPlacementOutput },
  fit_artboard: { input: FitArtboardInput, output: FitArtboardOutput },
  add_classes: { input: AddClassesInput, output: AddClassesOutput },
  remove_classes: { input: RemoveClassesInput, output: RemoveClassesOutput },
  set_text: { input: SetTextInput, output: SetTextOutput },
  select: { input: SelectInput, output: SelectOutput },
  deselect: { input: DeselectInput, output: DeselectOutput },
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  ping: "Health check. Returns { pong: true, at: <timestamp> } when the canvas is connected.",
  get_tree:
    "Read the full component tree of the canvas as recursive JSON. Optional depth limits tree depth for large documents.",
  get_html:
    "Get clean HTML for the canvas or a specific componentId subtree. Output is suitable for direct use in a React component.",
  get_css:
    "Get CSS stylesheet for the canvas or a specific componentId subtree.",
  get_screenshot:
    "Capture a PNG/JPEG screenshot of the canvas iframe as a base64 data URL. scale=2 for high fidelity.",
  get_selection:
    "Return the componentIds of currently selected elements in the editor. Empty array if nothing selected.",
  add_components:
    "Insert raw HTML onto the DesignJS design canvas. Tailwind classes resolve correctly. Returns the created componentIds. To land content inside a specific artboard (the common case after `create_artboard`), pass `artboardId` — not `target`. `target` is for appending into an existing component's subtree. Without either, content lands in the first/default frame, which is usually not what you want on a multi-artboard canvas.",
  add_css_rules:
    "Register raw CSS rules directly with the canvas iframe's stylesheet via GrapesJS' CSS Manager. Use this when you have CSS that needs to land in the canvas WITHOUT routing through HTML parsing (which silently strips `<style>` elements). Typical use: the browser-extension capture pipeline emits hoisted shared classes via this tool BEFORE the corresponding `add_components` call, so element references resolve. Optional `artboardId` scopes rules to one frame's stylesheet. Returns the number of rules added.",
  update_styles:
    "Update CSS properties on an existing component. Accepts both CSS properties and Tailwind utility strings (via the 'class' key convention).",
  delete_nodes:
    "Remove components and their children by id. Returns the total count of deleted nodes.",
  get_jsx:
    "Convert canvas HTML to a JSX component string. mode='tailwind' (default) preserves className and drops style props expressible as Tailwind utilities (padding, margin, color, background-color, width, height, display, flex-direction). mode='inline' converts every CSS property to a JSX style object. Optional componentId scopes output to a subtree.",
  get_variables:
    "Read CSS custom properties currently applied to the canvas iframe :root. Returns a flat key→value map (e.g. { '--brand-primary': 'oklch(0.55 0.2 260)' }).",
  set_variables:
    "Write CSS custom properties to the canvas iframe :root. Variables are merged into the existing set (existing keys overwritten, others preserved). Persisted to .designjs.json under cssVariables and re-applied on reload. Returns the full updated map.",
  create_artboard:
    "Create a new artboard (frame) on the spatial canvas. Requires width and height; name defaults to 'Artboard N'; x/y default to a non-overlapping position to the right of existing artboards. Returns the created artboard's id, name, position, and dimensions.",
  list_artboards:
    "List all artboards currently on the canvas with their ids, names, positions (x/y world coordinates), and dimensions. Use the returned ids with create_artboard's positioning, or scope get_tree / get_screenshot to a specific frame.",
  find_placement:
    "Suggest non-overlapping canvas-world coordinates for an artboard of the given width and height. Returns { x, y } placed to the right of the rightmost existing artboard with an 80px gap. Use this to pick coordinates for create_artboard without colliding.",
  fit_artboard:
    "Resize the artboard's height to match its actual content (via scrollHeight on the wrapper element). Width is preserved. Call this after adding content to an artboard that was created with a fixed preset height (e.g. Desktop 1440×900) so the artboard shrinks down to the content rather than leaving large blank space below. Returns the new height.",
  add_classes:
    "Add Tailwind / CSS class names to an existing component without touching unrelated classes. Idempotent: classes already present are left alone. Returns the component's full class list after the add.",
  remove_classes:
    "Remove Tailwind / CSS class names from an existing component. Classes not currently on the component are silently skipped. Returns the component's full class list after the remove.",
  set_text:
    "Replace a component's text content. Targets the GrapesJS `content` field, so this works for elements whose body is a single text node (h1/p/span/button/label and similar). Returns the text that was set.",
  select:
    "Programmatically set the editor's current selection to one or more components by id. Useful for highlighting what the agent is about to change so the user's eyes follow along. Throws if any id is unknown. Returns the component ids that ended up selected.",
  deselect:
    "Clear the editor's current selection. Returns the (now empty) selection.",
};
