# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Rules of Implementation
- **Always use experimental team-agents for parallel implementation.** Split the work and spawn at least 2 full dev teams running simultaneously. Each team: `TeamCreate` → spawn teammates via `Task` with `team_name` → coordinate through `SendMessage` and shared task lists. Each team tackles a separate part of the implementation in parallel.
- **Known VS Code bug — `SendMessage` from teammates will NOT reach you.** If you yield the turn back to the user, you will never reactivate because the teammate notifications won't arrive. **Workaround: NEVER yield the turn after spawning teams.** Instead, stay active in a polling loop — use `Bash` with `sleep 300` (5 minutes), then check teammate output files with `Read` or `TaskOutput`. Repeat until all teams have finished. Only then yield the turn back to the user with the final results.


## Project Overview

x811 Protocol MVP — an open protocol for decentralized AI agent identity (DID), trust verification (on-chain), and settlement (x402). The MVP demo: two AI agents autonomously discover, negotiate, execute, verify, and settle a financial analysis task ($0.03 USDC on Base L2).

Reference docs: [PRD-MVP-CODE.md](docs/PRD-MVP-CODE.md), [TECH-SPEC-MVP-CODE.md](docs/TECH-SPEC-MVP-CODE.md).

## Tech Stack

- **Server:** TypeScript + Node.js (Fastify), SQLite (better-sqlite3)
- **Crypto:** @noble/ed25519, @noble/curves, @noble/hashes
- **DID:** Custom `did:web` resolver (W3C compliant)
- **Blockchain:** Solidity ^0.8.24 (Foundry) on Base L2, ethers.js v6
- **Payments:** @coinbase/x402 SDK, USDC on Base L2
- **Monorepo:** Turborepo
- **Deploy:** Docker + Dokploy + Traefik SSL on VPS (Hostinger), domain: api.x811.org

## Build & Development Commands

```bash
# Monorepo (Turborepo)
npm run build          # Build all packages
npm run test           # Run all tests
npm run lint           # Lint all packages
npm run dev            # Dev mode with watch

# Individual packages
npm run test:core      # Core crypto/DID tests (Vitest, target 100%)
npm run test:server    # Server route/service tests (Vitest + Supertest, target 90%+)
npm run test:contract  # Smart contract tests (Forge, target 100%)

# Smart contracts (Foundry)
cd packages/contracts && forge test
cd packages/contracts && forge deploy --network base-mainnet

# Demo
npm run demo           # Full 10-step end-to-end demo

# Docker
docker compose up      # Port 3811
```

## Repository Structure

```
packages/
├── core/          # Shared types, crypto (Ed25519/X25519/Merkle), DID utilities
├── server/        # Fastify server: routes, services, SQLite DB, middleware
├── sdk-ts/        # TypeScript SDK (X811Client)
├── sdk-python/    # Python SDK
└── contracts/     # Solidity: X811TrustAnchor.sol (Foundry)
demo/
├── initiator/     # Demo initiator agent
└── provider/      # Demo provider agent
```

## Architecture

### 7 Core Components

1. **DID System** — `did:web:x811.org:agents:{uuid}`, Ed25519 (signing) + X25519 (encryption), W3C DID documents
2. **Authenticated Communication** — X811Envelope with Ed25519 signatures, nonce replay protection, ±5min timestamp validation
3. **Agent Registry** — CRUD + discovery API (`GET /agents?capability=X&trust_min=Y`), Agent Cards (A2A compatible + x811 extensions)
4. **Negotiation Protocol** — 6 signed messages: REQUEST → OFFER → ACCEPT → RESULT → VERIFY → PAY; 10 states: pending → offered → accepted → delivered → verified → completed (+ expired, rejected, disputed, failed)
5. **Settlement** — x402 payments in USDC on Base L2, pre-flight balance checks, idempotency keys, retry with exponential backoff (4 attempts)
6. **On-Chain Trust** — X811TrustAnchor.sol, Merkle tree batching (100 interactions or 5 min threshold), root submission to Base L2
7. **Gas Subsidy** — Relayer pattern: x811 pays gas, agents don't need ETH

### Key Data Flow (10-step demo)

```
Discovery → DID Verify → REQUEST → OFFER → AUTO-ACCEPT → Execute → RESULT → Verify → Pay (x402/USDC) → Merkle batch → On-chain
```

### Message Envelope

All messages use `X811Envelope<T>` with: version "0.1.0", UUIDv7 id, DID from/to, ISO 8601 timestamps, Ed25519 Base64url signature, nonce. 11 message types: request, offer, accept, reject, result, verify, payment, payment-failed, cancel, heartbeat, error.

### Trust Score

Range 0.0–1.0, new agents start at 0.5. Formula: 70% adjusted success rate + 20% raw success + 10% activity bonus. Dispute penalty: 3x multiplier. Time decay for inactive agents.

### Acceptance Policy

Three modes: `auto` (accepts if price ≤ budget AND time ≤ deadline AND trust ≥ min), `human_approval` (escalate to operator), `threshold` (auto below threshold, escalate above).

### Negotiation TTLs

REQUEST→OFFER: 60s, OFFER→ACCEPT: 5min, ACCEPT→RESULT: 1h, RESULT→VERIFY: 30s, VERIFY→PAY: 60s, PAY confirmation: 30s, payment retries: 4 (backoff 5s/15s/60s/300s).

## API Endpoints

- **Registry:** `POST /agents`, `GET /agents` (discovery with filters), `GET /agents/{id}`, `GET /agents/{id}/card`, `GET /agents/{id}/did`, `GET /agents/{id}/status`
- **Messages:** `POST /messages/send`, `GET /messages/poll`
- **Verification:** `GET /verify/proof`, `GET /verify/batches`
- **Well-known:** `GET /.well-known/did.json`, `GET /.well-known/agent-cards`, `GET /health`
- **Auth:** All mutations require DID-based signature verification
- **Rate limits:** 100 req/min read per IP, 20 req/min write per DID

## Database

SQLite with tables: agents, capabilities, interactions, batches, merkle_proofs, messages, nonces.

## Error Code Ranges

X811-1xxx: Identity, X811-2xxx: Auth, X811-3xxx: Registry, X811-4xxx: Negotiation, X811-5xxx: Settlement, X811-6xxx: Result, X811-9xxx: System.

## Edge Cases to Handle

- Provider timeout → deadline + grace → cancel → retry next provider
- Malformed result → schema validation → reject → no payment
- DID revoked mid-flow → re-verify before payment
- Insufficient funds → pre-flight balance check
- Double request/payment → idempotency keys
- Invalid signature → reject + log

## Environment Variables

```
PORT, NODE_ENV, LOG_LEVEL, DATABASE_URL
BASE_RPC_URL, CONTRACT_ADDRESS, RELAYER_PRIVATE_KEY
USDC_CONTRACT_ADDRESS
BATCH_SIZE_THRESHOLD, BATCH_TIME_THRESHOLD_MS
RATE_LIMIT_READ, RATE_LIMIT_WRITE
SERVER_DOMAIN, DID_DOMAIN
```

## Protocol Fee

2.5% of transaction value, collected in USDC. Fields: `protocol_fee` and `total_cost` in OfferPayload. Distribution: 60% disputes, 20% gas, 10% community, 10% burn.
