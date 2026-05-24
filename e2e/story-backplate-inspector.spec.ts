import { test, expect } from "./fixtures";

/**
 * ADR-0012 §1 follow-up — dedicated "Source screenshot backplate"
 * affordance in the Appearance inspector. Renders only when the
 * selection is the backplate img (`data-designjs-backplate`) or its
 * wrapper (`data-designjs-backplate-wrapper`); writes opacity directly
 * to the selected component.
 */
test.describe("Backplate inspector row (ADR-0012 §1 follow-up)", () => {
  test("hidden when the selection is not a backplate element", async ({
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

    await expect(
      page.locator('[data-testid="oc-ins-backplate-opacity"]'),
    ).toHaveCount(0);
  });

  test("renders + writes opacity when a data-designjs-backplate img is selected", async ({
    freshApp: page,
  }) => {
    await page.waitForFunction(
      () => typeof (window as unknown as { __designjs?: unknown }).__designjs !== "undefined",
      undefined,
      { timeout: 10_000 },
    );

    // Inject a backplate img into the page-root frame and select it.
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
        append: (h: string) => Array<unknown>;
        components: () => { models?: Array<unknown>; at?: (i: number) => unknown };
      };
      wrapper.append(
        '<img data-designjs-backplate="" src="data:image/png;base64,iVBORw0KGgo=" class="designjs-backplate-img">',
      );
      const collection = wrapper.components();
      const last =
        collection.at?.(((collection.models?.length ?? 1) - 1)) ?? null;
      if (last) ed.select(last);
    });

    await expect(
      page.locator('[data-testid="oc-ins-backplate-opacity"]'),
    ).toBeVisible();

    await page.locator('[data-testid="oc-ins-backplate-opacity"]').fill("50");
    await page.locator('[data-testid="oc-ins-backplate-opacity"]').press("Enter");

    const opacity = await page.evaluate(() => {
      const ed = (window as unknown as {
        __designjs: {
          editor: { getSelected: () => { getStyle: () => Record<string, string> } | null };
        };
      }).__designjs.editor;
      return ed.getSelected()?.getStyle()?.opacity;
    });
    expect(opacity).toBe("0.5");
  });
});
