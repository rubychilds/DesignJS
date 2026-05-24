import { test, expect } from "./fixtures";

/**
 * ADR-0006 §1: Min/Max clamps. Width/height clamps are independent of mode
 * (Fixed / Hug / Fill) and emitted as `min-width` / `max-width` /
 * `min-height` / `max-height` longhands. Surfaced via the SizeField overflow
 * popover. Empty input clears the clamp.
 */
test.describe("Inspector: SizeField Min/Max clamps", () => {
  test("setting and clearing min-width / max-width writes and removes the CSS longhands", async ({
    freshApp: page,
  }) => {
    await page.waitForFunction(
      () => typeof (window as unknown as { __designjs?: unknown }).__designjs !== "undefined",
      undefined,
      { timeout: 10_000 },
    );

    await page.evaluate(() => {
      const ed = (window as unknown as {
        __designjs: {
          editor: {
            Canvas: { getFrames: () => Array<{ get: (k: string) => unknown }> };
            select: (c: unknown) => void;
          };
        };
      }).__designjs.editor;
      const wrapper = ed.Canvas.getFrames()[0]!.get("component");
      if (wrapper) ed.select(wrapper);
    });

    await page.locator('[data-testid="oc-ins-w-clamp-trigger"]').click();
    await page.locator('[data-testid="oc-ins-min-w"]').fill("200");
    await page.locator('[data-testid="oc-ins-min-w"]').press("Enter");
    await page.locator('[data-testid="oc-ins-max-w"]').fill("600");
    await page.locator('[data-testid="oc-ins-max-w"]').press("Enter");

    const after = await page.evaluate(() => {
      const ed = (window as unknown as {
        __designjs: {
          editor: {
            Canvas: { getFrames: () => Array<{ get: (k: string) => unknown }> };
          };
        };
      }).__designjs.editor;
      const wrapper = ed.Canvas.getFrames()[0]!.get("component") as {
        getStyle: () => Record<string, string>;
      };
      return wrapper.getStyle();
    });

    expect(after["min-width"]).toBe("200px");
    expect(after["max-width"]).toBe("600px");

    await page.locator('[data-testid="oc-ins-min-w"]').fill("");
    await page.locator('[data-testid="oc-ins-min-w"]').press("Enter");

    const cleared = await page.evaluate(() => {
      const ed = (window as unknown as {
        __designjs: {
          editor: {
            Canvas: { getFrames: () => Array<{ get: (k: string) => unknown }> };
          };
        };
      }).__designjs.editor;
      const wrapper = ed.Canvas.getFrames()[0]!.get("component") as {
        getStyle: () => Record<string, string>;
      };
      return wrapper.getStyle();
    });

    expect(cleared["min-width"]).toBeUndefined();
    expect(cleared["max-width"]).toBe("600px");
  });

  test("clamps survive mode switch from Fixed to Hug", async ({ freshApp: page }) => {
    await page.waitForFunction(
      () => typeof (window as unknown as { __designjs?: unknown }).__designjs !== "undefined",
      undefined,
      { timeout: 10_000 },
    );

    await page.evaluate(() => {
      const ed = (window as unknown as {
        __designjs: {
          editor: {
            Canvas: { getFrames: () => Array<{ get: (k: string) => unknown }> };
            select: (c: unknown) => void;
          };
        };
      }).__designjs.editor;
      const wrapper = ed.Canvas.getFrames()[0]!.get("component") as {
        addStyle: (s: Record<string, string>) => void;
      };
      // Make the wrapper itself an auto-layout container so Hug becomes available.
      wrapper.addStyle({ display: "flex", "flex-direction": "row" });
      ed.select(wrapper);
    });

    await page.locator('[data-testid="oc-ins-w-clamp-trigger"]').click();
    await page.locator('[data-testid="oc-ins-min-w"]').fill("320");
    await page.locator('[data-testid="oc-ins-min-w"]').press("Enter");
    // Close popover by clicking elsewhere.
    await page.keyboard.press("Escape");

    // Switch W mode to Hug.
    await page.locator('[data-testid="oc-ins-width-mode"]').click();
    await page.locator('[data-testid="oc-ins-width-mode-hug"]').click();

    const after = await page.evaluate(() => {
      const ed = (window as unknown as {
        __designjs: {
          editor: {
            Canvas: { getFrames: () => Array<{ get: (k: string) => unknown }> };
          };
        };
      }).__designjs.editor;
      const wrapper = ed.Canvas.getFrames()[0]!.get("component") as {
        getStyle: () => Record<string, string>;
      };
      return wrapper.getStyle();
    });

    expect(after["min-width"]).toBe("320px");
    expect(after["width"]).toBeUndefined();
  });
});
