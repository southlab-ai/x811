# x811 Agent Economic Execution Protocol (AEEP) — Negotiation Layer Specification

**Document ID:** x811-AEEP-v0.1.0
**Version:** 0.1.0
**Status:** draft-experimental
**Date:** 2026-02-20
**Repository:** https://github.com/southlab-ai/x811

---

## 1. Abstract

The x811 Agent Economic Execution Protocol (AEEP) defines a negotiation layer for autonomous AI agents to conduct economic transactions. It specifies price negotiation, capability discovery, result verification, and economic settlement coordination between agents operating without human intervention. AEEP occupies the protocol gap explicitly left open by ERC-8004 (agent identity), x402 (payment execution), A2A (task delegation), and ANP (agent communication) — none of which define how agents negotiate price, verify deliverables, or coordinate payment conditioned on result quality. This specification provides the complete state machine, message schemas, cryptographic envelope format, security requirements, and timing constraints necessary for interoperable implementations.

---

## 2. Status of This Memo

This document specifies an experimental protocol for the x811 ecosystem. It is published for discussion and evaluation purposes. This is NOT an Internet Engineering Task Force (IETF) standard. It has not been submitted for IETF review and does not represent the consensus of any standards body.

**Version:** 0.1.0 (draft-experimental)

**Distribution:** Unlimited. This document may be freely distributed and referenced.

Implementors should be aware that this specification is subject to change. Feedback is solicited and should be directed to the x811 repository issue tracker at https://github.com/southlab-ai/x811/issues.

---

## 3. Table of Contents

1. [Abstract](#1-abstract)
2. [Status of This Memo](#2-status-of-this-memo)
3. [Table of Contents](#3-table-of-contents)
4. [Introduction & Motivation](#4-introduction--motivation)
5. [Terminology](#5-terminology)
6. [Protocol Architecture](#6-protocol-architecture)
7. [State Machine (Normative)](#7-state-machine-normative)
8. [Message Types (Normative)](#8-message-types-normative)
9. [Cryptographic Envelope (Normative)](#9-cryptographic-envelope-normative)
10. [Security Requirements (Normative)](#10-security-requirements-normative)
11. [Timing Requirements (Normative)](#11-timing-requirements-normative)
12. [Error Code Registry (Normative)](#12-error-code-registry-normative)
13. [Acceptance Policy Semantics (Normative)](#13-acceptance-policy-semantics-normative)
14. [Extensibility Rules (Normative)](#14-extensibility-rules-normative)
15. [Relationship to Other Standards](#15-relationship-to-other-standards)
16. [References](#16-references)
17. [Appendix A: SSE Transport (Informative)](#17-appendix-a-sse-transport-informative)
18. [Appendix B: Implementation Notes (Informative)](#18-appendix-b-implementation-notes-informative)

---

## 4. Introduction & Motivation

Autonomous AI agents require a protocol to negotiate, execute, and settle economic transactions without human intervention. Several emerging standards address adjacent concerns but explicitly defer the negotiation problem:

- **ERC-8004** (Ethereum Agent Registry Protocol) defines an on-chain registry for agent identity and reputation. Its specification states in the Payments section: "Payments are orthogonal to this protocol." ERC-8004 provides the identity layer but no mechanism for agents to agree on price, scope, or deliverables before work begins.

- **x402** (HTTP 402 Payment Extension) defines HTTP payment headers that allow servers to request payment before serving resources. However, x402 supports only static, server-determined pricing. There is no negotiation mechanism — the client either pays the stated price or receives no service. Dynamic pricing, counter-offers, and conditional payment based on result quality are outside its scope.

- **A2A** (Agent-to-Agent Protocol, Google, 2025) defines a framework for task delegation between agents, including capability discovery via Agent Cards and structured task lifecycle management. A2A handles the "what" of agent collaboration but does not address economic settlement — there is no specification for how agents agree on compensation, verify deliverables against payment terms, or resolve disputes over result quality.

- **ANP** (Agent Network Protocol, Ant Group, 2025) provides a communication layer for agent-to-agent messaging with DID-based identity. The ANP specification explicitly acknowledges that "economic incentives require in-depth research" and defers this concern entirely.

**x811 AEEP defines the negotiation layer that these standards explicitly left open.** It specifies:

1. **Price negotiation**: How an initiator requests work with a budget constraint and how a provider responds with a binding price offer.
2. **Trust-gated acceptance**: How acceptance policies gate offer acceptance on provider trust scores, budget thresholds, and human escalation.
3. **Result verification**: How the initiator verifies delivered results against cryptographic hashes before payment is released.
4. **Settlement coordination**: How payment is triggered only after successful verification, with timeout-based dispute escalation.

A typical AEEP interaction follows the sequence: REQUEST, OFFER, ACCEPT, RESULT, VERIFY, PAYMENT. Each step is authenticated via a signed cryptographic envelope, governed by a deterministic state machine, and bounded by configurable time-to-live constraints.

---

## 5. Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [RFC 2119].

| Term | Definition |
|---|---|
| **Initiator** | The consumer agent that requests a task and pays for the result. The initiator sends REQUEST, ACCEPT/REJECT, VERIFY, and PAYMENT messages. |
| **Provider** | The service agent that receives a task request, produces a result, and receives payment. The provider sends OFFER, RESULT messages. |
| **Interaction** | A single negotiation lifecycle instance, identified by a unique interaction ID. An interaction transitions through the state machine from creation to a terminal state (completed, expired, rejected, disputed, or failed). |
| **X811Envelope** | The signed message container that wraps all protocol messages. Contains version, identifiers, timestamps, payload, and an Ed25519 signature. See [Section 9](#9-cryptographic-envelope-normative). |
| **DID** | Decentralized Identifier, as defined by [W3C DID Core]. In x811, the `did:x811` method is used, where each DID resolves to a DID document containing the agent's public keys. |
| **TTL** | Time-to-Live. The maximum duration allowed for a state transition before the interaction is automatically moved to an expiry or failure state. |
| **Agent Card** | A machine-readable document advertising an agent's capabilities, endpoint, and trust metadata. Compatible with A2A Agent Card format with x811 extensions. |
| **Trust Score** | A numerical value in the range [0.0, 1.0] representing an agent's reliability based on historical interaction outcomes. New agents start at 0.5. |
| **Protocol Fee** | A 2.5% fee on the transaction value, denominated in USDC, collected to fund dispute resolution, gas subsidies, community development, and token burn. |

---

## 6. Protocol Architecture

x811 AEEP operates as Layer 3 in a four-layer protocol stack:

```
+-----------------------------------------------------------+
|  Layer 4: Settlement                                      |
|  (USDC on Base L2 — implementation choice)                |
+-----------------------------------------------------------+
|  Layer 3: Negotiation                                     |
|  (x811 AEEP — THIS SPECIFICATION)                         |
+-----------------------------------------------------------+
|  Layer 2: Delivery                                        |
|  (X811Envelope — signed, authenticated message container) |
+-----------------------------------------------------------+
|  Layer 1: Transport                                       |
|  (HTTP poll, SSE, WebSocket — implementation choice)      |
+-----------------------------------------------------------+
```

**Scope:** This specification defines Layer 3 (Negotiation) only. The normative requirements in this document constrain the behavior of the negotiation state machine, message schemas, and security properties. Layers 1, 2, and 4 are referenced for context but their implementations are not constrained by this specification.

**Transport agnosticism:** AEEP is transport-agnostic. Compliant implementations MAY use HTTP polling, Server-Sent Events (SSE), WebSocket, or any reliable message delivery mechanism. The only transport requirement is that messages MUST be delivered at least once and in causal order within a single interaction.

**Settlement agnosticism:** While this specification references USDC on Base L2 as the reference settlement mechanism, compliant implementations MAY use any settlement layer that can provide transaction hashes and on-chain confirmation. The normative requirement is that payment messages MUST include a verifiable transaction reference.

---

## 7. State Machine (Normative)

### 7.1 States

An interaction MUST be in exactly one of the following 10 states at any given time:

| State | Terminal | Description |
|---|---|---|
| `pending` | No | Initial state. A REQUEST has been sent; awaiting OFFER from provider. |
| `offered` | No | Provider has sent an OFFER; awaiting ACCEPT or REJECT from initiator. |
| `accepted` | No | Initiator has accepted the OFFER; provider is executing the task. |
| `delivered` | No | Provider has delivered the RESULT; awaiting VERIFY from initiator. |
| `verified` | No | Initiator has verified the result; awaiting PAYMENT. |
| `completed` | Yes | Payment confirmed. Interaction is successfully finished. |
| `expired` | Yes | A TTL deadline was missed. No further messages are accepted. |
| `rejected` | Yes | Initiator rejected the OFFER. No further messages are accepted. |
| `disputed` | Yes | Verification failed or payment timed out. Dispute resolution required. |
| `failed` | Yes | Verification TTL expired. No further messages are accepted. |

### 7.2 Transition Table

| From State | Triggering Message | To State | Guard Conditions | Error If Invalid |
|---|---|---|---|---|
| `pending` | x811/offer (from provider) | `offered` | offer.price MUST NOT exceed request.max_budget; offer.expiry MUST be a positive integer | X811-4001 |
| `offered` | x811/accept (from initiator) | `accepted` | Offer MUST NOT be expired; accept.offer_hash MUST match SHA-256 of canonical OFFER payload | X811-4001, X811-4010 |
| `offered` | x811/reject (from initiator) | `rejected` | None | X811-4001 |
| `offered` | TTL expired (5 min offer window) | `expired` | Automatic; server background check | X811-4021 |
| `accepted` | x811/result (from provider) | `delivered` | Offer MUST NOT be expired; result_hash MUST be present | X811-4001 |
| `accepted` | TTL expired (1 hour result window) | `expired` | Automatic; server background check | X811-4022 |
| `delivered` | x811/verify (verified=true, from initiator) | `verified` | verify.result_hash MUST match result.result_hash | X811-6001 |
| `delivered` | x811/verify (verified=false, from initiator) | `disputed` | dispute_reason and dispute_code MUST be present | X811-4001 |
| `delivered` | TTL expired (30 second verify window) | `failed` | Automatic; server background check | X811-4023 |
| `verified` | x811/payment (from initiator) | `completed` | payment.amount MUST be greater than or equal to offer.total_cost; tx_hash MUST be present and valid | X811-5001 |
| `verified` | TTL expired (60 second payment window) | `disputed` | Automatic; server background check | X811-4024 |

### 7.3 Invalid Transitions

The following transitions MUST be rejected by a compliant server. The server MUST respond with the indicated error code.

| Attempted Action | Current State | Error Code |
|---|---|---|
| Any message | `completed` | X811-4001 |
| Any message | `expired` | X811-4001 |
| Any message | `rejected` | X811-4001 |
| Any message | `failed` | X811-4001 |
| Any message (except future dispute resolution) | `disputed` | X811-4001 |
| x811/offer | Any state other than `pending` | X811-4001 |
| x811/accept | Any state other than `offered` | X811-4001 |
| x811/reject | Any state other than `offered` | X811-4001 |
| x811/result | Any state other than `accepted` | X811-4001 |
| x811/verify | Any state other than `delivered` | X811-4001 |
| x811/payment | Any state other than `verified` | X811-4001 |

### 7.4 State Diagram

```
                          x811/offer                x811/accept               x811/result
    +---------+  ───────────────>  +---------+  ───────────────>  +----------+  ──────────────>  +-----------+
    | pending |                    | offered |                    | accepted |                   | delivered |
    +---------+                    +---------+                    +----------+                   +-----------+
         |                          |       |                         |                           |        |
         |                          |       |                         |                           |        |
    TTL (60s)                  TTL (5m)  x811/reject              TTL (1h)                  TTL (30s)  x811/verify
    no offer                   no accept                          no result                  no verify   (verified
    received                       |       |                         |                           |       =false)
         |                         |       |                         |                           |        |
         v                         v       v                         v                           v        v
    +---------+               +---------+  +---------+          +---------+                 +--------+ +---------+
    | expired |               | expired |  | rejected|          | expired |                 | failed | |disputed |
    +---------+               +---------+  +---------+          +---------+                 +--------+ +---------+


                x811/verify                 x811/payment
    +-----------+  (verified=true)  +----------+  ───────────────>  +-----------+
    | delivered |  ──────────────>  | verified |                    | completed |
    +-----------+                   +----------+                    +-----------+
                                         |
                                    TTL (60s)
                                    no payment
                                         |
                                         v
                                    +---------+
                                    | disputed|
                                    +---------+
```

---

## 8. Message Types (Normative)

AEEP defines 8 message types. Each message is transported inside an X811Envelope (see [Section 9](#9-cryptographic-envelope-normative)). The `type` field of the envelope MUST be set to the corresponding message type identifier.

All message payloads permit additional properties beyond those defined here (`"additionalProperties": true`). Receivers MUST ignore unknown properties (see [Section 14](#14-extensibility-rules-normative)).

### 8.1 x811/request

The initiator sends a REQUEST to a provider to solicit an offer for a specific task.

**Schema:**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "x811/request",
  "type": "object",
  "required": ["task_type", "parameters", "max_budget", "currency", "deadline", "acceptance_policy", "idempotency_key"],
  "properties": {
    "task_type": {
      "type": "string",
      "description": "Capability identifier matching a registered provider capability"
    },
    "parameters": {
      "type": "object",
      "description": "Task-specific parameters passed to the provider"
    },
    "max_budget": {
      "type": "number",
      "minimum": 0,
      "description": "Maximum budget in USDC the initiator is willing to pay (inclusive of protocol fee)"
    },
    "currency": {
      "type": "string",
      "const": "USDC"
    },
    "deadline": {
      "type": "integer",
      "minimum": 1,
      "description": "Maximum execution time in seconds the initiator will wait for a result"
    },
    "acceptance_policy": {
      "type": "string",
      "enum": ["auto", "human_approval", "threshold"],
      "description": "Policy governing how the initiator handles incoming offers"
    },
    "threshold_amount": {
      "type": "number",
      "minimum": 0,
      "description": "For threshold policy: auto-accept offers at or below this amount"
    },
    "callback_url": {
      "type": "string",
      "format": "uri",
      "description": "Optional URL for asynchronous result delivery notifications"
    },
    "idempotency_key": {
      "type": "string",
      "description": "UUIDv4 preventing duplicate request processing"
    }
  },
  "additionalProperties": true
}
```

**Example:**

```json
{
  "task_type": "financial-analysis",
  "parameters": {
    "ticker": "ETH",
    "period": "7d",
    "metrics": ["price", "volume", "volatility"]
  },
  "max_budget": 0.05,
  "currency": "USDC",
  "deadline": 60,
  "acceptance_policy": "auto",
  "idempotency_key": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

### 8.2 x811/offer

The provider responds to a REQUEST with an OFFER containing a binding price, estimated completion time, and list of deliverables.

**Schema:**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "x811/offer",
  "type": "object",
  "required": ["request_id", "price", "protocol_fee", "total_cost", "currency", "estimated_time", "deliverables", "expiry"],
  "properties": {
    "request_id": {
      "type": "string",
      "description": "The envelope ID of the original REQUEST message"
    },
    "price": {
      "type": "string",
      "description": "Provider's price in USDC (string type preserves decimal precision)"
    },
    "protocol_fee": {
      "type": "string",
      "description": "Protocol fee (2.5% of price) in USDC"
    },
    "total_cost": {
      "type": "string",
      "description": "Total cost to initiator: price + protocol_fee"
    },
    "currency": {
      "type": "string",
      "const": "USDC"
    },
    "estimated_time": {
      "type": "integer",
      "minimum": 1,
      "description": "Estimated task completion time in seconds"
    },
    "deliverables": {
      "type": "array",
      "items": { "type": "string" },
      "minItems": 1,
      "description": "List of deliverable descriptions the provider commits to"
    },
    "terms": {
      "type": "string",
      "description": "Optional human-readable terms or conditions"
    },
    "expiry": {
      "type": "integer",
      "minimum": 1,
      "description": "Offer validity duration in seconds from envelope created timestamp"
    },
    "payment_address": {
      "type": "string",
      "description": "Checksummed Ethereum address for receiving USDC payment"
    }
  },
  "additionalProperties": true
}
```

**Example:**

```json
{
  "request_id": "0190a1b2-c3d4-7e5f-8901-234567890abc",
  "price": "0.029",
  "protocol_fee": "0.000725",
  "total_cost": "0.029725",
  "currency": "USDC",
  "estimated_time": 30,
  "deliverables": [
    "7-day ETH price analysis with trend indicators",
    "Volume-weighted average price calculation",
    "Volatility assessment with confidence intervals"
  ],
  "expiry": 300,
  "payment_address": "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18"
}
```

### 8.3 x811/accept

The initiator accepts a provider's OFFER, authorizing the provider to begin work.

**Schema:**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "x811/accept",
  "type": "object",
  "required": ["offer_id", "offer_hash"],
  "properties": {
    "offer_id": {
      "type": "string",
      "description": "The envelope ID of the OFFER message being accepted"
    },
    "offer_hash": {
      "type": "string",
      "description": "SHA-256 hex digest of the RFC 8785 canonicalized OFFER payload, ensuring integrity"
    }
  },
  "additionalProperties": true
}
```

**Example:**

```json
{
  "offer_id": "0190a1b2-d4e5-7f60-9012-345678901bcd",
  "offer_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
}
```

### 8.4 x811/reject

The initiator rejects a provider's OFFER with a reason code.

**Schema:**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "x811/reject",
  "type": "object",
  "required": ["offer_id", "reason", "code"],
  "properties": {
    "offer_id": {
      "type": "string",
      "description": "The envelope ID of the OFFER message being rejected"
    },
    "reason": {
      "type": "string",
      "description": "Human-readable explanation for the rejection"
    },
    "code": {
      "type": "string",
      "enum": ["PRICE_TOO_HIGH", "DEADLINE_TOO_SHORT", "TRUST_TOO_LOW", "POLICY_REJECTED", "OTHER"],
      "description": "Machine-readable rejection reason code"
    }
  },
  "additionalProperties": true
}
```

**Example:**

```json
{
  "offer_id": "0190a1b2-d4e5-7f60-9012-345678901bcd",
  "reason": "Offered price exceeds budget threshold for auto-acceptance",
  "code": "PRICE_TOO_HIGH"
}
```

### 8.5 x811/result

The provider delivers the task result to the initiator after completing the work.

**Schema:**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "x811/result",
  "type": "object",
  "required": ["request_id", "offer_id", "content_type", "result_hash", "execution_time_ms"],
  "properties": {
    "request_id": {
      "type": "string",
      "description": "The envelope ID of the original REQUEST message"
    },
    "offer_id": {
      "type": "string",
      "description": "The envelope ID of the accepted OFFER message"
    },
    "content": {
      "type": "string",
      "description": "Inline result content (for small payloads)"
    },
    "content_type": {
      "type": "string",
      "description": "MIME type of the result content (e.g., application/json, text/plain)"
    },
    "result_url": {
      "type": "string",
      "format": "uri",
      "description": "URL for retrieving large result payloads out-of-band"
    },
    "result_size": {
      "type": "integer",
      "minimum": 0,
      "description": "Size of the result content in bytes"
    },
    "result_hash": {
      "type": "string",
      "description": "SHA-256 hex digest of the result content for integrity verification"
    },
    "execution_time_ms": {
      "type": "integer",
      "minimum": 0,
      "description": "Actual task execution time in milliseconds"
    },
    "model_used": {
      "type": "string",
      "description": "Identifier of the AI model used (if applicable)"
    },
    "methodology": {
      "type": "string",
      "description": "Description of the methodology or approach used"
    }
  },
  "additionalProperties": true
}
```

**Example:**

```json
{
  "request_id": "0190a1b2-c3d4-7e5f-8901-234567890abc",
  "offer_id": "0190a1b2-d4e5-7f60-9012-345678901bcd",
  "content": "{\"ticker\":\"ETH\",\"period\":\"7d\",\"trend\":\"bullish\",\"vwap\":2847.32}",
  "content_type": "application/json",
  "result_hash": "a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a",
  "execution_time_ms": 12500,
  "model_used": "claude-sonnet-4-6",
  "methodology": "Multi-source price aggregation with statistical trend analysis"
}
```

### 8.6 x811/verify

The initiator verifies the delivered result. If `verified` is `true`, the interaction proceeds to payment. If `verified` is `false`, the interaction moves to a disputed state.

**Schema:**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "x811/verify",
  "type": "object",
  "required": ["request_id", "offer_id", "result_hash", "verified"],
  "properties": {
    "request_id": {
      "type": "string",
      "description": "The envelope ID of the original REQUEST message"
    },
    "offer_id": {
      "type": "string",
      "description": "The envelope ID of the accepted OFFER message"
    },
    "result_hash": {
      "type": "string",
      "description": "SHA-256 hex digest that MUST match the result_hash in the RESULT message"
    },
    "verified": {
      "type": "boolean",
      "description": "true if the result is accepted; false if disputed"
    },
    "dispute_reason": {
      "type": "string",
      "description": "Human-readable dispute explanation (REQUIRED when verified=false)"
    },
    "dispute_code": {
      "type": "string",
      "enum": ["WRONG_RESULT", "INCOMPLETE", "TIMEOUT", "QUALITY", "OTHER"],
      "description": "Machine-readable dispute code (REQUIRED when verified=false)"
    }
  },
  "additionalProperties": true
}
```

**Example (verified):**

```json
{
  "request_id": "0190a1b2-c3d4-7e5f-8901-234567890abc",
  "offer_id": "0190a1b2-d4e5-7f60-9012-345678901bcd",
  "result_hash": "a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a",
  "verified": true
}
```

**Example (disputed):**

```json
{
  "request_id": "0190a1b2-c3d4-7e5f-8901-234567890abc",
  "offer_id": "0190a1b2-d4e5-7f60-9012-345678901bcd",
  "result_hash": "a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a",
  "verified": false,
  "dispute_reason": "Result missing volatility assessment with confidence intervals",
  "dispute_code": "INCOMPLETE"
}
```

### 8.7 x811/payment

The initiator confirms payment to the provider after successful verification.

**Schema:**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "x811/payment",
  "type": "object",
  "required": ["request_id", "offer_id", "tx_hash", "amount", "currency", "network", "payer_address", "payee_address"],
  "properties": {
    "request_id": {
      "type": "string",
      "description": "The envelope ID of the original REQUEST message"
    },
    "offer_id": {
      "type": "string",
      "description": "The envelope ID of the accepted OFFER message"
    },
    "tx_hash": {
      "type": "string",
      "description": "On-chain transaction hash of the USDC transfer"
    },
    "amount": {
      "type": "string",
      "description": "Amount paid in USDC (string for precision)"
    },
    "currency": {
      "type": "string",
      "const": "USDC"
    },
    "network": {
      "type": "string",
      "const": "base",
      "description": "Settlement network identifier"
    },
    "payer_address": {
      "type": "string",
      "description": "Checksummed Ethereum address of the payer (initiator)"
    },
    "payee_address": {
      "type": "string",
      "description": "Checksummed Ethereum address of the payee (provider)"
    },
    "fee_tx_hash": {
      "type": "string",
      "description": "Transaction hash of the protocol fee transfer (if separate)"
    }
  },
  "additionalProperties": true
}
```

**Example:**

```json
{
  "request_id": "0190a1b2-c3d4-7e5f-8901-234567890abc",
  "offer_id": "0190a1b2-d4e5-7f60-9012-345678901bcd",
  "tx_hash": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  "amount": "0.029725",
  "currency": "USDC",
  "network": "base",
  "payer_address": "0xAbC1234567890DefAbC1234567890DefAbC12345",
  "payee_address": "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18",
  "fee_tx_hash": "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
}
```

### 8.8 x811/error

An error message sent by either party or the server to indicate a protocol violation, timeout, or system error.

**Schema:**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "x811/error",
  "type": "object",
  "required": ["code", "message"],
  "properties": {
    "code": {
      "type": "string",
      "description": "Error code from the x811 Error Code Registry (Section 12)"
    },
    "message": {
      "type": "string",
      "description": "Human-readable error description"
    },
    "related_message_id": {
      "type": "string",
      "description": "Envelope ID of the message that caused the error"
    }
  },
  "additionalProperties": true
}
```

**Example:**

```json
{
  "code": "X811-4001",
  "message": "Invalid state transition: cannot send x811/accept when interaction is in 'pending' state",
  "related_message_id": "0190a1b2-e5f6-7071-8901-234567890def"
}
```

---

## 9. Cryptographic Envelope (Normative)

All AEEP messages MUST be wrapped in an X811Envelope. The envelope provides authentication, integrity, replay protection, and non-repudiation for every protocol message.

### 9.1 Envelope Structure

```json
{
  "version": "0.1.0",
  "id": "<UUIDv7>",
  "type": "x811/request",
  "from": "did:x811:<uuid>",
  "to": "did:x811:<uuid>",
  "created": "2026-02-20T12:00:00.000Z",
  "expires": "2026-02-20T13:00:00.000Z",
  "nonce": "<UUIDv4>",
  "payload": { },
  "signature": "<Base64url Ed25519 signature>"
}
```

### 9.2 Field Requirements

| Field | Type | Requirement | Description |
|---|---|---|---|
| `version` | string | REQUIRED | Protocol version. MUST be a valid semver string. Current version: `"0.1.0"`. |
| `id` | string | REQUIRED | MUST be a UUIDv7 (time-ordered). Uniquely identifies this envelope. |
| `type` | string | REQUIRED | One of the 8 message types defined in [Section 8](#8-message-types-normative), or a namespaced extension type. |
| `from` | string | REQUIRED | DID of the sender. MUST be a valid `did:x811:<uuid>` identifier. |
| `to` | string | REQUIRED | DID of the intended recipient. |
| `created` | string | REQUIRED | ISO 8601 timestamp of envelope creation. |
| `expires` | string | OPTIONAL | ISO 8601 timestamp after which the envelope SHOULD be discarded. |
| `nonce` | string | REQUIRED | MUST be a UUIDv4. MUST be unique per DID within the server's nonce TTL window. |
| `payload` | object | REQUIRED | The message payload conforming to the schema for the specified `type`. |
| `signature` | string | REQUIRED | Base64url-encoded Ed25519 signature over the signable content. |

### 9.3 Signature Computation

The signature MUST be computed as follows:

1. Construct the **signable object** containing all envelope fields except `signature`:
   ```
   { version, id, type, from, to, created, expires, nonce, payload }
   ```
2. Apply **RFC 8785 JSON Canonicalization Scheme** to the signable object, producing a deterministic byte sequence.
3. Compute the **SHA-256 hash** of the canonicalized bytes.
4. Sign the SHA-256 hash using the sender's **Ed25519 private key**.
5. Encode the resulting signature as **Base64url** (RFC 4648, Section 5, no padding).

**Algorithm:** Ed25519 is RECOMMENDED. Other signature algorithms MAY be used if the algorithm is listed in the sender's DID document under the `verificationMethod` property.

### 9.4 Verification Procedure

A receiver MUST verify each incoming envelope using the following procedure:

1. **Decode** the `signature` field from Base64url.
2. **Construct** the signable object (all envelope fields except `signature`).
3. **Canonicalize** the signable object using RFC 8785.
4. **Compute** the SHA-256 hash of the canonicalized bytes.
5. **Resolve** the sender's DID document from the registry.
6. **Verify** the Ed25519 signature over the SHA-256 hash using the public key from the sender's DID document.

If verification fails, the receiver MUST reject the envelope with error code X811-2003.

---

## 10. Security Requirements (Normative)

Compliant servers MUST implement all six of the following security requirements.

### 10.1 Nonce Replay Protection

The server MUST maintain a nonce store keyed by DID with a minimum 10-minute TTL. When an envelope is received, the server MUST check whether the `nonce` value has been previously used by the same `from` DID within the TTL window. If the nonce has been seen, the server MUST reject the envelope with error code **X811-2001** (NONCE_REPLAY). The nonce MUST be recorded in the store before processing the payload.

### 10.2 Timestamp Validation

The server MUST reject any envelope whose `created` timestamp is more than 5 minutes before or after the server's current time. The server MUST respond with error code **X811-2002** (TIMESTAMP_INVALID). Implementations SHOULD use NTP-synchronized clocks to minimize drift.

### 10.3 Offer Integrity

When processing an x811/accept message, the server MUST verify that the `offer_hash` field in the ACCEPT payload equals the SHA-256 hex digest of the RFC 8785 canonicalized OFFER payload. If the hashes do not match, the server MUST reject the message with error code **X811-4010** (OFFER_HASH_MISMATCH). This prevents the initiator from accepting a different offer than the one the provider sent.

### 10.4 DID Ownership

The server MUST verify that the public key used to sign an envelope is present in the sender's current DID document. The server MUST resolve the DID document at verification time (or use a cached version no older than 5 minutes). If the DID is expired, revoked, or deactivated, the server MUST reject the envelope with error code **X811-2003** (SIGNATURE_INVALID). If the signing key is not present in the resolved DID document, the server MUST also reject with X811-2003.

### 10.5 State Sequence Enforcement

The server MUST enforce the state machine defined in [Section 7](#7-state-machine-normative). Any message that would cause an invalid state transition MUST be rejected with error code **X811-4001** (INVALID_STATE_TRANSITION). The server MUST check the current interaction state before processing any negotiation message and MUST NOT update the state unless all guard conditions are satisfied.

### 10.6 Verify-Result Hash Validation

When processing an x811/verify message, the server MUST verify that the `result_hash` field in the VERIFY payload equals the `result_hash` field from the corresponding RESULT message stored for the interaction. If the hashes do not match, the server MUST reject the message with error code **X811-6001** (RESULT_HASH_MISMATCH).

---

## 11. Timing Requirements (Normative)

Each state transition is bounded by a time-to-live (TTL). Servers MUST implement background TTL checks to enforce these deadlines. Once an interaction enters an expiry state due to TTL, it MUST NOT accept further messages.

| Transition | TTL | Terminal State on Expiry | Error Code |
|---|---|---|---|
| REQUEST sent, awaiting OFFER | 60 seconds | `expired` | X811-4020 |
| OFFER sent, awaiting ACCEPT or REJECT | 5 minutes | `expired` | X811-4021 |
| ACCEPT sent, awaiting RESULT | 1 hour | `expired` | X811-4022 |
| RESULT sent, awaiting VERIFY | 30 seconds | `failed` | X811-4023 |
| VERIFY (verified=true) sent, awaiting PAYMENT | 60 seconds | `disputed` | X811-4024 |
| PAYMENT sent, awaiting on-chain confirmation | 30 seconds | N/A (retry) | X811-5030 |

**Background TTL Checker:** Servers MUST run a background process that checks for expired interactions. The check interval SHOULD be no longer than 30 seconds. When an interaction's TTL has elapsed, the server MUST transition the interaction to the appropriate terminal state and MUST emit an x811/error message to both parties.

**Payment Retries:** Unlike other transitions, payment confirmation timeout (X811-5030) does NOT automatically expire the interaction. The initiator SHOULD retry payment with exponential backoff (recommended intervals: 5s, 15s, 60s, 300s). After 4 failed attempts, the interaction transitions to `disputed`.

---

## 12. Error Code Registry (Normative)

All error codes follow the format `X811-NNNN` where the first digit indicates the error category. Servers MUST use these codes in x811/error messages and HTTP error responses.

### X811-1xxx — Identity

| Code | Name | Description |
|---|---|---|
| X811-1001 | DID_NOT_FOUND | The specified DID is not registered in the x811 registry. |
| X811-1002 | DID_REVOKED | The specified DID has been revoked by its controller. |
| X811-1003 | DID_DEACTIVATED | The specified DID is deactivated and cannot be used. |
| X811-1004 | INVALID_PUBLIC_KEY | The public key format is invalid or the key is missing from the DID document. |
| X811-1005 | DID_DOCUMENT_INVALID | The DID document fails structural validation. |

### X811-2xxx — Authentication

| Code | Name | Description |
|---|---|---|
| X811-2001 | NONCE_REPLAY | The nonce has been used previously by this DID (replay attack detected). |
| X811-2002 | TIMESTAMP_INVALID | The envelope timestamp is outside the +/-5 minute tolerance window. |
| X811-2003 | SIGNATURE_INVALID | Ed25519 signature verification failed against the sender's DID document. |
| X811-2004 | MISSING_CREDENTIALS | Required authentication fields (signature, nonce, from) are absent. |

### X811-3xxx — Registry

| Code | Name | Description |
|---|---|---|
| X811-3001 | AGENT_NOT_FOUND | The specified agent ID or DID is not registered in the agent registry. |
| X811-3002 | CAPABILITY_NOT_REGISTERED | The provider does not advertise the requested capability. |
| X811-3003 | AGENT_OFFLINE | The agent's last heartbeat has expired; the agent is not available. |

### X811-4xxx — Negotiation

| Code | Name | Description |
|---|---|---|
| X811-4001 | INVALID_STATE_TRANSITION | The message was rejected because it would cause an invalid state transition. |
| X811-4010 | OFFER_HASH_MISMATCH | The offer_hash in the ACCEPT payload does not match the SHA-256 of the OFFER payload. |
| X811-4020 | REQUEST_TIMEOUT | No OFFER was received within 60 seconds of the REQUEST. |
| X811-4021 | OFFER_EXPIRED | The OFFER TTL (5 minutes) elapsed before the initiator sent ACCEPT or REJECT. |
| X811-4022 | RESULT_TIMEOUT | No RESULT was received within 1 hour of ACCEPT. |
| X811-4023 | VERIFY_TIMEOUT | No VERIFY was received within 30 seconds of RESULT delivery. |
| X811-4024 | PAYMENT_TIMEOUT | No PAYMENT was received within 60 seconds of successful VERIFY. |
| X811-4030 | POLICY_REJECTED | The OFFER was rejected by the initiator's acceptance policy rules. |

### X811-5xxx — Settlement

| Code | Name | Description |
|---|---|---|
| X811-5001 | INSUFFICIENT_BALANCE | The payer's USDC balance is below the required payment amount. |
| X811-5002 | INVALID_PAYMENT_ADDRESS | The payee address is not a valid checksummed Ethereum address. |
| X811-5003 | PAYMENT_FAILED | The on-chain USDC transfer transaction failed. |
| X811-5030 | PAYMENT_CONFIRMATION_TIMEOUT | Payment was not confirmed on-chain within 30 seconds. |

### X811-6xxx — Result Delivery

| Code | Name | Description |
|---|---|---|
| X811-6001 | RESULT_HASH_MISMATCH | The result_hash in the VERIFY payload does not match the result_hash in the RESULT payload. |
| X811-6002 | RESULT_TOO_LARGE | The result payload exceeds the server's maximum allowed size. |
| X811-6003 | CONTENT_TYPE_UNSUPPORTED | The result content_type is not accepted by the initiator or server. |

### X811-9xxx — System

| Code | Name | Description |
|---|---|---|
| X811-9001 | RATE_LIMIT_EXCEEDED | Too many requests from this DID or IP address. |
| X811-9002 | INTERNAL_ERROR | An unexpected server error occurred. The client SHOULD retry with exponential backoff. |
| X811-9003 | PROTOCOL_VERSION_UNSUPPORTED | The server does not support the protocol version specified in the envelope. |

---

## 13. Acceptance Policy Semantics (Normative)

The `acceptance_policy` field in a REQUEST message governs how the initiator handles incoming OFFER messages. Implementations MUST enforce the semantics described below.

### 13.1 auto

When `acceptance_policy` is `"auto"`, the initiator MUST automatically accept an OFFER if and only if ALL of the following conditions are met:

1. `offer.total_cost <= request.max_budget` (price within budget)
2. `offer.estimated_time <= request.deadline` (delivery time within deadline)
3. `provider.trust_score >= min_trust_score` (provider meets trust threshold; default minimum: 0.0)
4. The provider's DID document is valid, not expired, and not revoked.

If any condition is not met, the initiator MUST reject the OFFER with error code X811-4030 (POLICY_REJECTED) and the appropriate rejection `code` field.

The initiator MUST NOT accept offers from providers whose DID documents are expired or revoked, regardless of other conditions.

### 13.2 human_approval

When `acceptance_policy` is `"human_approval"`, the initiator MUST NOT automatically accept any OFFER. The initiator MUST escalate the OFFER to a human operator for review. The escalation MUST occur within the OFFER TTL window. If the human operator does not respond within the OFFER TTL, the OFFER expires with error code X811-4021.

### 13.3 threshold

When `acceptance_policy` is `"threshold"`, the initiator MUST behave as follows:

- If `offer.total_cost <= request.threshold_amount`: auto-accept (same conditions as `auto` policy).
- If `offer.total_cost > request.threshold_amount` AND `offer.total_cost <= request.max_budget`: escalate to human operator (same as `human_approval` policy).
- If `offer.total_cost > request.max_budget`: reject with X811-4030.

The same DID validity requirements from the `auto` policy apply to `threshold` acceptances.

---

## 14. Extensibility Rules (Normative)

### 14.1 Unknown Fields

Receivers MUST ignore unknown fields in message payloads. This ensures forward compatibility when new optional fields are added in future versions.

### 14.2 Versioning

The `version` field in the X811Envelope uses semantic versioning (MAJOR.MINOR.PATCH):

- **Patch version** bumps (e.g., 0.1.0 to 0.1.1): Bug fixes and clarifications only. No schema changes.
- **Minor version** bumps (e.g., 0.1.x to 0.2.0): Backward-compatible additions (new optional fields, new informative appendices). Receivers MUST NOT reject envelopes solely because the minor version is higher than expected.
- **Major version** bumps (e.g., 0.x.y to 1.0.0): Breaking changes (required field additions, state machine changes, removed fields). Servers MUST advertise supported major versions in their agent registration capabilities. Receivers MAY reject envelopes with unsupported major versions using X811-9003.

### 14.3 Custom Message Types

Implementations MAY define custom message types beyond the 8 specified in [Section 8](#8-message-types-normative). Custom types MUST be prefixed with an implementation namespace to avoid collisions. The format MUST be: `x811.{namespace}/{type-name}`.

Example: `x811.ext/counter-offer`, `x811.myimpl/custom-verify`.

Receivers that do not recognize a custom message type MUST ignore it and MUST NOT treat it as an error.

---

## 15. Relationship to Other Standards

x811 AEEP does not replace any of the standards listed below. It occupies the negotiation layer that each explicitly defers or does not address.

| Standard | Layer | Scope | x811 AEEP Relationship |
|---|---|---|---|
| **ERC-8004** (Agent Identity) | Identity / Reputation | On-chain agent registry, reputation scores | x811 uses DID-based identity compatible with ERC-8004. AEEP adds economic negotiation on top of the identity layer. |
| **x402** (HTTP Payments) | Payment Execution | HTTP 402 payment headers, static pricing | x402 handles the mechanics of payment (how to pay). AEEP defines when and why to pay (negotiation, verification, conditional settlement). |
| **A2A** (Google, 2025) | Task Delegation | Agent Cards, task lifecycle, capability discovery | A2A delegates tasks between agents. AEEP handles the economic settlement that A2A does not specify. Agent Cards are compatible. |
| **ANP** (Ant Group, 2025) | Communication | DID-based messaging, agent discovery | ANP provides the communication layer. AEEP adds economic incentive alignment and settlement coordination. |
| **W3C DID Core** | Identity | Decentralized Identifiers specification | x811 uses the `did:x811` method, conforming to W3C DID Core for identifier syntax and DID document structure. |
| **RFC 8785** (JCS) | Cryptography | JSON Canonicalization Scheme | Used by AEEP for deterministic serialization before signature computation. |

---

## 16. References

### Normative References

- **[RFC2119]** Bradner, S., "Key words for use in RFCs to Indicate Requirement Levels", BCP 14, RFC 2119, March 1997. https://www.rfc-editor.org/rfc/rfc2119

- **[RFC8785]** Rundgren, S., Jordan, B., Erdtman, S., "JSON Canonicalization Scheme (JCS)", RFC 8785, June 2020. https://www.rfc-editor.org/rfc/rfc8785

- **[W3C-DID]** W3C, "Decentralized Identifiers (DIDs) v1.0", W3C Recommendation, July 2022. https://www.w3.org/TR/did-core/

- **[JSON-SCHEMA-07]** Wright, A., Andrews, H., Hutton, B., "JSON Schema: A Media Type for Describing JSON Documents", draft-handrews-json-schema-01, 2018. https://json-schema.org/draft-07/schema

- **[RFC4648]** Josefsson, S., "The Base16, Base32, and Base64 Data Encodings", RFC 4648, October 2006. https://www.rfc-editor.org/rfc/rfc4648

### Informative References

- **[ERC-8004]** "ERC-8004: Ethereum Agent Registry Protocol", Ethereum Improvement Proposals. https://eips.ethereum.org/EIPS/eip-8004

- **[x402]** "x402: HTTP 402 Payment Extension", Coinbase. https://x402.org

- **[A2A]** "Agent-to-Agent Protocol", Google, 2025. https://google.github.io/A2A

- **[ANP]** "Agent Network Protocol", Ant Group, 2025. https://agent-network-protocol.com

---

## 17. Appendix A: SSE Transport (Informative)

This appendix describes one compliant transport implementation using Server-Sent Events (SSE). This is NOT normative; compliant implementations MAY use any reliable message delivery mechanism.

### 17.1 Endpoint

```
GET /api/v1/messages/{agentId}/stream
Accept: text/event-stream
```

The server MUST respond with `Content-Type: text/event-stream`.

### 17.2 Event Format

Each message is delivered as an SSE event:

```
id: {messageId}
event: message
data: {X811Envelope JSON on a single line}

```

- The `id` field MUST be set to the envelope's `id` (UUIDv7).
- The `event` field MUST be `message` for protocol messages.
- The `data` field MUST contain the complete X811Envelope serialized as a single-line JSON string.
- Events MUST be terminated by two newline characters.

### 17.3 Keepalive

The server SHOULD send a keepalive comment every 30 seconds to prevent proxy timeouts:

```
: keepalive

```

### 17.4 Reconnection

Clients SHOULD send the `Last-Event-ID` header on reconnection. The server MUST replay all undelivered messages with IDs after the specified `Last-Event-ID`. This enables zero-message-loss reconnection.

### 17.5 Connection Limits

Servers SHOULD enforce connection limits:
- RECOMMENDED: Maximum 3 SSE connections per agent DID
- RECOMMENDED: Maximum 100 global SSE connections

---

## 18. Appendix B: Implementation Notes (Informative)

This appendix provides practical guidance for implementors. These are recommendations, not normative requirements.

### 18.1 Server Implementation Notes

- **Fastify SSE:** Use `reply.hijack()` to take control of the raw socket for SSE streaming. This bypasses Fastify's response serialization pipeline.

- **Proxy Buffering:** Set the `X-Accel-Buffering: no` header on SSE responses to disable buffering in Traefik, nginx, and similar reverse proxies. Without this header, SSE events may be batched and delivered with significant delay.

- **SSE Connection Limits:** Enforce a maximum of 3 SSE connections per agent DID and 100 connections globally. Excess connections SHOULD receive HTTP 429 (Too Many Requests).

- **Store-and-Forward:** The database is the source of truth for message delivery. SSE is a fast-path optimization but is NOT authoritative. If an SSE connection drops, messages remain in the database and are delivered on the next poll or reconnection.

- **Background TTL Checker:** Run a background interval that checks for expired interactions every 30 seconds. For each expired interaction, transition to the appropriate terminal state and emit x811/error messages to both parties.

- **Nonce Storage:** Use a dedicated database table for nonce tracking, keyed by `(did, nonce)` with a `created_at` timestamp. Periodically purge entries older than 10 minutes to prevent unbounded growth.

### 18.2 Client Implementation Notes

- **Reconnection Backoff:** Use exponential backoff on SSE reconnect: 1s, 2s, 4s, 8s, 16s, with a maximum interval of 30 seconds.

- **Polling Fallback:** After 5 consecutive SSE connection failures, fall back to HTTP polling. Poll interval SHOULD start at 2 seconds and MAY increase to 10 seconds during idle periods.

- **Last-Event-ID:** Always send the `Last-Event-ID` header on SSE reconnection. This enables the server to replay missed messages, achieving zero-message-loss delivery.

- **Canonical Hashing:** When computing `offer_hash` for ACCEPT messages, ensure the OFFER payload is canonicalized using RFC 8785 before hashing. Common implementation error: hashing the JSON string as received (which may have different key ordering) rather than the canonicalized form.

- **Payment Retries:** Implement exponential backoff for payment confirmation: 5s, 15s, 60s, 300s. After 4 failed attempts, transition the local interaction state to `disputed` and notify the operator.

- **Clock Synchronization:** Ensure the client's system clock is NTP-synchronized. Timestamp validation (Section 10.2) uses a 5-minute tolerance, but sustained clock drift will cause intermittent authentication failures.

---

*End of Specification*
