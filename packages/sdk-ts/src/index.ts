/**
 * x811 Protocol — TypeScript SDK
 *
 * Public API surface for @x811/sdk.
 */

// SDK classes
export { X811Client, type X811ClientConfig } from "./client.js";
export { WalletService, MockWalletService } from "./wallet.js";

// Wallet adapter system
export type { WalletAdapter, WalletPayParams } from "./wallet-adapter.js";
export {
  EthersWalletAdapter,
  MockWalletAdapter,
  AgentKitWalletAdapter,
  isValidPaymentAddress,
} from "./wallet-adapter.js";
export { createWalletAdapter } from "./wallet-factory.js";

// Payment utilities
export type { FeePaymentParams } from "./payment-utils.js";
export { preflightBalanceCheck, executePaymentWithFee } from "./payment-utils.js";

// Re-export commonly used types from @x811/core
export type {
  // DID types
  DIDKeyPair,
  DIDDocument,
  DIDStatus,
  AgentAvailability,
  ResolvedDID,
  // Message types
  X811Envelope,
  X811MessageType,
  NegotiationStatus,
  // Negotiation payloads
  RequestPayload,
  OfferPayload,
  AcceptPayload,
  RejectPayload,
  RejectReasonCode,
  ResultPayload,
  VerifyPayload,
  PaymentPayload,
  ErrorPayload,
  AcceptancePolicy,
  // Agent card types
  AgentCard,
  Capability,
  PricingModel,
  JSONSchema,
} from "@x811/core";

// Re-export error class and codes
export { X811Error, X811ErrorCode } from "@x811/core";

// Re-export crypto utilities (useful for advanced usage)
export { signEnvelope, verifyEnvelope, hashPayload, canonicalize } from "@x811/core";

// Re-export DID utilities
export { generateDID } from "@x811/core";
