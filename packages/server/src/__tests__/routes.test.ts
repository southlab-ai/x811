/**
 * x811 Protocol — Route integration tests.
 *
 * Uses Fastify's inject() method for end-to-end route testing
 * without starting a real HTTP server.
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
  testDir = join(tmpdir(), `x811-route-test-${randomUUID()}`);
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

/**
 * Register a test agent directly in the database (bypasses auth).
 * This is used for tests that need an agent to already exist.
 */
function registerTestAgentDirectly(
  overrides: Partial<{
    id: string;
    name: string;
    did: string;
    status: string;
    availability: string;
  }> = {},
) {
  const id = overrides.id ?? randomUUID();
  const did = overrides.did ?? `did:web:x811.org:agents:${id}`;
  return app.db.insertAgent({
    id,
    did,
    status: overrides.status ?? "active",
    availability: overrides.availability ?? "online",
    last_seen_at: new Date().toISOString(),
    name: overrides.name ?? `Agent ${id.slice(0, 8)}`,
    description: "Test agent for route testing",
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
      x811: {
        did,
        trust_score: 0.5,
        verified_since: new Date().toISOString(),
        interaction_count: 0,
        payment_address: "0xtest123",
        network: "base",
        status: "active",
      },
    }),
  });
}

// ===========================================================================
// Health endpoint
// ===========================================================================

describe("GET /health", () => {
  it("should return health status with correct fields", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ok");
    expect(body.version).toBe("0.1.0");
    expect(body).toHaveProperty("agents_count");
    expect(body).toHaveProperty("batches_count");
    expect(body).toHaveProperty("relayer_balance_eth");
    expect(body).toHaveProperty("pending_interactions");
    expect(body).toHaveProperty("uptime_seconds");
    expect(body.agents_count).toBe(0);
    expect(body.uptime_seconds).toBeGreaterThanOrEqual(0);
  });

  it("should count agents correctly", async () => {
    registerTestAgentDirectly({ name: "Agent 1" });
    registerTestAgentDirectly({ name: "Agent 2" });

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    const body = response.json();
    expect(body.agents_count).toBe(2);
  });
});

// ===========================================================================
// Well-known endpoints
// ===========================================================================

describe("GET /.well-known/did.json", () => {
  it("should return server DID document", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/.well-known/did.json",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toMatch(/^did:web:/);
    expect(body["@context"]).toBeDefined();
    expect(body.verificationMethod).toBeDefined();
    expect(body.service).toBeDefined();
  });
});

// ===========================================================================
// Agent routes
// ===========================================================================

describe("Agent Discovery", () => {
  it("GET /api/v1/agents — should return empty list initially", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/agents",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.agents).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("GET /api/v1/agents — should list registered agents", async () => {
    const agent1 = registerTestAgentDirectly({ name: "FinAnalyst" });
    const agent2 = registerTestAgentDirectly({ name: "Translator" });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/agents",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.agents).toHaveLength(2);
    expect(body.total).toBe(2);
  });

  it("GET /api/v1/agents — should filter by capability", async () => {
    const agent1 = registerTestAgentDirectly({ name: "FinAnalyst" });
    const agent2 = registerTestAgentDirectly({ name: "Translator" });

    app.db.insertCapability({
      agent_id: agent1.id,
      name: "financial-analysis",
      metadata: null,
    });
    app.db.insertCapability({
      agent_id: agent2.id,
      name: "translation",
      metadata: null,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/agents?capability=financial-analysis",
    });

    const body = response.json();
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].name).toBe("FinAnalyst");
  });

  it("GET /api/v1/agents — should filter by trust_min", async () => {
    registerTestAgentDirectly({ name: "HighTrust" });
    registerTestAgentDirectly({ name: "LowTrust" });

    // Set different trust scores
    const agents = app.db.listAgents();
    app.db.updateAgent(agents.agents[0].id, { trust_score: 0.9 });
    app.db.updateAgent(agents.agents[1].id, { trust_score: 0.3 });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/agents?trust_min=0.5",
    });

    const body = response.json();
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].trust_score).toBeGreaterThanOrEqual(0.5);
  });

  it("GET /api/v1/agents — should respect pagination", async () => {
    for (let i = 0; i < 5; i++) {
      registerTestAgentDirectly({ name: `Agent ${i}` });
    }

    const page1 = await app.inject({
      method: "GET",
      url: "/api/v1/agents?limit=2&offset=0",
    });

    const body1 = page1.json();
    expect(body1.agents).toHaveLength(2);
    expect(body1.total).toBe(5);
    expect(body1.limit).toBe(2);
    expect(body1.offset).toBe(0);

    const page2 = await app.inject({
      method: "GET",
      url: "/api/v1/agents?limit=2&offset=2",
    });

    const body2 = page2.json();
    expect(body2.agents).toHaveLength(2);
    expect(body2.agents[0].id).not.toBe(body1.agents[0].id);
  });
});

describe("Agent Details", () => {
  it("GET /api/v1/agents/:id — should return agent details", async () => {
    const agent = registerTestAgentDirectly({ name: "TestAgent" });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${agent.id}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toBe(agent.id);
    expect(body.name).toBe("TestAgent");
    expect(body.did).toBe(agent.did);
    expect(body).toHaveProperty("trust_score");
    expect(body).toHaveProperty("capabilities");
  });

  it("GET /api/v1/agents/:id — should return 404 for non-existent agent", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/agents/non-existent",
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.error.code).toBe("X811-3001");
  });
});

describe("Agent Card", () => {
  it("GET /api/v1/agents/:id/card — should return agent card", async () => {
    const agent = registerTestAgentDirectly({ name: "CardAgent" });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${agent.id}/card`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.name).toBe("CardAgent");
    expect(body.x811).toBeDefined();
    expect(body.x811.did).toBe(agent.did);
    expect(body.x811.trust_score).toBeDefined();
  });

  it("GET /agents/:id/.well-known/agent.json — should return agent card via well-known", async () => {
    const agent = registerTestAgentDirectly({ name: "WellKnownAgent" });

    const response = await app.inject({
      method: "GET",
      url: `/agents/${agent.id}/.well-known/agent.json`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.name).toBe("WellKnownAgent");
  });
});

describe("DID Document", () => {
  it("GET /api/v1/agents/:id/did — should return DID document", async () => {
    const agent = registerTestAgentDirectly();

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${agent.id}/did`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toBe(agent.did);
  });
});

describe("Agent Status", () => {
  it("GET /api/v1/agents/:id/status — should return status and availability", async () => {
    const agent = registerTestAgentDirectly({ availability: "online" });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${agent.id}/status`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("active");
    expect(body.availability).toBe("online");
    expect(body).toHaveProperty("last_seen_at");
  });
});

// ===========================================================================
// Message routes (basic — no auth for tests)
// ===========================================================================

describe("Message Polling", () => {
  it("GET /api/v1/messages/:agentId — should return empty messages", async () => {
    const agent = registerTestAgentDirectly();

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/messages/${agent.id}?did=${agent.did}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.agent_id).toBe(agent.id);
    expect(body.messages).toEqual([]);
    expect(body.count).toBe(0);
  });

  it("GET /api/v1/messages/:agentId — should return stored messages", async () => {
    const sender = registerTestAgentDirectly({ name: "Sender" });
    const receiver = registerTestAgentDirectly({ name: "Receiver" });

    // Insert a message directly
    app.db.insertMessage({
      id: randomUUID(),
      type: "x811/request",
      from_did: sender.did,
      to_did: receiver.did,
      envelope: JSON.stringify({
        version: "0.1.0",
        type: "x811/request",
        from: sender.did,
        to: receiver.did,
        payload: { test: true },
      }),
      created_at: new Date().toISOString(),
      expires_at: null,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/messages/${receiver.id}?did=${receiver.did}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.count).toBe(1);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].type).toBe("x811/request");
  });

  it("GET /api/v1/messages/:agentId — should return 404 for non-existent agent", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/messages/non-existent?did=test",
    });

    expect(response.statusCode).toBe(404);
  });
});

// ===========================================================================
// Verification routes
// ===========================================================================

describe("Verification Routes", () => {
  it("GET /api/v1/verify/:interactionHash — should return 404 for unknown hash", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/verify/unknown-hash-123",
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.error.code).toBe("X811-3001");
  });

  it("GET /api/v1/verify/:interactionHash — should return proof for batched interaction", async () => {
    const agent1 = registerTestAgentDirectly();
    const agent2 = registerTestAgentDirectly();
    const hash = `hash-${randomUUID()}`;

    // Create interaction
    app.db.insertInteraction({
      id: randomUUID(),
      interaction_hash: hash,
      initiator_did: agent1.did,
      provider_did: agent2.did,
      capability: "test",
      status: "completed",
      outcome: "success",
      payment_tx: "0xabc",
      payment_amount: 0.03,
      batch_id: null,
      request_payload: null,
      offer_payload: null,
      result_payload: null,
      idempotency_key: null,
    });

    // Create batch and proof
    const batchId = app.db.insertBatch("root-abc", 1);
    app.db.updateBatchStatus(batchId, "submitted", "0xtxhash");
    app.db.insertMerkleProof(hash, batchId, ["proof1", "proof2"], "leaf-hash");
    app.db.updateInteractionBatch(hash, batchId);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/verify/${hash}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.interaction_hash).toBe(hash);
    expect(body.included).toBe(true);
    expect(body.batch_id).toBe(batchId);
    expect(body.proof).toEqual(["proof1", "proof2"]);
    expect(body.basescan_url).toContain("basescan.org/tx/0xtxhash");
  });

  it("GET /api/v1/verify/:interactionHash — should return unbatched status", async () => {
    const agent1 = registerTestAgentDirectly();
    const agent2 = registerTestAgentDirectly();
    const hash = `hash-${randomUUID()}`;

    app.db.insertInteraction({
      id: randomUUID(),
      interaction_hash: hash,
      initiator_did: agent1.did,
      provider_did: agent2.did,
      capability: "test",
      status: "pending",
      outcome: null,
      payment_tx: null,
      payment_amount: null,
      batch_id: null,
      request_payload: null,
      offer_payload: null,
      result_payload: null,
      idempotency_key: null,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/verify/${hash}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.included).toBe(false);
    expect(body.batch_id).toBeNull();
  });

  it("GET /api/v1/batches — should list batches", async () => {
    app.db.insertBatch("root1", 10);
    app.db.insertBatch("root2", 20);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/batches",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.batches).toHaveLength(2);
    expect(body.total).toBe(2);
  });

  it("GET /api/v1/batches/:id — should return batch details", async () => {
    const batchId = app.db.insertBatch("root-detail", 5);
    app.db.updateBatchStatus(batchId, "submitted", "0xdetail");

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/batches/${batchId}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toBe(batchId);
    expect(body.merkle_root).toBe("root-detail");
    expect(body.interaction_count).toBe(5);
    expect(body.tx_hash).toBe("0xdetail");
    expect(body.basescan_url).toContain("0xdetail");
  });

  it("GET /api/v1/batches/:id — should return 404 for non-existent batch", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/batches/99999",
    });

    expect(response.statusCode).toBe(404);
  });
});

// ===========================================================================
// Full flow integration test
// ===========================================================================

describe("End-to-end agent flow", () => {
  it("should register agent → discover → get card → get DID doc", async () => {
    // Step 1: Register directly (bypassing auth for integration test)
    const agent = registerTestAgentDirectly({ name: "IntegrationAgent" });
    app.db.insertCapability({
      agent_id: agent.id,
      name: "financial-analysis",
      metadata: JSON.stringify({ pricing: { model: "fixed", amount: 0.03, currency: "USDC" } }),
    });

    // Step 2: Discover
    const discoverResponse = await app.inject({
      method: "GET",
      url: "/api/v1/agents?capability=financial-analysis",
    });
    expect(discoverResponse.statusCode).toBe(200);
    const discovered = discoverResponse.json();
    expect(discovered.agents).toHaveLength(1);
    expect(discovered.agents[0].name).toBe("IntegrationAgent");

    // Step 3: Get card
    const cardResponse = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${agent.id}/card`,
    });
    expect(cardResponse.statusCode).toBe(200);
    const card = cardResponse.json();
    expect(card.x811.did).toBe(agent.did);

    // Step 4: Get DID document
    const didResponse = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${agent.id}/did`,
    });
    expect(didResponse.statusCode).toBe(200);
    const didDoc = didResponse.json();
    expect(didDoc.id).toBe(agent.did);
  });
});

describe("Message flow integration", () => {
  it("should store a message and retrieve via polling", async () => {
    const sender = registerTestAgentDirectly({ name: "Sender" });
    const receiver = registerTestAgentDirectly({ name: "Receiver" });

    // Insert a message
    const msgId = randomUUID();
    app.db.insertMessage({
      id: msgId,
      type: "x811/request",
      from_did: sender.did,
      to_did: receiver.did,
      envelope: JSON.stringify({
        version: "0.1.0",
        id: msgId,
        type: "x811/request",
        from: sender.did,
        to: receiver.did,
        created: new Date().toISOString(),
        payload: { task_type: "analysis", parameters: { ticker: "AAPL" } },
        signature: "test",
        nonce: randomUUID(),
      }),
      created_at: new Date().toISOString(),
      expires_at: null,
    });

    // Poll messages
    const pollResponse = await app.inject({
      method: "GET",
      url: `/api/v1/messages/${receiver.id}?did=${receiver.did}`,
    });

    expect(pollResponse.statusCode).toBe(200);
    const pollBody = pollResponse.json();
    expect(pollBody.count).toBe(1);
    expect(pollBody.messages[0].type).toBe("x811/request");

    // Poll again — messages should now be delivered (empty queue)
    const pollResponse2 = await app.inject({
      method: "GET",
      url: `/api/v1/messages/${receiver.id}?did=${receiver.did}`,
    });
    expect(pollResponse2.json().count).toBe(0);
  });
});
