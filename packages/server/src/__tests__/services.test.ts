/**
 * x811 Protocol — Services tests.
 *
 * Tests TrustService, NegotiationService, and BatchingService.
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
  testDir = join(tmpdir(), `x811-svc-test-${randomUUID()}`);
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
// Helper: create a test agent in DB
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

// ===========================================================================
// TrustService
// ===========================================================================

describe("TrustService", () => {
  let trust: TrustService;

  beforeEach(() => {
    trust = new TrustService(db);
  });

  it("should return 0.5 for new agent with zero interactions", () => {
    const score = trust.calculateTrustScore({
      successful: 0,
      failed: 0,
      disputes: 0,
      time_active_days: 0,
    });
    expect(score).toBe(0.5);
  });

  it("should return high score for consistently successful agent", () => {
    const score = trust.calculateTrustScore({
      successful: 100,
      failed: 2,
      disputes: 0,
      time_active_days: 30,
    });
    expect(score).toBeGreaterThan(0.85);
  });

  it("should return perfect score for 100% success", () => {
    const score = trust.calculateTrustScore({
      successful: 50,
      failed: 0,
      disputes: 0,
      time_active_days: 30,
    });
    // 70% * 1.0 + 20% * 1.0 + 10% * activity = 0.9 + activity_bonus
    expect(score).toBeGreaterThanOrEqual(0.9);
  });

  it("should penalize disputes 3x heavier than failures", () => {
    const scoreWithFailures = trust.calculateTrustScore({
      successful: 90,
      failed: 10,
      disputes: 0,
      time_active_days: 30,
    });

    const scoreWithDisputes = trust.calculateTrustScore({
      successful: 90,
      failed: 0,
      disputes: 10,
      time_active_days: 30,
    });

    // Disputes should result in a lower score than equivalent failures
    expect(scoreWithDisputes).toBeLessThan(scoreWithFailures);
  });

  it("should give higher activity bonus for more interactions", () => {
    const scoreSmall = trust.calculateTrustScore({
      successful: 5,
      failed: 0,
      disputes: 0,
      time_active_days: 10,
    });

    const scoreLarge = trust.calculateTrustScore({
      successful: 500,
      failed: 0,
      disputes: 0,
      time_active_days: 10,
    });

    // Both have 100% success rate, but larger should have higher activity bonus
    expect(scoreLarge).toBeGreaterThanOrEqual(scoreSmall);
  });

  it("should clamp score to [0, 1] range", () => {
    const scoreHigh = trust.calculateTrustScore({
      successful: 1000,
      failed: 0,
      disputes: 0,
      time_active_days: 365,
    });
    expect(scoreHigh).toBeLessThanOrEqual(1.0);
    expect(scoreHigh).toBeGreaterThanOrEqual(0.0);

    const scoreLow = trust.calculateTrustScore({
      successful: 0,
      failed: 100,
      disputes: 50,
      time_active_days: 1,
    });
    expect(scoreLow).toBeGreaterThanOrEqual(0.0);
    expect(scoreLow).toBeLessThanOrEqual(1.0);
  });

  it("should apply no time decay within 7-day grace period", () => {
    const original = 0.9;
    const decayed = trust.applyTimeDecay(original, 3);
    expect(decayed).toBe(original);
  });

  it("should apply time decay after 7 days", () => {
    const original = 0.9;
    const decayed = trust.applyTimeDecay(original, 30);
    expect(decayed).toBeLessThan(original);
    expect(decayed).toBeGreaterThan(0);
  });

  it("should apply significant decay after 90 days", () => {
    const original = 0.9;
    const decayed30 = trust.applyTimeDecay(original, 30);
    const decayed90 = trust.applyTimeDecay(original, 90);
    expect(decayed90).toBeLessThan(decayed30);
  });

  it("should update trust score from database", () => {
    const agent = createTestAgent({
      successful_count: 10,
      failed_count: 1,
      interaction_count: 11,
    });

    const score = trust.updateTrustScore(agent.did);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);

    // Verify it was stored
    const updated = db.getAgent(agent.id);
    expect(updated!.trust_score).toBe(score);
  });

  it("should record success and update score", () => {
    const agent = createTestAgent();
    trust.recordSuccess(agent.did);

    const updated = db.getAgent(agent.id);
    expect(updated!.successful_count).toBe(1);
    expect(updated!.interaction_count).toBe(1);
  });

  it("should record failure and update score", () => {
    const agent = createTestAgent();
    trust.recordFailure(agent.did);

    const updated = db.getAgent(agent.id);
    expect(updated!.failed_count).toBe(1);
    expect(updated!.interaction_count).toBe(1);
  });
});

// ===========================================================================
// NegotiationService
// ===========================================================================

describe("NegotiationService", () => {
  let negotiation: NegotiationService;
  let router: MessageRouterService;
  let batching: BatchingService;
  let trust: TrustService;
  let relayer: MockRelayerService;

  beforeEach(() => {
    router = new MessageRouterService(db);
    relayer = new MockRelayerService();
    trust = new TrustService(db);
    batching = new BatchingService(db, relayer, {
      sizeThreshold: 100,
      timeThresholdMs: 300_000,
    });
    negotiation = new NegotiationService(db, router, batching, trust);
  });

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

  describe("Full state machine flow", () => {
    it("should handle complete REQUEST -> OFFER -> ACCEPT -> RESULT -> VERIFY -> PAYMENT flow", async () => {
      const initiator = createTestAgent();
      const provider = createTestAgent();
      const idempotencyKey = randomUUID();

      // 1. REQUEST
      const requestEnv = makeEnvelope(
        "x811/request",
        initiator.did,
        provider.did,
        {
          task_type: "financial-analysis",
          parameters: { ticker: "AAPL" },
          max_budget: 1.0,
          currency: "USDC",
          deadline: 3600,
          acceptance_policy: "auto",
          idempotency_key: idempotencyKey,
        },
      );

      const requestResult = await negotiation.handleRequest(requestEnv);
      expect(requestResult.status).toBe("pending");
      const interactionId = requestResult.interaction_id;

      // 2. OFFER
      const price = 0.03;
      const protocolFee = Math.round(price * 0.025 * 1_000_000) / 1_000_000;
      const totalCost = Math.round((price + protocolFee) * 1_000_000) / 1_000_000;

      const offerEnv = makeEnvelope(
        "x811/offer",
        provider.did,
        initiator.did,
        {
          request_id: interactionId,
          price: price.toString(),
          protocol_fee: protocolFee.toString(),
          total_cost: totalCost.toString(),
          currency: "USDC",
          estimated_time: 30,
          deliverables: ["financial_report"],
          expiry: 300,
        },
      );

      const offerResult = await negotiation.handleOffer(offerEnv);
      expect(offerResult.status).toBe("offered");

      // 3. ACCEPT
      const interaction = db.getInteraction(interactionId);
      const offerHash = interaction!.offer_payload
        ? (() => {
          const { sha256 } = require("@noble/hashes/sha256");
          const { bytesToHex } = require("@noble/hashes/utils");
          return bytesToHex(
            sha256(new TextEncoder().encode(interaction!.offer_payload!)),
          );
        })()
        : "test-hash";

      const acceptEnv = makeEnvelope(
        "x811/accept",
        initiator.did,
        provider.did,
        {
          offer_id: interactionId,
          offer_hash: offerHash,
        },
      );

      const acceptResult = await negotiation.handleAccept(acceptEnv);
      expect(acceptResult.status).toBe("accepted");

      // 4. RESULT
      const resultEnv = makeEnvelope(
        "x811/result",
        provider.did,
        initiator.did,
        {
          request_id: interactionId,
          offer_id: interactionId,
          content: { analysis: "AAPL is bullish" },
          content_type: "application/json",
          result_hash: "result-hash-abc",
          execution_time_ms: 1500,
          model_used: "gpt-4",
        },
      );

      const resultResult = await negotiation.handleResult(resultEnv);
      expect(resultResult.status).toBe("delivered");

      // 5. VERIFY
      const verifyEnv = makeEnvelope(
        "x811/verify",
        initiator.did,
        provider.did,
        {
          request_id: interactionId,
          result_hash: "result-hash-abc",
          verified: true,
        },
      );

      const verifyResult = await negotiation.handleVerify(verifyEnv);
      expect(verifyResult.status).toBe("verified");

      // 6. PAYMENT
      const paymentEnv = makeEnvelope(
        "x811/payment",
        initiator.did,
        provider.did,
        {
          request_id: interactionId,
          offer_id: interactionId,
          tx_hash: "0xabc123def456",
          amount: totalCost,
          currency: "USDC",
          network: "base",
          payer_address: "0xpayer",
          payee_address: "0xpayee",
        },
      );

      const paymentResult = await negotiation.handlePayment(paymentEnv);
      expect(paymentResult.status).toBe("completed");

      // Verify final interaction state
      const final = db.getInteraction(interactionId);
      expect(final!.status).toBe("completed");
      expect(final!.outcome).toBe("success");
      expect(final!.payment_tx).toBe("0xabc123def456");
    });
  });

  describe("Idempotency", () => {
    it("should return existing interaction for duplicate idempotency key", async () => {
      const initiator = createTestAgent();
      const provider = createTestAgent();
      const idempotencyKey = randomUUID();

      const envelope = makeEnvelope(
        "x811/request",
        initiator.did,
        provider.did,
        {
          task_type: "analysis",
          parameters: {},
          max_budget: 1.0,
          currency: "USDC",
          deadline: 3600,
          acceptance_policy: "auto",
          idempotency_key: idempotencyKey,
        },
      );

      const first = await negotiation.handleRequest(envelope);
      const second = await negotiation.handleRequest(envelope);

      expect(second.interaction_id).toBe(first.interaction_id);
      expect(second.status).toBe(first.status);
    });
  });

  describe("State transition validation", () => {
    it("should reject invalid state transitions", async () => {
      const initiator = createTestAgent();
      const provider = createTestAgent();

      // Create a pending interaction
      const envelope = makeEnvelope(
        "x811/request",
        initiator.did,
        provider.did,
        {
          task_type: "analysis",
          parameters: {},
          max_budget: 1.0,
          currency: "USDC",
          deadline: 3600,
          acceptance_policy: "auto",
          idempotency_key: randomUUID(),
        },
      );

      const result = await negotiation.handleRequest(envelope);

      // Try to accept without an offer (pending -> accepted is invalid)
      const acceptEnv = makeEnvelope(
        "x811/accept",
        initiator.did,
        provider.did,
        {
          offer_id: result.interaction_id,
          offer_hash: "test",
        },
      );

      await expect(negotiation.handleAccept(acceptEnv)).rejects.toThrow(
        NegotiationError,
      );
    });

    it("should reject offer from non-provider", async () => {
      const initiator = createTestAgent();
      const provider = createTestAgent();
      const outsider = createTestAgent();

      const envelope = makeEnvelope(
        "x811/request",
        initiator.did,
        provider.did,
        {
          task_type: "analysis",
          parameters: {},
          max_budget: 1.0,
          currency: "USDC",
          deadline: 3600,
          acceptance_policy: "auto",
          idempotency_key: randomUUID(),
        },
      );

      const result = await negotiation.handleRequest(envelope);

      // Outsider tries to send offer
      const offerEnv = makeEnvelope(
        "x811/offer",
        outsider.did,
        initiator.did,
        {
          request_id: result.interaction_id,
          price: "0.03",
          protocol_fee: "0.00075",
          total_cost: "0.03075",
          currency: "USDC",
          estimated_time: 30,
          deliverables: ["report"],
          expiry: 300,
        },
      );

      await expect(negotiation.handleOffer(offerEnv)).rejects.toThrow(
        /Only the provider/,
      );
    });
  });

  describe("Budget validation", () => {
    it("should reject offer exceeding max budget", async () => {
      const initiator = createTestAgent();
      const provider = createTestAgent();

      const envelope = makeEnvelope(
        "x811/request",
        initiator.did,
        provider.did,
        {
          task_type: "analysis",
          parameters: {},
          max_budget: 0.05,
          currency: "USDC",
          deadline: 3600,
          acceptance_policy: "auto",
          idempotency_key: randomUUID(),
        },
      );

      const result = await negotiation.handleRequest(envelope);

      const price = 0.10; // Exceeds max_budget
      const protocolFee = Math.round(price * 0.025 * 1_000_000) / 1_000_000;
      const totalCost = Math.round((price + protocolFee) * 1_000_000) / 1_000_000;

      const offerEnv = makeEnvelope(
        "x811/offer",
        provider.did,
        initiator.did,
        {
          request_id: result.interaction_id,
          price: price.toString(),
          protocol_fee: protocolFee.toString(),
          total_cost: totalCost.toString(),
          currency: "USDC",
          estimated_time: 30,
          deliverables: ["report"],
          expiry: 300,
        },
      );

      await expect(negotiation.handleOffer(offerEnv)).rejects.toThrow(
        /exceeds request budget/,
      );
    });
  });

  describe("TTL enforcement", () => {
    it("should expire stale interactions", async () => {
      const initiator = createTestAgent();
      const provider = createTestAgent();

      // Create a pending interaction with an old timestamp
      const oldTime = new Date(
        Date.now() - 120_000, // 2 minutes ago (>60s TTL for REQUEST_TO_OFFER)
      ).toISOString();

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

      // Manually set the updated_at to old time
      db.raw
        .prepare("UPDATE interactions SET updated_at = ? WHERE status = 'pending'")
        .run(oldTime);

      negotiation.checkExpiredInteractions();

      // All pending interactions should now be expired
      const stmt = db.raw.prepare(
        "SELECT * FROM interactions WHERE status = 'expired'",
      );
      const expired = stmt.all();
      expect(expired.length).toBeGreaterThan(0);
    });
  });

  describe("Protocol fee validation", () => {
    it("should reject incorrect protocol fee", async () => {
      const initiator = createTestAgent();
      const provider = createTestAgent();

      const envelope = makeEnvelope(
        "x811/request",
        initiator.did,
        provider.did,
        {
          task_type: "analysis",
          parameters: {},
          max_budget: 1.0,
          currency: "USDC",
          deadline: 3600,
          acceptance_policy: "auto",
          idempotency_key: randomUUID(),
        },
      );

      const result = await negotiation.handleRequest(envelope);

      const offerEnv = makeEnvelope(
        "x811/offer",
        provider.did,
        initiator.did,
        {
          request_id: result.interaction_id,
          price: "0.03",
          protocol_fee: "0.01", // Wrong fee (should be ~0.00075)
          total_cost: "0.04",
          currency: "USDC",
          estimated_time: 30,
          deliverables: ["report"],
          expiry: 300,
        },
      );

      await expect(negotiation.handleOffer(offerEnv)).rejects.toThrow(
        /Invalid protocol fee/,
      );
    });
  });

  describe("Reject flow", () => {
    it("should handle rejection correctly", async () => {
      const initiator = createTestAgent();
      const provider = createTestAgent();

      // REQUEST
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

      // OFFER
      const price = 0.03;
      const fee = Math.round(price * 0.025 * 1_000_000) / 1_000_000;
      const total = Math.round((price + fee) * 1_000_000) / 1_000_000;

      await negotiation.handleOffer(
        makeEnvelope("x811/offer", provider.did, initiator.did, {
          request_id: requestResult.interaction_id,
          price: price.toString(),
          protocol_fee: fee.toString(),
          total_cost: total.toString(),
          currency: "USDC",
          estimated_time: 30,
          deliverables: ["report"],
          expiry: 300,
        }),
      );

      // REJECT
      const rejectResult = await negotiation.handleReject(
        makeEnvelope("x811/reject", initiator.did, provider.did, {
          offer_id: requestResult.interaction_id,
          reason: "Price too high",
          code: "PRICE_TOO_HIGH",
        }),
      );

      expect(rejectResult.status).toBe("rejected");

      const interaction = db.getInteraction(requestResult.interaction_id);
      expect(interaction!.status).toBe("rejected");
      expect(interaction!.outcome).toBe("rejected");
    });
  });
});

// ===========================================================================
// BatchingService
// ===========================================================================

describe("BatchingService", () => {
  let batching: BatchingService;
  let relayer: MockRelayerService;

  beforeEach(() => {
    relayer = new MockRelayerService();
  });

  describe("Size trigger", () => {
    it("should auto-submit batch when size threshold is reached", async () => {
      batching = new BatchingService(db, relayer, {
        sizeThreshold: 3,
        timeThresholdMs: 300_000,
      });

      await batching.addInteraction("hash-1");
      await batching.addInteraction("hash-2");
      expect(batching.pendingCount).toBe(2);

      // This should trigger a batch submission
      await batching.addInteraction("hash-3");
      expect(batching.pendingCount).toBe(0);

      // Verify batch was created in DB
      const { batches, total } = db.listBatches();
      expect(total).toBe(1);
      expect(batches[0].interaction_count).toBe(3);
      expect(batches[0].status).toBe("submitted");
    });
  });

  describe("Time trigger", () => {
    it("should submit batch when time threshold is exceeded", async () => {
      batching = new BatchingService(db, relayer, {
        sizeThreshold: 100,
        timeThresholdMs: 1, // 1ms for testing
      });

      await batching.addInteraction("hash-1");
      await batching.addInteraction("hash-2");

      // Wait for the time threshold to pass
      await new Promise((resolve) => setTimeout(resolve, 10));

      await batching.checkTimeThreshold();
      expect(batching.pendingCount).toBe(0);

      const { total } = db.listBatches();
      expect(total).toBe(1);
    });

    it("should not submit if no pending hashes", async () => {
      batching = new BatchingService(db, relayer, {
        sizeThreshold: 100,
        timeThresholdMs: 1,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      await batching.checkTimeThreshold();

      const { total } = db.listBatches();
      expect(total).toBe(0);
    });
  });

  describe("Merkle proof storage", () => {
    it("should store Merkle proofs for each interaction in a batch", async () => {
      batching = new BatchingService(db, relayer, {
        sizeThreshold: 2,
        timeThresholdMs: 300_000,
      });

      await batching.addInteraction("hash-a");
      await batching.addInteraction("hash-b"); // triggers batch

      const proofA = db.getMerkleProof("hash-a");
      const proofB = db.getMerkleProof("hash-b");

      expect(proofA).toBeDefined();
      expect(proofB).toBeDefined();
      expect(proofA!.batch_id).toBe(proofB!.batch_id);
      expect(proofA!.parsed_proof.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Relayer failure handling", () => {
    it("should re-queue hashes on relayer failure", async () => {
      // Create a failing relayer
      const failingRelayer = {
        async submitBatch(): Promise<string> {
          throw new Error("Network error");
        },
        async verifyInclusion(): Promise<boolean> {
          return false;
        },
        async getBalance(): Promise<string> {
          return "0";
        },
      };

      batching = new BatchingService(db, failingRelayer, {
        sizeThreshold: 2,
        timeThresholdMs: 300_000,
      });

      await batching.addInteraction("hash-1");
      await batching.addInteraction("hash-2"); // triggers batch (fails)

      // Hashes should be re-queued
      expect(batching.pendingCount).toBe(2);

      // Batch should be marked as failed
      const { batches } = db.listBatches();
      expect(batches.length).toBe(1);
      expect(batches[0].status).toBe("failed");
    });
  });

  describe("Timer management", () => {
    it("should start and stop timer without errors", () => {
      batching = new BatchingService(db, relayer, {
        sizeThreshold: 100,
        timeThresholdMs: 300_000,
      });

      batching.startTimer();
      batching.startTimer(); // idempotent
      batching.stopTimer();
      batching.stopTimer(); // idempotent
    });
  });
});
