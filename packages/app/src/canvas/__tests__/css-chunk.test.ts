import { describe, it, expect } from "vitest";
import { chunkCss } from "../css-chunk";

describe("chunkCss", () => {
  it("returns single chunk when css is smaller than maxChunkSize", () => {
    const css = ".a { color: red } .b { color: blue }";
    expect(chunkCss(css, 1000)).toEqual([css]);
  });

  it("splits at rule boundaries (no rule torn in half)", () => {
    // 3 rules ~30 chars each; small maxChunkSize forces splits.
    const css =
      ".a { color: red }" +
      ".b { color: blue }" +
      ".c { color: green }";
    const chunks = chunkCss(css, 25);
    // Each chunk should end on `}` and contain whole rules.
    for (const chunk of chunks) {
      expect(chunk.trim().endsWith("}")).toBe(true);
      // Opening braces equal closing braces inside the chunk.
      const opens = (chunk.match(/\{/g) ?? []).length;
      const closes = (chunk.match(/\}/g) ?? []).length;
      expect(opens).toBe(closes);
    }
    // Concatenation reconstructs the original.
    expect(chunks.join("")).toBe(css);
  });

  it("doesn't break nested at-rules across chunks", () => {
    // The @media block is bigger than maxChunkSize on its own, so chunking
    // can't split it; the function should still emit it as one chunk.
    const css =
      ".a { color: red }" +
      "@media (min-width: 500px) { .b { color: blue } .c { color: cyan } }" +
      ".d { color: green }";
    const chunks = chunkCss(css, 25);
    // Each chunk has balanced braces.
    for (const chunk of chunks) {
      const opens = (chunk.match(/\{/g) ?? []).length;
      const closes = (chunk.match(/\}/g) ?? []).length;
      expect(opens).toBe(closes);
    }
    // The @media block lands intact in one chunk somewhere.
    const mediaChunk = chunks.find((c) => c.includes("@media"));
    expect(mediaChunk).toBeDefined();
    expect(mediaChunk!.includes(".b { color: blue }")).toBe(true);
    expect(mediaChunk!.includes(".c { color: cyan }")).toBe(true);
  });

  it("makes forward progress even when a rule exceeds maxChunkSize", () => {
    // Edge case: one giant rule with no top-level `}` within the window.
    // The function should still terminate (emit the chunk as-is) rather
    // than infinite-loop.
    const giantRule = ".x { " + "color: red; ".repeat(500) + "}";
    const css = giantRule + ".y { color: blue }";
    const chunks = chunkCss(css, 200);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join("")).toBe(css);
  });

  it("reconstructs input exactly via concatenation", () => {
    // No bytes added or dropped — chunking is purely a partition.
    const css = Array.from({ length: 50 }, (_, i) => `._a${i}{c:red}`).join("");
    const chunks = chunkCss(css, 60);
    expect(chunks.join("")).toBe(css);
    expect(chunks.length).toBeGreaterThan(1);
  });
});
