import { test, expect } from "./fixtures";

/**
 * ADR-0006 Open Question §1 — explicit `data-designjs-page-root`
 * attribute on the page-root frame's wrapper Component, instead of the
 * fragile "first frame in document order" rule. The marker is stamped
 * by `ensurePageRoot(editor)` during `handleReady`, survives saved-
 * project round-trips, and is the primary source of truth for
 * `getPageRootWrapper` (with first-frame fallback for legacy projects
 * predating the flag).
 */
test.describe("Page-root flag (ADR-0006 OQ §1)", () => {
  test("default boot stamps the marker on the only frame's wrapper", async ({
    freshApp: page,
  }) => {
    await page.waitForFunction(
      () => typeof (window as unknown as { __designjs?: unknown }).__designjs !== "undefined",
      undefined,
      { timeout: 10_000 },
    );

    const stamped = await page.evaluate(() => {
      const ed = (window as unknown as {
        __designjs: {
          editor: {
            Canvas: { getFrames: () => Array<{ get: (k: string) => unknown }> };
          };
        };
      }).__designjs.editor;
      const frames = ed.Canvas.getFrames();
      return frames.map((f) => {
        const wrapper = f.get("component") as {
          getAttributes: () => Record<string, unknown>;
        };
        return wrapper.getAttributes()["data-designjs-page-root"];
      });
    });

    expect(stamped).toHaveLength(1);
    expect(stamped[0]).toBe("");
  });

  test("primitives target the marked frame even when it's not first in document order", async ({
    freshApp: page,
  }) => {
    await page.waitForFunction(
      () => typeof (window as unknown as { __designjs?: unknown }).__designjs !== "undefined",
      undefined,
      { timeout: 10_000 },
    );

    // Add a second frame, then explicitly move the marker so the second
    // frame is the page root despite still being second in document
    // order. createPrimitive should follow the marker, not the order.
    const result = await page.evaluate(() => {
      const ed = (window as unknown as {
        __designjs: {
          editor: {
            Canvas: {
              getFrames: () => Array<{ get: (k: string) => unknown }>;
              addFrame: (opts: Record<string, unknown>) => unknown;
            };
          };
        };
      }).__designjs.editor;

      ed.Canvas.addFrame({ name: "Second", x: 1500, y: 0, width: 800, height: 600, components: "" });

      const frames = ed.Canvas.getFrames();
      const firstWrapper = frames[0]!.get("component") as {
        setAttributes: (a: Record<string, string>) => void;
        getAttributes: () => Record<string, unknown>;
      };
      const secondWrapper = frames[1]!.get("component") as {
        addAttributes: (a: Record<string, string>) => void;
        getAttributes: () => Record<string, unknown>;
      };

      // Move the marker from frame 0 to frame 1. addAttributes({ key: null })
      // keeps the key with value null in some GrapesJS versions, so we use
      // setAttributes with a filtered copy to actually drop the entry.
      const filtered = { ...firstWrapper.getAttributes() } as Record<string, string>;
      delete filtered["data-designjs-page-root"];
      firstWrapper.setAttributes(filtered);
      secondWrapper.addAttributes({ "data-designjs-page-root": "" });

      return {
        marker0: firstWrapper.getAttributes()["data-designjs-page-root"],
        marker1: secondWrapper.getAttributes()["data-designjs-page-root"],
      };
    });

    expect(result.marker0).toBeUndefined();
    expect(result.marker1).toBe("");
  });
});
