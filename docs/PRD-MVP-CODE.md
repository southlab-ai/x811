# x811 Protocol — PRD para Coding del MVP

**Para:** Claude Code (implementación)
**Deadline:** 11 Mar 2026
**Status:** READY TO CODE

---

## Qué es x811

Protocolo abierto para identity (DID), trust (on-chain), y settlement (x402) entre agentes de IA. "El DNS + SSL + Stripe de la economía de agentes."

---

## Qué construir (MVP)

### Demo target
Dos agentes reales ejecutan un análisis financiero de AAPL: discover → verify → negotiate → execute → deliver → pay → record on-chain. $0.03 USDC en Base L2.

### 7 componentes

1. **DID System** — Generación y verificación de DIDs (`did:web:x811.org:agents:{uuid}`, Ed25519 + X25519)
2. **Comunicación autenticada** — Envelope firmado con Ed25519, nonce para replay protection, timestamp validation ±5min
3. **Agent Registry** — CRUD + Discovery API con Agent Cards (A2A compatible + extensiones x811)
4. **Negotiation Protocol** — 6 mensajes firmados: REQUEST → OFFER → ACCEPT → RESULT → VERIFY → PAY
5. **Settlement** — x402 para pagos agent-to-agent, USDC en Base L2
6. **On-chain Trust** — Smart contract X811TrustAnchor en Base L2, Merkle tree batching
7. **Gas Subsidy** — Relayer pattern, x811 paga gas, agentes no necesitan ETH

### Deferred (P2 — no en MVP demo)
- **MCP Plugin** (`npx x811 init`) — Scaffold para que MCP servers usen x811. Tracked pero no necesario para el demo.
- **OpenClaw Skill** (`clawhub install x811`) — Idem.
- **Python SDK** — Ninguna user story lo referencia; TypeScript SDK es suficiente para MVP.

---

## Flujo de 10 pasos (el demo completo)

```
STEP 1 — DISCOVERY
  Iniciador → x811: GET /agents?capability=financial-analysis&trust_min=0.8
  x811 → Iniciador: [FinAnalyst-Pro (trust: 0.94, price: $0.01-0.05)]

STEP 2 — IDENTITY VERIFICATION
  Iniciador → x811: GET /agents/{id}/did
  x811 → Iniciador: DID Document (Ed25519 public key)
  Iniciador: verifica DID activo, no revocado

STEP 3 — AUTHENTICATED COMMUNICATION
  Iniciador → x811 → Proveedor: REQUEST firmado {task, params, max_budget, deadline, acceptance_policy}

STEP 4 — NEGOTIATION
  Proveedor → x811 → Iniciador: OFFER firmado {price, estimated_time, deliverables, expiry}

STEP 5 — AUTONOMOUS ACCEPTANCE
  Iniciador evalúa: price ≤ max_budget ✅, time ≤ deadline ✅, trust ≥ min ✅
  → AUTO-ACCEPT: ACCEPT firmado {offer_hash}

STEP 6 — EXECUTION
  Proveedor: ejecuta análisis financiero de AAPL

STEP 7 — DELIVERY
  Proveedor → x811 → Iniciador: RESULT firmado {recommendation, confidence, metrics, result_hash}

STEP 8 — VERIFICATION
  Iniciador: verifica firma ✅, schema ✅, sanity checks ✅

STEP 9 — SETTLEMENT
  Iniciador → Proveedor: x402 payment, $0.03 USDC, Base L2

STEP 10 — RECORD & TRUST UPDATE
  x811: interaction_hash → Merkle tree → publish root on-chain
  x811: actualiza trust scores
```

---

## User Stories P0 (25 stories — las únicas que importan para el MVP)

### Agente Iniciador (9)

| ID | Story | Acceptance Criteria clave |
|---|---|---|
| US-AI-01 | Descubrir proveedores | GET /agents?capability=X&trust_min=Y funciona |
| US-AI-02 | Verificar identidad | DID resolve + status check |
| US-AI-03 | Canal autenticado | Mensajes firmados Ed25519, verificación bilateral |
| US-AI-04 | Enviar request | Payload firmado con task, params, budget, deadline, policy |
| US-AI-05 | Evaluar offer | Auto/threshold/human policies |
| US-AI-06 | Aceptar offer | Accept firmado con offer_hash |
| US-AI-07 | Verificar resultado | Firma + hash + schema validation |
| US-AI-08 | Pagar vía x402 | USDC en Base L2, pre-flight balance check |
| US-AI-09 | Procesar resultado | Almacenar receipt completo |

### Agente Proveedor (7)

| ID | Story | Acceptance Criteria clave |
|---|---|---|
| US-AP-01 | Registrarse | DID + capabilities + pricing, firmado |
| US-AP-02 | Publicar Agent Card | A2A compatible + x811 extensions |
| US-AP-03 | Recibir request | Verificar firma, evaluar viabilidad |
| US-AP-04 | Enviar offer | Price + time + deliverables, firmada, con TTL |
| US-AP-05 | Ejecutar tarea | Post-acceptance, dentro del deadline |
| US-AP-06 | Entregar resultado | Firmado + hash + output_schema |
| US-AP-07 | Recibir pago | USDC vía x402, confirmar receipt |

### Protocolo x811 (9)

| ID | Story | Acceptance Criteria clave |
|---|---|---|
| US-X8-01 | Generar DID | did:web + Ed25519 + X25519, W3C compliant |
| US-X8-02 | Registry | CRUD + search por capability, trust, status |
| US-X8-03 | Verificar identidad | Firma check en cada mensaje |
| US-X8-04 | Message routing | Verificar sender → queue → deliver/poll |
| US-X8-05 | Registrar interacción | interaction_hash → Merkle tree → on-chain |
| US-X8-06 | Trust score | 0.0-1.0, nuevo=0.5, weighted success + time decay |
| US-X8-07 | Servir Agent Cards | GET /agents/{id}/card, A2A compatible |
| US-X8-14 | Merkle batching | 100 txs ó 5min → submit root on-chain |
| US-X8-ON1 | Gas subsidy | Relayer paga gas, agentes sin ETH |

---

## Edge Cases (8 — implementar)

| ID | Case | Handling |
|---|---|---|
| EC-01 | Timeout proveedor | deadline + grace → cancel → retry next |
| EC-02 | Resultado malformado | schema validation → reject → no pago |
| EC-03 | No providers | Error X811-3004 |
| EC-04 | DID revocado mid-flow | Re-verify antes de pagar |
| EC-05 | Insufficient funds | Pre-flight balance check |
| EC-06 | Double request/payment | Idempotency key |
| EC-07 | Firma inválida | Reject + log |
| EC-08 | Proveedor sin DID | 401 Unauthorized |

---

## Métricas de éxito (P0 — must-have)

1. Dos agentes con DID se comunican remotamente
2. Cada mensaje firmado y verificado
3. Discovery funcional (capability + trust)
4. Negotiation completa 100% autónoma
5. Tarea real ejecutada (análisis financiero AAPL)
6. Pago ejecutado ($0.03 USDC Base L2 vía x402)
7. Interacción registrada con hash verificable
8. Agnóstico de plataforma
9. Trust anclado on-chain (Merkle root en Base L2)
10. Gas subsidiado (relayer paga)

---

## Negotiation Protocol

6 mensajes firmados con Ed25519:
```
1. REQUEST   (Iniciador → Proveedor): {task, params, max_budget, deadline, acceptance_policy}
2. OFFER     (Proveedor → Iniciador): {price, estimated_time, deliverables, terms, expiry}
3. ACCEPT    (Iniciador → Proveedor): {offer_hash, commitment}  // o REJECT con razón
4. RESULT    (Proveedor → Iniciador): {data, result_hash, methodology}
5. VERIFY    (Iniciador valida): schema + sanity checks
6. PAY       (Iniciador → Proveedor): x402 payment, USDC, Base L2
```

### State Machine (10 estados)

```
pending → offered → accepted → delivered → verified → completed
                                                    ↘ expired
                  ↘ rejected
                                         ↘ disputed
                                                    ↘ failed
```

### TTLs por defecto

| Transición | TTL |
|---|---|
| REQUEST → OFFER | 60s |
| OFFER → ACCEPT | 5 min |
| ACCEPT → RESULT | 1h (configurable) |
| RESULT → VERIFY | 30s (server-side) |
| VERIFY → PAY | 60s |
| PAY confirmation | 30s |
| Payment retries | 4 (backoff: 5s, 15s, 60s, 300s) |

---

## Acceptance Policy (cómo decide el iniciador)

```json
{
  "acceptance_policy": "auto" | "human_approval" | "threshold",
  "threshold_amount": 0.05,
  "min_trust_score": 0.8,
  "max_budget_per_task": 1.00,
  "allowed_capabilities": ["financial-analysis"]
}
```

- `auto`: acepta si price ≤ budget AND time ≤ deadline AND trust ≥ min
- `human_approval`: escala al operador
- `threshold`: auto si price < threshold, escala si ≥

---

## Message Envelope

```typescript
interface X811Envelope<T> {
  version: "0.1.0";
  id: string;           // UUIDv7
  type: X811MessageType;
  from: string;         // DID sender
  to: string;           // DID recipient
  created: string;      // ISO 8601
  expires?: string;
  payload: T;
  signature: string;    // Base64url Ed25519
  nonce: string;        // Replay protection
}
```

11 message types: `x811/request`, `x811/offer`, `x811/accept`, `x811/reject`, `x811/result`, `x811/verify`, `x811/payment`, `x811/payment-failed`, `x811/cancel`, `x811/heartbeat`, `x811/error`

---

## Identity — DID

- Format: `did:web:x811.org:agents:{uuid}`
- Keys: Ed25519 (signing) + X25519 (encryption)
- Document: `.well-known/did.json`, W3C compliant
- Status: active | revoked | deactivated
- Nuevo agente: trust score 0.5

---

## Trust Score

- Range: 0.0 – 1.0
- Nuevo = 0.5
- Inputs: successful_interactions, failed_interactions, disputes, time_active
- Algoritmo: weighted success rate + time decay + dispute penalty (3x)
- Formula: 70% adjusted rate + 20% raw success + 10% activity bonus

---

## Heartbeat / Availability

- Agentes envían heartbeat periódico: `POST /agents/{id}/heartbeat` (firmado)
- Payload: `{availability: "online"|"busy"|"offline", capacity: N, ttl: 300}`
- Si no hay heartbeat en TTL → server marca availability = "unknown"
- Discovery excluye agentes `unknown` y `offline` por defecto

---

## x402 Compatibility Note

> **SPIKE REQUERIDO (Día 2):** x402 está diseñado para HTTP 402 paywalls, no para bilateral agent settlements. Validar en Week 1 que @coinbase/x402 soporta transferencias USDC agent-to-agent. **Fallback:** transferencia directa USDC ERC-20 via ethers.js.

---

## Protocol Fee (MVP temporal)

- 2.5% del precio de cada transacción
- En MVP: cobrado en USDC (temporal), va a multisig del protocolo
- Post-MVP (E3): se cobra en $X811 tokens
- Distribución: 60% disputes, 20% gas, 10% community, 10% burn
- Campo `protocol_fee` y `total_cost` en OfferPayload

---

## Inline Changelog

| Fecha | Cambio |
|---|---|
| 2026-02-19 05:00 | Creación — lean PRD extraído de prd-mvp-v2.md para coding |
| 2026-02-19 05:30 | Agregado: MCP plugin/OpenClaw/Python SDK como deferred P2, heartbeat/availability, x402 spike note |
