import type { Editor, Component, Frame } from "grapesjs";
import { toPng, toJpeg } from "html-to-image";
import {
  AddClassesInput,
  AddComponentsInput,
  AddCssRulesInput,
  type ComponentNodeT,
  CreateArtboardInput,
  DeleteNodesInput,
  DeselectInput,
  FindPlacementInput,
  FitArtboardInput,
  GetCssInput,
  GetHtmlInput,
  GetJsxInput,
  GetScreenshotInput,
  GetTreeInput,
  GetVariablesInput,
  ListArtboardsInput,
  PingInput,
  RemoveClassesInput,
  SelectInput,
  SetTextInput,
  SetVariablesInput,
  UpdateStylesInput,
} from "@designjs/bridge";
import {
  createArtboard,
  findPlacement,
  fitArtboardToContent,
  listArtboards,
} from "../canvas/artboards.js";
import { htmlToJsx, mergeStylesIntoHtml } from "../canvas/jsx-export.js";
import { getVariables, setVariables } from "../canvas/variables.js";

type ToolHandler = (params: unknown) => Promise<unknown> | unknown;

function serializeComponent(component: Component, maxDepth: number, depth = 0): ComponentNodeT {
  const attrs = component.getAttributes();
  const rawClasses = component.getClasses() as unknown as Array<string | { get: (k: string) => unknown }>;
  const classes: string[] = rawClasses
    .map((c) => (typeof c === "string" ? c : (c.get("name") as string | undefined)))
    .filter((c): c is string => typeof c === "string");
  const childComponents = component.components() as unknown as { toArray: () => Component[] };
  const childArray: Component[] = childComponents.toArray();
  const children = depth >= maxDepth ? [] : childArray.map((child) => serializeComponent(child, maxDepth, depth + 1));
  const tagName = component.get("tagName") as string | undefined;
  const type = component.get("type") as string | undefined;
  return {
    id: component.getId(),
    type: type ?? "default",
    tagName,
    classes,
    attributes: Object.fromEntries(
      Object.entries(attrs).map(([k, v]) => [k, String(v)]),
    ) as Record<string, string>,
    textContent: typeof component.get("content") === "string" ? (component.get("content") as string) : undefined,
    children,
  };
}

/**
 * Pull a stable string list of class names off a GrapesJS Component.
 * `component.getClasses()` returns either string[] or Selector models depending
 * on which collection it traverses, so we coerce both shapes here.
 */
function classNamesOf(component: Component): string[] {
  const raw = component.getClasses() as unknown as Array<
    string | { get: (k: string) => unknown }
  >;
  return raw
    .map((c) => (typeof c === "string" ? c : (c.get("name") as string | undefined)))
    .filter((c): c is string => typeof c === "string");
}

function findById(editor: Editor, id: string): Component | undefined {
  // Walk every frame's wrapper, plus editor.getWrapper() as a fallback.
  // Under v0.1's multi-frame layout, `add_components` with an `artboardId`
  // lands content in `frame.get("component")` for that specific frame —
  // which may not be the wrapper editor.getWrapper() returns. Searching
  // only the latter produced "component not found" for IDs we'd just
  // handed out (see story-mcp-autosave update_styles regression).
  const search = (root: Component | undefined): Component | undefined => {
    if (!root) return undefined;
    if (root.getId() === id) return root;
    const stack: Component[] = [root];
    while (stack.length > 0) {
      const c = stack.pop()!;
      const childArray = (c.components() as unknown as { toArray: () => Component[] }).toArray();
      for (const child of childArray) {
        if (child.getId() === id) return child;
        stack.push(child);
      }
    }
    return undefined;
  };
  for (const frame of editor.Canvas.getFrames()) {
    const wrapper = (frame as unknown as { get?: (k: string) => unknown }).get?.("component") as
      | Component
      | undefined;
    const hit = search(wrapper);
    if (hit) return hit;
  }
  return search(editor.getWrapper() ?? undefined);
}

/**
 * Returns every plausible id for a Frame: GrapesJS Backbone models carry a
 * `cid` (like "c69"), an optional model `id`, and a `getId()` method that
 * may return either. Phase B's `artboards.ts.readFrameData` reads them in
 * one order; the bridge sometimes sees a different one back. Match against
 * the union to be robust.
 */
function frameIds(frame: Frame): string[] {
  const ids: string[] = [];
  const get = (frame as unknown as { getId?: () => string }).getId;
  if (typeof get === "function") {
    const v = get.call(frame);
    if (typeof v === "string" && v) ids.push(v);
  }
  const id = (frame as unknown as { id?: unknown }).id;
  if (typeof id === "string" && id) ids.push(id);
  const cid = (frame as unknown as { cid?: unknown }).cid;
  if (typeof cid === "string" && cid) ids.push(cid);
  return ids;
}

function findFrameById(editor: Editor, id: string): Frame | undefined {
  return editor.Canvas.getFrames().find((f) => frameIds(f).includes(id));
}

function frameWrapper(frame: Frame): Component | undefined {
  const c = (frame as unknown as { get: (k: string) => unknown }).get("component");
  return c as Component | undefined;
}

/**
 * Resolve the iframe DOM element for a specific Frame. GrapesJS exposes the
 * iframe via `frame.view.frame` (the <iframe> directly) or `frame.view.el`
 * (the wrapper element that contains it). Try both since the field name has
 * shifted across GrapesJS versions.
 */
function frameIframe(frame: Frame): HTMLIFrameElement | undefined {
  const view = (frame as unknown as { view?: unknown }).view as
    | { frame?: unknown; el?: unknown }
    | undefined;
  if (!view) return undefined;
  if (view.frame instanceof HTMLIFrameElement) return view.frame;
  if (view.el instanceof HTMLElement) {
    if (view.el.tagName === "IFRAME") return view.el as HTMLIFrameElement;
    const inner = view.el.querySelector("iframe");
    if (inner) return inner as HTMLIFrameElement;
  }
  return undefined;
}

/**
 * MCP tools that mutate canvas state. After a successful call, we need to
 * mark the project dirty so `attachPersistence`'s 30s autosave catches it.
 * GrapesJS doesn't reliably fire its `"update"` event for programmatic
 * mutations (e.g. component.append from an MCP call), so we explicitly
 * trigger it ourselves below.
 */
const WRITE_TOOLS = new Set([
  "add_components",
  "add_css_rules",
  "update_styles",
  "delete_nodes",
  "set_variables",
  "create_artboard",
  "fit_artboard",
  "add_classes",
  "remove_classes",
  "set_text",
]);

export function buildHandlers(editor: Editor): Record<string, ToolHandler> {
  const handlers: Record<string, ToolHandler> = {
    ping: (params) => {
      PingInput.parse(params);
      return { pong: true, at: Date.now() };
    },

    get_tree: (params) => {
      const input = GetTreeInput.parse(params);
      let wrapper: Component | undefined;
      if (input.artboardId) {
        const frame = findFrameById(editor, input.artboardId);
        if (!frame) throw new Error(`artboard not found: ${input.artboardId}`);
        wrapper = frameWrapper(frame);
        if (!wrapper) throw new Error(`artboard ${input.artboardId} has no wrapper component`);
      } else {
        wrapper = editor.getWrapper() ?? undefined;
      }
      if (!wrapper) return { root: null };
      const depth = input.depth ?? Number.POSITIVE_INFINITY;
      return { root: serializeComponent(wrapper, depth) };
    },

    get_html: (params) => {
      const input = GetHtmlInput.parse(params);
      if (input.componentId) {
        const c = findById(editor, input.componentId);
        if (!c) throw new Error(`component not found: ${input.componentId}`);
        return { html: c.toHTML() };
      }
      return { html: editor.getHtml() };
    },

    get_css: (params) => {
      const input = GetCssInput.parse(params);
      if (input.componentId) {
        const c = findById(editor, input.componentId);
        if (!c) throw new Error(`component not found: ${input.componentId}`);
        return { css: editor.getCss({ component: c }) ?? "" };
      }
      return { css: editor.getCss() ?? "" };
    },

    get_screenshot: async (params) => {
      const input = GetScreenshotInput.parse(params);
      const scale = input.scale ?? 1;
      const format = input.format ?? "png";
      let frameEl: HTMLIFrameElement | undefined;
      if (input.artboardId) {
        const frame = findFrameById(editor, input.artboardId);
        if (!frame) throw new Error(`artboard not found: ${input.artboardId}`);
        frameEl = frameIframe(frame);
        // Fallback: if the scoped frame happens to be the active one, the
        // canvas-level accessor is the most-tested code path.
        if (!frameEl) {
          const active = (editor.Canvas as unknown as { getFrame?: () => Frame }).getFrame?.();
          if (active && frameIds(active).includes(input.artboardId)) {
            frameEl = (editor.Canvas.getFrameEl() as HTMLIFrameElement | null) ?? undefined;
          }
        }
        if (!frameEl) throw new Error(`artboard ${input.artboardId} iframe not available`);
      } else {
        // Canvas.getFrameEl() returns a wrapper iframe under the multi-frame
        // layout — its body is empty and toPng() hangs. Prefer the first real
        // frame's iframe (same source the artboardId branch uses) and fall
        // back to getFrameEl only if nothing's there.
        const firstFrame = editor.Canvas.getFrames()[0];
        if (firstFrame) frameEl = frameIframe(firstFrame);
        if (!frameEl) {
          frameEl = (editor.Canvas.getFrameEl() as HTMLIFrameElement | null) ?? undefined;
        }
      }
      const doc = frameEl?.contentDocument;
      const body = doc?.body;
      if (!body) throw new Error("canvas iframe not ready");
      const options = { pixelRatio: scale, cacheBust: true };
      const dataUrl =
        format === "jpeg" ? await toJpeg(body, options) : await toPng(body, options);
      return {
        dataUrl,
        width: body.scrollWidth * scale,
        height: body.scrollHeight * scale,
      };
    },

    get_selection: () => {
      const selected = editor.getSelectedAll();
      return { componentIds: selected.map((c) => c.getId()) };
    },

    add_components: (params) => {
      const input = AddComponentsInput.parse(params);
      // Routing precedence: target (component id) > artboardId (frame id) >
      // default (first frame's wrapper). target wins because it's the more-
      // specific of the two. editor.addComponents alone does NOT render into
      // a frame's iframe under the multi-frame layout shipped in v0.1 — the
      // component lives in a detached tree with no mount — so we always land
      // the content inside a frame's wrapper.
      let parent: Component | undefined;
      if (input.target) {
        parent = findById(editor, input.target);
        if (!parent) throw new Error(`target component not found: ${input.target}`);
      } else if (input.artboardId) {
        const frame = findFrameById(editor, input.artboardId);
        if (!frame) throw new Error(`artboard not found: ${input.artboardId}`);
        const wrapper = (frame as unknown as { get?: (k: string) => unknown }).get?.("component") as
          | Component
          | undefined;
        if (!wrapper) {
          throw new Error(`artboard ${input.artboardId} has no wrapper component`);
        }
        parent = wrapper;
      } else {
        const firstFrame = editor.Canvas.getFrames()[0];
        const wrapper = (firstFrame as unknown as { get?: (k: string) => unknown })?.get?.(
          "component",
        ) as Component | undefined;
        if (wrapper) parent = wrapper;
      }
      const added = parent
        ? parent.append(input.html)
        : editor.addComponents(input.html);
      const list = Array.isArray(added) ? added : [added];
      return { componentIds: list.filter(Boolean).map((c) => (c as Component).getId()) };
    },

    add_css_rules: (params) => {
      const input = AddCssRulesInput.parse(params);
      // CssComposer.addRules parses the cssText, builds CssRule models, and
      // appends them to the editor's CSS collection. GrapesJS renders the
      // collection into each frame's iframe stylesheet automatically, so
      // class references in already-imported HTML resolve once the rules
      // land. `artboardId` is accepted for forward compatibility (per-frame
      // CSS scoping is a future GrapesJS feature) — today the rules are
      // class-keyed so cross-frame leakage isn't a concern in practice.
      const rules = editor.Css.addRules(input.cssText);
      return { ruleCount: Array.isArray(rules) ? rules.length : 0 };
    },

    update_styles: (params) => {
      const input = UpdateStylesInput.parse(params);
      const c = findById(editor, input.componentId);
      if (!c) throw new Error(`component not found: ${input.componentId}`);
      c.addStyle(input.styles);
      return { styles: c.getStyle() };
    },

    delete_nodes: (params) => {
      const input = DeleteNodesInput.parse(params);
      let deleted = 0;
      for (const id of input.componentIds) {
        const c = findById(editor, id);
        if (!c) continue;
        deleted += 1 + countDescendants(c);
        c.remove();
      }
      return { deleted };
    },

    get_jsx: (params) => {
      const input = GetJsxInput.parse(params);
      let html: string;
      let css: string;
      if (input.componentId) {
        const c = findById(editor, input.componentId);
        if (!c) throw new Error(`component not found: ${input.componentId}`);
        html = c.toHTML();
        css = editor.getCss({ component: c }) ?? "";
      } else {
        html = editor.getHtml();
        css = editor.getCss() ?? "";
      }
      const merged = mergeStylesIntoHtml(html, css);
      return { jsx: htmlToJsx(merged, input.mode ?? "tailwind") };
    },

    get_variables: (params) => {
      GetVariablesInput.parse(params);
      return { variables: getVariables() };
    },

    set_variables: (params) => {
      const input = SetVariablesInput.parse(params);
      const updated = setVariables(editor, input.variables);
      return { variables: updated };
    },

    create_artboard: (params) => {
      const input = CreateArtboardInput.parse(params);
      const artboard = createArtboard(editor, {
        name: input.name,
        width: input.width,
        height: input.height,
        x: input.x,
        y: input.y,
      });
      return { artboard };
    },

    list_artboards: (params) => {
      ListArtboardsInput.parse(params);
      return { artboards: listArtboards(editor) };
    },

    find_placement: (params) => {
      const input = FindPlacementInput.parse(params);
      return findPlacement(editor, input.width, input.height);
    },

    fit_artboard: async (params) => {
      const input = FitArtboardInput.parse(params);
      // Fail fast if the artboard genuinely doesn't exist — avoid the
      // retry loop for a doomed call that would just eat time.
      if (!listArtboards(editor).some((a) => a.id === input.artboardId)) {
        throw new Error(`cannot fit artboard: ${input.artboardId} (not found)`);
      }
      // Iframe may still be mounting when this is called (typical agent
      // workflow: create_artboard → add_components → fit_artboard). Retry
      // briefly so the wrapper + body become measurable. setTimeout (not
      // rAF) because rAF can be throttled in background/detached states.
      // Bumped 1500ms → 3000ms once Google Fonts started landing (epic-8-
      // followups §3.3, §3.1) — `@font-face` loading delays text layout,
      // and large captures + screenshot backplate (ADR-0012 §1) settle
      // slower than the prior budget allowed.
      const FIT_TIMEOUT_MS = 3000;
      const deadline = Date.now() + FIT_TIMEOUT_MS;
      let height: number | null = null;
      while (Date.now() < deadline) {
        height = fitArtboardToContent(editor, input.artboardId);
        if (height != null) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      if (height == null) {
        throw new Error(
          `cannot fit artboard: ${input.artboardId} (wrapper/content not measurable within ${FIT_TIMEOUT_MS}ms)`,
        );
      }
      const artboard = listArtboards(editor).find((a) => a.id === input.artboardId);
      if (!artboard) throw new Error(`artboard not found after fit: ${input.artboardId}`);
      return { artboard, height };
    },

    add_classes: (params) => {
      const input = AddClassesInput.parse(params);
      const c = findById(editor, input.componentId);
      if (!c) throw new Error(`component not found: ${input.componentId}`);
      const adder = c as unknown as { addClass: (name: string) => unknown };
      for (const name of input.classes) {
        if (name) adder.addClass(name);
      }
      return { classes: classNamesOf(c) };
    },

    remove_classes: (params) => {
      const input = RemoveClassesInput.parse(params);
      const c = findById(editor, input.componentId);
      if (!c) throw new Error(`component not found: ${input.componentId}`);
      const remover = c as unknown as { removeClass: (name: string) => unknown };
      for (const name of input.classes) {
        if (name) remover.removeClass(name);
      }
      return { classes: classNamesOf(c) };
    },

    set_text: (params) => {
      const input = SetTextInput.parse(params);
      const c = findById(editor, input.componentId);
      if (!c) throw new Error(`component not found: ${input.componentId}`);
      const setter = c as unknown as {
        get: (k: string) => unknown;
        set: (k: string, v: unknown) => void;
        empty?: () => void;
        append: (x: unknown) => void;
      };
      // Two cases:
      //  1. The component IS a textnode (parent.get('type') === 'textnode') —
      //     update its `content` field directly.
      //  2. The component is an element whose body is a (possibly single) text
      //     child — wipe its children and append one textnode. This handles
      //     button / h1 / p / label / span etc. where the text lives in a
      //     child textnode and `set('content', ...)` on the parent is a no-op.
      if (setter.get("type") === "textnode") {
        setter.set("content", input.text);
        return { text: input.text };
      }
      setter.empty?.();
      setter.append({ type: "textnode", content: input.text });
      return { text: input.text };
    },

    select: (params) => {
      const input = SelectInput.parse(params);
      const components: Component[] = [];
      for (const id of input.componentIds) {
        const c = findById(editor, id);
        if (!c) throw new Error(`component not found: ${id}`);
        components.push(c);
      }
      // editor.select replaces the current selection; pass the array form so
      // multi-select is honoured.
      (editor as unknown as { select: (c: Component[] | Component | null) => void }).select(
        components,
      );
      return { componentIds: editor.getSelectedAll().map((c) => c.getId()) };
    },

    deselect: (params) => {
      DeselectInput.parse(params);
      (editor as unknown as { select: (c: Component[] | Component | null) => void }).select([]);
      return { componentIds: editor.getSelectedAll().map((c) => c.getId()) };
    },
  };

  // Wrap every write-side tool with a post-success hook that fires GrapesJS's
  // `update` event — the signal `attachPersistence` listens for to flip the
  // dirty bit. Without this, MCP-driven mutations (which bypass the user
  // interactions GrapesJS normally instruments) wouldn't trigger autosave
  // and agent-authored content disappears on reload.
  const triggerUpdate = () => {
    (editor as unknown as { trigger?: (ev: string) => void }).trigger?.("update");
  };
  for (const name of Object.keys(handlers)) {
    if (!WRITE_TOOLS.has(name)) continue;
    const inner = handlers[name]!;
    handlers[name] = async (params) => {
      const result = await inner(params);
      triggerUpdate();
      return result;
    };
  }

  return handlers;
}

function countDescendants(c: Component): number {
  let n = 0;
  const childArray = (c.components() as unknown as { toArray: () => Component[] }).toArray();
  for (const child of childArray) {
    n += 1 + countDescendants(child);
  }
  return n;
}
