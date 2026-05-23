import { describe, it, expect } from "vitest";
import {
  BridgeRole,
  HelloMessage,
  RequestMessage,
  ResponseMessage,
  BridgeMessage,
} from "../protocol";

// Note: protocol.ts does NOT export separate ErrorMessage or EventMessage schemas.
// Errors are modeled as the `ok: false` arm of ResponseMessage's discriminated union.
// There is no EventMessage in the current protocol; if events are added later,
// add a corresponding describe block here.

describe("BridgeRole", () => {
  it("accepts the three valid roles", () => {
    for (const role of ["mcp-server", "canvas", "browser-extension"] as const) {
      const result = BridgeRole.safeParse(role);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(role);
      }
    }
  });

  it("rejects an unknown role", () => {
    const result = BridgeRole.safeParse("designer");
    expect(result.success).toBe(false);
  });
});

describe("HelloMessage", () => {
  it("parses a hello with role and no sessionId", () => {
    const result = HelloMessage.safeParse({
      type: "hello",
      role: "mcp-server",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("hello");
      expect(result.data.role).toBe("mcp-server");
      expect(result.data.sessionId).toBeUndefined();
    }
  });

  it("parses a hello with an optional sessionId", () => {
    const result = HelloMessage.safeParse({
      type: "hello",
      role: "canvas",
      sessionId: "abc-123",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sessionId).toBe("abc-123");
    }
  });

  it("rejects a hello with a wrong type literal", () => {
    const result = HelloMessage.safeParse({
      type: "greeting",
      role: "canvas",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a hello with an unknown role", () => {
    const result = HelloMessage.safeParse({
      type: "hello",
      role: "designer",
    });
    expect(result.success).toBe(false);
  });
});

describe("RequestMessage", () => {
  it("parses a valid request with params", () => {
    const result = RequestMessage.safeParse({
      type: "request",
      id: "req-1",
      tool: "ping",
      params: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe("req-1");
      expect(result.data.tool).toBe("ping");
    }
  });

  it("rejects a request missing the required `tool` field", () => {
    const result = RequestMessage.safeParse({
      type: "request",
      id: "req-1",
      params: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects a request with a non-string id", () => {
    const result = RequestMessage.safeParse({
      type: "request",
      id: 42,
      tool: "ping",
      params: {},
    });
    expect(result.success).toBe(false);
  });
});

describe("ResponseMessage (success arm)", () => {
  it("parses an ok:true response with a result", () => {
    const result = ResponseMessage.safeParse({
      type: "response",
      id: "req-1",
      ok: true,
      result: { pong: true, at: 123 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ok).toBe(true);
      expect(result.data.id).toBe("req-1");
    }
  });

  it("rejects an ok:true response that lacks `id`", () => {
    const result = ResponseMessage.safeParse({
      type: "response",
      ok: true,
      result: {},
    });
    expect(result.success).toBe(false);
  });
});

describe("ResponseMessage (error arm)", () => {
  it("parses an ok:false response with an error string", () => {
    const result = ResponseMessage.safeParse({
      type: "response",
      id: "req-1",
      ok: false,
      error: "tool not found",
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.ok === false) {
      expect(result.data.error).toBe("tool not found");
    }
  });

  it("rejects an ok:false response missing the `error` field", () => {
    const result = ResponseMessage.safeParse({
      type: "response",
      id: "req-1",
      ok: false,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an ok:false response where error is not a string", () => {
    const result = ResponseMessage.safeParse({
      type: "response",
      id: "req-1",
      ok: false,
      error: { message: "boom" },
    });
    expect(result.success).toBe(false);
  });
});

describe("BridgeMessage union", () => {
  it("accepts a HelloMessage", () => {
    const result = BridgeMessage.safeParse({
      type: "hello",
      role: "canvas",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a RequestMessage", () => {
    const result = BridgeMessage.safeParse({
      type: "request",
      id: "r1",
      tool: "ping",
      params: {},
    });
    expect(result.success).toBe(true);
  });

  it("accepts a ResponseMessage (ok:true)", () => {
    const result = BridgeMessage.safeParse({
      type: "response",
      id: "r1",
      ok: true,
      result: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a message with an unknown `type`", () => {
    const result = BridgeMessage.safeParse({
      type: "event",
      payload: {},
    });
    expect(result.success).toBe(false);
  });
});
