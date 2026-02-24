# x811 AEEP Protocol -- Benchmark Report

Generated: 2026-02-23
Node: v24.12.0
OS: win32 x64 10.0.26100

## Protocol Comparison Matrix

| Feature | x811 AEEP | ERC-8004 | x402 | A2A | ANP |
|---------|:---------:|:--------:|:----:|:---:|:---:|
| DID-based identity | Y | Y | - | - | Y |
| Signed message envelopes | Y | - | - | - | - |
| Price negotiation | Y | - | - | - | - |
| Budget constraints | Y | - | - | - | - |
| Rejection with reason codes | Y | - | - | - | - |
| Trust scoring (0.0-1.0) | Y | Y | - | - | - |
| Trust-gated acceptance | Y | - | - | - | - |
| Result verification | Y | - | - | - | - |
| Verify-then-pay | Y | - | - | - | - |
| Merkle proof anchoring | Y | - | - | - | - |
| 10-state machine | Y | - | - | Y | - |
| TTL-bounded transitions | Y | - | - | - | - |
| Protocol fee structure | Y | - | - | - | - |
| Idempotency keys | Y | - | - | - | - |
| Nonce replay protection | Y | - | - | - | - |
| Gas subsidized settlement | Y | - | - | - | - |
| Dispute signaling | Y | - | - | - | - |
| **Total** | **17/17** | **2/17** | **0/17** | **1/17** | **1/17** |

## Performance Benchmarks

> No benchmark results found. Run benchmarks to generate data:
>
> ```bash
> npx vitest bench --config benchmarks/vitest.config.ts --reporter=json > benchmarks/benchmark-results.json
> ```

| Benchmark | ops/sec | Mean | p99 | Samples |
|-----------|--------:|-----:|----:|--------:|
| **Trust Score Calculation** | | | | |
| Calculate trust score | (pending) | (pending) | (pending) | - |
| Apply time decay | (pending) | (pending) | (pending) | - |
| **Full Negotiation Cycle** | | | | |
| Complete 6-message flow | (pending) | (pending) | (pending) | - |
| **Individual Operations** | | | | |
| Handle REQUEST message | (pending) | (pending) | (pending) | - |
| Insert agent to DB | (pending) | (pending) | (pending) | - |
| Insert interaction to DB | (pending) | (pending) | (pending) | - |
| **Key Generation** | | | | |
| Ed25519 key pair generation | (pending) | (pending) | (pending) | - |
| X25519 key pair generation | (pending) | (pending) | (pending) | - |
| Full DID generation | (pending) | (pending) | (pending) | - |
| **Merkle Tree Construction** | | | | |
| Build tree with 100 items | (pending) | (pending) | (pending) | - |
| Build tree with 1,000 items | (pending) | (pending) | (pending) | - |
| Build tree with 10,000 items | (pending) | (pending) | (pending) | - |

## Conclusion

x811 AEEP is the only protocol providing all 17 capabilities required for autonomous AI agent economic interactions. It combines DID-based identity, cryptographic message signing, price negotiation with budget constraints, trust scoring with gated acceptance, result verification, Merkle proof anchoring, and on-chain settlement into a single cohesive protocol.

No existing protocol -- ERC-8004 (2/17), x402 (0/17), A2A (1/17), or ANP (1/17) -- provides more than a fraction of these features.
