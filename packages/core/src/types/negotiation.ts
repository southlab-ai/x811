/**
 * x811 Protocol — Negotiation payload types for the request-offer-accept lifecycle.
 */

/** Payload for a task request from a consumer agent. */
export interface RequestPayload {
  /** Type of task being requested. */
  task_type: string;
  /** Task-specific parameters. */
  parameters: Record<string, unknown>;
  /** Maximum budget the consumer is willing to pay (USDC). */
  max_budget: number;
  /** Settlement currency. */
  currency: "USDC";
  /** Maximum acceptable execution time in seconds. */
  deadline: number;
  /** How the consumer wants to handle incoming offers. */
  acceptance_policy: "auto" | "human_approval" | "threshold";
  /** Budget threshold for auto-acceptance (when policy is "threshold"). */
  threshold_amount?: number;
  /** URL for async notifications. */
  callback_url?: string;
  /** UUIDv4 idempotency key to prevent duplicate requests. */
  idempotency_key: string;
}

/** Payload for a provider's offer in response to a request. */
export interface OfferPayload {
  /** ID of the original request. */
  request_id: string;
  /** Quoted price in USDC (string for precision). */
  price: string;
  /** Protocol fee (2.5%) in USDC. */
  protocol_fee: string;
  /** Total cost (price + protocol_fee) in USDC. */
  total_cost: string;
  /** Settlement currency. */
  currency: "USDC";
  /** Estimated execution time in seconds. */
  estimated_time: number;
  /** List of deliverables. */
  deliverables: string[];
  /** Optional terms of service or conditions. */
  terms?: string;
  /** Offer validity period in seconds. */
  expiry: number;
  /** Provider's checksummed Ethereum address for receiving payment. REQUIRED per RFC S.8.2. */
  payment_address: string;
}

/** Payload for accepting a provider's offer. */
export interface AcceptPayload {
  /** ID of the accepted offer. */
  offer_id: string;
  /** SHA-256 hash of the offer for integrity verification. */
  offer_hash: string;
}

/** Rejection reason codes. */
export type RejectReasonCode =
  | "PRICE_TOO_HIGH"
  | "DEADLINE_TOO_SHORT"
  | "TRUST_TOO_LOW"
  | "POLICY_REJECTED"
  | "OTHER";

/** Payload for rejecting a provider's offer. */
export interface RejectPayload {
  /** ID of the rejected offer. */
  offer_id: string;
  /** Human-readable rejection reason. */
  reason: string;
  /** Machine-readable rejection code. */
  code: RejectReasonCode;
}

/** Payload for delivering task results. */
export interface ResultPayload {
  /** ID of the original request. */
  request_id: string;
  /** ID of the accepted offer. */
  offer_id: string;
  /** Inline result content (for small payloads). */
  content?: string;
  /** MIME type of the result. */
  content_type: string;
  /** URL to fetch large results. */
  result_url?: string;
  /** Size of the result in bytes. */
  result_size?: number;
  /** SHA-256 hash of the result content for integrity. */
  result_hash: string;
  /** Actual execution time in milliseconds. */
  execution_time_ms: number;
  /** AI model used (if applicable). */
  model_used?: string;
  /** Description of the methodology or approach. */
  methodology?: string;
}

/** Payload for settlement payment. */
export interface PaymentPayload {
  /** ID of the original request. */
  request_id: string;
  /** ID of the accepted offer. */
  offer_id: string;
  /** On-chain transaction hash. */
  tx_hash: string;
  /** Payment amount in USDC. */
  amount: string;
  /** Settlement currency. */
  currency: "USDC";
  /** Settlement network. */
  network: "base";
  /** Payer's on-chain address. */
  payer_address: string;
  /** Payee's on-chain address. */
  payee_address: string;
  /** Protocol fee transfer tx hash (nullable if fee skipped or failed). */
  fee_tx_hash?: string;
}

/** Payload for verifying a delivered result and authorizing payment. */
export interface VerifyPayload {
  /** ID of the original request interaction. */
  request_id: string;
  /** ID of the accepted offer interaction. */
  offer_id: string;
  /** SHA-256 hash of the result — MUST match ResultPayload.result_hash. */
  result_hash: string;
  /** true = result accepted and payment authorized; false = result disputed. */
  verified: boolean;
  /** Human-readable dispute reason. Required if verified = false. */
  dispute_reason?: string;
  /** Machine-readable dispute code. Required if verified = false. */
  dispute_code?: "WRONG_RESULT" | "INCOMPLETE" | "TIMEOUT" | "QUALITY" | "OTHER";
}

/** Payload for protocol error messages. */
export interface ErrorPayload {
  /** Machine-readable error code. */
  code: string;
  /** Human-readable error description. */
  message: string;
  /** ID of the message that caused the error. */
  related_message_id?: string;
}

/** Consumer's acceptance policy configuration. */
export interface AcceptancePolicy {
  /** How to handle incoming offers. */
  acceptance_policy: "auto" | "human_approval" | "threshold";
  /** Budget threshold for auto-acceptance. */
  threshold_amount?: number;
  /** Minimum trust score required from providers (0-1). */
  min_trust_score: number;
  /** Maximum budget per individual task in USDC. */
  max_budget_per_task: number;
  /** List of capability IDs this policy applies to. */
  allowed_capabilities: string[];
}
