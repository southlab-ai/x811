# x811 Protocol MVP — Development Backlog

**Generated:** 2026-02-19
**Deadline:** 2026-03-11 (15 working days)
**Source:** PRD-MVP-CODE.md, TECH-SPEC-MVP-CODE.md

---

## Backlog Structure

- **Epics** map to the 7 core components + infrastructure + demo
- **Priority:** P0 = must-have for demo, P1 = important but demo works without it, P2 = defer post-MVP
- **Dependencies** noted as `depends: TASK-ID`
- **User stories** linked as `stories: US-XX-NN`
- **Critical path** marked with `[CP]`

## Key Decisions (Council)

1. **Python SDK deferred to P2** — zero user stories reference Python; not needed for MVP demo
2. **MCP plugin deferred to P2** — mentioned in timeline but not in user stories; tracked as EPIC 16
3. **x402 investigation spike in Week 1** — x402 is designed for HTTP 402 paywalls, not bilateral agent settlements. Validate compatibility early; fallback: direct USDC ERC-20 transfer via ethers.js
4. **Acceptance policy: implement `auto` only for demo** — `human_approval` and `threshold` can be stubs
5. **Edge cases split into tiers** — Tier 1 (security: EC-05/06/07/08) built into core from Day 1; Tier 2 (resilience: EC-01/02/03/04) after happy path works
6. **Mock external deps in Week 1** — x402 stub (PAY-08) and blockchain stub (BAT-06) unblock all development
7. **Testnet before mainnet** — SOL-07 (Base Sepolia) must pass before SOL-08 (Base mainnet)

---

## EPIC 0: Infrastructure & Monorepo Setup

| ID | Task | Priority | Depends | Stories | Week | Status |
|---|---|---|---|---|---|---|
| INF-01 | `[CP]` Init Turborepo monorepo with `packages/` workspace structure | P0 | — | — | W1 | DONE |
| INF-02 | `[CP]` Root `package.json` with workspace scripts (build, test, lint, dev) | P0 | INF-01 | — | W1 | DONE |
| INF-03 | `[CP]` Root `tsconfig.json` with project references for all TS packages | P0 | INF-01 | — | W1 | DONE |
| INF-04 | `[CP]` `turbo.json` pipeline config (build, test, lint, dev) | P0 | INF-01 | — | W1 | DONE |
| INF-05 | Configure Vitest at root for shared test setup | P0 | INF-01 | — | W1 | DONE |
| INF-06 | ESLint + Prettier shared config | P1 | INF-01 | — | W1 | PENDING |
| INF-07 | `.env.example` with all environment variables documented | P0 | — | — | W1 | DONE |
| INF-08 | Git repo init, `.gitignore`, LICENSE (MIT) | P0 | — | — | W1 | DONE |
| INF-09 | CI pipeline (GitHub Actions): lint + test + build on PR | P1 | INF-01 | — | W2 | PENDING |

---

## EPIC 1: Core Package — Types

| ID | Task | Priority | Depends | Stories | Week | Status |
|---|---|---|---|---|---|---|
| TYP-01 | `[CP]` `packages/core/` package scaffold (package.json, tsconfig, index.ts) | P0 | INF-01 | — | W1 | DONE |
| TYP-02 | `[CP]` DID types: `DIDDocument`, `DIDKeyPair`, `DIDStatus`, `AgentAvailability` | P0 | TYP-01 | US-X8-01 | W1 | DONE |
| TYP-03 | `[CP]` Message types: `X811Envelope<T>`, `X811MessageType` (11 types), `MESSAGE_LIMITS`, `NEGOTIATION_TTLS` | P0 | TYP-01 | US-AI-03 | W1 | DONE |
| TYP-04 | `[CP]` Negotiation types: `RequestPayload`, `OfferPayload`, `AcceptPayload`, `RejectPayload`, `ResultPayload`, `PaymentPayload`, `NegotiationStatus` (10 states) | P0 | TYP-01 | US-AI-04 | W1 | DONE |
| TYP-05 | `[CP]` Agent Card types: `AgentCard`, `Capability`, `PricingModel` (A2A compatible + x811 extensions) | P0 | TYP-01 | US-AP-02 | W1 | DONE |
| TYP-06 | `[CP]` Acceptance policy types: `AcceptancePolicy` with auto/human_approval/threshold modes | P0 | TYP-01 | US-AI-05 | W1 | DONE |
| TYP-07 | Error code constants: X811-1xxx through X811-9xxx | P0 | TYP-01 | — | W1 | DONE |

---

## EPIC 2: Core Package — Cryptography

| ID | Task | Priority | Depends | Stories | Week | Status |
|---|---|---|---|---|---|---|
| CRY-01 | `[CP]` `keys.ts` — Ed25519 key generation (signing), X25519 key generation (encryption), multibase encoding | P0 | TYP-01 | US-X8-01 | W1 | DONE |
| CRY-02 | `[CP]` `signing.ts` — `canonicalize()`, `signEnvelope()`, `verifyEnvelope()` using @noble/ed25519 | P0 | CRY-01, TYP-03 | US-AI-03, US-X8-03 | W1 | DONE |
| CRY-03 | `encryption.ts` — X25519 Diffie-Hellman shared secret, encrypt/decrypt payloads | P1 | CRY-01 | — | W2 | PENDING |
| CRY-04 | `[CP]` `merkle.ts` — Merkle tree: `calculateRoot()`, `generateProof()`, `verifyProof()` | P0 | TYP-01 | US-X8-05, US-X8-14 | W1 | DONE |
| CRY-05 | Unit tests for keys, signing, merkle (target: 100% coverage) | P0 | CRY-01, CRY-02, CRY-04 | — | W1 | DONE (32 tests) |

---

## EPIC 3: Core Package — DID Module

| ID | Task | Priority | Depends | Stories | Week | Status |
|---|---|---|---|---|---|---|
| DID-01 | `[CP]` `generate.ts` — `generateDID()`: create `did:web:x811.org:agents:{uuid}` with Ed25519 + X25519 keys | P0 | CRY-01, TYP-02 | US-X8-01 | W1 | DONE |
| DID-02 | `[CP]` `document.ts` — Build W3C-compliant DID Document from keys (verificationMethod, authentication, keyAgreement, service) | P0 | DID-01 | US-X8-01 | W1 | DONE |
| DID-03 | `[CP]` `resolve.ts` — `resolveDID()`: retrieve DID document from registry, extract public keys | P0 | DID-02 | US-AI-02 | W1 | DONE |
| DID-04 | `status.ts` — DID status management (active/revoked/deactivated transitions) | P0 | DID-01 | US-AI-02, EC-04 | W1 | DONE |
| DID-05 | Unit tests for DID module (target: 100% coverage) | P0 | DID-01 to DID-04 | — | W1 | DONE (30 tests) |

---

## EPIC 4: Server — Database & Foundation

| ID | Task | Priority | Depends | Stories | Week | Status |
|---|---|---|---|---|---|---|
| SRV-01 | `[CP]` `packages/server/` package scaffold (package.json, tsconfig, Fastify app.ts) | P0 | INF-01 | — | W1 | DONE |
| SRV-02 | `[CP]` `db/schema.ts` — SQLite schema: agents, capabilities, interactions, batches, merkle_proofs, messages, nonces tables + indexes | P0 | SRV-01 | US-X8-02 | W1 | DONE |
| SRV-03 | `[CP]` `middleware/auth.ts` — DID-based signature verification for all mutations | P0 | CRY-02, SRV-01 | US-X8-03 | W1 | DONE |
| SRV-04 | `middleware/rateLimit.ts` — 100 req/min read per IP, 20 req/min write per DID | P1 | SRV-01 | — | W2 | DONE |
| SRV-05 | Environment variable loading and validation | P0 | SRV-01, INF-07 | — | W1 | DONE |

---

## EPIC 5: Server — Agent Registry

| ID | Task | Priority | Depends | Stories | Week | Status |
|---|---|---|---|---|---|---|
| REG-01 | `[CP]` `routes/agents.ts` — `POST /agents`: register agent with DID, capabilities, pricing (signed) | P0 | SRV-02, SRV-03, DID-01 | US-AP-01 | W1 | DONE |
| REG-02 | `[CP]` `routes/agents.ts` — `GET /agents`: discovery with filters (?capability=X&trust_min=Y&status=Z) | P0 | SRV-02 | US-AI-01, US-X8-02 | W1 | DONE |
| REG-03 | `[CP]` `routes/agents.ts` — `GET /agents/{id}`: agent details | P0 | SRV-02 | US-X8-02 | W1 | DONE |
| REG-04 | `[CP]` `routes/agents.ts` — `GET /agents/{id}/card`: return Agent Card (A2A compatible) | P0 | SRV-02, TYP-05 | US-X8-07, US-AP-02 | W1 | DONE |
| REG-05 | `[CP]` `routes/agents.ts` — `GET /agents/{id}/did`: return DID Document | P0 | SRV-02, DID-02 | US-AI-02 | W1 | DONE |
| REG-06 | `routes/agents.ts` — `GET /agents/{id}/status`: availability check | P0 | SRV-02 | — | W1 | DONE |
| REG-07 | `services/registry.ts` — Registry service (CRUD logic, capability indexing) | P0 | SRV-02 | US-X8-02 | W1 | DONE |
| REG-08 | Tests for all registry routes (target: 90%+) | P0 | REG-01 to REG-07 | — | W1 | DONE (25 route tests) |

---

## EPIC 6: Server — Message Router

| ID | Task | Priority | Depends | Stories | Week | Status |
|---|---|---|---|---|---|---|
| MSG-01 | `[CP]` `routes/messages.ts` — `POST /messages/send`: verify signature → queue message | P0 | SRV-02, SRV-03, CRY-02 | US-X8-04, US-AI-03 | W1 | DONE |
| MSG-02 | `[CP]` `routes/messages.ts` — `GET /messages/poll`: retrieve queued messages for DID | P0 | SRV-02, SRV-03 | US-X8-04, US-AP-03 | W1 | DONE |
| MSG-03 | `[CP]` `services/router.ts` — Message routing service: verify sender → nonce check → queue → deliver | P0 | SRV-02, CRY-02 | US-X8-04 | W1 | DONE |
| MSG-04 | Nonce tracking for replay protection (nonces table) | P0 | SRV-02 | US-AI-03, EC-06 | W1 | DONE |
| MSG-05 | Timestamp validation (±5 min tolerance) | P0 | MSG-03 | US-AI-03 | W1 | DONE |
| MSG-06 | Tests for message routes + router service | P0 | MSG-01 to MSG-05 | — | W1 | DONE |

---

## EPIC 7: Server — Negotiation Protocol

| ID | Task | Priority | Depends | Stories | Week | Status |
|---|---|---|---|---|---|---|
| NEG-01 | `[CP]` Negotiation state machine: 10 states (pending → offered → accepted → delivered → verified → completed + expired/rejected/disputed/failed) | P0 | TYP-04, SRV-02 | — | W2 | DONE |
| NEG-02 | `[CP]` REQUEST handling: validate payload, create interaction record, route to provider | P0 | MSG-03, NEG-01 | US-AI-04, US-AP-03 | W2 | DONE |
| NEG-03 | `[CP]` OFFER handling: validate price/time/deliverables, update state, route to initiator | P0 | NEG-01, MSG-03 | US-AP-04 | W2 | DONE |
| NEG-04 | `[CP]` ACCEPT handling: validate offer_hash, update state to accepted | P0 | NEG-01 | US-AI-06 | W2 | DONE |
| NEG-05 | REJECT handling: validate reason/code, update state to rejected | P0 | NEG-01 | — | W2 | DONE |
| NEG-06 | `[CP]` RESULT handling: validate result_hash, update state to delivered | P0 | NEG-01 | US-AP-06 | W2 | DONE |
| NEG-07 | `[CP]` VERIFY handling: server-side schema + signature validation, update state to verified | P0 | NEG-01, CRY-02 | US-AI-07 | W2 | DONE |
| NEG-08 | TTL enforcement per transition (60s, 5min, 1h, 30s, 60s) with expiration handling | P0 | NEG-01 | EC-01 | W2 | DONE |
| NEG-09 | Protocol fee calculation (2.5%) and inclusion in OfferPayload (protocol_fee, total_cost) | P0 | NEG-03 | — | W2 | DONE |
| NEG-10 | Tests for full negotiation flow including state transitions and TTLs | P0 | NEG-01 to NEG-09 | — | W2 | DONE (9 tests) |

---

## EPIC 8: Server — Settlement (x402)

| ID | Task | Priority | Depends | Stories | Week | Status |
|---|---|---|---|---|---|---|
| PAY-01 | `[CP]` PAYMENT handling: validate tx_hash, amount, currency, network, addresses | P0 | NEG-07 | US-AI-08 | W2 | DONE |
| PAY-02 | `[CP]` x402 payment integration: @coinbase/x402 SDK for USDC on Base L2 | P0 | PAY-01 | US-AI-08 | W2 | DONE (direct ERC-20 via ethers.js) |
| PAY-03 | Pre-flight balance check before payment attempt | P0 | PAY-02 | EC-05 | W2 | DONE |
| PAY-04 | Payment retry logic: 4 attempts with exponential backoff (5s, 15s, 60s, 300s) | P0 | PAY-02 | — | W2 | DONE |
| PAY-05 | Idempotency keys for double-payment prevention | P0 | PAY-01 | EC-06 | W2 | DONE |
| PAY-06 | Payment receipt confirmation and state → completed | P0 | PAY-01, NEG-01 | US-AP-07, US-AI-09 | W2 | DONE |
| PAY-07 | PAYMENT-FAILED handling with reason code | P0 | PAY-01 | — | W2 | DONE |
| PAY-08 | Mock/stub for x402 SDK to enable local development without real USDC | P0 | — | — | W1 | DONE (MockWalletService + MockRelayerService) |
| PAY-10 | `[CP]` x402 investigation spike: validate @coinbase/x402 supports agent-to-agent USDC transfers (not just HTTP 402 paywalls). If incompatible, define fallback: direct USDC ERC-20 transfer via ethers.js | P0 | — | — | W1 | DONE (fallback: direct USDC ERC-20 via ethers.js) |
| PAY-09 | Tests for payment flow (with mocked x402) | P0 | PAY-01 to PAY-07 | — | W2 | DONE |

---

## EPIC 9: Server — Trust Engine

| ID | Task | Priority | Depends | Stories | Week | Status |
|---|---|---|---|---|---|---|
| TRU-01 | `[CP]` `services/trust.ts` — `calculateTrustScore()`: 70% adjusted success rate + 20% raw success + 10% activity bonus | P0 | SRV-02 | US-X8-06 | W2 | DONE |
| TRU-02 | New agent default score: 0.5 | P0 | TRU-01 | US-X8-06 | W2 | DONE |
| TRU-03 | Dispute penalty: 3x multiplier on failed interactions | P0 | TRU-01 | US-X8-06 | W2 | DONE |
| TRU-04 | Time decay for inactive agents | P1 | TRU-01 | US-X8-06 | W2 | DONE (7-day grace, 60-day half-life) |
| TRU-05 | Trust score update after each completed/failed interaction | P0 | TRU-01, NEG-01 | US-X8-06 | W2 | DONE |
| TRU-06 | Tests for trust score calculation (edge cases: new agent, high disputes, inactive) | P0 | TRU-01 to TRU-05 | — | W2 | DONE (10 tests) |

---

## EPIC 10: Server — Batching & On-Chain Trust

| ID | Task | Priority | Depends | Stories | Week | Status |
|---|---|---|---|---|---|---|
| BAT-01 | `[CP]` `services/batching.ts` — Collect interaction hashes, trigger on size (100) or time (5 min) | P0 | SRV-02, CRY-04 | US-X8-14 | W2 | DONE |
| BAT-02 | `[CP]` Create Merkle tree from batch, store root + individual proofs in DB | P0 | BAT-01, CRY-04 | US-X8-05, US-X8-14 | W2 | DONE |
| BAT-03 | `[CP]` `services/relayer.ts` — Submit batch root to X811TrustAnchor contract via ethers.js v6 | P0 | BAT-02 | US-X8-ON1 | W2 | DONE |
| BAT-04 | `routes/verify.ts` — `GET /verify/proof`: return Merkle proof for interaction hash | P0 | BAT-02 | US-X8-05 | W2 | DONE |
| BAT-05 | `routes/verify.ts` — `GET /verify/batches`: list submitted batches | P0 | BAT-02 | — | W2 | DONE |
| BAT-06 | Mock/stub for ethers.js relayer to enable local dev without Base L2 RPC | P0 | — | — | W1 | DONE (MockRelayerService) |
| BAT-07 | Tests for batching service and relayer (with mocked blockchain) | P0 | BAT-01 to BAT-05 | — | W2 | DONE (7 tests) |

---

## EPIC 11: Smart Contract

| ID | Task | Priority | Depends | Stories | Week | Status |
|---|---|---|---|---|---|---|
| SOL-01 | `[CP]` `packages/contracts/` scaffold: foundry.toml, OpenZeppelin dependency | P0 | INF-01 | — | W1 | DONE |
| SOL-02 | `[CP]` `X811TrustAnchor.sol` — submitBatch(bytes32 root, uint256 count), verifyInclusion(bytes32 root, bytes32 leaf, bytes32[] proof) | P0 | SOL-01 | US-X8-05 | W1 | DONE |
| SOL-03 | Access control: onlyRelayer modifier, setRelayer(), pause/unpause (Ownable + Pausable) | P0 | SOL-02 | US-X8-ON1 | W1 | DONE |
| SOL-04 | Events: BatchSubmitted, RelayerUpdated, Paused, Unpaused | P0 | SOL-02 | — | W1 | DONE |
| SOL-05 | `X811TrustAnchor.t.sol` — Full test suite (target: 100% coverage) | P0 | SOL-02 to SOL-04 | — | W1 | DONE (20 Forge tests) |
| SOL-06 | `Deploy.s.sol` — Deployment script for Base L2 | P0 | SOL-02 | — | W2 | DONE |
| SOL-07 | Deploy to Base Sepolia testnet, verify contract | P0 | SOL-06 | — | W3 | PENDING (needs funded wallet) |
| SOL-08 | Deploy to Base mainnet, verify contract | P0 | SOL-07 | — | W3 | PENDING (needs SOL-07 first) |

---

## EPIC 12: Well-Known Endpoints

| ID | Task | Priority | Depends | Stories | Week | Status |
|---|---|---|---|---|---|---|
| WK-01 | `routes/well-known.ts` — `GET /.well-known/did.json`: server DID root document | P0 | SRV-01, DID-02 | US-X8-01 | W1 | DONE |
| WK-02 | `routes/well-known.ts` — `GET /.well-known/agent-cards`: all registered agent cards | P0 | SRV-01, REG-04 | US-X8-07 | W1 | DONE |
| WK-03 | `GET /health` — Server health check | P0 | SRV-01 | — | W1 | DONE |
| WK-04 | Tests for well-known endpoints | P0 | WK-01 to WK-03 | — | W1 | DONE |

---

## EPIC 13: Edge Cases

| ID | Task | Priority | Depends | Stories | Week | Status |
|---|---|---|---|---|---|---|
| EC-01 | Provider timeout: deadline + grace period → cancel → retry next provider | P0 | NEG-08 | EC-01 | W2 | DONE |
| EC-02 | Malformed result: schema validation → reject → no payment | P0 | NEG-07 | EC-02 | W2 | DONE |
| EC-03 | No available providers: return Error X811-3004 | P0 | REG-02 | EC-03 | W2 | DONE |
| EC-04 | DID revoked mid-flow: re-verify DID status before payment | P0 | DID-04, PAY-01 | EC-04 | W2 | DONE |
| EC-05 | Insufficient funds: pre-flight balance check | P0 | PAY-03 | EC-05 | W2 | DONE |
| EC-06 | Double request/payment: idempotency key enforcement | P0 | PAY-05, MSG-04 | EC-06 | W2 | DONE |
| EC-07 | Invalid signature: reject message + log | P0 | SRV-03 | EC-07 | W1 | DONE |
| EC-08 | Provider without DID: 401 Unauthorized | P0 | SRV-03 | EC-08 | W1 | DONE |

---

## EPIC 14: TypeScript SDK

| ID | Task | Priority | Depends | Stories | Week | Status |
|---|---|---|---|---|---|---|
| SDK-01 | `packages/sdk-ts/` scaffold (package.json, tsconfig, index.ts) | P0 | INF-01 | — | W3 | DONE |
| SDK-02 | `client.ts` — X811Client: HTTP client wrapping all server API calls | P0 | SDK-01 | — | W3 | DONE |
| SDK-03 | `agent.ts` — Identity methods: register(), resolve() | P0 | SDK-02 | US-AP-01 | W3 | DONE (in client.ts) |
| SDK-04 | `agent.ts` — Discovery: discover(capability, trustMin) | P0 | SDK-02 | US-AI-01 | W3 | DONE (in client.ts) |
| SDK-05 | `agent.ts` — Messaging: send(), poll() | P0 | SDK-02 | US-AI-03 | W3 | DONE (in client.ts) |
| SDK-06 | `agent.ts` — Negotiation: request(), offer(), accept(), deliverResult() | P0 | SDK-02 | US-AI-04 to US-AI-06, US-AP-04 to US-AP-06 | W3 | DONE (in client.ts) |
| SDK-07 | `wallet.ts` — pay() via x402, verifyInteraction() | P0 | SDK-02 | US-AI-08 | W3 | DONE |
| SDK-08 | Tests for SDK (target: 80%+) | P0 | SDK-01 to SDK-07 | — | W3 | DONE (35 tests) |

---

## EPIC 15: Python SDK

| ID | Task | Priority | Depends | Stories | Week |
|---|---|---|---|---|---|
| PY-01 | `packages/sdk-python/` scaffold (pyproject.toml, x811/) | P2 | — | — | W3 |
| PY-02 | `client.py` — HTTP client wrapping server API | P2 | PY-01 | — | W3 |
| PY-03 | `agent.py` — register, discover, messaging | P2 | PY-02 | — | W3 |
| PY-04 | `crypto.py` — Ed25519 signing/verification | P2 | PY-01 | — | W3 |
| PY-05 | `wallet.py` — x402 payment wrapper | P2 | PY-02 | — | W3 |
| PY-06 | Tests for Python SDK | P2 | PY-01 to PY-05 | — | W3 |

---

## EPIC 16: MCP Plugin

| ID | Task | Priority | Depends | Stories | Week |
|---|---|---|---|---|---|
| MCP-01 | MCP plugin scaffold: define x811 tools (register, discover, request, pay, verify) | P2 | SDK-01 | — | W3+ |
| MCP-02 | Tool: `x811_register` — register agent with DID and capabilities | P2 | MCP-01, SDK-03 | US-AP-01 | W3+ |
| MCP-03 | Tool: `x811_discover` — discover providers by capability and trust score | P2 | MCP-01, SDK-04 | US-AI-01 | W3+ |
| MCP-04 | Tool: `x811_request` — send negotiation request to provider | P2 | MCP-01, SDK-06 | US-AI-04 | W3+ |
| MCP-05 | Tool: `x811_pay` — execute x402 payment for completed task | P2 | MCP-01, SDK-07 | US-AI-08 | W3+ |
| MCP-06 | Tool: `x811_verify` — verify interaction proof on-chain | P2 | MCP-01, SDK-07 | US-X8-05 | W3+ |
| MCP-07 | Tests for MCP plugin tools | P2 | MCP-01 to MCP-06 | — | W3+ |

---

## EPIC 17: Demo Agents

| ID | Task | Priority | Depends | Stories | Week | Status |
|---|---|---|---|---|---|---|
| DEM-01 | `[CP]` `demo/initiator/index.ts` — Initiator agent: discovery → verify → request → evaluate → accept → verify result → pay | P0 | SDK-01 to SDK-07 | US-AI-01 to US-AI-09 | W3 | DONE |
| DEM-02 | `[CP]` `demo/provider/index.ts` — Provider agent: register → publish card → receive request → offer → execute AAPL analysis → deliver result → receive payment | P0 | SDK-01 to SDK-07 | US-AP-01 to US-AP-07 | W3 | DONE |
| DEM-03 | AAPL financial analysis mock task (realistic output: recommendation, confidence, metrics) | P0 | — | US-AP-05 | W3 | DONE |
| DEM-04 | `[CP]` `demo/run-demo.ts` — Orchestrate full 10-step demo end-to-end | P0 | DEM-01, DEM-02 | — | W3 | DONE |
| DEM-05 | Acceptance policy demo: auto-accept with budget/trust/deadline checks | P0 | DEM-01, TYP-06 | US-AI-05 | W3 | DONE |
| DEM-06 | Demo logging: clear step-by-step console output showing all 10 steps | P0 | DEM-04 | — | W3 | DONE |

---

## EPIC 18: Deployment

| ID | Task | Priority | Depends | Stories | Week | Status |
|---|---|---|---|---|---|---|
| DEP-01 | `Dockerfile` — Multi-stage build (Node 20 Alpine), expose port 3811 | P0 | SRV-01 | — | W3 | DONE |
| DEP-02 | `docker-compose.yml` — x811-server service + x811-data volume | P0 | DEP-01 | — | W3 | DONE |
| DEP-03 | Dokploy service config with env vars and volume mount | P0 | DEP-02 | — | W3 | PENDING (needs VPS) |
| DEP-04 | DNS: configure api.x811.org → VPS IP | P0 | — | — | W3 | PENDING (needs VPS) |
| DEP-05 | SSL via Traefik + Let's Encrypt on api.x811.org | P0 | DEP-04 | — | W3 | PENDING (needs DNS) |
| DEP-06 | Fund relayer wallet with ETH on Base L2 for gas | P0 | SOL-08 | US-X8-ON1 | W3 | PENDING (needs SOL-08) |
| DEP-07 | Smoke test: run full demo against production deployment | P0 | DEP-01 to DEP-06, DEM-04 | — | W3 | PENDING (needs DEP-03 to DEP-06) |

---

## Weekly Sprint Plan

### Week 1 (Days 1-5): Core Protocol — Foundation

**Goal:** All types defined, crypto working, DID system complete, server running with registry + messaging + well-known endpoints, smart contract written and tested.

**Critical path:** INF-01→TYP-01→CRY-01→CRY-02→DID-01→SRV-02→REG-01→MSG-01

| Day | Focus | Tasks |
|---|---|---|
| D1 | Monorepo + types | INF-01 to INF-08, TYP-01 to TYP-07 |
| D2 | Crypto + DID + x402 spike | CRY-01, CRY-02, CRY-04, CRY-05, DID-01 to DID-05, PAY-10 |
| D3 | Server foundation + registry | SRV-01, SRV-02, SRV-03, SRV-05, REG-01 to REG-07 |
| D4 | Message router + well-known | MSG-01 to MSG-06, WK-01 to WK-04, EC-07, EC-08 |
| D5 | Smart contract + registry tests | SOL-01 to SOL-05, REG-08, PAY-08, BAT-06 |

### Week 2 (Days 6-10): Integration — Protocol Logic

**Goal:** Full negotiation flow, settlement, trust engine, batching/relayer working end-to-end with mocked externals.

**Critical path:** NEG-01→NEG-02→NEG-06→NEG-07→PAY-01→PAY-02→BAT-01→BAT-03

| Day | Focus | Tasks |
|---|---|---|
| D6 | Negotiation state machine + REQUEST/OFFER/ACCEPT | NEG-01 to NEG-05, NEG-09 |
| D7 | RESULT/VERIFY + TTLs | NEG-06 to NEG-08 |
| D8 | Settlement (x402) | PAY-01 to PAY-07 |
| D9 | Trust engine + batching | TRU-01 to TRU-06, BAT-01, BAT-02 |
| D10 | Relayer + verification routes + edge cases + tests | BAT-03 to BAT-07, NEG-10, PAY-09, EC-01 to EC-06, INF-09 |

### Week 3 (Days 11-15): Demo & Launch

**Goal:** SDK complete, demo agents running full 10-step flow, contract on mainnet, deployed to production.

**Critical path:** SDK-01→DEM-01→DEM-04→SOL-08→DEP-01→DEP-07

| Day | Focus | Tasks |
|---|---|---|
| D11 | TypeScript SDK | SDK-01 to SDK-08 |
| D12 | Demo agents + AAPL task | DEM-01 to DEM-06 |
| D13 | Contract deployment (testnet → mainnet) + deploy script | SOL-06 to SOL-08 |
| D14 | Docker + Dokploy deployment | DEP-01 to DEP-06 |
| D15 | Production smoke test + buffer | DEP-07, SRV-04, TRU-04 |

---

## Summary

| Metric | Count |
|---|---|
| Total epics | 19 (0-18) |
| Total tasks | 114 |
| P0 tasks | 102 |
| P1 tasks | 5 |
| P2 tasks | 7 (Python SDK + MCP Plugin — deferred) |
| Critical path tasks | 36 |
| User stories covered | 25/25 |
| Edge cases covered | 8/8 |
| **DONE** | **97** |
| **PENDING (P1)** | **3** (INF-06, INF-09, CRY-03) |
| **PENDING (infra)** | **7** (SOL-07, SOL-08, DEP-03 to DEP-07) |
| **DEFERRED (P2)** | **7** (PY-01 to PY-06, MCP-01 to MCP-07) |
| **Tests passing** | **183** (core: 62, server: 86, SDK: 35) |
| **E2E demo** | **10/10 steps validated** |

---

## Inline Changelog

| Fecha | Cambio |
|---|---|
| 2026-02-19 06:00 | Creación — backlog completo con 114 tasks, 19 epics, sprint plan semanal |
| 2026-02-19 23:00 | Implementación completa — 97 tasks DONE, 183 tests passing, demo E2E 10/10 pasos. Pendiente: 3 P1 (lint, CI, encryption), 7 infra (deploy a Base + VPS), 7 P2 deferred. Bug encontrado y corregido: canonicalize shallow vs deep en auth.ts |
