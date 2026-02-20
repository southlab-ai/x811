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
- **DID:** Custom `did:x811` resolver (W3C-inspired)
- **Blockchain:** Solidity ^0.8.24 (Foundry) on Base L2, ethers.js v6
- **Payments:** @coinbase/x402 SDK, USDC on Base L2
- **Monorepo:** Turborepo (npm workspaces: core, server, sdk-ts as `@x811/sdk`, mcp-server)
- **Deploy:** Docker + Dokploy + Traefik SSL on VPS (Hostinger), domain: api.x811.org

## Build & Development Commands

```bash
# Monorepo (Turborepo)
npm run build          # Build all packages
npm run test           # Run all tests
npm run lint           # Lint all packages
npm run dev            # Dev mode with watch
npm run clean          # Remove dist/ and build artifacts

# Individual packages
npm run test:core      # Core crypto/DID tests (Vitest, target 100%)
npm run test:server    # Server route/service tests (Vitest + Supertest, target 90%+)
npm run test:contract  # Smart contract tests (Forge, target 100%)

# Per-package watch/coverage (run from package dir or with --workspace)
npm run test:watch --workspace=@x811/core
npm run test:coverage --workspace=@x811/server

# Smart contracts (Foundry — not in npm workspaces, run directly)
cd packages/contracts && forge test
cd packages/contracts && forge deploy --network base-mainnet

# Demo (full 10-step end-to-end, spawns initiator + provider)
npm run demo

# Docker
docker compose up      # Port 3811
```

## Repository Structure

```
packages/
├── core/          # Shared types, crypto (Ed25519/X25519/Merkle), DID utilities (@x811/core)
├── server/        # Fastify server: routes, services, SQLite DB, middleware (@x811/server)
├── sdk-ts/        # TypeScript SDK — X811Client (@x811/sdk)
├── mcp-server/    # MCP plugin for Claude Code — wraps @x811/sdk as MCP tools (@x811/mcp-server)
└── contracts/     # Solidity: X811TrustAnchor.sol (Foundry, not in npm workspaces)
demo/
├── initiator/     # Demo initiator agent
├── provider/      # Demo provider agent
└── run-demo.ts    # Orchestrates the full 10-step demo
```

## Architecture

### 7 Core Components

1. **DID System** — `did:x811:<uuid>`, Ed25519 (signing) + X25519 (encryption), W3C-inspired DID documents. Keys generated via `generateDID()` in `@x811/core`.
2. **Authenticated Communication** — `X811Envelope<T>` with Ed25519 signatures, nonce replay protection (stored in `nonces` table), ±5min timestamp validation.
3. **Agent Registry** — CRUD + discovery API (`GET /api/v1/agents?capability=X&trust_min=Y`), Agent Cards (A2A compatible + x811 extensions). Heartbeat expiry checked every 60s.
4. **Negotiation Protocol** — 6 signed messages: REQUEST → OFFER → ACCEPT → RESULT → VERIFY → PAY; 10 states: pending → offered → accepted → delivered → verified → completed (+ expired, rejected, disputed, failed). Message store-and-forward via `messages` table; recipients poll to consume.
5. **Settlement** — x402 payments in USDC on Base L2, pre-flight balance checks, idempotency keys, retry with exponential backoff (4 attempts).
6. **On-Chain Trust** — X811TrustAnchor.sol, Merkle tree batching (100 interactions or 5 min threshold), root submission to Base L2. Batch timer runs as a background interval in the server.
7. **Gas Subsidy** — Relayer pattern: x811 pays gas, agents don't need ETH. In development/test, `MockRelayerService` is used automatically (no blockchain calls).

### Key Data Flow (10-step demo)

```
Discovery → DID Verify → REQUEST → OFFER → AUTO-ACCEPT → Execute → RESULT → Verify → Pay (x402/USDC) → Merkle batch → On-chain
```

### Server Dependency Graph

Services are injected as Fastify decorators in `app.ts`:
```
Database → TrustService → RegistryService
         → BatchingService (+ RelayerService)
         → MessageRouterService → NegotiationService
```

### Message Envelope

All messages use `X811Envelope<T>` with: version "0.1.0", UUIDv7 id, DID from/to, ISO 8601 timestamps, Ed25519 Base64url signature, nonce. 11 message types: request, offer, accept, reject, result, verify, payment, payment-failed, cancel, heartbeat, error.

### Trust Score

Range 0.0–1.0, new agents start at 0.5. Formula: 70% adjusted success rate + 20% raw success + 10% activity bonus. Dispute penalty: 3x multiplier. Time decay for inactive agents.

### Acceptance Policy

Three modes: `auto` (accepts if price ≤ budget AND time ≤ deadline AND trust ≥ min), `human_approval` (escalate to operator), `threshold` (auto below threshold, escalate above).

### Negotiation TTLs

REQUEST→OFFER: 60s, OFFER→ACCEPT: 5min, ACCEPT→RESULT: 1h, RESULT→VERIFY: 30s, VERIFY→PAY: 60s, PAY confirmation: 30s, payment retries: 4 (backoff 5s/15s/60s/300s).

## MCP Server Plugin

The MCP server source lives in `packages/mcp-server/` and is bundled via esbuild into `plugins/x811/dist/index.mjs`. The plugin uses `${CLAUDE_PLUGIN_ROOT}/dist/index.mjs` — no npm publish needed.

**Bundle command:** `npm run bundle:plugin`

**Key implementation details:**
- DID keys are persisted to `~/.x811/keys.json` so agent identity survives restarts
- A local `messageBuffer` prevents message loss: unmatched poll results are buffered locally and checked before the next server poll
- **Autonomous tools** handle full protocol flows without manual step-by-step calls:
  - `x811_provide_service` — register, go online, wait for request, send offer, wait for accept, return task details for the agent to execute, then call `x811_deliver_result`
  - `x811_request_and_pay` — register, discover provider, send request, auto-accept offer, wait for result, verify, pay — all in one call

## API Endpoints

- **Registry:** `POST /api/v1/agents`, `GET /api/v1/agents` (discovery with filters), `GET /api/v1/agents/{id}`, `GET /api/v1/agents/{id}/card`, `GET /api/v1/agents/{id}/did`, `GET /api/v1/agents/{id}/status`, `POST /api/v1/agents/{id}/heartbeat`
- **Messages:** `POST /api/v1/messages`, `GET /api/v1/messages/{agentId}` (poll, marks as delivered)
- **Verification:** `GET /api/v1/verify/{hash}`, `GET /api/v1/verify/batches`
- **Well-known:** `GET /.well-known/did.json`, `GET /.well-known/agent-cards`, `GET /health`
- **Auth:** All mutations require DID-based signature verification
- **Rate limits:** 100 req/min read per IP, 20 req/min write per DID

## Database

SQLite (WAL mode) with tables: agents, capabilities, interactions, batches, merkle_proofs, messages, nonces.

## Error Code Ranges

X811-1xxx: Identity, X811-2xxx: Auth, X811-3xxx: Registry, X811-4xxx: Negotiation, X811-5xxx: Settlement, X811-6xxx: Result, X811-9xxx: System.

## Environment Variables

```
PORT                      # default 3811
NODE_ENV                  # development | production | test
LOG_LEVEL                 # default info
DATABASE_URL              # default ./data/x811.db
BASE_RPC_URL              # default https://mainnet.base.org
CONTRACT_ADDRESS          # required in production for on-chain batching
RELAYER_PRIVATE_KEY       # required in production; MockRelayerService used otherwise
USDC_CONTRACT_ADDRESS     # default 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
BATCH_SIZE_THRESHOLD      # default 100
BATCH_TIME_THRESHOLD_MS   # default 300000
RATE_LIMIT_READ           # default 100
RATE_LIMIT_WRITE          # default 20
SERVER_DOMAIN             # default api.x811.org
DID_DOMAIN                # default x811.org
```

## Protocol Fee

2.5% of transaction value, collected in USDC. Fields: `protocol_fee` and `total_cost` in OfferPayload. Distribution: 60% disputes, 20% gas, 10% community, 10% burn.

## Plugin Update Workflow

When making changes to the plugin (skills, commands, MCP server, tools), always follow this checklist:

1. **Make code changes** in `plugins/x811/` and/or `packages/mcp-server/`
2. **Rebuild the bundle** if MCP server code changed:
   ```bash
   npm run build && npm run bundle:plugin
   ```
3. **Bump version** in both files (keep them in sync):
   - `.claude-plugin/marketplace.json` → `plugins[0].version`
   - `plugins/x811/.claude-plugin/plugin.json` → `version`
4. **Commit and push** (including `plugins/x811/dist/index.mjs`) — the marketplace serves from `origin/main`
5. **Users update** by reinstalling the plugin in Claude Code:
   ```
   /plugin install x811@x811-marketplace
   ```
   Then restart Claude Code to pick up the new version.
