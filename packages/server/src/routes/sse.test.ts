/**
 * x811 Protocol --- SSE route integration tests.
 *
 * Tests for GET /api/v1/messages/:agentId/stream
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `x811-sse-test-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });

  app = await buildApp({
    databaseUrl: join(testDir, "test.db"),
    skipRateLimit: true,
  });
});

afterEach(async () => {
  await app.close();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // cleanup best-effort
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function registerTestAgentDirectly(
  overrides: Partial<{
    id: string;
    name: string;
    did: string;
  }> = {},
) {
  const id = overrides.id ?? randomUUID();
  const did = overrides.did ?? `did:web:x811.org:agents:${id}`;
  return app.db.insertAgent({
    id,
    did,
    status: "active",
    availability: "online",
    last_seen_at: new Date().toISOString(),
    name: overrides.name ?? `Agent ${id.slice(0, 8)}`,
    description: "Test agent for SSE testing",
    endpoint: "https://example.com/x811",
    payment_address: "0xtest123",
    trust_score: 0.5,
    interaction_count: 0,
    successful_count: 0,
    failed_count: 0,
    did_document: JSON.stringify({
      "@context": ["https://www.w3.org/ns/did/v1"],
      id: did,
      verificationMethod: [
        {
          id: `${did}#key-1`,
          type: "Ed25519VerificationKey2020",
          controller: did,
          publicKeyMultibase: "z6Mkf5rGMoatrSj1f4CyvuHBeXJELe9RPdzo2PKGNCKVtZxP",
        },
      ],
      authentication: [`${did}#key-1`],
      keyAgreement: [],
      service: [],
    }),
    agent_card: JSON.stringify({
      name: overrides.name ?? `Agent ${id.slice(0, 8)}`,
      description: "Test",
      url: `https://api.x811.org/api/v1/agents/${id}/card`,
      version: "0.1.0",
      capabilities: [],
    }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/v1/messages/:agentId/stream", () => {
  it("returns 404 for unknown agent", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/messages/${randomUUID()}/stream?did=did:x811:test`,
    });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe("X811-3001");
  });

  it("returns 401 when did query param is missing", async () => {
    const agent = registerTestAgentDirectly();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/messages/${agent.id}/stream`,
    });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.code).toBe("X811-2004");
  });

  it("returns 403 when did does not match agent", async () => {
    const agent = registerTestAgentDirectly();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/messages/${agent.id}/stream?did=did:x811:wrong`,
    });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error.code).toBe("X811-2004");
  });

  it("returns 200 with text/event-stream Content-Type", async () => {
    const agent = registerTestAgentDirectly();

    // reply.hijack() causes inject() to hang, so we start a real server
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const url = `${address}/api/v1/messages/${agent.id}/stream?did=${agent.did}`;

    const controller = new AbortController();
    try {
      const response = await fetch(url, { signal: controller.signal });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "text/event-stream",
      );
    } finally {
      controller.abort();
    }
  });

  it("returns 429 when SSE connection limit exceeded", async () => {
    const agent = registerTestAgentDirectly();

    // Fill up per-agent limit (3 connections)
    for (let i = 0; i < 3; i++) {
      // Subscribe directly to the manager to fill slots
      const { PassThrough } = await import("node:stream");
      const mockRes =
        new PassThrough() as unknown as import("node:http").ServerResponse;
      app.sseManager.subscribe(agent.id, mockRes);
    }

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/messages/${agent.id}/stream?did=${agent.did}`,
    });
    expect(res.statusCode).toBe(429);
    const body = res.json();
    expect(body.error.code).toBe("X811-9001");
  });
});
