import { describe, it, expect, beforeEach } from "vitest";
import { collectFontLinks } from "../style-serializer";

/**
 * epic-8-followups §3.1: walk document.head for <link rel="stylesheet">
 * pointing at known font-CDN hosts, emit them as clean <link> tags so
 * captured text renders in the source page's font instead of the system
 * fallback.
 */
describe("collectFontLinks", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
  });

  function addLink(rel: string, href: string): void {
    const el = document.createElement("link");
    el.setAttribute("rel", rel);
    el.setAttribute("href", href);
    document.head.appendChild(el);
  }

  it("returns the empty string when there are no font links", () => {
    addLink("stylesheet", "https://example.com/site.css");
    addLink("preconnect", "https://fonts.googleapis.com");
    expect(collectFontLinks(document.head)).toBe("");
  });

  it("emits matching Google Fonts stylesheets with crossorigin=anonymous", () => {
    addLink("stylesheet", "https://fonts.googleapis.com/css2?family=Inter&display=swap");
    const out = collectFontLinks(document.head);
    expect(out).toContain('href="https://fonts.googleapis.com/css2?family=Inter&amp;display=swap"');
    expect(out).toContain('crossorigin="anonymous"');
    expect(out).toMatch(/^<link rel="stylesheet" /);
  });

  it("includes the four allowlisted hosts and excludes everything else", () => {
    addLink("stylesheet", "https://fonts.googleapis.com/css?family=A");
    addLink("stylesheet", "https://fonts.bunny.net/css?family=B");
    addLink("stylesheet", "https://use.typekit.net/abc.css");
    addLink("stylesheet", "https://p.typekit.net/abc.js");
    addLink("stylesheet", "https://cdn.jsdelivr.net/npm/something.css");
    addLink("stylesheet", "https://malicious.example/font.css");

    const out = collectFontLinks(document.head);
    expect(out).toContain("fonts.googleapis.com");
    expect(out).toContain("fonts.bunny.net");
    expect(out).toContain("use.typekit.net");
    expect(out).toContain("p.typekit.net");
    expect(out).not.toContain("jsdelivr");
    expect(out).not.toContain("malicious");
  });

  it("ignores non-stylesheet rels (preload, preconnect, dns-prefetch)", () => {
    addLink("preconnect", "https://fonts.googleapis.com");
    addLink("dns-prefetch", "https://fonts.googleapis.com");
    addLink("preload", "https://fonts.googleapis.com/css2?family=X");
    expect(collectFontLinks(document.head)).toBe("");
  });

  it("deduplicates identical hrefs", () => {
    addLink("stylesheet", "https://fonts.googleapis.com/css?family=Inter");
    addLink("stylesheet", "https://fonts.googleapis.com/css?family=Inter");
    const out = collectFontLinks(document.head);
    const matches = out.match(/<link /g);
    expect(matches?.length).toBe(1);
  });

  it("returns the empty string for null/undefined heads (defensive)", () => {
    expect(collectFontLinks(null)).toBe("");
    expect(collectFontLinks(undefined)).toBe("");
  });

  it("skips links whose href is malformed and cannot be parsed as a URL", () => {
    const el = document.createElement("link");
    el.setAttribute("rel", "stylesheet");
    el.setAttribute("href", "not a url");
    document.head.appendChild(el);
    expect(() => collectFontLinks(document.head)).not.toThrow();
  });
});
