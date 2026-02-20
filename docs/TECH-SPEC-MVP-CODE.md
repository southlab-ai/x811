# x811 Protocol — Tech Spec para Coding del MVP

**Para:** Claude Code (implementación)
**Deadline:** 11 Mar 2026
**Status:** READY TO CODE

---

## Tech Stack

| Layer | Technology |
|---|---|
| Server | TypeScript + Node.js (Fastify) |
| Database | SQLite (better-sqlite3) |
| Crypto | @noble/ed25519, @noble/curves, @noble/hashes |
| DID | Custom did:web resolver |
| Smart Contract | Solidity (Foundry) on Base L2 |
| Blockchain | ethers.js v6 |
| Payments | @coinbase/x402 SDK, USDC on Base L2 |
| SDK | TypeScript (primary) |
| Monorepo | Turborepo |
| Deploy | VPS Hostinger + Dokploy (Docker, Traefik SSL) |

---

## Repository Structure

```
x811-protocol/
├── packages/
│   ├── core/                    # Shared types, crypto, DID utils
│   │   ├── src/
│   │   │   ├── types/
│   │   │   │   ├── did.ts
│   │   │   │   ├── messages.ts
│   │   │   │   ├── agent-card.ts
│   │   │   │   └── negotiation.ts
│   │   │   ├── crypto/
│   │   │   │   ├── keys.ts
│   │   │   │   ├── signing.ts
│   │   │   │   ├── encryption.ts
│   │   │   │   └── merkle.ts
│   │   │   ├── did/
│   │   │   │   ├── generate.ts
│   │   │   │   ├── resolve.ts
│   │   │   │   ├── document.ts
│   │   │   │   └── status.ts
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── server/                  # x811 Server (centralized MVP)
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   │   ├── agents.ts
│   │   │   │   ├── messages.ts
│   │   │   │   ├── verify.ts
│   │   │   │   └── well-known.ts
│   │   │   ├── services/
│   │   │   │   ├── registry.ts
│   │   │   │   ├── trust.ts
│   │   │   │   ├── router.ts
│   │   │   │   ├── batching.ts
│   │   │   │   └── relayer.ts
│   │   │   ├── db/
│   │   │   │   ├── schema.ts
│   │   │   │   └── migrations/
│   │   │   ├── middleware/
│   │   │   │   ├── auth.ts
│   │   │   │   └── rateLimit.ts
│   │   │   └── app.ts
│   │   ├── package.json
│   │   └── Dockerfile
│   │
│   ├── sdk-ts/                  # TypeScript SDK
│   │   ├── src/
│   │   │   ├── client.ts
│   │   │   ├── agent.ts
│   │   │   ├── wallet.ts
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   └── contracts/               # Solidity smart contracts
│       ├── src/
│       │   └── X811TrustAnchor.sol
│       ├── test/
│       │   └── X811TrustAnchor.t.sol
│       ├── script/
│       │   └── Deploy.s.sol
│       └── foundry.toml
│
├── demo/
│   ├── initiator/index.ts
│   ├── provider/index.ts
│   └── run-demo.sh
│
├── turbo.json
├── package.json
├── LICENSE (MIT)
└── README.md
```

---

## Core Types

### DID Types

```typescript
// packages/core/src/types/did.ts

interface DIDDocument {
  "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/suites/ed25519-2020/v1"];
  id: string;                          // "did:web:x811.org:agents:{uuid}"
  verificationMethod: [{
    id: string;                        // "{did}#key-1"
    type: "Ed25519VerificationKey2020";
    controller: string;
    publicKeyMultibase: string;        // z-base58 encoded Ed25519 public key
  }];
  authentication: [string];           // ["{did}#key-1"]
  keyAgreement: [{
    id: string;                        // "{did}#key-agreement-1"
    type: "X25519KeyAgreementKey2020";
    controller: string;
    publicKeyMultibase: string;        // z-base58 encoded X25519 public key
  }];
  service: [{
    id: string;                        // "{did}#x811-endpoint"
    type: "X811AgentService";
    serviceEndpoint: string;
  }];
}

interface DIDKeyPair {
  did: string;
  signingKey: {
    publicKey: Uint8Array;   // Ed25519 32 bytes
    privateKey: Uint8Array;  // Ed25519 64 bytes
  };
  encryptionKey: {
    publicKey: Uint8Array;   // X25519 32 bytes
    privateKey: Uint8Array;  // X25519 32 bytes
  };
}

type DIDStatus = "active" | "revoked" | "deactivated";
type AgentAvailability = "online" | "offline" | "busy" | "unknown";
```

### Message Envelope

```typescript
// packages/core/src/types/messages.ts

interface X811Envelope<T = unknown> {
  version: "0.1.0";
  id: string;                          // UUIDv7
  type: X811MessageType;
  from: string;                        // DID sender
  to: string;                          // DID recipient
  created: string;                     // ISO 8601
  expires?: string;                    // ISO 8601
  payload: T;
  signature: string;                   // Base64url Ed25519 signature
  nonce: string;                       // Replay protection
}

type X811MessageType =
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

type NegotiationStatus =
  | "pending"      // REQUEST sent, waiting OFFER
  | "offered"      // OFFER received, waiting ACCEPT
  | "accepted"     // ACCEPT sent, provider working
  | "delivered"    // RESULT received, verifying
  | "verified"     // Merkle anchored, waiting PAY
  | "completed"    // PAY confirmed
  | "expired"      // TTL expired
  | "rejected"     // Explicitly rejected
  | "disputed"     // Quality dispute
  | "failed";      // Unrecoverable error

const MESSAGE_LIMITS = {
  MAX_ENVELOPE_SIZE: 1_048_576,    // 1MB
  MAX_INLINE_PAYLOAD: 524_288,     // 512KB
  MAX_RESULT_URL_FILE: 52_428_800, // 50MB via URL
  NONCE_TTL_HOURS: 24,
  MAX_CLOCK_SKEW_MINUTES: 5,
};

const NEGOTIATION_TTLS = {
  REQUEST_TO_OFFER: 60,       // 60s
  OFFER_TO_ACCEPT: 300,       // 5 min
  ACCEPT_TO_RESULT: 3600,     // 1h
  RESULT_TO_VERIFY: 30,       // 30s
  VERIFY_TO_PAY: 60,          // 60s
  PAY_CONFIRMATION: 30,       // 30s
  PAYMENT_MAX_RETRIES: 4,     // backoff: 5s, 15s, 60s, 300s
};

// Signature covers: version + id + type + from + to + created + expires + payload + nonce
// Serialized as canonical JSON (sorted keys, no whitespace)
```

### Negotiation Messages

```typescript
// packages/core/src/types/negotiation.ts

interface RequestPayload {
  task_type: string;
  parameters: Record<string, unknown>;
  max_budget: number;                  // USDC
  currency: "USDC";
  deadline: number;                    // seconds
  acceptance_policy: "auto" | "human_approval" | "threshold";
  threshold_amount?: number;
  callback_url?: string;
  idempotency_key: string;            // UUIDv4
}

interface OfferPayload {
  request_id: string;
  price: string;                       // USDC (string for precision)
  protocol_fee: string;                // 2.5% auto-calculated
  total_cost: string;                  // price + protocol_fee
  currency: string;
  estimated_time: number;              // seconds
  deliverables: string[];
  terms?: string;
  expiry: number;                      // seconds until expires
}

interface AcceptPayload {
  offer_id: string;
  offer_hash: string;                  // SHA-256 of offer envelope
}

interface RejectPayload {
  offer_id: string;
  reason: string;
  code: "PRICE_TOO_HIGH" | "DEADLINE_TOO_SHORT" | "TRUST_TOO_LOW" | "POLICY_REJECTED" | "OTHER";
}

interface ResultPayload {
  request_id: string;
  offer_id: string;
  // Inline (< 512KB)
  content?: unknown;
  content_type: string;                // MIME type
  // URL (> 512KB)
  result_url?: string;
  result_size?: number;
  // Always present
  result_hash: string;                 // SHA-256
  execution_time_ms: number;
  model_used?: string;
  methodology?: string;
}

interface PaymentPayload {
  request_id: string;
  offer_id: string;
  tx_hash: string;                     // Base L2 tx hash
  amount: number;
  currency: "USDC";
  network: "base";
  payer_address: string;
  payee_address: string;
}

interface ErrorPayload {
  code: string;
  message: string;
  related_message_id?: string;
}
```

### Agent Card

```typescript
// packages/core/src/types/agent-card.ts

interface AgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: Capability[];
  x811: {
    did: string;
    trust_score: number;               // 0.0 - 1.0
    verified_since: string;
    interaction_count: number;
    payment_address: string;           // Base L2
    network: "base";
    status: DIDStatus;
  };
}

interface Capability {
  id: string;
  name: string;
  description?: string;
  input_schema: JSONSchema;
  output_schema: JSONSchema;
  pricing: PricingModel;
}

interface PricingModel {
  model: "fixed" | "per-request" | "per-unit" | "range";
  amount?: number;
  range?: { min: number; max: number };
  unit?: string;
  currency: "USDC";
}

type JSONSchema = Record<string, unknown>;
```

---

## Cryptography Module

### Key Generation

```typescript
// packages/core/src/crypto/keys.ts
import { ed25519 } from "@noble/curves/ed25519";
import { x25519 } from "@noble/curves/ed25519";
import { randomBytes } from "crypto";

interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

function generateSigningKeyPair(): KeyPair {
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

function generateEncryptionKeyPair(): KeyPair {
  const privateKey = randomBytes(32);
  const publicKey = x25519.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

function generateDIDKeyPair(agentId: string): DIDKeyPair {
  const did = `did:web:x811.org:agents:${agentId}`;
  return {
    did,
    signingKey: generateSigningKeyPair(),
    encryptionKey: generateEncryptionKeyPair(),
  };
}
```

### Signing & Verification

```typescript
// packages/core/src/crypto/signing.ts
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

function canonicalize(obj: unknown): string {
  return JSON.stringify(obj, Object.keys(obj as object).sort());
}

function signEnvelope<T>(envelope: Omit<X811Envelope<T>, "signature">, privateKey: Uint8Array): X811Envelope<T> {
  const signable = {
    version: envelope.version,
    id: envelope.id,
    type: envelope.type,
    from: envelope.from,
    to: envelope.to,
    created: envelope.created,
    expires: envelope.expires,
    payload: envelope.payload,
    nonce: envelope.nonce,
  };
  const message = new TextEncoder().encode(canonicalize(signable));
  const signature = ed25519.sign(message, privateKey);
  return { ...envelope, signature: Buffer.from(signature).toString("base64url") };
}

function verifyEnvelope<T>(envelope: X811Envelope<T>, publicKey: Uint8Array): boolean {
  const signable = {
    version: envelope.version,
    id: envelope.id,
    type: envelope.type,
    from: envelope.from,
    to: envelope.to,
    created: envelope.created,
    expires: envelope.expires,
    payload: envelope.payload,
    nonce: envelope.nonce,
  };
  const message = new TextEncoder().encode(canonicalize(signable));
  const signatureBytes = Buffer.from(envelope.signature, "base64url");
  return ed25519.verify(signatureBytes, message, publicKey);
}

function hashPayload(data: unknown): string {
  const bytes = new TextEncoder().encode(canonicalize(data));
  return bytesToHex(sha256(bytes));
}
```

### Merkle Tree

```typescript
// packages/core/src/crypto/merkle.ts
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

class MerkleTree {
  private leaves: Uint8Array[];
  private layers: Uint8Array[][];

  constructor(items: string[]) {
    this.leaves = items
      .map((item) => sha256(new TextEncoder().encode(item)))
      .sort(Buffer.compare);
    this.layers = this.buildTree();
  }

  private buildTree(): Uint8Array[][] {
    if (this.leaves.length === 0) return [[]];
    let layer = [...this.leaves];
    const layers = [layer];
    while (layer.length > 1) {
      const nextLayer: Uint8Array[] = [];
      for (let i = 0; i < layer.length; i += 2) {
        const left = layer[i];
        const right = i + 1 < layer.length ? layer[i + 1] : left;
        const [a, b] = Buffer.compare(left, right) <= 0 ? [left, right] : [right, left];
        nextLayer.push(sha256(new Uint8Array([...a, ...b])));
      }
      layers.push(nextLayer);
      layer = nextLayer;
    }
    return layers;
  }

  get root(): string {
    const topLayer = this.layers[this.layers.length - 1];
    return topLayer.length > 0 ? bytesToHex(topLayer[0]) : bytesToHex(sha256(new Uint8Array()));
  }

  getProof(item: string): string[] {
    const leaf = sha256(new TextEncoder().encode(item));
    let index = this.layers[0].findIndex((l) => Buffer.compare(l, leaf) === 0);
    if (index === -1) throw new Error("Item not found in tree");
    const proof: string[] = [];
    for (let i = 0; i < this.layers.length - 1; i++) {
      const layer = this.layers[i];
      const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
      if (siblingIndex < layer.length) proof.push(bytesToHex(layer[siblingIndex]));
      index = Math.floor(index / 2);
    }
    return proof;
  }

  static verify(leaf: string, proof: string[], root: string): boolean {
    let hash = sha256(new TextEncoder().encode(leaf));
    for (const sibling of proof) {
      const siblingBytes = hexToBytes(sibling);
      const [a, b] = Buffer.compare(hash, siblingBytes) <= 0 ? [hash, siblingBytes] : [siblingBytes, hash];
      hash = sha256(new Uint8Array([...a, ...b]));
    }
    return bytesToHex(hash) === root;
  }
}
```

---

## DID Module

### Generation

```typescript
// packages/core/src/did/generate.ts
import { v7 as uuidv7 } from "uuid";
import { base58btc } from "multiformats/bases/base58";

interface GeneratedDID {
  did: string;
  document: DIDDocument;
  keyPair: DIDKeyPair;
}

function generateDID(serviceEndpoint?: string): GeneratedDID {
  const agentId = uuidv7();
  const keyPair = generateDIDKeyPair(agentId);

  // Multibase encoding (z prefix = base58btc)
  const edPrefix = new Uint8Array([0xed, 0x01]);  // Ed25519 multicodec
  const edMultibase = "z" + base58btc.encode(new Uint8Array([...edPrefix, ...keyPair.signingKey.publicKey]));

  const x25519Prefix = new Uint8Array([0xec, 0x01]);  // X25519 multicodec
  const x25519Multibase = "z" + base58btc.encode(new Uint8Array([...x25519Prefix, ...keyPair.encryptionKey.publicKey]));

  const document: DIDDocument = {
    "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/suites/ed25519-2020/v1"],
    id: keyPair.did,
    verificationMethod: [{
      id: `${keyPair.did}#key-1`,
      type: "Ed25519VerificationKey2020",
      controller: keyPair.did,
      publicKeyMultibase: edMultibase,
    }],
    authentication: [`${keyPair.did}#key-1`],
    keyAgreement: [{
      id: `${keyPair.did}#key-agreement-1`,
      type: "X25519KeyAgreementKey2020",
      controller: keyPair.did,
      publicKeyMultibase: x25519Multibase,
    }],
    service: serviceEndpoint ? [{
      id: `${keyPair.did}#x811-endpoint`,
      type: "X811AgentService",
      serviceEndpoint,
    }] : [],
  };

  return { did: keyPair.did, document, keyPair };
}
```

### Resolution

```typescript
// packages/core/src/did/resolve.ts

interface ResolvedDID {
  document: DIDDocument;
  status: DIDStatus;
  publicKey: Uint8Array;
  encryptionKey: Uint8Array;
}

async function resolveDID(did: string, registryUrl: string): Promise<ResolvedDID> {
  if (!did.startsWith("did:web:x811.org:agents:")) {
    throw new Error(`Unsupported DID method: ${did}`);
  }
  const agentId = did.split(":").pop()!;
  const response = await fetch(`${registryUrl}/agents/${agentId}/did`);
  if (!response.ok) throw new Error(`DID resolution failed: ${response.status}`);
  const document: DIDDocument = await response.json();
  const publicKey = decodeMultibaseEd25519(document.verificationMethod[0].publicKeyMultibase);
  const encryptionKey = decodeMultibaseX25519(document.keyAgreement[0].publicKeyMultibase);
  const statusResponse = await fetch(`${registryUrl}/agents/${agentId}/status`);
  const { status } = await statusResponse.json();
  return { document, status, publicKey, encryptionKey };
}
```

---

## Database Schema (SQLite)

```sql
-- packages/server/src/db/schema.sql

CREATE TABLE agents (
  id              TEXT PRIMARY KEY,
  did             TEXT UNIQUE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  availability    TEXT NOT NULL DEFAULT 'unknown',
  last_seen_at    TEXT,
  name            TEXT NOT NULL,
  description     TEXT,
  endpoint        TEXT,
  payment_address TEXT,
  trust_score     REAL NOT NULL DEFAULT 0.5,
  interaction_count INTEGER NOT NULL DEFAULT 0,
  successful_count  INTEGER NOT NULL DEFAULT 0,
  failed_count      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  did_document    TEXT NOT NULL,
  agent_card      TEXT NOT NULL
);

CREATE INDEX idx_agents_status ON agents(status);
CREATE INDEX idx_agents_trust ON agents(trust_score DESC);
CREATE INDEX idx_agents_availability ON agents(availability);

CREATE TABLE capabilities (
  id        TEXT PRIMARY KEY,
  agent_id  TEXT NOT NULL REFERENCES agents(id),
  name      TEXT NOT NULL,
  metadata  TEXT,
  UNIQUE(agent_id, name)
);

CREATE INDEX idx_capabilities_name ON capabilities(name);

CREATE TABLE interactions (
  id                TEXT PRIMARY KEY,
  interaction_hash  TEXT UNIQUE NOT NULL,
  initiator_did     TEXT NOT NULL,
  provider_did      TEXT NOT NULL,
  capability        TEXT NOT NULL,
  outcome           TEXT NOT NULL,       -- success | failure | dispute | timeout
  payment_tx        TEXT,
  payment_amount    REAL,
  created_at        TEXT NOT NULL,
  batch_id          INTEGER,
  FOREIGN KEY (initiator_did) REFERENCES agents(did),
  FOREIGN KEY (provider_did) REFERENCES agents(did)
);

CREATE INDEX idx_interactions_batch ON interactions(batch_id);
CREATE INDEX idx_interactions_unbatched ON interactions(batch_id) WHERE batch_id IS NULL;

CREATE TABLE batches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  merkle_root     TEXT NOT NULL,
  interaction_count INTEGER NOT NULL,
  tx_hash         TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      TEXT NOT NULL,
  confirmed_at    TEXT
);

CREATE TABLE merkle_proofs (
  interaction_hash TEXT PRIMARY KEY,
  batch_id         INTEGER NOT NULL REFERENCES batches(id),
  proof            TEXT NOT NULL,
  leaf_hash        TEXT NOT NULL
);

CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  from_did    TEXT NOT NULL,
  to_did      TEXT NOT NULL,
  envelope    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT,
  status      TEXT NOT NULL DEFAULT 'queued',
  delivered_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT
);

CREATE INDEX idx_messages_to_did ON messages(to_did, status);
CREATE INDEX idx_messages_expires ON messages(expires_at) WHERE status = 'queued';

CREATE TABLE nonces (
  nonce      TEXT PRIMARY KEY,
  did        TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_nonces_expires ON nonces(expires_at);
```

---

## API Routes

### Registry

```
POST   /api/v1/agents                  → Register agent (signed)
GET    /api/v1/agents                  → Discovery (query: capability, trust_min, availability, limit, offset)
GET    /api/v1/agents/:id              → Agent details
GET    /api/v1/agents/:id/card         → Agent Card (A2A + x811)
GET    /api/v1/agents/:id/did          → DID Document
PUT    /api/v1/agents/:id              → Update agent (signed)
DELETE /api/v1/agents/:id              → Deactivate agent (signed)
GET    /api/v1/agents/:id/status       → DID status + availability
POST   /api/v1/agents/:id/heartbeat   → Report availability (signed)
```

**Discovery params:** `capability`, `trust_min`, `status` (default: active), `availability` (default: online), `limit` (default: 20, max: 100), `offset`

**Discovery response:**

```json
{
  "agents": [{
    "id": "019...",
    "did": "did:web:x811.org:agents:019...",
    "name": "FinAnalyst-Pro",
    "trust_score": 0.94,
    "capabilities": ["financial-analysis"],
    "pricing_hint": { "model": "range", "min": 0.01, "max": 0.05, "currency": "USDC" },
    "status": "active",
    "availability": "online",
    "last_seen_at": "2026-02-19T12:34:56Z"
  }],
  "total": 1, "limit": 20, "offset": 0
}
```

**Registration request (signed):**

```json
{
  "envelope": {
    "version": "0.1.0",
    "id": "019...",
    "type": "x811/register",
    "from": "did:web:x811.org:agents:019...",
    "to": "did:web:x811.org",
    "created": "2026-02-19T...",
    "payload": {
      "name": "FinAnalyst-Pro",
      "description": "AI financial analyst...",
      "endpoint": "https://finanalyst.example.com/x811",
      "payment_address": "0x1234...abcd",
      "capabilities": [],
      "agent_card": {}
    },
    "signature": "base64url...",
    "nonce": "uuid..."
  },
  "did_document": {},
  "public_key": "base64url..."
}
```

**Heartbeat request (signed):**

```json
{
  "envelope": {
    "type": "x811/heartbeat",
    "payload": {
      "availability": "online",
      "capacity": 5,
      "ttl": 300
    }
  }
}
```

**Availability logic:**
- Heartbeat received → update `availability` + `last_seen_at`
- No heartbeat within TTL → mark `availability = "unknown"`
- Background job every 60s checks expired TTLs
- Discovery excludes `unknown` and `offline` by default

### Messages

```
POST   /api/v1/messages              → Send signed envelope
GET    /api/v1/messages/:agentId     → Poll pending messages (authenticated)
```

**Send flow:** verify sender DID → verify signature → check nonce → verify recipient → store → attempt push delivery (or queue if offline) → return status

**Send response:**

```json
{
  "message_id": "019...",
  "status": "delivered" | "queued",
  "recipient_availability": "online" | "offline" | "unknown"
}
```

**Message expiry:** Messages with `expires_at` past current time → marked `expired`. Default: 24h.

### Verification

```
GET    /api/v1/verify/:interactionHash   → Merkle proof
GET    /api/v1/batches                   → List batches
GET    /api/v1/batches/:id               → Batch details + BaseScan link
```

**Proof response:**

```json
{
  "interaction_hash": "abc123...",
  "included": true,
  "batch_id": 42,
  "merkle_root": "def456...",
  "proof": ["aaa...", "bbb...", "ccc..."],
  "batch_tx_hash": "0x789...",
  "basescan_url": "https://basescan.org/tx/0x789...",
  "batch_timestamp": "2026-02-19T...",
  "batch_interaction_count": 100
}
```

### Well-Known + Health

```
GET    /.well-known/did.json             → x811 server DID Document
GET    /agents/:id/.well-known/agent.json → Agent Card
GET    /health                           → Health check
```

**Health response:**

```json
{
  "status": "ok",
  "version": "0.1.0",
  "agents_count": 12,
  "batches_count": 42,
  "relayer_balance_eth": "0.05",
  "pending_interactions": 37,
  "uptime_seconds": 86400
}
```

---

## Authentication Middleware

```typescript
// packages/server/src/middleware/auth.ts

// All mutation routes (POST, PUT, DELETE) require DID-based auth:
// 1. Envelope.from matches a registered DID
// 2. Signature valid for that DID's public key
// 3. Nonce not reused (stored with TTL 24h)
// 4. Created timestamp within ±5 minutes
// 5. DID status is "active"

// Read routes (GET) are public but rate-limited
// Rate limits: 100 req/min per IP (read), 20 req/min per DID (write)
```

---

## Trust Engine

```typescript
// packages/server/src/services/trust.ts

interface TrustScoreInputs {
  successful_interactions: number;
  failed_interactions: number;
  disputes: number;
  time_active_days: number;
  total_volume_usdc: number;
}

function calculateTrustScore(inputs: TrustScoreInputs): number {
  const { successful_interactions, failed_interactions, disputes, time_active_days } = inputs;
  const total = successful_interactions + failed_interactions + disputes;

  if (total === 0) return 0.5;  // New agent

  const successRate = successful_interactions / total;
  const activityFactor = Math.min(1.0, Math.log10(total + 1) / 3);
  const adjustedFailures = failed_interactions + disputes * 3;  // Disputes count 3x
  const adjustedTotal = successful_interactions + adjustedFailures;
  const adjustedRate = successful_interactions / adjustedTotal;

  // 70% adjusted rate + 20% raw success + 10% activity bonus
  const rawScore = 0.7 * adjustedRate + 0.2 * successRate + 0.1 * activityFactor;
  return Math.round(Math.max(0, Math.min(1, rawScore)) * 100) / 100;
}
```

---

## Batching Service

```typescript
// packages/server/src/services/batching.ts

const BATCH_SIZE_THRESHOLD = 100;
const BATCH_TIME_THRESHOLD_MS = 5 * 60 * 1000; // 5 min

class BatchingService {
  private pendingHashes: string[] = [];
  private lastBatchTime: number = Date.now();

  constructor(private db: Database, private relayer: RelayerService) {
    // Timer checks every 30s if time threshold exceeded
  }

  async addInteraction(interactionHash: string): Promise<void> {
    this.pendingHashes.push(interactionHash);
    if (this.pendingHashes.length >= BATCH_SIZE_THRESHOLD) {
      await this.submitBatch();
    }
  }

  async submitBatch(): Promise<void> {
    if (this.pendingHashes.length === 0) return;
    const hashes = [...this.pendingHashes];
    this.pendingHashes = [];
    this.lastBatchTime = Date.now();

    // 1. Build Merkle tree
    const tree = new MerkleTree(hashes);

    // 2. Store batch + proofs in DB
    const batchId = this.db.insertBatch(tree.root, hashes.length);
    for (const hash of hashes) {
      const proof = tree.getProof(hash);
      this.db.insertMerkleProof(hash, batchId, proof);
      this.db.updateInteractionBatch(hash, batchId);
    }

    // 3. Submit to chain via relayer
    try {
      const txHash = await this.relayer.submitBatch(`0x${tree.root}`, hashes.length);
      this.db.updateBatchStatus(batchId, "submitted", txHash);
    } catch (error) {
      this.db.updateBatchStatus(batchId, "failed");
      this.pendingHashes.push(...hashes);  // Re-queue on failure
    }
  }
}
```

---

## Relayer Service

```typescript
// packages/server/src/services/relayer.ts
import { ethers } from "ethers";

const X811_TRUST_ANCHOR_ABI = [
  "function submitBatch(bytes32 _merkleRoot, uint256 _count) external",
  "function verifyInclusion(uint256 _batchId, bytes32 _leaf, bytes32[] calldata _proof) external view returns (bool)",
  "function batchCount() external view returns (uint256)",
  "function batches(uint256) external view returns (bytes32, uint256, uint256)",
  "event BatchSubmitted(uint256 indexed batchId, bytes32 merkleRoot, uint256 interactionCount)",
];

class RelayerService {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private contract: ethers.Contract;

  constructor(rpcUrl: string, privateKey: string, contractAddress: string) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.contract = new ethers.Contract(contractAddress, X811_TRUST_ANCHOR_ABI, this.wallet);
  }

  async submitBatch(merkleRoot: string, count: number): Promise<string> {
    const tx = await this.contract.submitBatch(merkleRoot, count);
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async verifyInclusion(batchId: number, leaf: string, proof: string[]): Promise<boolean> {
    return this.contract.verifyInclusion(batchId, leaf, proof);
  }

  async getBalance(): Promise<string> {
    const balance = await this.provider.getBalance(this.wallet.address);
    return ethers.formatEther(balance);
  }
}
```

---

## Smart Contract

### X811TrustAnchor.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

contract X811TrustAnchor {
    struct Batch {
        bytes32 merkleRoot;
        uint256 timestamp;
        uint256 interactionCount;
    }

    mapping(uint256 => Batch) public batches;
    uint256 public batchCount;
    address public relayer;
    address public owner;
    bool public paused;

    event BatchSubmitted(uint256 indexed batchId, bytes32 indexed merkleRoot, uint256 interactionCount, uint256 timestamp);
    event RelayerUpdated(address indexed oldRelayer, address indexed newRelayer);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    modifier onlyRelayer() { require(msg.sender == relayer, "X811: not relayer"); _; }
    modifier onlyOwner() { require(msg.sender == owner, "X811: not owner"); _; }
    modifier whenNotPaused() { require(!paused, "X811: paused"); _; }

    constructor(address _relayer) {
        owner = msg.sender;
        relayer = _relayer;
        paused = false;
    }

    function pause() external onlyOwner { paused = true; emit Paused(msg.sender); }
    function unpause() external onlyOwner { paused = false; emit Unpaused(msg.sender); }

    function setRelayer(address _newRelayer) external onlyOwner {
        require(_newRelayer != address(0), "X811: zero address");
        emit RelayerUpdated(relayer, _newRelayer);
        relayer = _newRelayer;
    }

    function submitBatch(bytes32 _merkleRoot, uint256 _count) external onlyRelayer whenNotPaused {
        require(_merkleRoot != bytes32(0), "X811: empty root");
        require(_count > 0, "X811: empty batch");
        batches[batchCount] = Batch(_merkleRoot, block.timestamp, _count);
        emit BatchSubmitted(batchCount, _merkleRoot, _count, block.timestamp);
        batchCount++;
    }

    function verifyInclusion(uint256 _batchId, bytes32 _leaf, bytes32[] calldata _proof) external view returns (bool) {
        require(_batchId < batchCount, "X811: invalid batch");
        return MerkleProof.verify(_proof, batches[_batchId].merkleRoot, _leaf);
    }

    function totalInteractions() external view returns (uint256 total) {
        for (uint256 i = 0; i < batchCount; i++) total += batches[i].interactionCount;
    }

    function transferOwnership(address _newOwner) external onlyOwner {
        require(_newOwner != address(0), "X811: zero address");
        owner = _newOwner;
    }
}
```

### Contract Tests

```solidity
// packages/contracts/test/X811TrustAnchor.t.sol
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import "../src/X811TrustAnchor.sol";

contract X811TrustAnchorTest is Test {
    X811TrustAnchor public anchor;
    address public relayer = address(0x1);

    function setUp() public { anchor = new X811TrustAnchor(relayer); }

    function test_submitBatch() public {
        bytes32 root = keccak256("test-root");
        vm.prank(relayer);
        anchor.submitBatch(root, 100);
        assertEq(anchor.batchCount(), 1);
        (bytes32 storedRoot, , uint256 count) = anchor.batches(0);
        assertEq(storedRoot, root);
        assertEq(count, 100);
    }

    function test_revertIfNotRelayer() public {
        vm.prank(address(0x2));
        vm.expectRevert("X811: not relayer");
        anchor.submitBatch(keccak256("root"), 100);
    }

    function test_revertEmptyRoot() public {
        vm.prank(relayer);
        vm.expectRevert("X811: empty root");
        anchor.submitBatch(bytes32(0), 100);
    }

    function test_multipleBatches() public {
        vm.startPrank(relayer);
        anchor.submitBatch(keccak256("r1"), 50);
        anchor.submitBatch(keccak256("r2"), 75);
        anchor.submitBatch(keccak256("r3"), 100);
        vm.stopPrank();
        assertEq(anchor.batchCount(), 3);
        assertEq(anchor.totalInteractions(), 225);
    }
}
```

### Deploy Script

```solidity
// packages/contracts/script/Deploy.s.sol
pragma solidity ^0.8.24;
import "forge-std/Script.sol";
import "../src/X811TrustAnchor.sol";

contract DeployX811 is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address relayer = vm.envAddress("RELAYER_ADDRESS");
        vm.startBroadcast(deployerPrivateKey);
        X811TrustAnchor anchor = new X811TrustAnchor(relayer);
        vm.stopBroadcast();
        console.log("Deployed at:", address(anchor));
    }
}
```

---

## SDK (TypeScript)

```typescript
// packages/sdk-ts/src/client.ts

interface X811ClientConfig {
  serverUrl: string;        // "https://api.x811.org"
  keyPair?: DIDKeyPair;     // Existing keys or generate new
}

class X811Client {
  constructor(config: X811ClientConfig) { ... }

  // Identity
  get did(): string;
  async register(agentCard: Partial<AgentCard>): Promise<AgentCard>;
  async resolve(did: string): Promise<ResolvedDID>;

  // Discovery
  async discover(params: { capability?: string; trust_min?: number; limit?: number }): Promise<AgentCard[]>;

  // Messaging
  async send<T>(to: string, type: X811MessageType, payload: T): Promise<string>;
  async poll(): Promise<X811Envelope[]>;

  // Negotiation shortcuts
  async request(providerDid: string, task: RequestPayload): Promise<string>;
  async offer(initiatorDid: string, offer: OfferPayload): Promise<string>;
  async accept(providerDid: string, accept: AcceptPayload): Promise<string>;
  async deliverResult(initiatorDid: string, result: ResultPayload): Promise<string>;
  async pay(providerDid: string, payment: PaymentPayload): Promise<string>;

  // Verification
  async verifyInteraction(hash: string): Promise<{ included: boolean; proof: string[]; basescan_url: string }>;
}
```

---

## Environment Variables

```bash
# Server
PORT=3811
NODE_ENV=production
LOG_LEVEL=info

# Database
DATABASE_URL=./data/x811.db

# Base L2
BASE_RPC_URL=https://mainnet.base.org
CONTRACT_ADDRESS=0x...
RELAYER_PRIVATE_KEY=0x...

# USDC
USDC_CONTRACT_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913

# Batching
BATCH_SIZE_THRESHOLD=100
BATCH_TIME_THRESHOLD_MS=300000

# Rate limiting
RATE_LIMIT_READ=100
RATE_LIMIT_WRITE=20

# Domain
SERVER_DOMAIN=api.x811.org
DID_DOMAIN=x811.org
```

---

## Docker Deployment

```dockerfile
# packages/server/Dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/packages/server/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
RUN mkdir -p /data
EXPOSE 3811
CMD ["node", "dist/app.js"]
```

```yaml
# docker-compose.yml
version: "3.8"
services:
  x811-server:
    build:
      context: .
      dockerfile: packages/server/Dockerfile
    ports: ["3811:3811"]
    environment:
      - PORT=3811
      - NODE_ENV=production
      - DATABASE_URL=/data/x811.db
      - BASE_RPC_URL=${BASE_RPC_URL}
      - CONTRACT_ADDRESS=${CONTRACT_ADDRESS}
      - RELAYER_PRIVATE_KEY=${RELAYER_PRIVATE_KEY}
    volumes:
      - x811-data:/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:3811/health"]
      interval: 30s
      timeout: 5s
      retries: 3
volumes:
  x811-data:
```

**Dokploy:** Domain `api.x811.org` → Traefik → port 3811. SSL via Let's Encrypt. Env vars in Dokploy UI.

---

## Implementation Timeline

### Semana 1 — Core Protocol (D1-D5)

| Day | Task |
|---|---|
| D1 | Monorepo setup (turbo, tsconfig, lint) + shared types |
| D1 | Crypto module: keys, signing, verification (tests) |
| D2 | DID module: generate, resolve, document (tests) |
| D2 | DB schema + migrations. x402 investigation spike. |
| D3 | Registry CRUD + discovery API |
| D3 | Auth middleware (DID-signed requests) |
| D4 | Message routing (send/poll) + heartbeat + availability |
| D4 | .well-known endpoints |
| D5 | Smart contract: write + test (Foundry) |
| D5 | Deploy to Base Sepolia. Stubs: x402 mock + blockchain mock. |

**Gate:** 2 agents register, discover, exchange signed messages.

### Semana 2 — Integration (D6-D10)

| Day | Task |
|---|---|
| D6 | Negotiation protocol (6-message flow + state machine) |
| D6 | Acceptance policy evaluation (auto/threshold/human) |
| D7 | x402 settlement integration (or fallback to direct USDC transfer) |
| D7 | Payment verification + receipt |
| D8 | Trust engine: calculate + update |
| D8 | Interaction recording |
| D9 | Merkle tree batching service |
| D9 | Relayer + chain submission |
| D10 | Merkle proof endpoint + Agent Cards (A2A compatible) |
| D10 | Edge cases + integration tests |

**Gate:** Full negotiation + payment + on-chain proof.

### Semana 3 — Demo + Launch (D11-D15)

| Day | Task |
|---|---|
| D11 | Demo initiator agent + Demo provider agent (FinAnalyst-Pro) |
| D12 | E2E demo: full 10-step loop |
| D12 | Deploy contract to Base mainnet |
| D13 | SDK-TS: X811Client package |
| D14 | Docker + Dokploy deployment |
| D15 | Production smoke test + demo recording |

**Gate:** Full loop on mainnet, SDK published, api.x811.org live.

---

## Error Codes

```typescript
enum X811ErrorCode {
  // Identity (1xxx)
  DID_NOT_FOUND = "X811-1001",
  DID_REVOKED = "X811-1002",
  DID_DEACTIVATED = "X811-1003",
  INVALID_DID_FORMAT = "X811-1004",

  // Auth (2xxx)
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
```

Error response: `{ "error": { "code": "X811-3004", "message": "...", "details": {} } }`

---

## Testing Strategy

| Layer | Tool | Target |
|---|---|---|
| Core crypto | Vitest | 100% |
| Core DID | Vitest | 100% |
| Core Merkle | Vitest | 100% |
| Server routes | Vitest + Supertest | 90%+ |
| Server services | Vitest | 90%+ |
| Smart contract | Forge test | 100% |
| SDK-TS | Vitest | 80%+ |
| E2E | Custom script | Full 10-step demo |

**Critical test cases:**

- **Crypto:** sign/verify roundtrip, reject tampered, nonce uniqueness
- **DID:** valid W3C document, resolve + extract keys, revoked fails
- **Merkle:** build + verify each item, proof matches Solidity, empty/single
- **Negotiation:** 6-msg happy path, expiry, budget exceeded, trust rejection, idempotency
- **Settlement:** amount matches offer, tx_hash verify, insufficient funds pre-flight
- **Batching:** size trigger, time trigger, failed retry, proof retrieval

---

## Deployment Checklist

- [ ] All tests passing
- [ ] Contract on Base mainnet
- [ ] Relayer funded (~$10 ETH)
- [ ] USDC for demo agents
- [ ] Dokploy: service + env vars + volume
- [ ] DNS: api.x811.org → VPS
- [ ] SSL: Let's Encrypt
- [ ] .well-known/did.json serving
- [ ] Rate limiting on
- [ ] Full demo on mainnet
- [ ] SDK published (npm)
- [ ] Demo video recorded

---

## Inline Changelog

| Fecha | Cambio |
|---|---|
| 2026-02-19 05:00 | Creación — lean tech spec extraído de tech-spec-v1.md para coding |
| 2026-02-19 05:30 | Regenerado con código verbatim (tipos, crypto, DID, SQL, Solidity). Agregado heartbeat, x402 spike en timeline. Python SDK removido del repo structure (P2 deferred). |
