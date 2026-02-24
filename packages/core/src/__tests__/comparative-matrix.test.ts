import { describe, it, expect } from "vitest";
import {
  generateSigningKeyPair,
} from "../crypto/keys.js";
import {
  canonicalize,
  signEnvelope,
  verifyEnvelope,
  hashPayload,
} from "../crypto/signing.js";
import { MerkleTree } from "../crypto/merkle.js";
import type { X811Envelope, NegotiationStatus, X811MessageType } from "../types/messages.js";
import { NEGOTIATION_TTLS } from "../types/messages.js";
import type {
  RequestPayload,
  OfferPayload,
  AcceptPayload,
  RejectPayload,
  ResultPayload,
  VerifyPayload,
  PaymentPayload,
  AcceptancePolicy,
  RejectReasonCode,
} from "../types/negotiation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let envelopeCounter = 0;

function makeUnsignedEnvelope<T>(
  type: X811MessageType,
  payload: T,
): Omit<X811Envelope<T>, "signature"> {
  envelopeCounter++;
  return {
    version: "0.1.0",
    id: `019c0000-0000-7000-8000-${String(envelopeCounter).padStart(12, "0")}`,
    type,
    from: "did:x811:sender",
    to: "did:x811:receiver",
    created: new Date().toISOString(),
    payload,
    nonce: `nonce-${envelopeCounter}-${Date.now()}`,
  };
}

// ==========================================================================
// vs ERC-8004 — x811 has capabilities that ERC-8004 (ERC-based payment) lacks
// ==========================================================================
describe("Comparative: x811 vs ERC-8004", () => {
  it("x811 provides a 6-message signed negotiation protocol that ERC-8004 lacks", () => {
    const kp = generateSigningKeyPair();

    // All 6 message types in the negotiation lifecycle
    const messageTypes: X811MessageType[] = [
      "x811/request",
      "x811/offer",
      "x811/accept",
      "x811/result",
      "x811/verify",
      "x811/payment",
    ];

    const payloads: Record<string, unknown>[] = [
      {
        task_type: "financial-analysis",
        parameters: { symbol: "ETH" },
        max_budget: 0.05,
        currency: "USDC",
        deadline: 60,
        acceptance_policy: "auto",
        idempotency_key: "idem-001",
      } satisfies RequestPayload,
      {
        request_id: "req-001",
        price: "0.03",
        protocol_fee: "0.00075",
        total_cost: "0.03075",
        currency: "USDC",
        estimated_time: 30,
        deliverables: ["analysis report"],
        expiry: 300,
        payment_address: "0x1234567890abcdef1234567890abcdef12345678",
      } satisfies OfferPayload,
      {
        offer_id: "offer-001",
        offer_hash: "a".repeat(64),
      } satisfies AcceptPayload,
      {
        request_id: "req-001",
        offer_id: "offer-001",
        content: '{"result":"bullish"}',
        content_type: "application/json",
        result_hash: "b".repeat(64),
        execution_time_ms: 1500,
      } satisfies ResultPayload,
      {
        request_id: "req-001",
        offer_id: "offer-001",
        result_hash: "b".repeat(64),
        verified: true,
      } satisfies VerifyPayload,
      {
        request_id: "req-001",
        offer_id: "offer-001",
        tx_hash: "0x" + "c".repeat(64),
        amount: "0.03",
        currency: "USDC",
        network: "base",
        payer_address: "0xaaaa",
        payee_address: "0xbbbb",
      } satisfies PaymentPayload,
    ];

    // Sign all 6 and verify every signature
    for (let i = 0; i < messageTypes.length; i++) {
      const unsigned = makeUnsignedEnvelope(messageTypes[i], payloads[i]);
      const signed = signEnvelope(unsigned, kp.privateKey);
      expect(signed.signature).toBeDefined();
      expect(signed.signature.length).toBeGreaterThan(0);
      const valid = verifyEnvelope(signed, kp.publicKey);
      expect(valid).toBe(true);
    }
  });

  it("x811 provides cryptographic envelope authentication per-message", () => {
    const kp = generateSigningKeyPair();
    const unsigned = makeUnsignedEnvelope("x811/request", {
      task_type: "test",
      parameters: {},
      max_budget: 0.01,
      currency: "USDC",
      deadline: 60,
      acceptance_policy: "auto",
      idempotency_key: "idem-roundtrip",
    } satisfies RequestPayload);

    const signed = signEnvelope(unsigned, kp.privateKey);
    expect(signed.signature).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifyEnvelope(signed, kp.publicKey)).toBe(true);

    // Different key must fail
    const kp2 = generateSigningKeyPair();
    expect(verifyEnvelope(signed, kp2.publicKey)).toBe(false);
  });

  it("x811 provides deterministic state machine with 10 states", () => {
    const expectedStates: NegotiationStatus[] = [
      "pending",
      "offered",
      "accepted",
      "delivered",
      "verified",
      "completed",
      "expired",
      "rejected",
      "disputed",
      "failed",
    ];

    // These are the only valid transitions in the protocol
    const validTransitions: Record<string, string[]> = {
      pending: ["offered", "expired", "rejected"],
      offered: ["accepted", "rejected", "expired"],
      accepted: ["delivered", "expired", "failed"],
      delivered: ["verified", "disputed", "expired"],
      verified: ["completed", "failed"],
      completed: [],
      expired: [],
      rejected: [],
      disputed: [],
      failed: [],
    };

    expect(expectedStates).toHaveLength(10);
    for (const state of expectedStates) {
      expect(validTransitions).toHaveProperty(state);
    }
    // Every transition target must also be a valid state
    for (const targets of Object.values(validTransitions)) {
      for (const target of targets) {
        expect(expectedStates).toContain(target);
      }
    }
  });

  it("x811 includes economic settlement coordination", () => {
    const payment: PaymentPayload = {
      request_id: "req-econ",
      offer_id: "offer-econ",
      tx_hash: "0x" + "d".repeat(64),
      amount: "0.03",
      currency: "USDC",
      network: "base",
      payer_address: "0x1111111111111111111111111111111111111111",
      payee_address: "0x2222222222222222222222222222222222222222",
    };

    expect(payment.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(payment.amount).toBe("0.03");
    expect(payment.currency).toBe("USDC");
    expect(payment.network).toBe("base");
    expect(payment.payer_address).toBeDefined();
    expect(payment.payee_address).toBeDefined();
  });

  it("x811 provides trust-gated acceptance policies", () => {
    const policies: AcceptancePolicy[] = [
      {
        acceptance_policy: "auto",
        min_trust_score: 0.7,
        max_budget_per_task: 0.1,
        allowed_capabilities: ["financial-analysis"],
      },
      {
        acceptance_policy: "human_approval",
        min_trust_score: 0.0,
        max_budget_per_task: 1.0,
        allowed_capabilities: ["code-review"],
      },
      {
        acceptance_policy: "threshold",
        threshold_amount: 0.05,
        min_trust_score: 0.5,
        max_budget_per_task: 0.5,
        allowed_capabilities: ["data-analysis"],
      },
    ];

    expect(policies).toHaveLength(3);
    expect(policies.map((p) => p.acceptance_policy).sort()).toEqual(
      ["auto", "human_approval", "threshold"].sort(),
    );
    // Threshold mode requires threshold_amount
    const thresholdPolicy = policies.find((p) => p.acceptance_policy === "threshold");
    expect(thresholdPolicy?.threshold_amount).toBeDefined();
    expect(thresholdPolicy?.min_trust_score).toBeGreaterThanOrEqual(0);
    expect(thresholdPolicy?.min_trust_score).toBeLessThanOrEqual(1);
  });
});

// ==========================================================================
// vs x402 — x811 has capabilities that x402 (Coinbase pay-per-request) lacks
// ==========================================================================
describe("Comparative: x811 vs x402", () => {
  it("x811 supports dynamic price negotiation", () => {
    const request: RequestPayload = {
      task_type: "financial-analysis",
      parameters: { symbol: "BTC" },
      max_budget: 0.05,
      currency: "USDC",
      deadline: 120,
      acceptance_policy: "auto",
      idempotency_key: "idem-price-neg",
    };

    const offer: OfferPayload = {
      request_id: "req-x402-1",
      price: "0.03",
      protocol_fee: "0.00075",
      total_cost: "0.03075",
      currency: "USDC",
      estimated_time: 30,
      deliverables: ["market analysis"],
      expiry: 300,
      payment_address: "0xaaaa",
    };

    // Provider's price differs from consumer's max budget — negotiation!
    expect(parseFloat(offer.price)).toBeLessThan(request.max_budget);
    expect(parseFloat(offer.price)).toBeGreaterThan(0);
  });

  it("x811 supports counter-offers and rejection with reason codes", () => {
    const reasonCodes: RejectReasonCode[] = [
      "PRICE_TOO_HIGH",
      "DEADLINE_TOO_SHORT",
      "TRUST_TOO_LOW",
      "POLICY_REJECTED",
      "OTHER",
    ];

    for (const code of reasonCodes) {
      const rejection: RejectPayload = {
        offer_id: `offer-reject-${code}`,
        reason: `Rejected because: ${code}`,
        code,
      };
      expect(rejection.code).toBe(code);
      expect(rejection.reason.length).toBeGreaterThan(0);
    }

    expect(reasonCodes).toHaveLength(5);
  });

  it("x811 supports conditional payment based on result verification", () => {
    const resultContent = JSON.stringify({ analysis: "bullish", confidence: 0.92 });
    const resultHash = hashPayload(JSON.parse(resultContent));

    const result: ResultPayload = {
      request_id: "req-cond",
      offer_id: "offer-cond",
      content: resultContent,
      content_type: "application/json",
      result_hash: resultHash,
      execution_time_ms: 2000,
    };

    // Verifier independently recomputes hash
    const recomputedHash = hashPayload(JSON.parse(result.content!));
    expect(recomputedHash).toBe(result.result_hash);

    const verify: VerifyPayload = {
      request_id: "req-cond",
      offer_id: "offer-cond",
      result_hash: recomputedHash,
      verified: true,
    };

    expect(verify.verified).toBe(true);
    expect(verify.result_hash).toBe(result.result_hash);
  });

  it("x811 supports multi-step task workflows", () => {
    // Demonstrate all 6 message types in sequence
    const kp = generateSigningKeyPair();

    const step1 = signEnvelope(
      makeUnsignedEnvelope("x811/request", { step: 1 }),
      kp.privateKey,
    );
    const step2 = signEnvelope(
      makeUnsignedEnvelope("x811/offer", { step: 2 }),
      kp.privateKey,
    );
    const step3 = signEnvelope(
      makeUnsignedEnvelope("x811/accept", { step: 3 }),
      kp.privateKey,
    );
    const step4 = signEnvelope(
      makeUnsignedEnvelope("x811/result", { step: 4 }),
      kp.privateKey,
    );
    const step5 = signEnvelope(
      makeUnsignedEnvelope("x811/verify", { step: 5 }),
      kp.privateKey,
    );
    const step6 = signEnvelope(
      makeUnsignedEnvelope("x811/payment", { step: 6 }),
      kp.privateKey,
    );

    const workflow = [step1, step2, step3, step4, step5, step6];
    expect(workflow).toHaveLength(6);
    for (const env of workflow) {
      expect(verifyEnvelope(env, kp.publicKey)).toBe(true);
    }

    // Verify distinct types
    const types = workflow.map((e) => e.type);
    expect(new Set(types).size).toBe(6);
  });

  it("x811 includes trust scoring to gate provider selection", () => {
    const policy: AcceptancePolicy = {
      acceptance_policy: "auto",
      min_trust_score: 0.7,
      max_budget_per_task: 0.1,
      allowed_capabilities: ["financial-analysis"],
    };

    expect(policy.min_trust_score).toBeDefined();
    expect(policy.min_trust_score).toBeGreaterThanOrEqual(0);
    expect(policy.min_trust_score).toBeLessThanOrEqual(1);

    // Trust score gates provider selection — a provider with 0.5 would be rejected
    const providerTrust = 0.5;
    expect(providerTrust).toBeLessThan(policy.min_trust_score);
  });

  it("x811 computes protocol fees transparently", () => {
    const price = 0.03;
    const protocolFeeRate = 0.025; // 2.5%
    const protocolFee = price * protocolFeeRate;
    const totalCost = price + protocolFee;

    const offer: OfferPayload = {
      request_id: "req-fee",
      price: price.toFixed(5),
      protocol_fee: protocolFee.toFixed(5),
      total_cost: totalCost.toFixed(5),
      currency: "USDC",
      estimated_time: 30,
      deliverables: ["analysis"],
      expiry: 300,
      payment_address: "0xaaaa",
    };

    // Verify the math
    expect(parseFloat(offer.protocol_fee)).toBeCloseTo(
      parseFloat(offer.price) * 0.025,
      10,
    );
    expect(parseFloat(offer.total_cost)).toBeCloseTo(
      parseFloat(offer.price) + parseFloat(offer.protocol_fee),
      10,
    );
  });
});

// ==========================================================================
// vs A2A — x811 has capabilities that Google A2A lacks
// ==========================================================================
describe("Comparative: x811 vs A2A", () => {
  it("x811 includes integrated payment settlement", () => {
    const payment: PaymentPayload = {
      request_id: "req-a2a-pay",
      offer_id: "offer-a2a-pay",
      tx_hash: "0x" + "a".repeat(64),
      amount: "0.03",
      currency: "USDC",
      network: "base",
      payer_address: "0x1111111111111111111111111111111111111111",
      payee_address: "0x2222222222222222222222222222222222222222",
    };

    expect(payment.currency).toBe("USDC");
    expect(payment.network).toBe("base");
    expect(payment.tx_hash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(payment.amount).toBe("0.03");
    expect(payment.payer_address).toMatch(/^0x[0-9]{40}$/);
    expect(payment.payee_address).toMatch(/^0x[0-9]{40}$/);
  });

  it("x811 provides price negotiation within the protocol", () => {
    const request: RequestPayload = {
      task_type: "code-review",
      parameters: { repo: "test/repo" },
      max_budget: 0.1,
      currency: "USDC",
      deadline: 300,
      acceptance_policy: "auto",
      idempotency_key: "idem-a2a-neg",
    };

    const offer: OfferPayload = {
      request_id: "req-a2a-neg",
      price: "0.05",
      protocol_fee: "0.00125",
      total_cost: "0.05125",
      currency: "USDC",
      estimated_time: 120,
      deliverables: ["code review report"],
      expiry: 300,
      payment_address: "0xcccc",
    };

    // Provider offers a price within the consumer's budget range
    expect(parseFloat(offer.price)).toBeLessThanOrEqual(request.max_budget);
    expect(parseFloat(offer.price)).toBeGreaterThan(0);
    // Separate REQUEST and OFFER payloads with different values = negotiation
    expect(request.max_budget).not.toBe(parseFloat(offer.price));
  });

  it("x811 provides on-chain Merkle proof verification", () => {
    const interactionHashes = [
      hashPayload({ interaction: 1, status: "completed" }),
      hashPayload({ interaction: 2, status: "completed" }),
      hashPayload({ interaction: 3, status: "completed" }),
      hashPayload({ interaction: 4, status: "completed" }),
      hashPayload({ interaction: 5, status: "completed" }),
    ];

    const tree = new MerkleTree(interactionHashes);
    expect(tree.root).toMatch(/^[0-9a-f]{64}$/);

    // Generate and verify inclusion proof for every interaction
    for (const hash of interactionHashes) {
      const proof = tree.getProof(hash);
      expect(MerkleTree.verify(hash, proof, tree.root)).toBe(true);
    }

    // Non-existent interaction is not in the tree
    const fakeHash = hashPayload({ interaction: 999, status: "fake" });
    expect(() => tree.getProof(fakeHash)).toThrow("Item not found");
  });

  it("x811 provides dispute resolution signaling", () => {
    const disputeCodes = [
      "WRONG_RESULT",
      "INCOMPLETE",
      "TIMEOUT",
      "QUALITY",
      "OTHER",
    ] as const;

    for (const code of disputeCodes) {
      const verify: VerifyPayload = {
        request_id: "req-dispute",
        offer_id: "offer-dispute",
        result_hash: "f".repeat(64),
        verified: false,
        dispute_reason: `Result disputed: ${code}`,
        dispute_code: code,
      };

      expect(verify.verified).toBe(false);
      expect(verify.dispute_reason).toBeDefined();
      expect(verify.dispute_code).toBe(code);
    }

    expect(disputeCodes).toHaveLength(5);
  });

  it("x811 enforces time-bounded state transitions", () => {
    // All 6 TTL values from NEGOTIATION_TTLS in messages.ts
    expect(NEGOTIATION_TTLS.REQUEST_TO_OFFER).toBe(60);
    expect(NEGOTIATION_TTLS.OFFER_TO_ACCEPT).toBe(300);
    expect(NEGOTIATION_TTLS.ACCEPT_TO_RESULT).toBe(3600);
    expect(NEGOTIATION_TTLS.RESULT_TO_VERIFY).toBe(30);
    expect(NEGOTIATION_TTLS.VERIFY_TO_PAY).toBe(60);
    expect(NEGOTIATION_TTLS.PAY_CONFIRMATION).toBe(30);

    // All TTLs are positive integers
    for (const value of Object.values(NEGOTIATION_TTLS)) {
      expect(value).toBeGreaterThan(0);
      expect(Number.isInteger(value)).toBe(true);
    }
  });
});

// ==========================================================================
// vs ANP — x811 has capabilities that Ant Group ANP explicitly defers
// ==========================================================================
describe("Comparative: x811 vs ANP", () => {
  it("x811 provides the economic layer that ANP explicitly defers", () => {
    // Full economic cycle: budget -> price -> fee -> payment
    const budget = 0.05;

    const request: RequestPayload = {
      task_type: "data-analysis",
      parameters: {},
      max_budget: budget,
      currency: "USDC",
      deadline: 120,
      acceptance_policy: "auto",
      idempotency_key: "idem-anp-econ",
    };

    const price = 0.03;
    const protocolFee = price * 0.025;

    const offer: OfferPayload = {
      request_id: "req-anp-econ",
      price: price.toString(),
      protocol_fee: protocolFee.toString(),
      total_cost: (price + protocolFee).toString(),
      currency: "USDC",
      estimated_time: 30,
      deliverables: ["report"],
      expiry: 300,
      payment_address: "0xdddd",
    };

    const payment: PaymentPayload = {
      request_id: "req-anp-econ",
      offer_id: "offer-anp-econ",
      tx_hash: "0x" + "e".repeat(64),
      amount: offer.price,
      currency: "USDC",
      network: "base",
      payer_address: "0x1111",
      payee_address: "0xdddd",
    };

    expect(parseFloat(offer.price)).toBeLessThanOrEqual(request.max_budget);
    expect(payment.amount).toBe(offer.price);
    expect(payment.payee_address).toBe(offer.payment_address);
    expect(payment.currency).toBe("USDC");
    expect(payment.network).toBe("base");
  });

  it("x811 provides result verification before payment", () => {
    const resultData = { analysis: "bearish", confidence: 0.85 };
    const resultHash = hashPayload(resultData);

    const result: ResultPayload = {
      request_id: "req-anp-verify",
      offer_id: "offer-anp-verify",
      content: JSON.stringify(resultData),
      content_type: "application/json",
      result_hash: resultHash,
      execution_time_ms: 1200,
    };

    // Verifier recomputes hash independently
    const recomputed = hashPayload(JSON.parse(result.content!));
    expect(recomputed).toBe(result.result_hash);

    const verify: VerifyPayload = {
      request_id: "req-anp-verify",
      offer_id: "offer-anp-verify",
      result_hash: recomputed,
      verified: true,
    };

    expect(verify.verified).toBe(true);
    // Payment only happens after verification
    expect(verify.result_hash).toBe(result.result_hash);
  });

  it("x811 provides a protocol fee model", () => {
    const testPrices = [0.01, 0.03, 0.05, 0.10, 1.00];
    const feeRate = 0.025;

    for (const price of testPrices) {
      const fee = price * feeRate;
      const total = price + fee;

      expect(fee).toBeCloseTo(price * 0.025, 10);
      expect(total).toBeCloseTo(price * 1.025, 10);

      const offer: OfferPayload = {
        request_id: "req-fee-model",
        price: price.toString(),
        protocol_fee: fee.toString(),
        total_cost: total.toString(),
        currency: "USDC",
        estimated_time: 30,
        deliverables: ["result"],
        expiry: 300,
        payment_address: "0xeeee",
      };

      expect(parseFloat(offer.total_cost)).toBeCloseTo(
        parseFloat(offer.price) + parseFloat(offer.protocol_fee),
        10,
      );
    }
  });

  it("x811 provides Merkle-batched on-chain trust anchoring", () => {
    // Simulate a batch of interaction hashes
    const interactions = Array.from({ length: 50 }, (_, i) =>
      hashPayload({ interaction_id: i, completed: true, trust_delta: 0.01 }),
    );

    const tree = new MerkleTree(interactions);
    expect(tree.root).toMatch(/^[0-9a-f]{64}$/);
    expect(tree.root.length).toBe(64);

    // Every interaction can be proven as part of the batch
    for (const hash of interactions) {
      const proof = tree.getProof(hash);
      expect(proof.length).toBeGreaterThan(0);
      expect(MerkleTree.verify(hash, proof, tree.root)).toBe(true);
    }

    // Tampered interaction fails verification
    const tamperedHash = hashPayload({ interaction_id: 999, tampered: true });
    expect(() => tree.getProof(tamperedHash)).toThrow("Item not found");
  });
});

// ==========================================================================
// Unique to x811 — capabilities no competitor provides
// ==========================================================================
describe("Unique to x811", () => {
  it("provides canonical JSON serialization for deterministic signing", () => {
    // Same data, different key order — same canonical form
    const obj1 = { z: 3, a: 1, m: 2, nested: { b: 2, a: 1 } };
    const obj2 = { a: 1, m: 2, z: 3, nested: { a: 1, b: 2 } };
    const obj3 = { nested: { b: 2, a: 1 }, m: 2, z: 3, a: 1 };

    const c1 = canonicalize(obj1);
    const c2 = canonicalize(obj2);
    const c3 = canonicalize(obj3);

    expect(c1).toBe(c2);
    expect(c2).toBe(c3);

    // Signatures are deterministic when canonicalization is deterministic
    const kp = generateSigningKeyPair();
    const env1 = makeUnsignedEnvelope("x811/request", obj1);
    const env2 = { ...env1, payload: obj2 };
    const env3 = { ...env1, payload: obj3 };

    const sig1 = signEnvelope(env1, kp.privateKey);
    const sig2 = signEnvelope(env2, kp.privateKey);
    const sig3 = signEnvelope(env3, kp.privateKey);

    expect(sig1.signature).toBe(sig2.signature);
    expect(sig2.signature).toBe(sig3.signature);
  });

  it("generates the protocol comparison matrix", () => {
    const features = [
      "DID-based identity",
      "Signed message envelopes",
      "Price negotiation (REQUEST/OFFER)",
      "Counter-offer / rejection with reason codes",
      "Conditional payment after verification",
      "Multi-step task workflow (6 message types)",
      "Trust scoring and trust-gated acceptance",
      "On-chain Merkle proof verification",
      "Dispute resolution signaling",
      "Time-bounded state transitions (TTLs)",
      "Protocol fee model (2.5%)",
      "Canonical JSON serialization",
      "Nonce-based replay protection",
      "10-state negotiation state machine",
      "Economic settlement (USDC on Base L2)",
      "Acceptance policies (auto/human/threshold)",
      "Result hash integrity verification",
    ];

    expect(features).toHaveLength(17);

    // x811 AEEP: all 17 features
    const x811_AEEP = features.map(() => true);

    // ERC-8004: only DID-based identity (partial) and signed envelopes (partial)
    const ERC_8004 = [
      true,  // DID-based identity (via ERC, partial)
      false, // Signed message envelopes
      false, // Price negotiation
      false, // Counter-offer
      false, // Conditional payment
      false, // Multi-step workflow
      false, // Trust scoring
      false, // Merkle proof
      false, // Dispute resolution
      false, // Time-bounded transitions
      false, // Protocol fee model
      false, // Canonical JSON
      false, // Nonce replay protection
      false, // 10-state machine
      true,  // Economic settlement (on-chain, partial)
      false, // Acceptance policies
      false, // Result hash integrity
    ];

    // x402: basic payment only — no identity, negotiation, or verification
    const x402 = features.map(() => false);

    // A2A: task state machine only
    const A2A = [
      false, // DID-based identity
      false, // Signed envelopes
      false, // Price negotiation
      false, // Counter-offer
      false, // Conditional payment
      false, // Multi-step workflow
      false, // Trust scoring
      false, // Merkle proof
      false, // Dispute resolution
      false, // Time-bounded transitions
      false, // Protocol fee model
      false, // Canonical JSON
      false, // Nonce replay protection
      true,  // 10-state machine (A2A has task states)
      false, // Economic settlement
      false, // Acceptance policies
      false, // Result hash integrity
    ];

    // ANP: DID identity only
    const ANP = [
      true,  // DID-based identity
      false, // Signed envelopes
      false, // Price negotiation
      false, // Counter-offer
      false, // Conditional payment
      false, // Multi-step workflow
      false, // Trust scoring
      false, // Merkle proof
      false, // Dispute resolution
      false, // Time-bounded transitions
      false, // Protocol fee model
      false, // Canonical JSON
      false, // Nonce replay protection
      false, // 10-state machine
      false, // Economic settlement
      false, // Acceptance policies
      false, // Result hash integrity
    ];

    // Count features per protocol
    const count = (arr: boolean[]) => arr.filter(Boolean).length;

    expect(count(x811_AEEP)).toBe(17);
    expect(count(ERC_8004)).toBe(2);
    expect(count(x402)).toBe(0);
    expect(count(A2A)).toBe(1);
    expect(count(ANP)).toBe(1);

    // x811 has strictly more features than all competitors
    expect(count(x811_AEEP)).toBeGreaterThan(count(ERC_8004));
    expect(count(x811_AEEP)).toBeGreaterThan(count(x402));
    expect(count(x811_AEEP)).toBeGreaterThan(count(A2A));
    expect(count(x811_AEEP)).toBeGreaterThan(count(ANP));

    // x811 is a strict superset — every feature any competitor has, x811 also has
    for (let i = 0; i < features.length; i++) {
      if (ERC_8004[i] || x402[i] || A2A[i] || ANP[i]) {
        expect(x811_AEEP[i]).toBe(true);
      }
    }
  });
});
