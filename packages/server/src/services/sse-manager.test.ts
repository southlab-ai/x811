/**
 * x811 Protocol --- SSEManager unit tests.
 */

import { PassThrough } from "node:stream";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type http from "node:http";
import { SSEManager } from "./sse-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockResponse(): http.ServerResponse {
  const stream = new PassThrough();
  return stream as unknown as http.ServerResponse;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SSEManager", () => {
  let mgr: SSEManager;

  beforeEach(() => {
    vi.useFakeTimers();
    mgr = new SSEManager();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("subscribe returns true and stores connection", () => {
    const res = mockResponse();
    const ok = mgr.subscribe("agent-1", res);
    expect(ok).toBe(true);
    expect(mgr.getStats().global).toBe(1);
    expect(mgr.getStats().perAgent["agent-1"]).toBe(1);
  });

  it("subscribe returns false when per-agent limit reached (3)", () => {
    const r1 = mockResponse();
    const r2 = mockResponse();
    const r3 = mockResponse();
    const r4 = mockResponse();

    expect(mgr.subscribe("agent-1", r1)).toBe(true);
    expect(mgr.subscribe("agent-1", r2)).toBe(true);
    expect(mgr.subscribe("agent-1", r3)).toBe(true);
    expect(mgr.subscribe("agent-1", r4)).toBe(false);
    expect(mgr.getStats().global).toBe(3);
  });

  it("subscribe returns false when global limit reached (100)", () => {
    for (let i = 0; i < 100; i++) {
      expect(mgr.subscribe(`agent-${i}`, mockResponse())).toBe(true);
    }
    expect(mgr.subscribe("agent-overflow", mockResponse())).toBe(false);
    expect(mgr.getStats().global).toBe(100);
  });

  it("emit writes correct SSE format", () => {
    const res = mockResponse();
    mgr.subscribe("agent-1", res);

    const payload = { type: "request", from: "did:x811:a" };
    mgr.emit("agent-1", "msg-123", payload);

    const stream = res as unknown as PassThrough;
    const written = stream.read()?.toString();
    expect(written).toContain("id: msg-123");
    expect(written).toContain("event: message");
    expect(written).toContain(`data: ${JSON.stringify(payload)}`);
  });

  it("emit to non-existent agent is a no-op", () => {
    // Should not throw
    mgr.emit("no-agent", "msg-1", { hello: true });
  });

  it("unsubscribe removes connection and decrements count", () => {
    const res = mockResponse();
    mgr.subscribe("agent-1", res);
    expect(mgr.getStats().global).toBe(1);

    mgr.unsubscribe("agent-1", res);
    expect(mgr.getStats().global).toBe(0);
    expect(mgr.getStats().perAgent["agent-1"]).toBeUndefined();
  });

  it("unsubscribe with unknown agent is a no-op", () => {
    mgr.unsubscribe("no-agent", mockResponse());
    expect(mgr.getStats().global).toBe(0);
  });

  it("unsubscribe with unknown response is a no-op", () => {
    const r1 = mockResponse();
    const r2 = mockResponse();
    mgr.subscribe("agent-1", r1);
    mgr.unsubscribe("agent-1", r2);
    expect(mgr.getStats().global).toBe(1);
  });

  it("evictAgent closes all connections for an agent", () => {
    const r1 = mockResponse();
    const r2 = mockResponse();
    mgr.subscribe("agent-1", r1);
    mgr.subscribe("agent-1", r2);
    expect(mgr.getStats().global).toBe(2);

    mgr.evictAgent("agent-1");
    expect(mgr.getStats().global).toBe(0);
    expect(mgr.getStats().perAgent["agent-1"]).toBeUndefined();
  });

  it("evictAgent on non-existent agent is a no-op", () => {
    mgr.evictAgent("no-agent");
    expect(mgr.getStats().global).toBe(0);
  });

  it("getStats returns accurate counts", () => {
    mgr.subscribe("agent-1", mockResponse());
    mgr.subscribe("agent-1", mockResponse());
    mgr.subscribe("agent-2", mockResponse());

    const stats = mgr.getStats();
    expect(stats.global).toBe(3);
    expect(stats.perAgent["agent-1"]).toBe(2);
    expect(stats.perAgent["agent-2"]).toBe(1);
  });

  it("emit removes broken connections on write error", () => {
    // Create a response whose write() throws
    const res = mockResponse();
    const original = res.write.bind(res);
    let callCount = 0;
    (res as unknown as PassThrough).write = ((...args: unknown[]) => {
      callCount++;
      // Let the keepalive setup pass, but fail on emit
      if (callCount > 0) throw new Error("write failed");
      return original(...(args as Parameters<typeof original>));
    }) as typeof res.write;

    mgr.subscribe("agent-1", res);

    mgr.emit("agent-1", "msg-1", { test: true });
    expect(mgr.getStats().global).toBe(0);
  });
});
