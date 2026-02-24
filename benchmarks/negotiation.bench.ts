/**
 * x811 Protocol -- Server-side negotiation benchmarks.
 *
 * Benchmarks trust score calculation, time decay, full negotiation
 * cycle, and individual DB operations.
 */

import { bench, describe, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Database } from "../packages/server/src/db/schema.js";
import { TrustService } from "../packages/server/src/services/trust.js";
import { NegotiationService } from "../packages/server/src/services/negotiation.js";
import { BatchingService } from "../packages/server/src/services/batching.js";
import { MessageRouterService } from "../packages/server/src/services/router.js";
import { MockRelayerService } from "../packages/server/src/services/relayer.js";

// ---------------------------------------------------------------------------
// Shared state for benchmarks
// ---------------------------------------------------------------------------

let db: Database;
let trust: TrustService;
let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `x811-bench-neg-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
  db = new Database(join(testDir, "bench.db"));
  trust = new TrustService(db);
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

function createTestAgent(database: Database) {
  const id = randomUUID();
  return database.insertAgent({
    id,
    did: `did:web:x811.org:agents:${id}`,
    status: "active",
    availability: "online",
    last_seen_at: new Date().toISOString(),
    name: `Agent ${id.slice(0, 8)}`,
    description: "Bench agent",
    endpoint: "https://example.com",
    payment_address: "0xabc",
    trust_score: 0.5,
    interaction_count: 0,
    successful_count: 0,
    failed_count: 0,
    did_document: JSON.stringify({ id: `did:web:x811.org:agents:${id}` }),
    agent_card: JSON.stringify({ name: "Bench" }),
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
    signature: "bench-signature",
    nonce: randomUUID(),
  };
}

// ---------------------------------------------------------------------------
// Trust Score Benchmarks
// ---------------------------------------------------------------------------

describe("Trust Score Calculation", () => {
  bench("Calculate trust score (100s/5f/2d)", () => {
    trust.calculateTrustScore({
      successful: 100,
      failed: 5,
      disputes: 2,
      time_active_days: 30,
    });
  });

  bench("Apply time decay (0.85, 45 days)", () => {
    trust.applyTimeDecay(0.85, 45);
  });
});

// ---------------------------------------------------------------------------
// Full Negotiation Cycle
// ---------------------------------------------------------------------------

describe("Full Negotiation Cycle", () => {
  bench(
    "Complete REQUEST->OFFER->ACCEPT->RESULT->VERIFY->PAYMENT flow",
    async () => {
      // Fresh services each iteration (db is shared from beforeEach)
      const router = new MessageRouterService(db);
      const relayer = new MockRelayerService();
      const localTrust = new TrustService(db);
      const batching = new BatchingService(db, relayer, {
        sizeThreshold: 1000,
        timeThresholdMs: 300_000,
      });
      const negotiation = new NegotiationService(db, router, batching, localTrust);

      const initiator = createTestAgent(db);
      const provider = createTestAgent(db);
      const idempotencyKey = randomUUID();

      // 1. REQUEST
      const reqResult = await negotiation.handleRequest(
        makeEnvelope("x811/request", initiator.did, provider.did, {
          task_type: "benchmark",
          parameters: {},
          max_budget: 1.0,
          currency: "USDC",
          deadline: 3600,
          acceptance_policy: "auto",
          idempotency_key: idempotencyKey,
        }),
      );
      const interactionId = reqResult.interaction_id;

      // 2. OFFER
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

      // 3. ACCEPT (compute offer hash)
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

      // 4. RESULT
      await negotiation.handleResult(
        makeEnvelope("x811/result", provider.did, initiator.did, {
          request_id: interactionId,
          offer_id: interactionId,
          content: { data: "bench" },
          content_type: "application/json",
          result_hash: "bench-hash",
          execution_time_ms: 100,
        }),
      );

      // 5. VERIFY
      await negotiation.handleVerify(
        makeEnvelope("x811/verify", initiator.did, provider.did, {
          request_id: interactionId,
          result_hash: "bench-hash",
          verified: true,
        }),
      );

      // 6. PAYMENT
      await negotiation.handlePayment(
        makeEnvelope("x811/payment", initiator.did, provider.did, {
          request_id: interactionId,
          offer_id: interactionId,
          tx_hash: `0xbench${randomUUID().replace(/-/g, "")}`,
          amount: total,
          currency: "USDC",
          network: "base",
          payer_address: "0xpayer",
          payee_address: "0xpayee",
        }),
      );
    },
    { iterations: 50 },
  );
});

// ---------------------------------------------------------------------------
// Individual Operations
// ---------------------------------------------------------------------------

describe("Individual Operations", () => {
  bench("Handle REQUEST message", async () => {
    const router = new MessageRouterService(db);
    const relayer = new MockRelayerService();
    const localTrust = new TrustService(db);
    const batching = new BatchingService(db, relayer, {
      sizeThreshold: 1000,
      timeThresholdMs: 300_000,
    });
    const negotiation = new NegotiationService(db, router, batching, localTrust);

    const initiator = createTestAgent(db);
    const provider = createTestAgent(db);

    await negotiation.handleRequest(
      makeEnvelope("x811/request", initiator.did, provider.did, {
        task_type: "bench",
        parameters: {},
        max_budget: 1.0,
        currency: "USDC",
        deadline: 3600,
        acceptance_policy: "auto",
        idempotency_key: randomUUID(),
      }),
    );
  });

  bench("Insert agent to DB", () => {
    createTestAgent(db);
  });

  bench("Insert interaction to DB", () => {
    const id = randomUUID();
    db.insertInteraction({
      id,
      interaction_hash: `hash-${id}`,
      initiator_did: "did:web:x811.org:agents:bench-init",
      provider_did: "did:web:x811.org:agents:bench-prov",
      capability: "benchmark",
      status: "pending",
      outcome: null,
      payment_tx: null,
      payment_amount: null,
      batch_id: null,
      request_payload: JSON.stringify({ task_type: "bench", idempotency_key: id }),
      offer_payload: null,
      result_payload: null,
      idempotency_key: id,
    });
  });
});
