import { describe, it, expect } from "vitest";
import {
  ArtboardData,
  CreateArtboardInput,
  CreateArtboardOutput,
  ListArtboardsInput,
  ListArtboardsOutput,
  FindPlacementInput,
  FindPlacementOutput,
  FitArtboardInput,
  FitArtboardOutput,
  AddClassesInput,
  AddClassesOutput,
  RemoveClassesInput,
  RemoveClassesOutput,
  SetTextInput,
  SetTextOutput,
  SelectInput,
  SelectOutput,
  DeselectInput,
  DeselectOutput,
} from "../tools";

// Tests for artboard management, class/text mutation, and selection schemas.
// Companion to tools.test.ts (which covers the data/IO half of the surface).

describe("ArtboardData", () => {
  it("parses a full artboard", () => {
    expect(
      ArtboardData.safeParse({
        id: "a",
        name: "n",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      }).success,
    ).toBe(true);
  });
  it("rejects an artboard missing width", () => {
    expect(
      ArtboardData.safeParse({ id: "a", name: "n", x: 0, y: 0, height: 100 }).success,
    ).toBe(false);
  });
});

describe("CreateArtboardInput / CreateArtboardOutput", () => {
  it("parses with required width/height", () => {
    expect(CreateArtboardInput.safeParse({ width: 100, height: 50 }).success).toBe(true);
  });
  it("rejects non-positive width", () => {
    expect(CreateArtboardInput.safeParse({ width: 0, height: 50 }).success).toBe(false);
  });
  it("rejects unknown fields (.strict)", () => {
    expect(
      CreateArtboardInput.safeParse({ width: 1, height: 1, color: "red" }).success,
    ).toBe(false);
  });
  it("parses output with artboard", () => {
    expect(
      CreateArtboardOutput.safeParse({
        artboard: { id: "a", name: "n", x: 0, y: 0, width: 1, height: 1 },
      }).success,
    ).toBe(true);
  });
  it("rejects output missing artboard", () => {
    expect(CreateArtboardOutput.safeParse({}).success).toBe(false);
  });
});

describe("ListArtboardsInput / ListArtboardsOutput", () => {
  it("parses empty input", () => {
    expect(ListArtboardsInput.safeParse({}).success).toBe(true);
  });
  it("rejects extra fields (.strict)", () => {
    expect(ListArtboardsInput.safeParse({ filter: "all" }).success).toBe(false);
  });
  it("parses output with artboards array", () => {
    expect(ListArtboardsOutput.safeParse({ artboards: [] }).success).toBe(true);
  });
  it("rejects output missing artboards", () => {
    expect(ListArtboardsOutput.safeParse({}).success).toBe(false);
  });
});

describe("FindPlacementInput / FindPlacementOutput", () => {
  it("parses with positive width/height", () => {
    expect(FindPlacementInput.safeParse({ width: 100, height: 50 }).success).toBe(true);
  });
  it("rejects negative width", () => {
    expect(FindPlacementInput.safeParse({ width: -1, height: 50 }).success).toBe(false);
  });
  it("parses output { x, y }", () => {
    expect(FindPlacementOutput.safeParse({ x: 1, y: 2 }).success).toBe(true);
  });
  it("rejects output missing y", () => {
    expect(FindPlacementOutput.safeParse({ x: 1 }).success).toBe(false);
  });
});

describe("FitArtboardInput / FitArtboardOutput", () => {
  it("parses with artboardId", () => {
    expect(FitArtboardInput.safeParse({ artboardId: "a" }).success).toBe(true);
  });
  it("rejects missing artboardId", () => {
    expect(FitArtboardInput.safeParse({}).success).toBe(false);
  });
  it("parses output", () => {
    expect(
      FitArtboardOutput.safeParse({
        artboard: { id: "a", name: "n", x: 0, y: 0, width: 1, height: 1 },
        height: 200,
      }).success,
    ).toBe(true);
  });
  it("rejects output missing height", () => {
    expect(
      FitArtboardOutput.safeParse({
        artboard: { id: "a", name: "n", x: 0, y: 0, width: 1, height: 1 },
      }).success,
    ).toBe(false);
  });
});

describe("AddClassesInput / AddClassesOutput", () => {
  it("parses with componentId + classes", () => {
    expect(
      AddClassesInput.safeParse({ componentId: "c", classes: ["a"] }).success,
    ).toBe(true);
  });
  it("rejects missing classes", () => {
    expect(AddClassesInput.safeParse({ componentId: "c" }).success).toBe(false);
  });
  it("parses output with classes array", () => {
    expect(AddClassesOutput.safeParse({ classes: ["a"] }).success).toBe(true);
  });
  it("rejects output where classes contains non-strings", () => {
    expect(AddClassesOutput.safeParse({ classes: [1] }).success).toBe(false);
  });
});

describe("RemoveClassesInput / RemoveClassesOutput", () => {
  it("parses with componentId + classes", () => {
    expect(
      RemoveClassesInput.safeParse({ componentId: "c", classes: ["a"] }).success,
    ).toBe(true);
  });
  it("rejects unknown fields (.strict)", () => {
    expect(
      RemoveClassesInput.safeParse({ componentId: "c", classes: [], hard: true }).success,
    ).toBe(false);
  });
  it("parses output", () => {
    expect(RemoveClassesOutput.safeParse({ classes: [] }).success).toBe(true);
  });
  it("rejects output missing classes", () => {
    expect(RemoveClassesOutput.safeParse({}).success).toBe(false);
  });
});

describe("SetTextInput / SetTextOutput", () => {
  it("parses with componentId + text", () => {
    expect(SetTextInput.safeParse({ componentId: "c", text: "hi" }).success).toBe(true);
  });
  it("rejects missing text", () => {
    expect(SetTextInput.safeParse({ componentId: "c" }).success).toBe(false);
  });
  it("parses output", () => {
    expect(SetTextOutput.safeParse({ text: "hi" }).success).toBe(true);
  });
  it("rejects output missing text", () => {
    expect(SetTextOutput.safeParse({}).success).toBe(false);
  });
});

describe("SelectInput / SelectOutput", () => {
  it("parses with componentIds", () => {
    expect(SelectInput.safeParse({ componentIds: ["a"] }).success).toBe(true);
  });
  it("rejects missing componentIds", () => {
    expect(SelectInput.safeParse({}).success).toBe(false);
  });
  it("parses output", () => {
    expect(SelectOutput.safeParse({ componentIds: ["a"] }).success).toBe(true);
  });
  it("rejects output where componentIds is not an array", () => {
    expect(SelectOutput.safeParse({ componentIds: "a" }).success).toBe(false);
  });
});

describe("DeselectInput / DeselectOutput", () => {
  it("parses empty input", () => {
    expect(DeselectInput.safeParse({}).success).toBe(true);
  });
  it("rejects extra fields (.strict)", () => {
    expect(DeselectInput.safeParse({ all: true }).success).toBe(false);
  });
  it("parses output", () => {
    expect(DeselectOutput.safeParse({ componentIds: [] }).success).toBe(true);
  });
  it("rejects output missing componentIds", () => {
    expect(DeselectOutput.safeParse({}).success).toBe(false);
  });
});
