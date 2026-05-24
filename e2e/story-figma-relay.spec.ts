import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "./fixtures";

interface ComponentNode {
  id: string;
  type: string;
  tagName?: string;
  classes: string[];
  attributes: Record<string, string>;
  children: ComponentNode[];
}

interface FigmaRelayFixture {
  source: { tool: string; fileKey: string; frameName: string; capturedAt: string };
  variables: Record<string, string>;
  components: Array<{ name: string; html: string }>;
}

const FIXTURE_PATH = resolve(__dirname, "fixtures/figma-relay-sample.json");

function loadFixture(): FigmaRelayFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as FigmaRelayFixture;
}

/**
 * ADR-0008 Path A — MCP relay verification.
 *
 * Simulates the agent half of the relay: an upstream Figma Dev Mode MCP server
 * has already produced a frame walk + token defs (canned in the fixture). The
 * agent translates those into HTML/Tailwind and pipes them through the
 * existing DesignJS MCP tools — `set_variables` for the design tokens and
 * `add_components` for the per-frame HTML, one call per top-level component.
 *
 * No new MCP tool is involved on the DesignJS side; that is the point of the
 * strategy. The transport, the bridge, and the browser tool handlers are the
 * same ones Story 2.x exercises.
 */
test.describe("Story 6.3 / ADR-0008 Path A: Figma → DesignJS MCP relay", () => {
  test("relay payload lands on canvas via set_variables + add_components", async ({
    freshApp: page,
    mcp,
  }) => {
    const fixture = loadFixture();

    // 1. Agent forwards Figma's get_variable_defs output into our token surface.
    const varsRes = await mcp.call<{ variables: Record<string, string> }>("set_variables", {
      variables: fixture.variables,
    });
    for (const [key, value] of Object.entries(fixture.variables)) {
      expect(varsRes.variables[key]).toBe(value);
    }

    // 2. Agent walks each translated component and adds it to the canvas. The
    //    relay flow doesn't need a special bulk tool — one add_components call
    //    per top-level frame is enough and keeps each insertion's id list
    //    visible to the agent for follow-up edits.
    const created: string[] = [];
    for (const component of fixture.components) {
      const res = await mcp.call<{ componentIds: string[] }>("add_components", {
        html: component.html,
      });
      expect(res.componentIds.length).toBeGreaterThan(0);
      created.push(...res.componentIds);
    }
    expect(created.length).toBe(fixture.components.length);

    // 3. Tree contains every relay-tagged component at the top level.
    const tree = await mcp.call<{ root: ComponentNode | null }>("get_tree", {});
    expect(tree.root).not.toBeNull();
    const relayMarkers = tree
      .root!.children.flatMap((child) => collectRelayMarkers(child))
      .sort();
    expect(relayMarkers).toEqual(["card", "cta", "eyebrow", "headline"]);

    // 4. The HTML round-trips through GrapesJS without dropping the relay
    //    attribute or the token references — guard against silent class
    //    rewriting under heavy Tailwind v4 arbitrary-value usage.
    const { html } = await mcp.call<{ html: string }>("get_html", {});
    expect(html).toContain("data-figma-relay=\"headline\"");
    expect(html).toContain("data-figma-relay=\"cta\"");
    expect(html).toContain("var(--brand-primary)");
    expect(html).toContain("var(--text-base)");

    // 5. Variables persisted in the editor surface.
    const readBack = await mcp.call<{ variables: Record<string, string> }>(
      "get_variables",
      {},
    );
    expect(readBack.variables["--brand-primary"]).toBe(fixture.variables["--brand-primary"]);

    // 6. The CTA actually paints with the brand colour in the iframe — proves
    //    the var() reference resolved end-to-end against the iframe :root.
    const frame = page.frameLocator('iframe[class*="gjs-frame"]');
    const cta = frame.locator('[data-figma-relay="cta"]');
    await expect(cta).toBeVisible();
    const bg = await cta.evaluate((node) => window.getComputedStyle(node).backgroundColor);
    // oklch resolves to a non-transparent rgb()/oklch() string; the precise
    // value depends on the browser's color-space conversion. We just assert
    // the variable wasn't dropped.
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(bg).not.toBe("");
  });
});

function collectRelayMarkers(node: ComponentNode): string[] {
  const here = node.attributes?.["data-figma-relay"];
  const childMarkers = node.children.flatMap(collectRelayMarkers);
  return here ? [here, ...childMarkers] : childMarkers;
}
