/**
 * x811 Protocol — Message envelope types and protocol constants.
 */

/** All message types in the x811 protocol. */
export type X811MessageType =
  | "x811/request"
  | "x811/offer"
  | "x811/accept"
  | "x811/reject"
  | "x811/result"
  | "x811/verify"
  | "x811/payment"
  | "x811/payment-failed"
  | "x811/cancel"
  | "x811/heartbeat"
  | "x811/error";

/** Signed message envelope for all x811 protocol communication. */
export interface X811Envelope<T> {
  /** Protocol version. */
  version: "0.1.0";
  /** UUIDv7 message identifier. */
  id: string;
  /** Message type discriminator. */
  type: X811MessageType;
  /** Sender DID. */
  from: string;
  /** Recipient DID. */
  to: string;
  /** ISO 8601 creation timestamp. */
  created: string;
  /** ISO 8601 expiration timestamp. */
  expires?: string;
  /** Typed message payload. */
  payload: T;
  /** Base64url-encoded Ed25519 signature. */
  signature: string;
  /** Unique nonce to prevent replay attacks. */
  nonce: string;
}

/** Negotiation lifecycle states. */
export type NegotiationStatus =
  | "pending"
  | "offered"
  | "accepted"
  | "delivered"
  | "verified"
  | "completed"
  | "expired"
  | "rejected"
  | "disputed"
  | "failed";

/** Size and time limits for protocol messages. */
export const MESSAGE_LIMITS = {
  /** Maximum envelope size in bytes (1 MiB). */
  MAX_ENVELOPE_SIZE: 1_048_576,
  /** Maximum inline payload size in bytes (512 KiB). */
  MAX_INLINE_PAYLOAD: 524_288,
  /** Maximum result file size via URL (50 MiB). */
  MAX_RESULT_URL_FILE: 52_428_800,
  /** Nonce time-to-live in hours. */
  NONCE_TTL_HOURS: 24,
  /** Maximum allowed clock skew in minutes. */
  MAX_CLOCK_SKEW_MINUTES: 5,
} as const;

/** TTLs for each negotiation phase in seconds. */
export const NEGOTIATION_TTLS = {
  /** Time from request to offer (seconds). */
  REQUEST_TO_OFFER: 60,
  /** Time from offer to accept/reject (seconds). */
  OFFER_TO_ACCEPT: 300,
  /** Time from accept to result delivery (seconds). */
  ACCEPT_TO_RESULT: 3_600,
  /** Time from result to verification (seconds). */
  RESULT_TO_VERIFY: 30,
  /** Time from verification to payment initiation (seconds). */
  VERIFY_TO_PAY: 60,
  /** Time for payment confirmation (seconds). */
  PAY_CONFIRMATION: 30,
  /** Maximum payment retry attempts. */
  PAYMENT_MAX_RETRIES: 4,
} as const;
