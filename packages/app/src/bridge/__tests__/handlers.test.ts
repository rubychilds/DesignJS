import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "grapesjs";
import { buildHandlers } from "../handlers.js";
import { ARTBOARDS_CHANGED } from "../../canvas/artboards.js";
import { resetTokenStore } from "../../canvas/tokens.js";

/**
 * Unit tests for the MCP bridge handlers — finding F.18 in
 * `docs/architecture/architecture-testing.md` § 4.2.
 *
 * Pattern (mirrors `canvas/__tests__/artboards.test.ts`):
 *   - No real GrapesJS instance. Build a `makeEditor()` mock that exposes only
 *     the surface `handlers.ts` actually touches.
 *   - Each handler factory call is `buildHandlers(mockEditor)`; the test
 *     reaches in by tool name (`handlers.add_classes(...)`).
 *   - Component-tree state lives inside the per-test mock so `findById` walks
 *     a realistic tree.
 *
 * Mock-editor surface (kept tight intentionally — see report):
 *   - `editor.Canvas.getFrames() / getFrameEl() / getDocument()`
 *   - `editor.getWrapper() / getHtml() / getCss(...)`
 *   - `editor.getSelectedAll() / select(...)`
 *   - `editor.Css.addRules(text)` (returns parsed-rule array)
 *   - `editor.addComponents(html)` (fallback path)
 *   - `editor.trigger(ev)` (used for the `update` autosave hook + ARTBOARDS_CHANGED)
 *   - Per-Component: `getId / get / set / getAttributes / getClasses /
 *     components / append / addStyle / getStyle / addClass / removeClass /
 *     empty / addAttributes / toHTML / remove`
 *   - Per-Frame: `cid / id / get('component') / view.frame / view.el` (the
 *     iframe-fallback landmarks under the multi-frame layout fix)
 */

// ─────────────────────────────────────────────────────────────────────────────
// Mock factories
// ─────────────────────────────────────────────────────────────────────────────

let idCounter = 0;
function nextId(prefix = "c"): string {
  idCounter += 1;
  return `${prefix}${idCounter}`;
}

interface MockComponentOpts {
  id?: string;
  tagName?: string;
  type?: string;
  attributes?: Record<string, string>;
  classes?: string[];
  content?: string;
  styles?: Record<string, string>;
}

/**
 * Minimal Component shape consumed by handlers.ts. Children are real nested
 * MockComponents so `findById` actually walks the tree.
 */
function makeComponent(opts: MockComponentOpts = {}) {
  const id = opts.id ?? nextId();
  const attributes: Record<string, string> = { ...(opts.attributes ?? {}) };
  const classes: string[] = [...(opts.classes ?? [])];
  const styles: Record<string, string> = { ...(opts.styles ?? {}) };
  const children: MockComponent[] = [];
  const fields: Record<string, unknown> = {
    tagName: opts.tagName ?? "div",
    type: opts.type ?? "default",
    content: opts.content,
  };

  const component = {
    __id: id,
    children,
    fields,
    styles,
    getId: vi.fn(() => id),
    get: vi.fn((k: string) => fields[k]),
    set: vi.fn((k: string, v: unknown) => {
      fields[k] = v;
    }),
    getAttributes: vi.fn(() => ({ ...attributes })),
    addAttributes: vi.fn((a: Record<string, string>) => Object.assign(attributes, a)),
    getClasses: vi.fn(() => [...classes]),
    getStyle: vi.fn(() => ({ ...styles })),
    addStyle: vi.fn((s: Record<string, string>) => Object.assign(styles, s)),
    addClass: vi.fn((name: string) => {
      if (!classes.includes(name)) classes.push(name);
    }),
    removeClass: vi.fn((name: string) => {
      const idx = classes.indexOf(name);
      if (idx >= 0) classes.splice(idx, 1);
    }),
    components: vi.fn(() => ({
      toArray: () => children,
      length: children.length,
    })),
    append: vi.fn((html: string | { type: string; content: string }) => {
      // Two call sites: parent.append(htmlString) in add_components — returns
      // the appended Component(s); and setter.append({type,content}) in
      // set_text — used purely for side-effect.
      if (typeof html === "string") {
        const child = makeComponent({ tagName: "section" });
        children.push(child);
        return [child as unknown as Component];
      }
      const child = makeComponent({ type: html.type, content: html.content });
      children.push(child);
      return child as unknown as Component;
    }),
    empty: vi.fn(() => {
      children.length = 0;
    }),
    toHTML: vi.fn(() => {
      const tag = String(fields.tagName ?? "div");
      const cls = classes.length ? ` class="${classes.join(" ")}"` : "";
      const body = String(fields.content ?? "");
      return `<${tag}${cls}>${body}</${tag}>`;
    }),
    remove: vi.fn(),
  };
  return component;
}
type MockComponent = ReturnType<typeof makeComponent>;
// Loose Component alias so vi.fn signatures don't drown the file in casts.
type Component = MockComponent;

interface MockFrameOpts {
  cid?: string;
  id?: string;
  name?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** Wrapper component for this frame (the root of its tree). */
  wrapper?: MockComponent;
  /** Optional iframe element — exercised by `get_screenshot`. */
  iframeEl?: HTMLIFrameElement;
  /** When set, places iframeEl behind view.el instead of view.frame. */
  iframeViaViewEl?: boolean;
}

function makeFrame(opts: MockFrameOpts = {}) {
  const wrapper = opts.wrapper ?? makeComponent();
  const attrs: Record<string, unknown> = {
    name: opts.name ?? "Frame",
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    width: opts.width ?? 1280,
    height: opts.height ?? 800,
  };
  const view = opts.iframeEl
    ? opts.iframeViaViewEl
      ? { el: opts.iframeEl }
      : { frame: opts.iframeEl, el: opts.iframeEl }
    : undefined;
  return {
    cid: opts.cid ?? nextId("f"),
    id: opts.id,
    attributes: attrs,
    wrapper,
    view,
    get: vi.fn((k: string) => (k === "component" ? wrapper : attrs[k])),
    set: vi.fn((next: Record<string, unknown>) => Object.assign(attrs, next)),
  };
}
type MockFrame = ReturnType<typeof makeFrame>;

interface MakeEditorOpts {
  frames?: MockFrame[];
  /** Optional editor.getWrapper() — used when there are no frames. */
  rootWrapper?: MockComponent;
  /** What editor.getHtml() returns. Defaults to empty. */
  html?: string;
  /** What editor.getCss() returns. Defaults to empty. */
  css?: string;
  /** What editor.Css.addRules returns per call. */
  parsedRules?: unknown[];
  /** Initial selection. */
  selected?: MockComponent[];
}

function makeEditor(opts: MakeEditorOpts = {}) {
  const frames = [...(opts.frames ?? [])];
  let selected: MockComponent[] = [...(opts.selected ?? [])];
  const cssAddRules = vi.fn(() => [...(opts.parsedRules ?? [])]);
  const trigger = vi.fn();
  const select = vi.fn((c: MockComponent | MockComponent[] | null) => {
    if (c == null) selected = [];
    else if (Array.isArray(c)) selected = [...c];
    else selected = [c];
  });
  const addComponents = vi.fn((html: string) => {
    const child = makeComponent({ tagName: "div" });
    if (opts.rootWrapper) opts.rootWrapper.children.push(child);
    return [child];
  });
  const addFrame = vi.fn(
    (a: { name: string; x: number; y: number; width: number; height: number }) => {
      const f = makeFrame({
        name: a.name,
        x: a.x,
        y: a.y,
        width: a.width,
        height: a.height,
      });
      frames.push(f);
      return f as unknown as Frame;
    },
  );
  const removeFromPage = vi.fn((f: MockFrame) => {
    const idx = frames.indexOf(f);
    if (idx >= 0) frames.splice(idx, 1);
  });

  const editor = {
    Canvas: {
      getFrames: () => frames,
      getFrameEl: () => null,
      getDocument: () => undefined,
      addFrame,
    },
    Pages: {
      getSelected: () => ({
        getFrames: () => ({ remove: removeFromPage }),
      }),
    },
    Css: { addRules: cssAddRules },
    getWrapper: () => opts.rootWrapper ?? null,
    getHtml: vi.fn(() => opts.html ?? ""),
    getCss: vi.fn(() => opts.css ?? ""),
    getSelectedAll: () => [...selected],
    select,
    addComponents,
    trigger,
  } as unknown as Editor;

  return {
    editor,
    frames,
    addFrame,
    removeFromPage,
    cssAddRules,
    trigger,
    select,
    addComponents,
    getSelection: () => selected,
  };
}

// Loose import-shim for the Frame import inside addFrame (needs to compile
// without dragging in the real type chain at test time).
type Frame = unknown;

// ─────────────────────────────────────────────────────────────────────────────
// Resets
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  idCounter = 0;
  // `getVariables` / `setVariables` read a module-level token store.
  // Reset between tests so the in-memory tree starts clean.
  resetTokenStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Inspect tools
// ─────────────────────────────────────────────────────────────────────────────

describe("buildHandlers — ping", () => {
  it("returns { pong: true, at: <number> } for empty input", async () => {
    const { editor } = makeEditor();
    const handlers = buildHandlers(editor);
    const before = Date.now();
    const result = (await handlers.ping!({})) as { pong: true; at: number };
    expect(result.pong).toBe(true);
    expect(typeof result.at).toBe("number");
    expect(result.at).toBeGreaterThanOrEqual(before);
  });

  it("rejects unknown keys (strict input schema)", async () => {
    const { editor } = makeEditor();
    const handlers = buildHandlers(editor);
    await expect(async () => handlers.ping!({ extra: 1 })).rejects.toThrow();
  });
});

describe("buildHandlers — get_tree", () => {
  it("serializes the editor wrapper when no artboardId is given", async () => {
    const root = makeComponent({ id: "root", tagName: "body" });
    const child = makeComponent({ id: "child", tagName: "p", classes: ["x"], content: "hi" });
    root.children.push(child);
    const { editor } = makeEditor({ rootWrapper: root });
    const handlers = buildHandlers(editor);

    const result = (await handlers.get_tree!({})) as {
      root: { id: string; children: Array<{ id: string; textContent?: string }> };
    };
    expect(result.root.id).toBe("root");
    expect(result.root.children).toHaveLength(1);
    expect(result.root.children[0]!.id).toBe("child");
    expect(result.root.children[0]!.textContent).toBe("hi");
  });

  it("scopes the tree to a specific artboard when artboardId is provided", async () => {
    const wrapperA = makeComponent({ id: "wA", tagName: "body" });
    const wrapperB = makeComponent({ id: "wB", tagName: "body" });
    const childB = makeComponent({ id: "bChild", tagName: "div" });
    wrapperB.children.push(childB);
    const frameA = makeFrame({ cid: "fA", wrapper: wrapperA });
    const frameB = makeFrame({ cid: "fB", wrapper: wrapperB });
    const { editor } = makeEditor({ frames: [frameA, frameB] });
    const handlers = buildHandlers(editor);

    const result = (await handlers.get_tree!({ artboardId: "fB" })) as {
      root: { id: string };
    };
    expect(result.root.id).toBe("wB");
  });

  it("throws when artboardId does not resolve to a frame", async () => {
    const { editor } = makeEditor({ frames: [makeFrame({ cid: "fA" })] });
    const handlers = buildHandlers(editor);
    await expect(async () => handlers.get_tree!({ artboardId: "missing" })).rejects.toThrow(
      /artboard not found/i,
    );
  });

  it("honors the depth limit by truncating deeper children", async () => {
    const root = makeComponent({ id: "r" });
    const c1 = makeComponent({ id: "c1" });
    const c2 = makeComponent({ id: "c2" });
    root.children.push(c1);
    c1.children.push(c2);
    const { editor } = makeEditor({ rootWrapper: root });
    const handlers = buildHandlers(editor);

    const result = (await handlers.get_tree!({ depth: 1 })) as {
      root: { children: Array<{ children: unknown[] }> };
    };
    expect(result.root.children).toHaveLength(1);
    // depth=1 means root's children render but their children are []
    expect(result.root.children[0]!.children).toEqual([]);
  });

  it("returns { root: null } when there is no wrapper", async () => {
    const { editor } = makeEditor();
    const handlers = buildHandlers(editor);
    const result = (await handlers.get_tree!({})) as { root: null };
    expect(result.root).toBeNull();
  });
});

describe("buildHandlers — get_html", () => {
  it("returns editor.getHtml() when componentId is omitted", async () => {
    const { editor } = makeEditor({ html: "<p>hello</p>" });
    const handlers = buildHandlers(editor);
    const result = (await handlers.get_html!({})) as { html: string };
    expect(result.html).toBe("<p>hello</p>");
  });

  it("returns the component's own HTML when componentId resolves", async () => {
    const root = makeComponent({ id: "root" });
    const target = makeComponent({ id: "n1", tagName: "h1", content: "Hi" });
    root.children.push(target);
    const { editor } = makeEditor({ rootWrapper: root });
    const handlers = buildHandlers(editor);

    const result = (await handlers.get_html!({ componentId: "n1" })) as { html: string };
    expect(result.html).toBe("<h1>Hi</h1>");
  });

  it("throws on unknown componentId", async () => {
    const { editor } = makeEditor({ rootWrapper: makeComponent() });
    const handlers = buildHandlers(editor);
    await expect(async () => handlers.get_html!({ componentId: "nope" })).rejects.toThrow(
      /component not found/i,
    );
  });
});

describe("buildHandlers — get_css", () => {
  it("returns editor.getCss() when no componentId", async () => {
    const { editor } = makeEditor({ css: ".x { color: red }" });
    const handlers = buildHandlers(editor);
    const result = (await handlers.get_css!({})) as { css: string };
    expect(result.css).toBe(".x { color: red }");
  });

  it("scopes css to the component when componentId resolves", async () => {
    const root = makeComponent({ id: "root" });
    const c = makeComponent({ id: "c1" });
    root.children.push(c);
    const { editor } = makeEditor({ rootWrapper: root });
    // Re-bind getCss as a vi.fn so we can assert the { component } shape.
    const scopedCss = vi.fn(() => ".c1 { color: blue }");
    (editor as unknown as { getCss: typeof scopedCss }).getCss = scopedCss;
    const handlers = buildHandlers(editor);

    const result = (await handlers.get_css!({ componentId: "c1" })) as { css: string };
    expect(result.css).toBe(".c1 { color: blue }");
    expect(scopedCss).toHaveBeenCalledWith({ component: c });
  });

  it("throws on unknown componentId", async () => {
    const { editor } = makeEditor({ rootWrapper: makeComponent() });
    const handlers = buildHandlers(editor);
    await expect(async () => handlers.get_css!({ componentId: "nope" })).rejects.toThrow(
      /component not found/i,
    );
  });
});

describe("buildHandlers — get_screenshot", () => {
  it.skip("get_screenshot — covered by E2E; jsdom can't rasterize iframe content (html-to-image toPng/toJpeg)", async () => {
    // intentional placeholder — Playwright covers this path end-to-end
  });

  it("throws when artboardId does not resolve", async () => {
    const { editor } = makeEditor({ frames: [makeFrame({ cid: "fA" })] });
    const handlers = buildHandlers(editor);
    await expect(async () =>
      handlers.get_screenshot!({ artboardId: "missing" }),
    ).rejects.toThrow(/artboard not found/i);
  });

  it("throws when iframe is not available even after finding the frame", async () => {
    // Frame exists but has no view → frameIframe returns undefined.
    const { editor } = makeEditor({ frames: [makeFrame({ cid: "fA" })] });
    const handlers = buildHandlers(editor);
    await expect(async () =>
      handlers.get_screenshot!({ artboardId: "fA" }),
    ).rejects.toThrow(/iframe not available/i);
  });

  it("throws 'canvas iframe not ready' when default branch can't find any iframe", async () => {
    const { editor } = makeEditor();
    const handlers = buildHandlers(editor);
    await expect(async () => handlers.get_screenshot!({})).rejects.toThrow(
      /canvas iframe not ready/i,
    );
  });
});

describe("buildHandlers — get_selection", () => {
  it("returns the current selection as componentIds", async () => {
    const a = makeComponent({ id: "a" });
    const b = makeComponent({ id: "b" });
    const { editor } = makeEditor({ selected: [a, b] });
    const handlers = buildHandlers(editor);
    const result = (await handlers.get_selection!({})) as { componentIds: string[] };
    expect(result.componentIds).toEqual(["a", "b"]);
  });

  it("returns an empty array when nothing is selected", async () => {
    const { editor } = makeEditor();
    const handlers = buildHandlers(editor);
    const result = (await handlers.get_selection!({})) as { componentIds: string[] };
    expect(result.componentIds).toEqual([]);
  });
});

describe("buildHandlers — get_jsx", () => {
  it("uses editor.getHtml + getCss when no componentId", async () => {
    const { editor } = makeEditor({ html: "<div>x</div>", css: "" });
    const handlers = buildHandlers(editor);
    const result = (await handlers.get_jsx!({})) as { jsx: string };
    expect(typeof result.jsx).toBe("string");
    expect(result.jsx).toMatch(/export default function Component/);
  });

  it("scopes to a component when componentId resolves", async () => {
    const root = makeComponent({ id: "root" });
    const target = makeComponent({ id: "t1", tagName: "p", content: "scoped" });
    root.children.push(target);
    const { editor } = makeEditor({ rootWrapper: root });
    const handlers = buildHandlers(editor);
    const result = (await handlers.get_jsx!({ componentId: "t1", mode: "tailwind" })) as {
      jsx: string;
    };
    expect(result.jsx).toContain("scoped");
  });

  it("throws on unknown componentId", async () => {
    const { editor } = makeEditor({ rootWrapper: makeComponent() });
    const handlers = buildHandlers(editor);
    await expect(async () =>
      handlers.get_jsx!({ componentId: "nope" }),
    ).rejects.toThrow(/component not found/i);
  });
});

describe("buildHandlers — get_variables", () => {
  it("returns the current token-store flattened to css vars (empty by default)", async () => {
    const { editor } = makeEditor();
    const handlers = buildHandlers(editor);
    const result = (await handlers.get_variables!({})) as {
      variables: Record<string, string>;
    };
    expect(result.variables).toEqual({});
  });

  it("rejects unknown keys (strict schema)", async () => {
    const { editor } = makeEditor();
    const handlers = buildHandlers(editor);
    await expect(async () =>
      handlers.get_variables!({ unexpected: true }),
    ).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mutate tools
// ─────────────────────────────────────────────────────────────────────────────

describe("buildHandlers — add_components", () => {
  it("appends into the first frame's wrapper by default and returns the new ids", async () => {
    const wrapper = makeComponent({ id: "fw" });
    const frame = makeFrame({ cid: "f1", wrapper });
    const { editor, trigger } = makeEditor({ frames: [frame] });
    const handlers = buildHandlers(editor);

    const result = (await handlers.add_components!({ html: "<section>x</section>" })) as {
      componentIds: string[];
    };
    expect(result.componentIds).toHaveLength(1);
    expect(wrapper.append).toHaveBeenCalledWith("<section>x</section>");
    // Write tools fire editor.trigger("update") so autosave catches them.
    expect(trigger).toHaveBeenCalledWith("update");
  });

  it("routes to the artboard's wrapper when artboardId is given", async () => {
    const wrapperA = makeComponent({ id: "wA" });
    const wrapperB = makeComponent({ id: "wB" });
    const frameA = makeFrame({ cid: "fA", wrapper: wrapperA });
    const frameB = makeFrame({ cid: "fB", wrapper: wrapperB });
    const { editor } = makeEditor({ frames: [frameA, frameB] });
    const handlers = buildHandlers(editor);

    await handlers.add_components!({ html: "<div/>", artboardId: "fB" });
    expect(wrapperB.append).toHaveBeenCalledTimes(1);
    expect(wrapperA.append).not.toHaveBeenCalled();
  });

  it("routes to target component when target is supplied (target wins over artboardId)", async () => {
    const wrapperA = makeComponent({ id: "wA" });
    const targetChild = makeComponent({ id: "tgt" });
    wrapperA.children.push(targetChild);
    const frameA = makeFrame({ cid: "fA", wrapper: wrapperA });
    const { editor } = makeEditor({ frames: [frameA] });
    const handlers = buildHandlers(editor);

    await handlers.add_components!({ html: "<p/>", target: "tgt", artboardId: "fA" });
    expect(targetChild.append).toHaveBeenCalledWith("<p/>");
    // The wrapper itself shouldn't have been appended to.
    expect(wrapperA.append).not.toHaveBeenCalled();
  });

  it("throws when target id does not resolve", async () => {
    const wrapper = makeComponent({ id: "w" });
    const { editor } = makeEditor({ frames: [makeFrame({ cid: "f1", wrapper })] });
    const handlers = buildHandlers(editor);
    await expect(async () =>
      handlers.add_components!({ html: "<x/>", target: "missing" }),
    ).rejects.toThrow(/target component not found/i);
  });

  it("throws when artboardId does not resolve", async () => {
    const { editor } = makeEditor({ frames: [makeFrame({ cid: "f1" })] });
    const handlers = buildHandlers(editor);
    await expect(async () =>
      handlers.add_components!({ html: "<x/>", artboardId: "missing" }),
    ).rejects.toThrow(/artboard not found/i);
  });

  it("falls back to editor.addComponents when no frame exists", async () => {
    const { editor, addComponents, trigger } = makeEditor();
    const handlers = buildHandlers(editor);
    const result = (await handlers.add_components!({ html: "<a/>" })) as {
      componentIds: string[];
    };
    expect(addComponents).toHaveBeenCalledWith("<a/>");
    expect(result.componentIds).toHaveLength(1);
    expect(trigger).toHaveBeenCalledWith("update");
  });
});

describe("buildHandlers — add_css_rules", () => {
  it("calls Css.addRules with the input and reports the parsed rule count", async () => {
    const { editor, cssAddRules, trigger } = makeEditor({
      parsedRules: [{}, {}, {}],
    });
    const handlers = buildHandlers(editor);
    const result = (await handlers.add_css_rules!({
      cssText: ".a { color: red; } .b { color: blue }",
    })) as { ruleCount: number };
    expect(result.ruleCount).toBe(3);
    expect(cssAddRules).toHaveBeenCalled();
    expect(trigger).toHaveBeenCalledWith("update");
  });

  it("reports 0 rules when nothing parses", async () => {
    const { editor } = makeEditor({ parsedRules: [] });
    const handlers = buildHandlers(editor);
    const result = (await handlers.add_css_rules!({ cssText: ".x{}" })) as {
      ruleCount: number;
    };
    expect(result.ruleCount).toBe(0);
  });

  it("rejects missing cssText (strict schema)", async () => {
    const { editor } = makeEditor();
    const handlers = buildHandlers(editor);
    await expect(async () => handlers.add_css_rules!({})).rejects.toThrow();
  });
});

describe("buildHandlers — update_styles", () => {
  it("applies styles to the matched component and returns the merged style map", async () => {
    const root = makeComponent({ id: "root" });
    const target = makeComponent({ id: "t1", styles: { color: "red" } });
    root.children.push(target);
    const { editor, trigger } = makeEditor({ rootWrapper: root });
    const handlers = buildHandlers(editor);

    const result = (await handlers.update_styles!({
      componentId: "t1",
      styles: { background: "blue" },
    })) as { styles: Record<string, string> };
    expect(target.addStyle).toHaveBeenCalledWith({ background: "blue" });
    expect(result.styles).toEqual({ color: "red", background: "blue" });
    expect(trigger).toHaveBeenCalledWith("update");
  });

  it("throws when componentId is unknown", async () => {
    const { editor } = makeEditor({ rootWrapper: makeComponent() });
    const handlers = buildHandlers(editor);
    await expect(async () =>
      handlers.update_styles!({ componentId: "nope", styles: {} }),
    ).rejects.toThrow(/component not found/i);
  });

  it("resolves componentIds living inside a non-root frame wrapper (multi-frame walk)", async () => {
    // Regression-shape coverage for the story-mcp-autosave fix referenced in
    // handlers.ts findById's comment: ids living in frame.get("component")
    // must resolve even when editor.getWrapper() returns a different tree.
    const frameWrapper = makeComponent({ id: "fwrap" });
    const inner = makeComponent({ id: "inner" });
    frameWrapper.children.push(inner);
    const frame = makeFrame({ cid: "f1", wrapper: frameWrapper });
    const otherRoot = makeComponent({ id: "other" });
    const { editor } = makeEditor({ frames: [frame], rootWrapper: otherRoot });
    const handlers = buildHandlers(editor);

    const result = (await handlers.update_styles!({
      componentId: "inner",
      styles: { padding: "4px" },
    })) as { styles: Record<string, string> };
    expect(result.styles.padding).toBe("4px");
  });
});

describe("buildHandlers — delete_nodes", () => {
  it("removes matched components and counts descendants", async () => {
    const root = makeComponent({ id: "root" });
    const a = makeComponent({ id: "a" });
    const a1 = makeComponent({ id: "a1" });
    const a2 = makeComponent({ id: "a2" });
    a.children.push(a1, a2);
    root.children.push(a);
    const { editor, trigger } = makeEditor({ rootWrapper: root });
    const handlers = buildHandlers(editor);

    const result = (await handlers.delete_nodes!({ componentIds: ["a"] })) as {
      deleted: number;
    };
    // 'a' + its 2 descendants = 3
    expect(result.deleted).toBe(3);
    expect(a.remove).toHaveBeenCalled();
    expect(trigger).toHaveBeenCalledWith("update");
  });

  it("silently skips ids that do not resolve (no throw)", async () => {
    const root = makeComponent({ id: "root" });
    const a = makeComponent({ id: "a" });
    root.children.push(a);
    const { editor } = makeEditor({ rootWrapper: root });
    const handlers = buildHandlers(editor);

    const result = (await handlers.delete_nodes!({
      componentIds: ["a", "nope"],
    })) as { deleted: number };
    expect(result.deleted).toBe(1);
  });

  it("returns deleted: 0 when no ids match", async () => {
    const { editor } = makeEditor({ rootWrapper: makeComponent() });
    const handlers = buildHandlers(editor);
    const result = (await handlers.delete_nodes!({ componentIds: ["x", "y"] })) as {
      deleted: number;
    };
    expect(result.deleted).toBe(0);
  });
});

describe("buildHandlers — set_text", () => {
  it("sets `content` directly when the target component is a textnode", async () => {
    const root = makeComponent({ id: "root" });
    const text = makeComponent({ id: "t1", type: "textnode", content: "old" });
    root.children.push(text);
    const { editor, trigger } = makeEditor({ rootWrapper: root });
    const handlers = buildHandlers(editor);

    const result = (await handlers.set_text!({ componentId: "t1", text: "new" })) as {
      text: string;
    };
    expect(text.set).toHaveBeenCalledWith("content", "new");
    expect(result.text).toBe("new");
    expect(trigger).toHaveBeenCalledWith("update");
  });

  it("empties and appends a textnode for element-with-text components", async () => {
    const root = makeComponent({ id: "root" });
    const button = makeComponent({ id: "btn", tagName: "button" });
    const oldText = makeComponent({ id: "t-old", type: "textnode", content: "Click" });
    button.children.push(oldText);
    root.children.push(button);
    const { editor } = makeEditor({ rootWrapper: root });
    const handlers = buildHandlers(editor);

    const result = (await handlers.set_text!({
      componentId: "btn",
      text: "Submit",
    })) as { text: string };
    expect(button.empty).toHaveBeenCalled();
    expect(button.append).toHaveBeenCalledWith({ type: "textnode", content: "Submit" });
    expect(result.text).toBe("Submit");
  });

  it("throws when componentId does not resolve", async () => {
    const { editor } = makeEditor({ rootWrapper: makeComponent() });
    const handlers = buildHandlers(editor);
    await expect(async () =>
      handlers.set_text!({ componentId: "nope", text: "x" }),
    ).rejects.toThrow(/component not found/i);
  });
});

describe("buildHandlers — set_variables", () => {
  it("writes variables into the store and returns the merged map", async () => {
    const { editor, trigger } = makeEditor();
    const handlers = buildHandlers(editor);

    const result = (await handlers.set_variables!({
      variables: { "--brand-primary": "oklch(0.55 0.2 260)" },
    })) as { variables: Record<string, string> };
    expect(result.variables["--brand-primary"]).toBe("oklch(0.55 0.2 260)");
    expect(trigger).toHaveBeenCalledWith("update");
  });

  it("merges with existing variables (preserves keys not in the new map)", async () => {
    const { editor } = makeEditor();
    const handlers = buildHandlers(editor);
    await handlers.set_variables!({ variables: { "--a": "1px" } });
    const result = (await handlers.set_variables!({
      variables: { "--b": "2px" },
    })) as { variables: Record<string, string> };
    expect(result.variables["--a"]).toBe("1px");
    expect(result.variables["--b"]).toBe("2px");
  });

  it("rejects malformed input (variables must be a record of strings)", async () => {
    const { editor } = makeEditor();
    const handlers = buildHandlers(editor);
    await expect(async () =>
      handlers.set_variables!({ variables: "not-an-object" }),
    ).rejects.toThrow();
  });
});

describe("buildHandlers — add_classes", () => {
  it("calls addClass for each input class and returns the final list", async () => {
    const root = makeComponent({ id: "root" });
    const t = makeComponent({ id: "t", classes: ["existing"] });
    root.children.push(t);
    const { editor, trigger } = makeEditor({ rootWrapper: root });
    const handlers = buildHandlers(editor);

    const result = (await handlers.add_classes!({
      componentId: "t",
      classes: ["foo", "bar"],
    })) as { classes: string[] };
    expect(t.addClass).toHaveBeenCalledWith("foo");
    expect(t.addClass).toHaveBeenCalledWith("bar");
    expect(result.classes).toEqual(["existing", "foo", "bar"]);
    expect(trigger).toHaveBeenCalledWith("update");
  });

  it("skips empty-string class names", async () => {
    const root = makeComponent({ id: "root" });
    const t = makeComponent({ id: "t" });
    root.children.push(t);
    const { editor } = makeEditor({ rootWrapper: root });
    const handlers = buildHandlers(editor);

    await handlers.add_classes!({ componentId: "t", classes: ["", "real"] });
    expect(t.addClass).toHaveBeenCalledTimes(1);
    expect(t.addClass).toHaveBeenCalledWith("real");
  });

  it("throws when componentId does not resolve", async () => {
    const { editor } = makeEditor({ rootWrapper: makeComponent() });
    const handlers = buildHandlers(editor);
    await expect(async () =>
      handlers.add_classes!({ componentId: "nope", classes: ["x"] }),
    ).rejects.toThrow(/component not found/i);
  });
});

describe("buildHandlers — remove_classes", () => {
  it("calls removeClass for each input class and returns the final list", async () => {
    const root = makeComponent({ id: "root" });
    const t = makeComponent({ id: "t", classes: ["a", "b", "c"] });
    root.children.push(t);
    const { editor, trigger } = makeEditor({ rootWrapper: root });
    const handlers = buildHandlers(editor);

    const result = (await handlers.remove_classes!({
      componentId: "t",
      classes: ["b"],
    })) as { classes: string[] };
    expect(t.removeClass).toHaveBeenCalledWith("b");
    expect(result.classes).toEqual(["a", "c"]);
    expect(trigger).toHaveBeenCalledWith("update");
  });

  it("silently skips classes not currently present", async () => {
    const root = makeComponent({ id: "root" });
    const t = makeComponent({ id: "t", classes: ["a"] });
    root.children.push(t);
    const { editor } = makeEditor({ rootWrapper: root });
    const handlers = buildHandlers(editor);
    const result = (await handlers.remove_classes!({
      componentId: "t",
      classes: ["nonexistent"],
    })) as { classes: string[] };
    expect(result.classes).toEqual(["a"]);
  });

  it("throws when componentId does not resolve", async () => {
    const { editor } = makeEditor({ rootWrapper: makeComponent() });
    const handlers = buildHandlers(editor);
    await expect(async () =>
      handlers.remove_classes!({ componentId: "nope", classes: ["x"] }),
    ).rejects.toThrow(/component not found/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Artboard tools — exercise the real canvas/artboards.ts (it's pure-ish and
// already mock-compatible thanks to the test helpers above).
// ─────────────────────────────────────────────────────────────────────────────

describe("buildHandlers — create_artboard", () => {
  it("creates a new frame via Canvas.addFrame and returns its data", async () => {
    const { editor, addFrame, trigger } = makeEditor();
    const handlers = buildHandlers(editor);

    const result = (await handlers.create_artboard!({
      name: "Hello",
      width: 1280,
      height: 800,
    })) as { artboard: { name: string; width: number; height: number } };
    expect(addFrame).toHaveBeenCalledTimes(1);
    expect(result.artboard.name).toBe("Hello");
    expect(result.artboard.width).toBe(1280);
    expect(result.artboard.height).toBe(800);
    // ARTBOARDS_CHANGED fires from createArtboard; the write-tools wrapper
    // also fires "update".
    expect(trigger).toHaveBeenCalledWith(ARTBOARDS_CHANGED);
    expect(trigger).toHaveBeenCalledWith("update");
  });

  it("rejects missing width/height (strict schema)", async () => {
    const { editor } = makeEditor();
    const handlers = buildHandlers(editor);
    await expect(async () =>
      handlers.create_artboard!({ name: "x" }),
    ).rejects.toThrow();
  });

  it("honors explicit x/y", async () => {
    const { editor, addFrame } = makeEditor();
    const handlers = buildHandlers(editor);
    await handlers.create_artboard!({ width: 200, height: 200, x: 42, y: 17 });
    expect(addFrame).toHaveBeenCalledWith(
      expect.objectContaining({ x: 42, y: 17 }),
    );
  });
});

describe("buildHandlers — list_artboards", () => {
  it("lists the current frames in canvas-world coordinates", async () => {
    const { editor } = makeEditor({
      frames: [
        makeFrame({ cid: "f1", name: "A", x: 0, y: 0, width: 100, height: 200 }),
        makeFrame({ cid: "f2", name: "B", x: 300, y: 0, width: 400, height: 500 }),
      ],
    });
    const handlers = buildHandlers(editor);
    const result = (await handlers.list_artboards!({})) as {
      artboards: Array<{ id: string }>;
    };
    expect(result.artboards.map((a) => a.id)).toEqual(["f1", "f2"]);
  });

  it("returns an empty list when there are no frames", async () => {
    const { editor } = makeEditor();
    const handlers = buildHandlers(editor);
    const result = (await handlers.list_artboards!({})) as { artboards: unknown[] };
    expect(result.artboards).toEqual([]);
  });
});

describe("buildHandlers — find_placement", () => {
  it("returns origin when no frames exist", async () => {
    const { editor } = makeEditor();
    const handlers = buildHandlers(editor);
    const result = (await handlers.find_placement!({ width: 200, height: 200 })) as {
      x: number;
      y: number;
    };
    expect(result).toEqual({ x: 0, y: 0 });
  });

  it("places new artboards to the right of the existing rightmost", async () => {
    const { editor } = makeEditor({
      frames: [makeFrame({ cid: "f1", x: 100, y: 0, width: 400, height: 600 })],
    });
    const handlers = buildHandlers(editor);
    const result = (await handlers.find_placement!({ width: 200, height: 200 })) as {
      x: number;
      y: number;
    };
    // rightmost edge = 100 + 400 = 500; +80 gap = 580
    expect(result.x).toBe(580);
    expect(result.y).toBe(0);
  });
});

describe("buildHandlers — fit_artboard", () => {
  it("throws fast when the artboard does not exist (avoids the retry loop)", async () => {
    const { editor } = makeEditor();
    const handlers = buildHandlers(editor);
    await expect(async () =>
      handlers.fit_artboard!({ artboardId: "missing" }),
    ).rejects.toThrow(/cannot fit artboard/i);
  });

  it("throws within the deadline when the wrapper is never measurable", async () => {
    // Frame exists (so the fast-fail branch is skipped) but has no iframe
    // view — fitArtboardToContent returns null forever. The handler retries
    // until the 3000ms deadline; with fake timers we drain instantly.
    vi.useFakeTimers();
    try {
      const { editor } = makeEditor({
        frames: [makeFrame({ cid: "f1" })],
      });
      const handlers = buildHandlers(editor);
      const promise = handlers.fit_artboard!({ artboardId: "f1" });
      // Attach the rejection assertion BEFORE advancing timers so the
      // rejection is observed synchronously when it lands — otherwise the
      // unhandled-rejection tripwire fires before expect() awaits.
      const assertion = expect(promise).rejects.toThrow(/cannot fit artboard/i);
      // Drain the polling loop past the 3000ms FIT_TIMEOUT_MS.
      await vi.advanceTimersByTimeAsync(3500);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Selection tools
// ─────────────────────────────────────────────────────────────────────────────

describe("buildHandlers — select", () => {
  it("calls editor.select(componentList) and returns the new selection ids", async () => {
    const root = makeComponent({ id: "root" });
    const a = makeComponent({ id: "a" });
    const b = makeComponent({ id: "b" });
    root.children.push(a, b);
    const { editor, select } = makeEditor({ rootWrapper: root });
    const handlers = buildHandlers(editor);

    const result = (await handlers.select!({ componentIds: ["a", "b"] })) as {
      componentIds: string[];
    };
    expect(select).toHaveBeenCalledTimes(1);
    expect(result.componentIds).toEqual(["a", "b"]);
  });

  it("throws on unknown id and does not partially apply selection", async () => {
    const root = makeComponent({ id: "root" });
    const a = makeComponent({ id: "a" });
    root.children.push(a);
    const { editor, select } = makeEditor({ rootWrapper: root });
    const handlers = buildHandlers(editor);

    await expect(async () =>
      handlers.select!({ componentIds: ["a", "missing"] }),
    ).rejects.toThrow(/component not found/i);
    // Selection mutator never fired because the loop threw before reaching it.
    expect(select).not.toHaveBeenCalled();
  });
});

describe("buildHandlers — deselect", () => {
  it("clears the current selection and returns []", async () => {
    const a = makeComponent({ id: "a" });
    const { editor, select } = makeEditor({ selected: [a] });
    const handlers = buildHandlers(editor);

    const result = (await handlers.deselect!({})) as { componentIds: string[] };
    expect(select).toHaveBeenCalledWith([]);
    expect(result.componentIds).toEqual([]);
  });

  it("is a no-op (but still callable) when nothing is selected", async () => {
    const { editor } = makeEditor();
    const handlers = buildHandlers(editor);
    const result = (await handlers.deselect!({})) as { componentIds: string[] };
    expect(result.componentIds).toEqual([]);
  });
});
