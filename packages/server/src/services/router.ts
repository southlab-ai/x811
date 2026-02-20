/**
 * x811 Protocol — Message Router Service.
 *
 * Routes signed envelopes between agents. Messages are stored in the
 * database and delivered via polling. Handles nonce replay protection,
 * timestamp validation, and message expiry.
 */

import { randomUUID } from "node:crypto";
import type { Database, MessageRow } from "../db/schema.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum allowed clock skew in milliseconds (5 minutes). */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Default message expiry (24 hours). */
const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000;

/** Nonce TTL in hours. */
const NONCE_TTL_HOURS = 24;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Envelope {
  version: string;
  id: string;
  type: string;
  from: string;
  to: string;
  created: string;
  expires?: string;
  payload: unknown;
  signature: string;
  nonce: string;
}

export interface SendResult {
  message_id: string;
  status: "delivered" | "queued";
  recipient_availability: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class MessageRouterService {
  constructor(private db: Database) {}

  /**
   * Send a signed envelope from one agent to another.
   *
   * Steps:
   * 1. Validate timestamp (±5 minutes)
   * 2. Check and store nonce (replay protection)
   * 3. Verify recipient exists in registry
   * 4. Store message in database
   * 5. Return delivery status
   *
   * Note: Signature verification is handled by the auth middleware before
   * this service is called. This service handles routing and storage.
   */
  sendMessage(envelope: Envelope): SendResult {
    // Note: Timestamp validation and nonce replay protection are handled by the
    // auth middleware (verifyEnvelopeAuth) before this method is called.
    // We skip them here to avoid double-checking / double-inserting nonces.

    // 1. Verify recipient exists
    const recipient = this.db.getAgentByDid(envelope.to);
    if (!recipient) {
      throw new RouterError(
        "X811-3001",
        "Recipient agent not found",
        { did: envelope.to },
      );
    }

    // 2. Compute message expiry
    const expiresAt = envelope.expires
      ? envelope.expires
      : new Date(Date.now() + DEFAULT_EXPIRY_MS).toISOString();

    // 3. Store message
    const messageId = envelope.id || randomUUID();
    const message = this.db.insertMessage({
      id: messageId,
      type: envelope.type,
      from_did: envelope.from,
      to_did: envelope.to,
      envelope: JSON.stringify(envelope),
      created_at: envelope.created,
      expires_at: expiresAt,
    });

    // 4. Determine delivery status based on recipient availability
    const recipientAvailability = recipient.availability;
    const status: "delivered" | "queued" =
      recipientAvailability === "online" ? "queued" : "queued";

    return {
      message_id: messageId,
      status,
      recipient_availability: recipientAvailability,
    };
  }

  /**
   * Poll messages for a specific agent. Returns queued messages and
   * marks them as delivered.
   */
  pollMessages(agentId: string, did: string): Envelope[] {
    const agent = this.db.getAgent(agentId);
    if (!agent) {
      throw new RouterError("X811-3001", "Agent not found", { id: agentId });
    }

    if (agent.did !== did) {
      throw new RouterError("X811-2004", "DID does not match agent", {
        expected: agent.did,
        provided: did,
      });
    }

    // Get queued messages for this agent
    const messages = this.db.getMessagesByRecipient(did, "queued");
    const envelopes: Envelope[] = [];

    for (const msg of messages) {
      try {
        const envelope = JSON.parse(msg.envelope) as Envelope;
        envelopes.push(envelope);
        // Mark as delivered
        this.db.updateMessageStatus(msg.id, "delivered");
      } catch {
        // Skip malformed messages but mark them as failed
        this.db.updateMessageStatus(msg.id, "failed", "Failed to parse envelope");
      }
    }

    return envelopes;
  }

  /**
   * Delete messages that have expired.
   * Should be called periodically (e.g. every 5 minutes).
   */
  cleanupExpiredMessages(): number {
    return this.db.deleteExpiredMessages();
  }

  /**
   * Validate that a timestamp is within ±5 minutes of server time.
   */
  validateTimestamp(created: string): void {
    const timestamp = new Date(created).getTime();
    if (Number.isNaN(timestamp)) {
      throw new RouterError("X811-2003", "Invalid timestamp format", {
        created,
      });
    }

    const now = Date.now();
    const skew = Math.abs(now - timestamp);
    if (skew > MAX_CLOCK_SKEW_MS) {
      throw new RouterError(
        "X811-2003",
        "Timestamp outside acceptable range (±5 minutes)",
        {
          server_time: new Date(now).toISOString(),
          envelope_time: created,
          skew_ms: skew,
        },
      );
    }
  }

  /**
   * Check that a nonce has not been used before and store it with TTL.
   */
  checkAndStoreNonce(nonce: string, did: string): void {
    if (this.db.nonceExists(nonce)) {
      throw new RouterError("X811-2002", "Nonce has already been used", {
        nonce,
      });
    }
    this.db.insertNonce(nonce, did, NONCE_TTL_HOURS);
  }
}

// ---------------------------------------------------------------------------
// Router-specific error
// ---------------------------------------------------------------------------

export class RouterError extends Error {
  constructor(
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RouterError";
  }
}
