import { describe, it, expect } from "vitest";
import {
  PingInput,
  PingOutput,
  GetTreeInput,
  GetTreeOutput,
  ComponentNode,
  GetHtmlInput,
  GetHtmlOutput,
  GetCssInput,
  GetCssOutput,
  GetScreenshotInput,
  GetScreenshotOutput,
  GetSelectionInput,
  GetSelectionOutput,
  AddComponentsInput,
  AddCssRulesInput,
  AddCssRulesOutput,
  AddComponentsOutput,
  UpdateStylesInput,
  UpdateStylesOutput,
  DeleteNodesInput,
  DeleteNodesOutput,
  GetJsxInput,
  GetJsxOutput,
  GetVariablesInput,
  GetVariablesOutput,
  SetVariablesInput,
  SetVariablesOutput,
  TOOL_SCHEMAS,
  TOOL_DESCRIPTIONS,
} from "../tools";

// Tests for the "data" half of the tool surface: read/write the canvas content,
// styles, screenshots, selection, variables. Artboard + class/text/selection
// management schemas are covered in tools-artboards.test.ts to keep this file
// under the 250-line budget.

describe("PingInput / PingOutput", () => {
  it("parses an empty object as PingInput", () => {
    expect(PingInput.safeParse({}).success).toBe(true);
  });
  it("rejects unknown fields on PingInput (.strict)", () => {
    expect(PingInput.safeParse({ extra: 1 }).success).toBe(false);
  });
  it("parses { pong: true, at: <number> } as PingOutput", () => {
    expect(PingOutput.safeParse({ pong: true, at: 123 }).success).toBe(true);
  });
  it("rejects PingOutput where pong is not literal true", () => {
    expect(PingOutput.safeParse({ pong: false, at: 123 }).success).toBe(false);
  });
});

describe("GetTreeInput / GetTreeOutput / ComponentNode", () => {
  it("parses GetTreeInput with optional depth + artboardId", () => {
    expect(GetTreeInput.safeParse({ depth: 3, artboardId: "ab1" }).success).toBe(true);
    expect(GetTreeInput.safeParse({}).success).toBe(true);
  });
  it("rejects GetTreeInput with negative depth", () => {
    expect(GetTreeInput.safeParse({ depth: -1 }).success).toBe(false);
  });
  it("parses a recursive ComponentNode tree via GetTreeOutput", () => {
    const tree = {
      root: {
        id: "1",
        type: "div",
        classes: ["flex"],
        attributes: { "data-x": "1" },
        children: [
          { id: "2", type: "span", classes: [], attributes: {}, children: [] },
        ],
      },
    };
    expect(GetTreeOutput.safeParse(tree).success).toBe(true);
  });
  it("accepts root: null in GetTreeOutput", () => {
    expect(GetTreeOutput.safeParse({ root: null }).success).toBe(true);
  });
  it("rejects ComponentNode missing required `classes`", () => {
    expect(
      ComponentNode.safeParse({ id: "1", type: "div", attributes: {}, children: [] }).success,
    ).toBe(false);
  });
});

describe("GetHtmlInput / GetHtmlOutput", () => {
  it("parses optional componentId", () => {
    expect(GetHtmlInput.safeParse({}).success).toBe(true);
    expect(GetHtmlInput.safeParse({ componentId: "c1" }).success).toBe(true);
  });
  it("rejects unknown fields on GetHtmlInput (.strict)", () => {
    expect(GetHtmlInput.safeParse({ id: "c1" }).success).toBe(false);
  });
  it("parses GetHtmlOutput with html string", () => {
    expect(GetHtmlOutput.safeParse({ html: "<div/>" }).success).toBe(true);
  });
  it("rejects GetHtmlOutput missing html", () => {
    expect(GetHtmlOutput.safeParse({}).success).toBe(false);
  });
});

describe("GetCssInput / GetCssOutput", () => {
  it("parses optional componentId", () => {
    expect(GetCssInput.safeParse({ componentId: "c1" }).success).toBe(true);
  });
  it("rejects unknown fields (.strict)", () => {
    expect(GetCssInput.safeParse({ foo: 1 }).success).toBe(false);
  });
  it("parses GetCssOutput with css string", () => {
    expect(GetCssOutput.safeParse({ css: ".x{}" }).success).toBe(true);
  });
  it("rejects GetCssOutput where css is not a string", () => {
    expect(GetCssOutput.safeParse({ css: 1 }).success).toBe(false);
  });
});

describe("GetScreenshotInput / GetScreenshotOutput", () => {
  it("parses with scale=2 and format=png", () => {
    expect(
      GetScreenshotInput.safeParse({ scale: 2, format: "png", artboardId: "a" }).success,
    ).toBe(true);
  });
  it("rejects an invalid scale", () => {
    expect(GetScreenshotInput.safeParse({ scale: 3 }).success).toBe(false);
  });
  it("parses GetScreenshotOutput", () => {
    expect(
      GetScreenshotOutput.safeParse({ dataUrl: "data:...", width: 100, height: 50 }).success,
    ).toBe(true);
  });
  it("rejects GetScreenshotOutput missing height", () => {
    expect(GetScreenshotOutput.safeParse({ dataUrl: "x", width: 1 }).success).toBe(false);
  });
});

describe("GetSelectionInput / GetSelectionOutput", () => {
  it("parses empty input", () => {
    expect(GetSelectionInput.safeParse({}).success).toBe(true);
  });
  it("rejects extra fields (.strict)", () => {
    expect(GetSelectionInput.safeParse({ x: 1 }).success).toBe(false);
  });
  it("parses output with componentIds array", () => {
    expect(GetSelectionOutput.safeParse({ componentIds: ["a", "b"] }).success).toBe(true);
  });
  it("rejects output where componentIds contains non-strings", () => {
    expect(GetSelectionOutput.safeParse({ componentIds: [1, 2] }).success).toBe(false);
  });
});

describe("AddComponentsInput / AddComponentsOutput", () => {
  it("parses with required html and optional target/artboardId", () => {
    expect(
      AddComponentsInput.safeParse({ html: "<p/>", target: "t", artboardId: "a" }).success,
    ).toBe(true);
  });
  it("rejects missing html", () => {
    expect(AddComponentsInput.safeParse({ target: "t" }).success).toBe(false);
  });
  it("parses output with componentIds", () => {
    expect(AddComponentsOutput.safeParse({ componentIds: ["a"] }).success).toBe(true);
  });
  it("rejects output missing componentIds", () => {
    expect(AddComponentsOutput.safeParse({}).success).toBe(false);
  });
});

describe("AddCssRulesInput / AddCssRulesOutput", () => {
  it("parses with required cssText and optional artboardId", () => {
    expect(
      AddCssRulesInput.safeParse({ cssText: ".x { color: red }", artboardId: "a" }).success,
    ).toBe(true);
  });
  it("parses without artboardId (global rules)", () => {
    expect(AddCssRulesInput.safeParse({ cssText: ".x { color: red }" }).success).toBe(true);
  });
  it("rejects missing cssText", () => {
    expect(AddCssRulesInput.safeParse({ artboardId: "a" }).success).toBe(false);
  });
  it("rejects unknown fields (.strict())", () => {
    expect(
      AddCssRulesInput.safeParse({ cssText: ".x { color: red }", html: "<p/>" }).success,
    ).toBe(false);
  });
  it("parses output with ruleCount", () => {
    expect(AddCssRulesOutput.safeParse({ ruleCount: 3 }).success).toBe(true);
  });
  it("rejects negative ruleCount", () => {
    expect(AddCssRulesOutput.safeParse({ ruleCount: -1 }).success).toBe(false);
  });
});

describe("UpdateStylesInput / UpdateStylesOutput", () => {
  it("parses with componentId + styles map", () => {
    expect(
      UpdateStylesInput.safeParse({ componentId: "c", styles: { color: "red" } }).success,
    ).toBe(true);
  });
  it("rejects missing styles", () => {
    expect(UpdateStylesInput.safeParse({ componentId: "c" }).success).toBe(false);
  });
  it("parses output with styles", () => {
    expect(UpdateStylesOutput.safeParse({ styles: { color: "red" } }).success).toBe(true);
  });
  it("rejects output where styles values are not strings", () => {
    expect(UpdateStylesOutput.safeParse({ styles: { color: 1 } }).success).toBe(false);
  });
});

describe("DeleteNodesInput / DeleteNodesOutput", () => {
  it("parses with componentIds", () => {
    expect(DeleteNodesInput.safeParse({ componentIds: ["a"] }).success).toBe(true);
  });
  it("rejects extra fields (.strict)", () => {
    expect(DeleteNodesInput.safeParse({ componentIds: [], force: true }).success).toBe(false);
  });
  it("parses output { deleted: nonNeg int }", () => {
    expect(DeleteNodesOutput.safeParse({ deleted: 0 }).success).toBe(true);
  });
  it("rejects negative deleted count", () => {
    expect(DeleteNodesOutput.safeParse({ deleted: -1 }).success).toBe(false);
  });
});

describe("GetJsxInput / GetJsxOutput", () => {
  it("parses with optional mode", () => {
    expect(GetJsxInput.safeParse({ mode: "tailwind" }).success).toBe(true);
    expect(GetJsxInput.safeParse({ mode: "inline" }).success).toBe(true);
  });
  it("rejects an invalid mode", () => {
    expect(GetJsxInput.safeParse({ mode: "vanilla" }).success).toBe(false);
  });
  it("parses output", () => {
    expect(GetJsxOutput.safeParse({ jsx: "<div/>" }).success).toBe(true);
  });
  it("rejects output missing jsx", () => {
    expect(GetJsxOutput.safeParse({}).success).toBe(false);
  });
});

describe("GetVariablesInput / GetVariablesOutput", () => {
  it("parses empty input", () => {
    expect(GetVariablesInput.safeParse({}).success).toBe(true);
  });
  it("rejects extra fields (.strict)", () => {
    expect(GetVariablesInput.safeParse({ x: 1 }).success).toBe(false);
  });
  it("parses output with variables map", () => {
    expect(
      GetVariablesOutput.safeParse({ variables: { "--brand": "red" } }).success,
    ).toBe(true);
  });
  it("rejects output missing variables", () => {
    expect(GetVariablesOutput.safeParse({}).success).toBe(false);
  });
});

describe("SetVariablesInput / SetVariablesOutput", () => {
  it("parses with variables map", () => {
    expect(SetVariablesInput.safeParse({ variables: { "--x": "1" } }).success).toBe(true);
  });
  it("rejects unknown fields (.strict)", () => {
    expect(
      SetVariablesInput.safeParse({ variables: {}, merge: true }).success,
    ).toBe(false);
  });
  it("parses output", () => {
    expect(SetVariablesOutput.safeParse({ variables: {} }).success).toBe(true);
  });
  it("rejects output where variables is not an object", () => {
    expect(SetVariablesOutput.safeParse({ variables: "x" }).success).toBe(false);
  });
});

describe("TOOL_SCHEMAS / TOOL_DESCRIPTIONS registry", () => {
  it("registers an input+output schema for every tool name", () => {
    for (const name of Object.keys(TOOL_SCHEMAS) as (keyof typeof TOOL_SCHEMAS)[]) {
      expect(TOOL_SCHEMAS[name].input).toBeDefined();
      expect(TOOL_SCHEMAS[name].output).toBeDefined();
    }
  });
  it("has a description for every tool name", () => {
    for (const name of Object.keys(TOOL_SCHEMAS) as (keyof typeof TOOL_SCHEMAS)[]) {
      expect(typeof TOOL_DESCRIPTIONS[name]).toBe("string");
      expect(TOOL_DESCRIPTIONS[name].length).toBeGreaterThan(0);
    }
  });
});
