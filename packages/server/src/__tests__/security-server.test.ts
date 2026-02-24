/**
 * x811 Protocol -- Security server tests.
 *
 * Tests state machine enforcement, authorization checks, nonce replay
 * protection, TTL enforcement, and offer hash integrity.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Database } from "../db/schema.js";
import { TrustService } from "../services/trust.js";
import { NegotiationService, NegotiationError } from "../services/negotiation.js";
import { BatchingService } from "../services/batching.js";
import { MessageRouterService } from "../services/router.js";
import { MockRelayerService } from "../services/relayer.js";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let db: Database;
let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `x811-sec-test-${randomUUID()}`);
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
    name: `Agent ${id.slice(0, 8)}`,
    description: "Test agent",
    endpoint: "https://example.com",
    payment_address: "0xabc",
    trust_score: 0.5,
    interaction_count: 0,
    successful_count: 0,
    failed_count: 0,
    did_document: JSON.stringify({ id: `did:web:x811.org:agents:${id}` }),
    agent_card: JSON.stringify({ name: "Test" }),
    ...overrides,
  });
}

function makeEnvelope(
  type: string,
  from: string,
  to: string,
  payload: unknown,
) {
  return {
    version: "0.1.0" as const,
    id: randomUUID(),
    type,
    from,
    to,
    created: new Date().toISOString(),
    payload,
    signature: "test-signature",
    nonce: randomUUID(),
  };
}

// ---------------------------------------------------------------------------
// Helper: create services
// ---------------------------------------------------------------------------

function createServices() {
  const router = new MessageRouterService(db);
  const relayer = new MockRelayerService();
  const trust = new TrustService(db);
  const batching = new BatchingService(db, relayer, {
    sizeThreshold: 100,
    timeThresholdMs: 300_000,
  });
  const negotiation = new NegotiationService(db, router, batching, trust);
  return { router, relayer, trust, batching, negotiation };
}

// ---------------------------------------------------------------------------
// Helper: create a pending interaction for state machine tests
// ---------------------------------------------------------------------------

async function createPendingInteraction(negotiation: NegotiationService) {
  const initiator = createTestAgent();
  const provider = createTestAgent();
  const requestResult = await negotiation.handleRequest(
    makeEnvelope("x811/request", initiator.did, provider.did, {
      task_type: "analysis",
      parameters: {},
      max_budget: 1.0,
      currency: "USDC",
      deadline: 3600,
      acceptance_policy: "auto",
      idempotency_key: randomUUID(),
    }),
  );
  return { initiator, provider, interactionId: requestResult.interaction_id };
}

// ---------------------------------------------------------------------------
// Helper: advance an interaction to a specific state
// ---------------------------------------------------------------------------

async function advanceToOffered(negotiation: NegotiationService) {
  const { initiator, provider, interactionId } = await createPendingInteraction(negotiation);
  const price = 0.03;
  const fee = Math.round(price * 0.025 * 1_000_000) / 1_000_000;
  const total = Math.round((price + fee) * 1_000_000) / 1_000_000;

  await negotiation.handleOffer(
    makeEnvelope("x811/offer", provider.did, initiator.did, {
      request_id: interactionId,
      price: price.toString(),
      protocol_fee: fee.toString(),
      total_cost: total.toString(),
      currency: "USDC",
      estimated_time: 30,
      deliverables: ["report"],
      expiry: 300,
    }),
  );
  return { initiator, provider, interactionId };
}

// ===========================================================================
// Security Tests
// ===========================================================================

describe("Security — State Machine Enforcement", () => {
  let negotiation: NegotiationService;

  beforeEach(() => {
    ({ negotiation } = createServices());
  });

  it("should reject ACCEPT when state is pending (skip OFFER)", async () => {
    const { initiator, provider, interactionId } = await createPendingInteraction(negotiation);

    const acceptEnv = makeEnvelope("x811/accept", initiator.did, provider.did, {
      offer_id: interactionId,
      offer_hash: "test-hash",
    });

    await expect(negotiation.handleAccept(acceptEnv)).rejects.toThrow(NegotiationError);
  });

  it("should reject RESULT when state is pending", async () => {
    const { initiator, provider, interactionId } = await createPendingInteraction(negotiation);

    const resultEnv = makeEnvelope("x811/result", provider.did, initiator.did, {
      request_id: interactionId,
      offer_id: interactionId,
      content: { data: "test" },
      content_type: "application/json",
      result_hash: "result-hash",
      execution_time_ms: 100,
    });

    // handleResult looks for status = "accepted", so it should fail to find the interaction
    // in "pending" state and throw
    await expect(negotiation.handleResult(resultEnv)).rejects.toThrow();
  });

  it("should reject PAYMENT when state is pending", async () => {
    const { initiator, provider, interactionId } = await createPendingInteraction(negotiation);

    const paymentEnv = makeEnvelope("x811/payment", initiator.did, provider.did, {
      request_id: interactionId,
      offer_id: interactionId,
      tx_hash: "0xabc",
      amount: 0.03,
      currency: "USDC",
      network: "base",
      payer_address: "0xpayer",
      payee_address: "0xpayee",
    });

    // handlePayment looks for status = "verified", won't find it for "pending"
    await expect(negotiation.handlePayment(paymentEnv)).rejects.toThrow();
  });

  it("should reject VERIFY when state is offered (skip ACCEPT+RESULT)", async () => {
    const { initiator, provider, interactionId } = await advanceToOffered(negotiation);

    const verifyEnv = makeEnvelope("x811/verify", initiator.did, provider.did, {
      request_id: interactionId,
      result_hash: "some-hash",
      verified: true,
    });

    // handleVerify looks for status = "delivered", won't find it for "offered"
    await expect(negotiation.handleVerify(verifyEnv)).rejects.toThrow();
  });

  it("should reject messages on completed (terminal) state", async () => {
    const initiator = createTestAgent();
    const provider = createTestAgent();

    // Manually insert a completed interaction
    const interactionId = randomUUID();
    db.insertInteraction({
      id: interactionId,
      interaction_hash: `hash-${randomUUID()}`,
      initiator_did: initiator.did,
      provider_did: provider.did,
      capability: "test",
      status: "completed",
      outcome: "success",
      payment_tx: "0xfinal",
      payment_amount: 0.03,
      batch_id: null,
      request_payload: JSON.stringify({ task_type: "test", idempotency_key: randomUUID() }),
      offer_payload: JSON.stringify({
        request_id: interactionId,
        price: "0.03",
        protocol_fee: "0.00075",
        total_cost: "0.03075",
        currency: "USDC",
        estimated_time: 30,
        deliverables: ["report"],
        expiry: 300,
      }),
      result_payload: null,
      idempotency_key: randomUUID(),
    });

    // Try to send an offer on the completed interaction
    const offerEnv = makeEnvelope("x811/offer", provider.did, initiator.did, {
      request_id: interactionId,
      price: "0.03",
      protocol_fee: "0.00075",
      total_cost: "0.03075",
      currency: "USDC",
      estimated_time: 30,
      deliverables: ["report"],
      expiry: 300,
    });

    await expect(negotiation.handleOffer(offerEnv)).rejects.toThrow(NegotiationError);
  });

  it("should reject messages on expired (terminal) state", async () => {
    const initiator = createTestAgent();
    const provider = createTestAgent();

    const interactionId = randomUUID();
    db.insertInteraction({
      id: interactionId,
      interaction_hash: `hash-${randomUUID()}`,
      initiator_did: initiator.did,
      provider_did: provider.did,
      capability: "test",
      status: "expired",
      outcome: "timeout",
      payment_tx: null,
      payment_amount: null,
      batch_id: null,
      request_payload: JSON.stringify({ task_type: "test", idempotency_key: randomUUID() }),
      offer_payload: null,
      result_payload: null,
      idempotency_key: randomUUID(),
    });

    const offerEnv = makeEnvelope("x811/offer", provider.did, initiator.did, {
      request_id: interactionId,
      price: "0.03",
      protocol_fee: "0.00075",
      total_cost: "0.03075",
      currency: "USDC",
      estimated_time: 30,
      deliverables: ["report"],
      expiry: 300,
    });

    await expect(negotiation.handleOffer(offerEnv)).rejects.toThrow(NegotiationError);
  });

  it("should reject messages on rejected (terminal) state", async () => {
    const initiator = createTestAgent();
    const provider = createTestAgent();

    const interactionId = randomUUID();
    db.insertInteraction({
      id: interactionId,
      interaction_hash: `hash-${randomUUID()}`,
      initiator_did: initiator.did,
      provider_did: provider.did,
      capability: "test",
      status: "rejected",
      outcome: "rejected",
      payment_tx: null,
      payment_amount: null,
      batch_id: null,
      request_payload: JSON.stringify({ task_type: "test", idempotency_key: randomUUID() }),
      offer_payload: null,
      result_payload: null,
      idempotency_key: randomUUID(),
    });

    const acceptEnv = makeEnvelope("x811/accept", initiator.did, provider.did, {
      offer_id: interactionId,
      offer_hash: "test-hash",
    });

    await expect(negotiation.handleAccept(acceptEnv)).rejects.toThrow(NegotiationError);
  });
});

describe("Security — Authorization Enforcement", () => {
  let negotiation: NegotiationService;

  beforeEach(() => {
    ({ negotiation } = createServices());
  });

  it("should reject ACCEPT from non-initiator", async () => {
    const { provider, interactionId } = await advanceToOffered(negotiation);
    const outsider = createTestAgent();

    const acceptEnv = makeEnvelope("x811/accept", outsider.did, provider.did, {
      offer_id: interactionId,
      offer_hash: "test-hash",
    });

    await expect(negotiation.handleAccept(acceptEnv)).rejects.toThrow(
      /Only the initiator/,
    );
  });

  it("should reject OFFER from non-provider", async () => {
    const { initiator, interactionId } = await createPendingInteraction(negotiation);
    const outsider = createTestAgent();

    const offerEnv = makeEnvelope("x811/offer", outsider.did, initiator.did, {
      request_id: interactionId,
      price: "0.03",
      protocol_fee: "0.00075",
      total_cost: "0.03075",
      currency: "USDC",
      estimated_time: 30,
      deliverables: ["report"],
      expiry: 300,
    });

    await expect(negotiation.handleOffer(offerEnv)).rejects.toThrow(
      /Only the provider/,
    );
  });

  it("should reject RESULT from non-provider", async () => {
    // Advance to accepted state first
    const { initiator, provider, interactionId } = await advanceToOffered(negotiation);

    // Compute offer hash for acceptance
    const interaction = db.getInteraction(interactionId);
    const { sha256 } = await import("@noble/hashes/sha256");
    const { bytesToHex } = await import("@noble/hashes/utils");
    const offerHash = bytesToHex(
      sha256(new TextEncoder().encode(interaction!.offer_payload!)),
    );

    await negotiation.handleAccept(
      makeEnvelope("x811/accept", initiator.did, provider.did, {
        offer_id: interactionId,
        offer_hash: offerHash,
      }),
    );

    // Now try to deliver result as an outsider
    const outsider = createTestAgent();
    const resultEnv = makeEnvelope("x811/result", outsider.did, initiator.did, {
      request_id: interactionId,
      offer_id: interactionId,
      content: { data: "fake" },
      content_type: "application/json",
      result_hash: "fake-hash",
      execution_time_ms: 100,
    });

    await expect(negotiation.handleResult(resultEnv)).rejects.toThrow(
      /Only the provider/,
    );
  });

  it("should reject PAYMENT from non-initiator", async () => {
    // We need to get to "verified" state.
    // Create a full flow up to verified.
    const { initiator, provider, interactionId } = await advanceToOffered(negotiation);

    const interaction = db.getInteraction(interactionId);
    const { sha256 } = await import("@noble/hashes/sha256");
    const { bytesToHex } = await import("@noble/hashes/utils");
    const offerHash = bytesToHex(
      sha256(new TextEncoder().encode(interaction!.offer_payload!)),
    );

    await negotiation.handleAccept(
      makeEnvelope("x811/accept", initiator.did, provider.did, {
        offer_id: interactionId,
        offer_hash: offerHash,
      }),
    );

    await negotiation.handleResult(
      makeEnvelope("x811/result", provider.did, initiator.did, {
        request_id: interactionId,
        offer_id: interactionId,
        content: { analysis: "bullish" },
        content_type: "application/json",
        result_hash: "result-hash-abc",
        execution_time_ms: 1500,
      }),
    );

    await negotiation.handleVerify(
      makeEnvelope("x811/verify", initiator.did, provider.did, {
        request_id: interactionId,
        result_hash: "result-hash-abc",
        verified: true,
      }),
    );

    // Now try to pay as an outsider
    const outsider = createTestAgent();
    const paymentEnv = makeEnvelope("x811/payment", outsider.did, provider.did, {
      request_id: interactionId,
      offer_id: interactionId,
      tx_hash: "0xfraud",
      amount: 0.03075,
      currency: "USDC",
      network: "base",
      payer_address: "0xfraud",
      payee_address: "0xpayee",
    });

    await expect(negotiation.handlePayment(paymentEnv)).rejects.toThrow(
      /Only the initiator/,
    );
  });
});

describe("Security — Nonce Replay Protection", () => {
  it("should accept first nonce insertion", () => {
    const nonce = randomUUID();
    expect(() => db.insertNonce(nonce, "did:test:1")).not.toThrow();
    expect(db.nonceExists(nonce)).toBe(true);
  });

  it("should reject second insertion of the same nonce (UNIQUE constraint)", () => {
    const nonce = randomUUID();
    db.insertNonce(nonce, "did:test:1");
    expect(() => db.insertNonce(nonce, "did:test:1")).toThrow();
  });
});

describe("Security — TTL Enforcement", () => {
  let negotiation: NegotiationService;

  beforeEach(() => {
    ({ negotiation } = createServices());
  });

  it("should expire pending interaction older than 60s", async () => {
    const initiator = createTestAgent();
    const provider = createTestAgent();

    const oldTime = new Date(Date.now() - 120_000).toISOString(); // 2 minutes ago

    db.insertInteraction({
      id: randomUUID(),
      interaction_hash: `hash-${randomUUID()}`,
      initiator_did: initiator.did,
      provider_did: provider.did,
      capability: "test",
      status: "pending",
      outcome: null,
      payment_tx: null,
      payment_amount: null,
      batch_id: null,
      request_payload: JSON.stringify({ task_type: "test", idempotency_key: randomUUID() }),
      offer_payload: null,
      result_payload: null,
      idempotency_key: randomUUID(),
    });

    // Backdate the updated_at to trigger TTL
    db.raw
      .prepare("UPDATE interactions SET updated_at = ? WHERE status = 'pending'")
      .run(oldTime);

    negotiation.checkExpiredInteractions();

    const expired = db.raw
      .prepare("SELECT * FROM interactions WHERE status = 'expired'")
      .all();
    expect(expired.length).toBeGreaterThan(0);
  });

  it("should NOT expire pending interaction within 60s", async () => {
    const initiator = createTestAgent();
    const provider = createTestAgent();

    const interactionId = randomUUID();
    db.insertInteraction({
      id: interactionId,
      interaction_hash: `hash-${randomUUID()}`,
      initiator_did: initiator.did,
      provider_did: provider.did,
      capability: "test",
      status: "pending",
      outcome: null,
      payment_tx: null,
      payment_amount: null,
      batch_id: null,
      request_payload: JSON.stringify({ task_type: "test", idempotency_key: randomUUID() }),
      offer_payload: null,
      result_payload: null,
      idempotency_key: randomUUID(),
    });

    // Do NOT backdate — it was just created
    negotiation.checkExpiredInteractions();

    const interaction = db.getInteraction(interactionId);
    expect(interaction!.status).toBe("pending");
  });
});

describe("Security — Offer Hash Integrity", () => {
  let negotiation: NegotiationService;

  beforeEach(() => {
    ({ negotiation } = createServices());
  });

  it("should reject ACCEPT with incorrect offer_hash", async () => {
    const { initiator, provider, interactionId } = await advanceToOffered(negotiation);

    const acceptEnv = makeEnvelope("x811/accept", initiator.did, provider.did, {
      offer_id: interactionId,
      offer_hash: "wrong-hash-definitely-not-correct",
    });

    await expect(negotiation.handleAccept(acceptEnv)).rejects.toThrow(
      /Offer hash mismatch/,
    );
  });

  it("should accept ACCEPT with correct offer_hash", async () => {
    const { initiator, provider, interactionId } = await advanceToOffered(negotiation);

    // Compute the correct offer hash
    const interaction = db.getInteraction(interactionId);
    const { sha256 } = await import("@noble/hashes/sha256");
    const { bytesToHex } = await import("@noble/hashes/utils");
    const correctHash = bytesToHex(
      sha256(new TextEncoder().encode(interaction!.offer_payload!)),
    );

    const acceptEnv = makeEnvelope("x811/accept", initiator.did, provider.did, {
      offer_id: interactionId,
      offer_hash: correctHash,
    });

    const result = await negotiation.handleAccept(acceptEnv);
    expect(result.status).toBe("accepted");
  });
});
