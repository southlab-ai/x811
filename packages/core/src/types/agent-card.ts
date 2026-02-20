/**
 * x811 Protocol — Agent Card types for agent discovery and capability advertisement.
 */

import type { DIDStatus } from "./did.js";

/** JSON Schema type alias. */
export type JSONSchema = Record<string, unknown>;

/** Pricing model for a capability. */
export interface PricingModel {
  /** Pricing strategy. */
  model: "fixed" | "per-request" | "per-unit" | "range";
  /** Fixed price or per-unit price (USDC). */
  amount?: string;
  /** Price range for "range" model. */
  range?: {
    min: string;
    max: string;
  };
  /** Unit of measurement for "per-unit" model. */
  unit?: string;
  /** Settlement currency. */
  currency: "USDC";
}

/** A single capability advertised by an agent. */
export interface Capability {
  /** Unique capability identifier. */
  id: string;
  /** Human-readable capability name. */
  name: string;
  /** Description of what this capability does. */
  description?: string;
  /** JSON Schema for capability input. */
  input_schema: JSONSchema;
  /** JSON Schema for capability output. */
  output_schema: JSONSchema;
  /** Pricing information. */
  pricing: PricingModel;
}

/** Public agent card for discovery and trust evaluation. */
export interface AgentCard {
  /** Agent display name. */
  name: string;
  /** Agent description. */
  description: string;
  /** Agent endpoint URL. */
  url: string;
  /** Agent card version. */
  version: string;
  /** List of capabilities this agent offers. */
  capabilities: Capability[];
  /** x811 protocol-specific metadata. */
  x811: {
    /** Agent's Decentralized Identifier. */
    did: string;
    /** Trust score from 0 to 1. */
    trust_score: number;
    /** ISO 8601 timestamp of when the agent was first verified. */
    verified_since: string;
    /** Total number of completed interactions. */
    interaction_count: number;
    /** On-chain payment address. */
    payment_address: string;
    /** Settlement network. */
    network: "base";
    /** Current DID status. */
    status: DIDStatus;
  };
}
