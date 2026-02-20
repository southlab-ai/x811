/**
 * x811 Protocol — Negotiation Service.
 *
 * Implements the full 10-step negotiation state machine:
 *
 * States: pending, offered, accepted, delivered, verified, completed,
 *         expired, rejected, disputed, failed
 *
 * Valid transitions:
 *   pending   -> offered
 *   offered   -> accepted, rejected
 *   accepted  -> delivered
 *   delivered -> verified, disputed
 *   verified  -> completed
 *   any       -> expired, failed
 *
 * Each transition is triggered by a specific message type (x811/request,
 * x811/offer, x811/accept, x811/reject, x811/result, x811/verify,
 * x811/payment, x811/payment-failed).
 *
 * TTLs are enforced per transition step.
 */

import { randomUUID } from "node:crypto";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import type { Database, InteractionRow } from "../db/schema.js";
import type { MessageRouterService, Envelope } from "./router.js";
import type { BatchingService } from "./batching.js";
import type { TrustService } from "./trust.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Protocol fee percentage. */
const PROTOCOL_FEE_RATE = 0.025; // 2.5%

/** TTLs in seconds for each transition step. */
const NEGOTIATION_TTLS: Record<string, number> = {
  REQUEST_TO_OFFER: 60,
  OFFER_TO_ACCEPT: 300,
  ACCEPT_TO_RESULT: 3600,
  RESULT_TO_VERIFY: 30,
  VERIFY_TO_PAY: 60,
  PAY_CONFIRMATION: 30,
};

/** Valid state transitions. */
const VALID_TRANSITIONS: Record<string, string[]> = {
  pending: ["offered", "expired", "failed"],
  offered: ["accepted", "rejected", "expired", "failed"],
  accepted: ["delivered", "expired", "failed"],
  delivered: ["verified", "disputed", "expired", "failed"],
  verified: ["completed", "expired", "failed"],
  completed: [],
  expired: [],
  rejected: [],
  disputed: ["failed"],
  failed: [],
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RequestPayload {
  task_type: string;
  parameters: Record<string, unknown>;
  max_budget: number;
  currency: string;
  deadline: number;
  acceptance_policy: string;
  threshold_amount?: number;
  callback_url?: string;
  idempotency_key: string;
}

interface OfferPayload {
  request_id: string;
  price: string;
  protocol_fee: string;
  total_cost: string;
  currency: string;
  estimated_time: number;
  deliverables: string[];
  terms?: string;
  expiry: number;
}

interface AcceptPayload {
  offer_id: string;
  offer_hash: string;
}

interface RejectPayload {
  offer_id: string;
  reason: string;
  code: string;
}

interface ResultPayload {
  request_id: string;
  offer_id: string;
  content?: unknown;
  content_type: string;
  result_url?: string;
  result_size?: number;
  result_hash: string;
  execution_time_ms: number;
  model_used?: string;
  methodology?: string;
}

interface PaymentPayload {
  request_id: string;
  offer_id: string;
  tx_hash: string;
  amount: number;
  currency: string;
  network: string;
  payer_address: string;
  payee_address: string;
}

interface ErrorPayload {
  code: string;
  message: string;
  related_message_id?: string;
}

// ---------------------------------------------------------------------------
// Negotiation Service
// ---------------------------------------------------------------------------

export class NegotiationService {
  constructor(
    private db: Database,
    private router: MessageRouterService,
    private batching: BatchingService,
    private trust: TrustService,
  ) {}

  /**
   * Route a negotiation-related message to the appropriate handler.
   */
  async handleMessage(envelope: Envelope): Promise<{ interaction_id: string; status: string }> {
    switch (envelope.type) {
      case "x811/request":
        return this.handleRequest(envelope);
      case "x811/offer":
        return this.handleOffer(envelope);
      case "x811/accept":
        return this.handleAccept(envelope);
      case "x811/reject":
        return this.handleReject(envelope);
      case "x811/result":
        return this.handleResult(envelope);
      case "x811/verify":
        return this.handleVerify(envelope);
      case "x811/payment":
        return this.handlePayment(envelope);
      case "x811/payment-failed":
        return this.handlePaymentFailed(envelope);
      default:
        throw new NegotiationError(
          "X811-4006",
          `Unsupported negotiation message type: ${envelope.type}`,
        );
    }
  }

  // -----------------------------------------------------------------------
  // Message handlers
  // -----------------------------------------------------------------------

  /**
   * Handle a REQUEST message.
   * Creates a new interaction in "pending" state.
   * Validates idempotency key for duplicate detection.
   */
  async handleRequest(
    envelope: Envelope,
  ): Promise<{ interaction_id: string; status: string }> {
    const payload = envelope.payload as RequestPayload;

    if (!payload.idempotency_key) {
      throw new NegotiationError("X811-4006", "Missing idempotency_key in request payload");
    }

    // Check for duplicate request (idempotency)
    const existing = this.db.getInteractionByIdempotencyKey(
      payload.idempotency_key,
    );
    if (existing) {
      return { interaction_id: existing.id, status: existing.status };
    }

    // Verify provider exists
    const provider = this.db.getAgentByDid(envelope.to);
    if (!provider) {
      throw new NegotiationError("X811-3001", "Provider agent not found", {
        did: envelope.to,
      });
    }

    // Create interaction hash from envelope content
    const interactionHash = this.computeHash(envelope);

    // Create interaction record
    const interaction = this.db.insertInteraction({
      id: randomUUID(),
      interaction_hash: interactionHash,
      initiator_did: envelope.from,
      provider_did: envelope.to,
      capability: payload.task_type,
      status: "pending",
      outcome: null,
      payment_tx: null,
      payment_amount: null,
      batch_id: null,
      request_payload: JSON.stringify(payload),
      offer_payload: null,
      result_payload: null,
      idempotency_key: payload.idempotency_key,
    });

    return { interaction_id: interaction.id, status: "pending" };
  }

  /**
   * Handle an OFFER message.
   * Transitions from "pending" to "offered".
   * Calculates and validates protocol fee (2.5%).
   */
  async handleOffer(
    envelope: Envelope,
  ): Promise<{ interaction_id: string; status: string }> {
    const payload = envelope.payload as OfferPayload;

    // Find the interaction by request_id, with fallback to DID + status lookup
    const interaction = this.findInteractionByRequestId(
      payload.request_id,
      "pending",
      envelope.from,
    );
    if (!interaction) {
      throw new NegotiationError("X811-4006", "Request not found for this offer", {
        request_id: payload.request_id,
      });
    }

    // Validate state transition
    this.validateTransition(interaction, "offered");

    // Validate the sender is the provider
    if (envelope.from !== interaction.provider_did) {
      throw new NegotiationError("X811-2004", "Only the provider can send an offer", {
        expected: interaction.provider_did,
        actual: envelope.from,
      });
    }

    // Validate protocol fee calculation
    const price = parseFloat(payload.price);
    const expectedFee = Math.round(price * PROTOCOL_FEE_RATE * 1_000_000) / 1_000_000;
    const actualFee = parseFloat(payload.protocol_fee);
    if (Math.abs(actualFee - expectedFee) > 0.000001) {
      throw new NegotiationError("X811-4006", "Invalid protocol fee calculation", {
        expected_fee: expectedFee,
        actual_fee: actualFee,
        rate: PROTOCOL_FEE_RATE,
      });
    }

    // Validate total cost
    const expectedTotal = Math.round((price + expectedFee) * 1_000_000) / 1_000_000;
    const actualTotal = parseFloat(payload.total_cost);
    if (Math.abs(actualTotal - expectedTotal) > 0.000001) {
      throw new NegotiationError("X811-4006", "Invalid total cost calculation", {
        expected_total: expectedTotal,
        actual_total: actualTotal,
      });
    }

    // Check budget constraint
    const requestPayload = JSON.parse(
      interaction.request_payload!,
    ) as RequestPayload;
    if (actualTotal > requestPayload.max_budget) {
      throw new NegotiationError("X811-4003", "Offer total exceeds request budget", {
        max_budget: requestPayload.max_budget,
        total_cost: actualTotal,
      });
    }

    // Update interaction
    this.db.updateInteraction(interaction.id, {
      status: "offered",
      offer_payload: JSON.stringify(payload),
    });

    return { interaction_id: interaction.id, status: "offered" };
  }

  /**
   * Handle an ACCEPT message.
   * Transitions from "offered" to "accepted".
   * Validates offer_hash matches the stored offer.
   */
  async handleAccept(
    envelope: Envelope,
  ): Promise<{ interaction_id: string; status: string }> {
    const payload = envelope.payload as AcceptPayload;

    // Find the interaction
    const interaction = this.findInteractionByOfferOrRequest(payload.offer_id);
    this.validateTransition(interaction, "accepted");

    // Validate the sender is the initiator
    if (envelope.from !== interaction.initiator_did) {
      throw new NegotiationError("X811-2004", "Only the initiator can accept an offer", {
        expected: interaction.initiator_did,
        actual: envelope.from,
      });
    }

    // Validate offer_hash matches stored offer
    if (interaction.offer_payload) {
      const expectedHash = this.computePayloadHash(interaction.offer_payload);
      if (payload.offer_hash !== expectedHash) {
        throw new NegotiationError("X811-4006", "Offer hash mismatch", {
          expected: expectedHash,
          actual: payload.offer_hash,
        });
      }
    }

    this.db.updateInteraction(interaction.id, { status: "accepted" });
    return { interaction_id: interaction.id, status: "accepted" };
  }

  /**
   * Handle a REJECT message.
   * Transitions from "offered" to "rejected".
   */
  async handleReject(
    envelope: Envelope,
  ): Promise<{ interaction_id: string; status: string }> {
    const payload = envelope.payload as RejectPayload;

    const interaction = this.findInteractionByOfferOrRequest(payload.offer_id);
    this.validateTransition(interaction, "rejected");

    // Validate the sender is the initiator
    if (envelope.from !== interaction.initiator_did) {
      throw new NegotiationError("X811-2004", "Only the initiator can reject an offer", {
        expected: interaction.initiator_did,
        actual: envelope.from,
      });
    }

    this.db.updateInteraction(interaction.id, {
      status: "rejected",
      outcome: "rejected",
    });

    return { interaction_id: interaction.id, status: "rejected" };
  }

  /**
   * Handle a RESULT message.
   * Transitions from "accepted" to "delivered".
   * Validates result_hash is present.
   */
  async handleResult(
    envelope: Envelope,
  ): Promise<{ interaction_id: string; status: string }> {
    const payload = envelope.payload as ResultPayload;

    const interaction = this.findInteractionByRequestId(
      payload.request_id,
      "accepted",
      envelope.from,
    );
    if (!interaction) {
      throw new NegotiationError("X811-4006", "Interaction not found", {
        request_id: payload.request_id,
      });
    }
    this.validateTransition(interaction, "delivered");

    // Validate the sender is the provider
    if (envelope.from !== interaction.provider_did) {
      throw new NegotiationError("X811-2004", "Only the provider can deliver results", {
        expected: interaction.provider_did,
        actual: envelope.from,
      });
    }

    // Validate result_hash is present
    if (!payload.result_hash) {
      throw new NegotiationError("X811-6002", "Missing result_hash in result payload");
    }

    this.db.updateInteraction(interaction.id, {
      status: "delivered",
      result_payload: JSON.stringify(payload),
    });

    return { interaction_id: interaction.id, status: "delivered" };
  }

  /**
   * Handle a VERIFY message.
   * Transitions from "delivered" to "verified".
   * Performs server-side validation of the result.
   */
  async handleVerify(
    envelope: Envelope,
  ): Promise<{ interaction_id: string; status: string }> {
    const payload = envelope.payload as {
      request_id: string;
      result_hash: string;
      verified: boolean;
    };

    const interaction = this.findInteractionByRequestId(
      payload.request_id,
      "delivered",
      envelope.from,
    );
    if (!interaction) {
      throw new NegotiationError("X811-4006", "Interaction not found", {
        request_id: payload.request_id,
      });
    }
    this.validateTransition(interaction, "verified");

    // Server-side verification: check result_hash matches stored result
    if (interaction.result_payload) {
      const resultPayload = JSON.parse(interaction.result_payload) as ResultPayload;
      if (payload.result_hash && payload.result_hash !== resultPayload.result_hash) {
        throw new NegotiationError("X811-6002", "Result hash mismatch during verification", {
          expected: resultPayload.result_hash,
          actual: payload.result_hash,
        });
      }
    }

    this.db.updateInteraction(interaction.id, {
      status: "verified",
      outcome: "success",
    });

    // Add to batching queue for Merkle tree anchoring
    await this.batching.addInteraction(interaction.interaction_hash);

    return { interaction_id: interaction.id, status: "verified" };
  }

  /**
   * Handle a PAYMENT message.
   * Transitions from "verified" to "completed".
   * Validates tx_hash and amount.
   */
  async handlePayment(
    envelope: Envelope,
  ): Promise<{ interaction_id: string; status: string }> {
    const payload = envelope.payload as PaymentPayload;

    const interaction = this.findInteractionByRequestId(
      payload.request_id,
      "verified",
      envelope.from,
    );
    if (!interaction) {
      throw new NegotiationError("X811-4006", "Interaction not found", {
        request_id: payload.request_id,
      });
    }
    this.validateTransition(interaction, "completed");

    // Validate the sender is the initiator (payer)
    if (envelope.from !== interaction.initiator_did) {
      throw new NegotiationError("X811-2004", "Only the initiator can submit payment", {
        expected: interaction.initiator_did,
        actual: envelope.from,
      });
    }

    // Validate tx_hash is present
    if (!payload.tx_hash) {
      throw new NegotiationError("X811-5001", "Missing tx_hash in payment payload");
    }

    // Validate amount matches the offer
    if (interaction.offer_payload) {
      const offerPayload = JSON.parse(interaction.offer_payload) as OfferPayload;
      const expectedAmount = parseFloat(offerPayload.total_cost);
      if (Math.abs(payload.amount - expectedAmount) > 0.000001) {
        throw new NegotiationError("X811-5003", "Payment amount does not match offer total", {
          expected: expectedAmount,
          actual: payload.amount,
        });
      }
    }

    this.db.updateInteraction(interaction.id, {
      status: "completed",
      outcome: "success",
      payment_tx: payload.tx_hash,
      payment_amount: payload.amount,
    });

    // Update trust scores for both agents
    this.trust.recordSuccess(interaction.initiator_did);
    this.trust.recordSuccess(interaction.provider_did);

    return { interaction_id: interaction.id, status: "completed" };
  }

  /**
   * Handle a PAYMENT-FAILED message.
   * Logs the failure and transitions to "failed" state.
   */
  async handlePaymentFailed(
    envelope: Envelope,
  ): Promise<{ interaction_id: string; status: string }> {
    const payload = envelope.payload as ErrorPayload;

    // Find the interaction by related_message_id or scan recent interactions
    let interaction: InteractionRow | undefined;
    if (payload.related_message_id) {
      interaction = this.db.getInteraction(payload.related_message_id);
    }

    if (!interaction) {
      // Try to find by initiator + provider + recent verified status
      const stmt = this.db.raw.prepare(`
        SELECT * FROM interactions
        WHERE (initiator_did = ? OR provider_did = ?)
          AND status = 'verified'
        ORDER BY updated_at DESC
        LIMIT 1
      `);
      interaction = stmt.get(envelope.from, envelope.from) as InteractionRow | undefined;
    }

    if (!interaction) {
      throw new NegotiationError("X811-4006", "No matching interaction found for payment failure");
    }

    this.validateTransition(interaction, "failed");

    this.db.updateInteraction(interaction.id, {
      status: "failed",
      outcome: "failure",
    });

    // Record failure for trust scoring
    this.trust.recordFailure(interaction.initiator_did);

    return { interaction_id: interaction.id, status: "failed" };
  }

  /**
   * Check for interactions that have exceeded their TTL for the current
   * state transition. Called periodically.
   */
  checkExpiredInteractions(): void {
    const now = Date.now();

    // Map of states to their TTL keys
    const stateTTLs: Array<{ status: string; ttlKey: string }> = [
      { status: "pending", ttlKey: "REQUEST_TO_OFFER" },
      { status: "offered", ttlKey: "OFFER_TO_ACCEPT" },
      { status: "accepted", ttlKey: "ACCEPT_TO_RESULT" },
      { status: "delivered", ttlKey: "RESULT_TO_VERIFY" },
      { status: "verified", ttlKey: "VERIFY_TO_PAY" },
    ];

    for (const { status, ttlKey } of stateTTLs) {
      const ttlMs = NEGOTIATION_TTLS[ttlKey] * 1000;
      const cutoff = new Date(now - ttlMs).toISOString();

      const stmt = this.db.raw.prepare(`
        UPDATE interactions SET
          status = 'expired',
          outcome = 'timeout',
          updated_at = ?
        WHERE status = ? AND updated_at < ?
      `);
      stmt.run(new Date().toISOString(), status, cutoff);
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Validate that a state transition is allowed.
   */
  private validateTransition(
    interaction: InteractionRow,
    targetStatus: string,
  ): void {
    const allowed = VALID_TRANSITIONS[interaction.status];
    if (!allowed || !allowed.includes(targetStatus)) {
      throw new NegotiationError(
        "X811-4006",
        `Invalid state transition: ${interaction.status} -> ${targetStatus}`,
        {
          interaction_id: interaction.id,
          current_status: interaction.status,
          target_status: targetStatus,
          allowed_transitions: allowed ?? [],
        },
      );
    }
  }

  /**
   * Find an interaction by request_id. Tries the direct ID lookup first,
   * then falls back to searching by DID + expected status. This covers
   * cases where the caller uses the message envelope ID instead of the
   * server-generated interaction UUID.
   */
  private findInteractionByRequestId(
    requestId: string,
    expectedStatus: string,
    senderDid: string,
  ): InteractionRow | undefined {
    // Primary: direct lookup by interaction ID
    let interaction = this.db.getInteraction(requestId);
    if (interaction) return interaction;

    // Fallback: search by DID and expected status
    const stmt = this.db.raw.prepare(`
      SELECT * FROM interactions
      WHERE (initiator_did = ? OR provider_did = ?) AND status = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `);
    interaction = stmt.get(senderDid, senderDid, expectedStatus) as InteractionRow | undefined;
    return interaction;
  }

  /**
   * Find an interaction by offer_id. The offer_id is typically the
   * interaction ID or can be looked up from stored offer payloads.
   */
  private findInteractionByOfferOrRequest(offerId: string): InteractionRow {
    // First try as interaction ID
    let interaction = this.db.getInteraction(offerId);
    if (interaction) return interaction;

    // Try to find by scanning offer payloads for matching ID
    const stmt = this.db.raw.prepare(`
      SELECT * FROM interactions WHERE offer_payload LIKE ?
    `);
    interaction = stmt.get(`%"request_id":"${offerId}"%`) as InteractionRow | undefined;
    if (interaction) return interaction;

    // Try by interaction hash
    interaction = this.db.getInteractionByHash(offerId);
    if (interaction) return interaction;

    throw new NegotiationError("X811-4006", "Interaction not found for offer", {
      offer_id: offerId,
    });
  }

  /**
   * Compute a SHA-256 hash of an envelope (canonical JSON).
   */
  private computeHash(envelope: Envelope): string {
    const canonical = JSON.stringify(envelope, Object.keys(envelope).sort());
    const bytes = new TextEncoder().encode(canonical);
    return bytesToHex(sha256(bytes));
  }

  /**
   * Compute a SHA-256 hash of a JSON payload string.
   */
  private computePayloadHash(payloadJson: string): string {
    const bytes = new TextEncoder().encode(payloadJson);
    return bytesToHex(sha256(bytes));
  }
}

// ---------------------------------------------------------------------------
// Negotiation-specific error
// ---------------------------------------------------------------------------

export class NegotiationError extends Error {
  constructor(
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "NegotiationError";
  }
}

/**
 * Check if a message type is negotiation-related.
 */
export function isNegotiationMessage(type: string): boolean {
  return [
    "x811/request",
    "x811/offer",
    "x811/accept",
    "x811/reject",
    "x811/result",
    "x811/verify",
    "x811/payment",
    "x811/payment-failed",
  ].includes(type);
}
