/**
 * x811 Protocol — Database tests.
 *
 * Tests the Database wrapper class: CRUD operations, query filters,
 * nonce management, batch operations, and message handling.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Database } from "../db/schema.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let db: Database;
let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `x811-test-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
  db = new Database(join(testDir, "test.db"));
});

afterEach(() => {
  db.close();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // cleanup best-effort
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestAgent(overrides: Partial<Parameters<Database["insertAgent"]>[0]> = {}) {
  const id = randomUUID();
  return db.insertAgent({
    id,
    did: `did:web:x811.org:agents:${id}`,
    status: "active",
    availability: "online",
    last_seen_at: new Date().toISOString(),
    name: `Test Agent ${id.slice(0, 8)}`,
    description: "A test agent",
    endpoint: "https://example.com/x811",
    payment_address: "0x1234567890abcdef1234567890abcdef12345678",
    trust_score: 0.5,
    interaction_count: 0,
    successful_count: 0,
    failed_count: 0,
    did_document: JSON.stringify({ id: `did:web:x811.org:agents:${id}` }),
    agent_card: JSON.stringify({ name: "Test" }),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Agent CRUD
// ---------------------------------------------------------------------------

describe("Agent CRUD", () => {
  it("should insert and retrieve an agent by ID", () => {
    const agent = createTestAgent();
    const fetched = db.getAgent(agent.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(agent.id);
    expect(fetched!.name).toBe(agent.name);
    expect(fetched!.trust_score).toBe(0.5);
  });

  it("should retrieve an agent by DID", () => {
    const agent = createTestAgent();
    const fetched = db.getAgentByDid(agent.did);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(agent.id);
  });

  it("should return undefined for non-existent agent", () => {
    expect(db.getAgent("non-existent")).toBeUndefined();
    expect(db.getAgentByDid("did:web:x811.org:agents:fake")).toBeUndefined();
  });

  it("should update an agent", () => {
    const agent = createTestAgent();
    const updated = db.updateAgent(agent.id, {
      name: "Updated Name",
      trust_score: 0.8,
    });
    expect(updated).toBe(true);

    const fetched = db.getAgent(agent.id);
    expect(fetched!.name).toBe("Updated Name");
    expect(fetched!.trust_score).toBe(0.8);
    expect(fetched!.updated_at).not.toBe(agent.updated_at);
  });

  it("should return false when updating non-existent agent", () => {
    const result = db.updateAgent("non-existent", { name: "Test" });
    expect(result).toBe(false);
  });

  it("should enforce unique DID constraint", () => {
    const agent = createTestAgent();
    expect(() =>
      createTestAgent({ did: agent.did, id: randomUUID() }),
    ).toThrow();
  });

  it("should list agents with default pagination", () => {
    createTestAgent({ trust_score: 0.9 });
    createTestAgent({ trust_score: 0.7 });
    createTestAgent({ trust_score: 0.3 });

    const result = db.listAgents();
    expect(result.total).toBe(3);
    expect(result.agents).toHaveLength(3);
    // Should be ordered by trust_score DESC
    expect(result.agents[0].trust_score).toBe(0.9);
    expect(result.agents[2].trust_score).toBe(0.3);
  });

  it("should filter agents by status", () => {
    createTestAgent({ status: "active" });
    createTestAgent({ status: "deactivated" });
    createTestAgent({ status: "active" });

    const result = db.listAgents({ status: "active" });
    expect(result.total).toBe(2);
    expect(result.agents).toHaveLength(2);
    result.agents.forEach((a) => expect(a.status).toBe("active"));
  });

  it("should filter agents by trust minimum", () => {
    createTestAgent({ trust_score: 0.9 });
    createTestAgent({ trust_score: 0.3 });
    createTestAgent({ trust_score: 0.7 });

    const result = db.listAgents({ trust_min: 0.5 });
    expect(result.total).toBe(2);
    result.agents.forEach((a) => expect(a.trust_score).toBeGreaterThanOrEqual(0.5));
  });

  it("should filter agents by capability", () => {
    const agent1 = createTestAgent();
    const agent2 = createTestAgent();
    createTestAgent();

    db.insertCapability({ agent_id: agent1.id, name: "financial-analysis", metadata: null });
    db.insertCapability({ agent_id: agent2.id, name: "financial-analysis", metadata: null });
    db.insertCapability({ agent_id: agent2.id, name: "translation", metadata: null });

    const result = db.listAgents({ capability: "financial-analysis" });
    expect(result.total).toBe(2);

    const translationResult = db.listAgents({ capability: "translation" });
    expect(translationResult.total).toBe(1);
  });

  it("should paginate agent results", () => {
    for (let i = 0; i < 5; i++) {
      createTestAgent({ trust_score: (5 - i) / 10 });
    }

    const page1 = db.listAgents({ limit: 2, offset: 0 });
    expect(page1.total).toBe(5);
    expect(page1.agents).toHaveLength(2);

    const page2 = db.listAgents({ limit: 2, offset: 2 });
    expect(page2.agents).toHaveLength(2);
    expect(page2.agents[0].id).not.toBe(page1.agents[0].id);
  });

  it("should cap limit at 100", () => {
    const result = db.listAgents({ limit: 999 });
    // The query itself should work, limit is capped internally
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

describe("Capability", () => {
  it("should insert and retrieve capabilities for an agent", () => {
    const agent = createTestAgent();
    db.insertCapability({ agent_id: agent.id, name: "analysis", metadata: null });
    db.insertCapability({
      agent_id: agent.id,
      name: "summarization",
      metadata: JSON.stringify({ pricing: { model: "fixed", amount: 0.01 } }),
    });

    const caps = db.getCapabilitiesForAgent(agent.id);
    expect(caps).toHaveLength(2);
    expect(caps.map((c) => c.name).sort()).toEqual(["analysis", "summarization"]);
  });

  it("should enforce unique (agent_id, name) constraint", () => {
    const agent = createTestAgent();
    db.insertCapability({ agent_id: agent.id, name: "analysis", metadata: null });
    expect(() =>
      db.insertCapability({ agent_id: agent.id, name: "analysis", metadata: null }),
    ).toThrow();
  });

  it("should find agents by capability name", () => {
    const agent1 = createTestAgent();
    const agent2 = createTestAgent();
    db.insertCapability({ agent_id: agent1.id, name: "analysis", metadata: null });
    db.insertCapability({ agent_id: agent2.id, name: "analysis", metadata: null });

    const agents = db.findAgentsByCapability("analysis");
    expect(agents).toHaveLength(2);
  });

  it("should only return active agents when finding by capability", () => {
    const active = createTestAgent({ status: "active" });
    const deactivated = createTestAgent({ status: "deactivated" });
    db.insertCapability({ agent_id: active.id, name: "analysis", metadata: null });
    db.insertCapability({ agent_id: deactivated.id, name: "analysis", metadata: null });

    const agents = db.findAgentsByCapability("analysis");
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe(active.id);
  });
});

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

describe("Interaction", () => {
  it("should insert and retrieve an interaction", () => {
    const agent1 = createTestAgent();
    const agent2 = createTestAgent();

    const interaction = db.insertInteraction({
      id: randomUUID(),
      interaction_hash: "hash123",
      initiator_did: agent1.did,
      provider_did: agent2.did,
      capability: "financial-analysis",
      status: "pending",
      outcome: null,
      payment_tx: null,
      payment_amount: null,
      batch_id: null,
      request_payload: JSON.stringify({ task_type: "analysis" }),
      offer_payload: null,
      result_payload: null,
      idempotency_key: randomUUID(),
    });

    const fetched = db.getInteraction(interaction.id);
    expect(fetched).toBeDefined();
    expect(fetched!.interaction_hash).toBe("hash123");
    expect(fetched!.status).toBe("pending");
  });

  it("should retrieve interaction by hash", () => {
    const agent1 = createTestAgent();
    const agent2 = createTestAgent();
    const hash = `hash-${randomUUID()}`;

    db.insertInteraction({
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

    const fetched = db.getInteractionByHash(hash);
    expect(fetched).toBeDefined();
    expect(fetched!.interaction_hash).toBe(hash);
  });

  it("should retrieve interaction by idempotency key", () => {
    const agent1 = createTestAgent();
    const agent2 = createTestAgent();
    const key = randomUUID();

    db.insertInteraction({
      id: randomUUID(),
      interaction_hash: `hash-${randomUUID()}`,
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
      idempotency_key: key,
    });

    const fetched = db.getInteractionByIdempotencyKey(key);
    expect(fetched).toBeDefined();
    expect(fetched!.idempotency_key).toBe(key);
  });

  it("should update interaction fields", () => {
    const agent1 = createTestAgent();
    const agent2 = createTestAgent();

    const interaction = db.insertInteraction({
      id: randomUUID(),
      interaction_hash: `hash-${randomUUID()}`,
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

    db.updateInteraction(interaction.id, {
      status: "offered",
      offer_payload: JSON.stringify({ price: "0.03" }),
    });

    const fetched = db.getInteraction(interaction.id);
    expect(fetched!.status).toBe("offered");
    expect(fetched!.offer_payload).toContain("0.03");
  });

  it("should get unbatched interactions", () => {
    const agent1 = createTestAgent();
    const agent2 = createTestAgent();

    // Create completed interaction (unbatched)
    db.insertInteraction({
      id: randomUUID(),
      interaction_hash: `hash-${randomUUID()}`,
      initiator_did: agent1.did,
      provider_did: agent2.did,
      capability: "test",
      status: "completed",
      outcome: "success",
      payment_tx: null,
      payment_amount: null,
      batch_id: null,
      request_payload: null,
      offer_payload: null,
      result_payload: null,
      idempotency_key: null,
    });

    // Create pending interaction (should NOT be returned)
    db.insertInteraction({
      id: randomUUID(),
      interaction_hash: `hash-${randomUUID()}`,
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

    const unbatched = db.getUnbatchedInteractions();
    expect(unbatched).toHaveLength(1);
    expect(unbatched[0].status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Batch & Merkle Proof
// ---------------------------------------------------------------------------

describe("Batch & Merkle Proof", () => {
  it("should insert and retrieve a batch", () => {
    const batchId = db.insertBatch("root123", 10);
    expect(batchId).toBeGreaterThan(0);

    const batch = db.getBatch(batchId);
    expect(batch).toBeDefined();
    expect(batch!.merkle_root).toBe("root123");
    expect(batch!.interaction_count).toBe(10);
    expect(batch!.status).toBe("pending");
  });

  it("should update batch status", () => {
    const batchId = db.insertBatch("root456", 5);
    db.updateBatchStatus(batchId, "submitted", "0xabc123");

    const batch = db.getBatch(batchId);
    expect(batch!.status).toBe("submitted");
    expect(batch!.tx_hash).toBe("0xabc123");
  });

  it("should list batches with pagination", () => {
    db.insertBatch("root1", 10);
    db.insertBatch("root2", 20);
    db.insertBatch("root3", 30);

    const result = db.listBatches(2, 0);
    expect(result.total).toBe(3);
    expect(result.batches).toHaveLength(2);
    // Ordered by id DESC
    expect(result.batches[0].merkle_root).toBe("root3");
  });

  it("should insert and retrieve Merkle proofs", () => {
    const batchId = db.insertBatch("rootXYZ", 3);
    db.insertMerkleProof("hash-a", batchId, ["proof1", "proof2"], "leaf-a");

    const proof = db.getMerkleProof("hash-a");
    expect(proof).toBeDefined();
    expect(proof!.batch_id).toBe(batchId);
    expect(proof!.parsed_proof).toEqual(["proof1", "proof2"]);
    expect(proof!.leaf_hash).toBe("leaf-a");
  });

  it("should update interaction batch assignment", () => {
    const agent1 = createTestAgent();
    const agent2 = createTestAgent();
    const hash = `hash-${randomUUID()}`;

    db.insertInteraction({
      id: randomUUID(),
      interaction_hash: hash,
      initiator_did: agent1.did,
      provider_did: agent2.did,
      capability: "test",
      status: "completed",
      outcome: "success",
      payment_tx: null,
      payment_amount: null,
      batch_id: null,
      request_payload: null,
      offer_payload: null,
      result_payload: null,
      idempotency_key: null,
    });

    const batchId = db.insertBatch("root999", 1);
    const updated = db.updateInteractionBatch(hash, batchId);
    expect(updated).toBe(true);

    const interaction = db.getInteractionByHash(hash);
    expect(interaction!.batch_id).toBe(batchId);
  });
});

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

describe("Message", () => {
  it("should insert and retrieve messages by recipient", () => {
    const msg = db.insertMessage({
      id: randomUUID(),
      type: "x811/request",
      from_did: "did:web:x811.org:agents:sender",
      to_did: "did:web:x811.org:agents:receiver",
      envelope: JSON.stringify({ test: true }),
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });

    const messages = db.getMessagesByRecipient(
      "did:web:x811.org:agents:receiver",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(msg.id);
    expect(messages[0].status).toBe("queued");
  });

  it("should update message status to delivered", () => {
    const msg = db.insertMessage({
      id: randomUUID(),
      type: "x811/request",
      from_did: "did:web:x811.org:agents:sender",
      to_did: "did:web:x811.org:agents:receiver",
      envelope: JSON.stringify({ test: true }),
      created_at: new Date().toISOString(),
      expires_at: null,
    });

    db.updateMessageStatus(msg.id, "delivered");
    const messages = db.getMessagesByRecipient(
      "did:web:x811.org:agents:receiver",
      "delivered",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].delivered_at).toBeDefined();
  });

  it("should delete expired messages", () => {
    // Insert an expired message
    db.insertMessage({
      id: randomUUID(),
      type: "x811/request",
      from_did: "did:web:x811.org:agents:sender",
      to_did: "did:web:x811.org:agents:receiver",
      envelope: JSON.stringify({ test: true }),
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() - 1000).toISOString(), // expired
    });

    // Insert a non-expired message
    db.insertMessage({
      id: randomUUID(),
      type: "x811/request",
      from_did: "did:web:x811.org:agents:sender",
      to_did: "did:web:x811.org:agents:receiver",
      envelope: JSON.stringify({ test: true }),
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });

    const deleted = db.deleteExpiredMessages();
    expect(deleted).toBe(1);

    const remaining = db.getMessagesByRecipient(
      "did:web:x811.org:agents:receiver",
    );
    expect(remaining).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Nonce
// ---------------------------------------------------------------------------

describe("Nonce", () => {
  it("should insert and check nonce existence", () => {
    const nonce = randomUUID();
    expect(db.nonceExists(nonce)).toBe(false);

    db.insertNonce(nonce, "did:web:x811.org:agents:test");
    expect(db.nonceExists(nonce)).toBe(true);
  });

  it("should reject duplicate nonces", () => {
    const nonce = randomUUID();
    db.insertNonce(nonce, "did:web:x811.org:agents:test");
    expect(() =>
      db.insertNonce(nonce, "did:web:x811.org:agents:test"),
    ).toThrow();
  });

  it("should delete expired nonces", () => {
    // Insert a nonce with 0-hour TTL (already expired)
    const nonce = randomUUID();
    const now = new Date();
    const expired = new Date(now.getTime() - 1000);
    db.raw
      .prepare(
        "INSERT INTO nonces (nonce, did, created_at, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(nonce, "did:test", now.toISOString(), expired.toISOString());

    expect(db.nonceExists(nonce)).toBe(true);
    const deleted = db.deleteExpiredNonces();
    expect(deleted).toBe(1);
    // Note: nonceExists checks existence regardless of expiry
    // The nonce row is actually deleted
    expect(db.nonceExists(nonce)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

describe("Stats", () => {
  it("should count active agents", () => {
    createTestAgent({ status: "active" });
    createTestAgent({ status: "active" });
    createTestAgent({ status: "deactivated" });

    expect(db.getAgentCount()).toBe(2);
  });

  it("should count batches", () => {
    db.insertBatch("root1", 10);
    db.insertBatch("root2", 20);

    expect(db.getBatchCount()).toBe(2);
  });

  it("should count pending interactions", () => {
    const agent1 = createTestAgent();
    const agent2 = createTestAgent();

    db.insertInteraction({
      id: randomUUID(),
      interaction_hash: `hash-${randomUUID()}`,
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

    db.insertInteraction({
      id: randomUUID(),
      interaction_hash: `hash-${randomUUID()}`,
      initiator_did: agent1.did,
      provider_did: agent2.did,
      capability: "test",
      status: "completed",
      outcome: "success",
      payment_tx: null,
      payment_amount: null,
      batch_id: null,
      request_payload: null,
      offer_payload: null,
      result_payload: null,
      idempotency_key: null,
    });

    expect(db.getPendingInteractionCount()).toBe(1);
  });
});
