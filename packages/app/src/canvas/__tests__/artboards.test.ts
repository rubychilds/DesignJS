import { describe, it, expect, vi } from "vitest";
import type { Editor, Frame } from "grapesjs";
import {
  ARTBOARD_PRESETS,
  ARTBOARD_CATEGORIES,
  ARTBOARDS_CHANGED,
  DEFAULT_ARTBOARD_GAP,
  PAGE_ROOT_ATTR,
  createArtboard,
  deleteArtboard,
  ensurePageRoot,
  findPlacement,
  listArtboards,
  renameArtboard,
  resizeArtboard,
} from "../artboards";

/**
 * Unit tests for the multi-artboard canvas state module.
 *
 * GrapesJS' Editor/Frame is not instantiated here — every test constructs a
 * minimal mock that exposes only the surface artboards.ts actually touches:
 *  - editor.Canvas.getFrames() / addFrame()
 *  - editor.Pages.getSelected().getFrames().remove()
 *  - editor.trigger() (for the ARTBOARDS_CHANGED event bus)
 *  - frame.get(key) / set(attrs) (Backbone-style model accessors)
 *  - frame.cid (the stable per-session id)
 *  - frame.get("component") → wrapper component (addStyle/addAttributes/getAttributes)
 */

// Type alias derived from the factory below: this lets the narrow vi.fn
// signatures (e.g. `Mock<[next: Record<string,unknown>], …>`) flow through
// without colliding with the widened `Mock<any[], unknown>` that an explicit
// `ReturnType<typeof vi.fn>` field would impose. Variance on
// `mockImplementation` makes that widening unassignable under strict TS.
type MockFrame = ReturnType<typeof makeFrame>;

function makeWrapper(childCount = 0) {
  const styles: Record<string, string> = {};
  const attributes: Record<string, string> = {};
  return {
    styles,
    attributes,
    addStyle: vi.fn((s: Record<string, string>) => Object.assign(styles, s)),
    addAttributes: vi.fn((a: Record<string, string>) => Object.assign(attributes, a)),
    getAttributes: vi.fn(() => attributes),
    components: () => ({ length: childCount }),
  };
}

function makeFrame(attrs: {
  cid?: string;
  name?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  childCount?: number;
}) {
  const attributes: Record<string, unknown> = {
    name: attrs.name ?? "Untitled",
    x: attrs.x ?? 0,
    y: attrs.y ?? 0,
    width: attrs.width ?? 1440,
    height: attrs.height ?? 900,
  };
  const wrapper = makeWrapper(attrs.childCount ?? 0);
  return {
    cid: attrs.cid ?? `c${Math.random().toString(36).slice(2, 8)}`,
    attributes,
    wrapper,
    get: (k: string) => (k === "component" ? wrapper : attributes[k]),
    set: vi.fn((next: Record<string, unknown>) => Object.assign(attributes, next)),
  };
}

function makeEditor(initialFrames: MockFrame[] = []) {
  const frames = [...initialFrames];
  const trigger = vi.fn();
  const removeFromPage = vi.fn((f: MockFrame) => {
    const idx = frames.indexOf(f);
    if (idx >= 0) frames.splice(idx, 1);
  });
  const addFrame = vi.fn(
    (attrs: { name: string; x: number; y: number; width: number; height: number }) => {
      const f = makeFrame(attrs);
      frames.push(f);
      return f as unknown as Frame;
    },
  );

  const editor = {
    Canvas: { getFrames: () => frames, addFrame },
    Pages: {
      getSelected: () => ({
        getFrames: () => ({ remove: removeFromPage }),
      }),
    },
    trigger,
  } as unknown as Editor;

  return { editor, frames, trigger, removeFromPage, addFrame };
}

describe("ARTBOARD_PRESETS", () => {
  it("exposes the documented category set", () => {
    const cats = new Set(ARTBOARD_PRESETS.map((p) => p.category));
    expect([...cats].sort()).toEqual([
      "desktop",
      "mobile",
      "presentation",
      "tablet",
      "watch",
    ]);
  });

  it.each([
    ["mobile", "iphone-17", "iPhone 17", 402, 874],
    ["tablet", "ipad-pro-11", 'iPad Pro 11"', 834, 1194],
    ["desktop", "macbook-pro-16", 'MacBook Pro 16"', 1728, 1117],
    ["presentation", "slide-16-9", "Slide 16:9", 1920, 1080],
    ["watch", "apple-watch-45", "Apple Watch 45mm", 198, 242],
  ])(
    "has a representative %s preset (%s) with the right shape",
    (category, id, label, width, height) => {
      const preset = ARTBOARD_PRESETS.find((p) => p.id === id);
      expect(preset).toBeDefined();
      expect(preset).toMatchObject({ id, label, width, height, category });
    },
  );

  it("declares unique ids across the table", () => {
    const ids = ARTBOARD_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ARTBOARD_CATEGORIES covers every category referenced by presets", () => {
    const catIds = new Set(ARTBOARD_CATEGORIES.map((c) => c.id));
    for (const preset of ARTBOARD_PRESETS) {
      expect(catIds.has(preset.category)).toBe(true);
    }
  });
});

describe("findPlacement", () => {
  it("returns origin when no frames exist", () => {
    const { editor } = makeEditor();
    expect(findPlacement(editor, 1440, 900)).toEqual({ x: 0, y: 0 });
  });

  it("pins new artboard y to 0 even when existing artboards have non-zero y", () => {
    // Regression: commit 9836da0 — previously placement copied the y of the
    // rightmost existing artboard, causing vertical drift.
    const { editor } = makeEditor([
      makeFrame({ x: 0, y: 500, width: 800, height: 600 }),
      makeFrame({ x: 900, y: -200, width: 400, height: 1000 }),
    ]);
    const placement = findPlacement(editor, 1440, 900);
    expect(placement.y).toBe(0);
  });

  it("places new artboard to the right of the rightmost edge plus the gap", () => {
    const { editor } = makeEditor([
      makeFrame({ x: 0, y: 0, width: 800, height: 600 }),
      makeFrame({ x: 1000, y: 0, width: 400, height: 600 }),
    ]);
    // Rightmost edge is 1000 + 400 = 1400. Next placement = 1400 + GAP.
    expect(findPlacement(editor, 500, 500)).toEqual({
      x: 1400 + DEFAULT_ARTBOARD_GAP,
      y: 0,
    });
  });

  it("does not consider the new artboard's own dimensions", () => {
    const { editor } = makeEditor([
      makeFrame({ x: 0, y: 0, width: 1280, height: 800 }),
    ]);
    const small = findPlacement(editor, 100, 100);
    const large = findPlacement(editor, 5000, 5000);
    expect(small).toEqual(large);
  });
});

describe("createArtboard", () => {
  it("adds a frame via Canvas.addFrame with computed placement and applies default body style", () => {
    // Includes the opacity-/white-background default from commit 7418afe.
    const { editor, addFrame, frames, trigger } = makeEditor();
    const data = createArtboard(editor, { width: 1280, height: 800, name: "Hello" });

    expect(addFrame).toHaveBeenCalledTimes(1);
    expect(addFrame).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Hello",
        x: 0,
        y: 0,
        width: 1280,
        height: 800,
        components: "",
      }),
    );
    expect(data.name).toBe("Hello");
    expect(data.width).toBe(1280);
    expect(data.height).toBe(800);

    // Default body style — white background, no margin/padding.
    const created = frames[frames.length - 1]!;
    expect(created.wrapper.styles).toMatchObject({
      margin: "0",
      padding: "0",
      background: "#ffffff",
    });
    // Wrapper dimensions are applied so infiniteCanvas renders correctly.
    expect(created.wrapper.styles).toMatchObject({
      width: "1280px",
      height: "800px",
    });

    expect(trigger).toHaveBeenCalledWith(ARTBOARDS_CHANGED);
  });

  it("auto-names frames as 'Artboard N' when no name is supplied", () => {
    const { editor } = makeEditor([
      makeFrame({ name: "Existing", x: 0, y: 0, width: 400, height: 400 }),
    ]);
    const data = createArtboard(editor, { width: 500, height: 500 });
    // Existing count (1) + 1 → "Artboard 2".
    expect(data.name).toBe("Artboard 2");
  });

  it("evicts an empty 'Frame 1' scratch frame before adding the real one", () => {
    // The scratch-frame definition: name === "Frame 1" AND zero child components.
    const scratch = makeFrame({
      name: "Frame 1",
      x: 0,
      y: 0,
      width: 1280,
      height: 800,
      childCount: 0,
    });
    const { editor, removeFromPage } = makeEditor([scratch]);

    createArtboard(editor, { width: 500, height: 500, name: "Real" });

    expect(removeFromPage).toHaveBeenCalledWith(scratch);
  });

  it("leaves a non-empty 'Frame 1' alone", () => {
    const populated = makeFrame({
      name: "Frame 1",
      x: 0,
      y: 0,
      width: 1280,
      height: 800,
      childCount: 3,
    });
    const { editor, removeFromPage } = makeEditor([populated]);

    createArtboard(editor, { width: 500, height: 500, name: "Real" });

    expect(removeFromPage).not.toHaveBeenCalled();
  });

  it("honors explicit x/y when both are provided (bypasses findPlacement)", () => {
    const { editor, addFrame } = makeEditor([
      makeFrame({ x: 0, y: 0, width: 800, height: 600 }),
    ]);
    createArtboard(editor, { width: 200, height: 200, x: 42, y: 17 });
    expect(addFrame).toHaveBeenCalledWith(
      expect.objectContaining({ x: 42, y: 17 }),
    );
  });
});

describe("listArtboards", () => {
  it("maps frames to FrameData using cid and attribute getters", () => {
    const { editor } = makeEditor([
      makeFrame({ cid: "c1", name: "A", x: 10, y: 20, width: 100, height: 200 }),
      makeFrame({ cid: "c2", name: "B", x: 300, y: 400, width: 500, height: 600 }),
    ]);
    const list = listArtboards(editor);
    expect(list).toEqual([
      { id: "c1", name: "A", x: 10, y: 20, width: 100, height: 200 },
      { id: "c2", name: "B", x: 300, y: 400, width: 500, height: 600 },
    ]);
  });
});

describe("multi-artboard horizontal layout", () => {
  it("places sequential creates so no two artboards overlap horizontally", () => {
    const { editor } = makeEditor();
    createArtboard(editor, { width: 400, height: 600, name: "A" });
    createArtboard(editor, { width: 800, height: 600, name: "B" });
    createArtboard(editor, { width: 300, height: 600, name: "C" });

    const list = listArtboards(editor).sort((a, b) => a.x - b.x);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]!;
      const cur = list[i]!;
      expect(cur.x).toBeGreaterThanOrEqual(prev.x + prev.width + DEFAULT_ARTBOARD_GAP);
      // Top-row strip — every artboard at y = 0.
      expect(cur.y).toBe(0);
    }
  });
});

describe("ensurePageRoot", () => {
  it("stamps the page-root attribute on the first frame's wrapper when no frame carries it", () => {
    // Commit c96f3f7 — explicit `data-designjs-page-root` flag on the
    // page-root frame. Verifies the attribute name + the placement.
    const first = makeFrame({ cid: "c1", name: "A" });
    const second = makeFrame({ cid: "c2", name: "B" });
    const { editor } = makeEditor([first, second]);

    ensurePageRoot(editor);

    expect(PAGE_ROOT_ATTR).toBe("data-designjs-page-root");
    expect(first.wrapper.addAttributes).toHaveBeenCalledWith({
      [PAGE_ROOT_ATTR]: "",
    });
    expect(second.wrapper.addAttributes).not.toHaveBeenCalled();
  });

  it("is idempotent — no-op when a frame already carries the attribute", () => {
    const first = makeFrame({ cid: "c1", name: "A" });
    // Pre-stamp the attribute, mimicking a project loaded from disk.
    first.wrapper.attributes[PAGE_ROOT_ATTR] = "";
    const { editor } = makeEditor([first]);

    ensurePageRoot(editor);

    expect(first.wrapper.addAttributes).not.toHaveBeenCalled();
  });

  it("does nothing on an empty canvas", () => {
    const { editor } = makeEditor();
    expect(() => ensurePageRoot(editor)).not.toThrow();
  });
});

describe("deleteArtboard / renameArtboard / resizeArtboard", () => {
  it("deleteArtboard removes the frame and fires ARTBOARDS_CHANGED", () => {
    const target = makeFrame({ cid: "victim" });
    const { editor, frames, trigger, removeFromPage } = makeEditor([
      makeFrame({ cid: "other" }),
      target,
    ]);

    expect(deleteArtboard(editor, "victim")).toBe(true);
    expect(removeFromPage).toHaveBeenCalledWith(target);
    expect(frames).toHaveLength(1);
    expect(trigger).toHaveBeenCalledWith(ARTBOARDS_CHANGED);
  });

  it("deleteArtboard returns false for an unknown id", () => {
    const { editor, trigger } = makeEditor([makeFrame({ cid: "a" })]);
    expect(deleteArtboard(editor, "nope")).toBe(false);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("renameArtboard writes the new name and fires ARTBOARDS_CHANGED", () => {
    const target = makeFrame({ cid: "a", name: "Old" });
    const { editor, trigger } = makeEditor([target]);
    expect(renameArtboard(editor, "a", "New")).toBe(true);
    expect(target.set).toHaveBeenCalledWith({ name: "New" });
    expect(trigger).toHaveBeenCalledWith(ARTBOARDS_CHANGED);
  });

  it("resizeArtboard sets width-only when height is omitted and mirrors dims to wrapper", () => {
    const target = makeFrame({ cid: "a", width: 100, height: 200 });
    const { editor } = makeEditor([target]);
    expect(resizeArtboard(editor, "a", 999)).toBe(true);
    expect(target.set).toHaveBeenCalledWith({ width: 999 });
    // applyFrameDimensions writes width+height (height read from the model
    // after the set merged) onto the wrapper component's styles.
    expect(target.wrapper.addStyle).toHaveBeenCalledWith({
      width: "999px",
      height: "200px",
    });
  });

  it("resizeArtboard writes both axes when height is provided", () => {
    const target = makeFrame({ cid: "a", width: 100, height: 200 });
    const { editor } = makeEditor([target]);
    resizeArtboard(editor, "a", 800, 600);
    expect(target.set).toHaveBeenCalledWith({ width: 800, height: 600 });
  });
});
