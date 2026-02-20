/**
 * x811 Protocol — Error codes and typed error class.
 */

/** All x811 protocol error codes organized by domain. */
export enum X811ErrorCode {
  // Identity (1xxx)
  DID_NOT_FOUND = "X811-1001",
  DID_REVOKED = "X811-1002",
  DID_DEACTIVATED = "X811-1003",
  INVALID_DID_FORMAT = "X811-1004",

  // Authentication (2xxx)
  INVALID_SIGNATURE = "X811-2001",
  NONCE_REUSED = "X811-2002",
  TIMESTAMP_EXPIRED = "X811-2003",
  UNAUTHORIZED = "X811-2004",

  // Registry (3xxx)
  AGENT_NOT_FOUND = "X811-3001",
  AGENT_ALREADY_EXISTS = "X811-3002",
  CAPABILITY_NOT_FOUND = "X811-3003",
  NO_PROVIDERS_AVAILABLE = "X811-3004",

  // Negotiation (4xxx)
  OFFER_EXPIRED = "X811-4001",
  OFFER_REJECTED = "X811-4002",
  PRICE_EXCEEDS_BUDGET = "X811-4003",
  DEADLINE_TOO_SHORT = "X811-4004",
  TRUST_TOO_LOW = "X811-4005",
  DUPLICATE_REQUEST = "X811-4006",

  // Settlement (5xxx)
  PAYMENT_FAILED = "X811-5001",
  INSUFFICIENT_FUNDS = "X811-5002",
  PAYMENT_VERIFICATION_FAILED = "X811-5003",

  // Result (6xxx)
  INVALID_RESULT_SCHEMA = "X811-6001",
  RESULT_HASH_MISMATCH = "X811-6002",
  SANITY_CHECK_FAILED = "X811-6003",
  RESULT_TIMEOUT = "X811-6004",

  // System (9xxx)
  RATE_LIMIT_EXCEEDED = "X811-9001",
  INTERNAL_ERROR = "X811-9002",
  CHAIN_SUBMISSION_FAILED = "X811-9003",
}

/** HTTP status code mapping for error codes. */
const ERROR_HTTP_STATUS: Record<string, number> = {
  "X811-1001": 404,
  "X811-1002": 410,
  "X811-1003": 410,
  "X811-1004": 400,
  "X811-2001": 401,
  "X811-2002": 409,
  "X811-2003": 401,
  "X811-2004": 403,
  "X811-3001": 404,
  "X811-3002": 409,
  "X811-3003": 404,
  "X811-3004": 503,
  "X811-4001": 410,
  "X811-4002": 409,
  "X811-4003": 400,
  "X811-4004": 400,
  "X811-4005": 403,
  "X811-4006": 409,
  "X811-5001": 502,
  "X811-5002": 402,
  "X811-5003": 502,
  "X811-6001": 400,
  "X811-6002": 409,
  "X811-6003": 422,
  "X811-6004": 504,
  "X811-9001": 429,
  "X811-9002": 500,
  "X811-9003": 502,
};

/** Typed error for x811 protocol operations. */
export class X811Error extends Error {
  /** Machine-readable error code. */
  public readonly code: X811ErrorCode;
  /** HTTP status code for API responses. */
  public readonly httpStatus: number;
  /** Additional error context. */
  public readonly details?: Record<string, unknown>;

  constructor(
    code: X811ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "X811Error";
    this.code = code;
    this.httpStatus = ERROR_HTTP_STATUS[code] ?? 500;
    this.details = details;

    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, X811Error.prototype);
  }
}
