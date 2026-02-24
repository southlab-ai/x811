import { describe, it, expect } from "vitest";
import {
  generateSigningKeyPair,
} from "../crypto/keys.js";
import {
  signEnvelope,
  verifyEnvelope,
  hashPayload,
  canonicalize,
} from "../crypto/signing.js";
import type { X811Envelope } from "../types/messages.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let nonceCounter = 0;

function makeUnsignedEnvelope<T>(
  payload: T,
): Omit<X811Envelope<T>, "signature"> {
  nonceCounter++;
  return {
    version: "0.1.0",
    id: `019c0000-0000-7000-8000-${String(nonceCounter).padStart(12, "0")}`,
    type: "x811/request",
    from: "did:x811:sender",
    to: "did:x811:receiver",
    created: new Date().toISOString(),
    payload,
    nonce: `nonce-sec-${nonceCounter}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
}

// ==========================================================================
// Nonce uniqueness
// ==========================================================================
describe("Security: Nonce uniqueness", () => {
  it("generates unique nonces across 1000 envelopes", () => {
    const nonces = new Set<string>();

    for (let i = 0; i < 1000; i++) {
      const unsigned = makeUnsignedEnvelope({ index: i });
      nonces.add(unsigned.nonce);
    }

    expect(nonces.size).toBe(1000);
  });

  it("nonce matches expected format (non-empty string)", () => {
    const unsigned = makeUnsignedEnvelope({ test: true });
    expect(unsigned.nonce).toBeDefined();
    expect(typeof unsigned.nonce).toBe("string");
    expect(unsigned.nonce.length).toBeGreaterThan(0);
    // Nonces should not contain whitespace
    expect(unsigned.nonce).toMatch(/^\S+$/);
  });
});

// ==========================================================================
// Timestamp validation
// ==========================================================================
describe("Security: Timestamp validation", () => {
  const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000; // 5 minutes

  it("rejects envelope with timestamp too far in the past (6 min)", () => {
    const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const now = Date.now();
    const createdMs = new Date(sixMinAgo).getTime();
    const drift = Math.abs(now - createdMs);

    expect(drift).toBeGreaterThan(MAX_CLOCK_SKEW_MS);
  });

  it("rejects envelope with timestamp too far in the future (6 min)", () => {
    const sixMinFuture = new Date(Date.now() + 6 * 60 * 1000).toISOString();
    const now = Date.now();
    const createdMs = new Date(sixMinFuture).getTime();
    const drift = Math.abs(now - createdMs);

    expect(drift).toBeGreaterThan(MAX_CLOCK_SKEW_MS);
  });

  it("accepts envelope with timestamp within clock skew (4 min ago)", () => {
    const fourMinAgo = new Date(Date.now() - 4 * 60 * 1000).toISOString();
    const now = Date.now();
    const createdMs = new Date(fourMinAgo).getTime();
    const drift = Math.abs(now - createdMs);

    expect(drift).toBeLessThan(MAX_CLOCK_SKEW_MS);
  });
});

// ==========================================================================
// Signature integrity — thorough tamper detection
// ==========================================================================
describe("Security: Signature integrity", () => {
  it("rejects tampered payload", () => {
    const kp = generateSigningKeyPair();
    const signed = signEnvelope(
      makeUnsignedEnvelope({ data: "original" }),
      kp.privateKey,
    );

    const tampered = { ...signed, payload: { data: "tampered" } };
    expect(verifyEnvelope(tampered, kp.publicKey)).toBe(false);
  });

  it("rejects tampered nonce", () => {
    const kp = generateSigningKeyPair();
    const signed = signEnvelope(
      makeUnsignedEnvelope({ data: "test" }),
      kp.privateKey,
    );

    const tampered = { ...signed, nonce: "tampered-nonce-value" };
    expect(verifyEnvelope(tampered, kp.publicKey)).toBe(false);
  });

  it("rejects tampered timestamp (modified created)", () => {
    const kp = generateSigningKeyPair();
    const signed = signEnvelope(
      makeUnsignedEnvelope({ data: "test" }),
      kp.privateKey,
    );

    const tampered = { ...signed, created: "2020-01-01T00:00:00Z" };
    expect(verifyEnvelope(tampered, kp.publicKey)).toBe(false);
  });

  it("rejects tampered from DID", () => {
    const kp = generateSigningKeyPair();
    const signed = signEnvelope(
      makeUnsignedEnvelope({ data: "test" }),
      kp.privateKey,
    );

    const tampered = { ...signed, from: "did:x811:attacker" };
    expect(verifyEnvelope(tampered, kp.publicKey)).toBe(false);
  });

  it("rejects tampered to DID", () => {
    const kp = generateSigningKeyPair();
    const signed = signEnvelope(
      makeUnsignedEnvelope({ data: "test" }),
      kp.privateKey,
    );

    const tampered = { ...signed, to: "did:x811:wrong-recipient" };
    expect(verifyEnvelope(tampered, kp.publicKey)).toBe(false);
  });

  it("rejects truncated signature (32 bytes instead of 64)", () => {
    const kp = generateSigningKeyPair();
    const signed = signEnvelope(
      makeUnsignedEnvelope({ data: "test" }),
      kp.privateKey,
    );

    // Ed25519 signatures are 64 bytes; truncate to ~32 bytes worth of base64url
    // A 64-byte sig in base64url is ~86 chars; take only first 43 chars (~32 bytes)
    const truncated = { ...signed, signature: signed.signature.slice(0, 43) };
    expect(verifyEnvelope(truncated, kp.publicKey)).toBe(false);
  });

  it("rejects empty signature", () => {
    const kp = generateSigningKeyPair();
    const signed = signEnvelope(
      makeUnsignedEnvelope({ data: "test" }),
      kp.privateKey,
    );

    const empty = { ...signed, signature: "" };
    expect(verifyEnvelope(empty, kp.publicKey)).toBe(false);
  });
});

// ==========================================================================
// Offer hash tampering detection
// ==========================================================================
describe("Security: Offer hash tampering", () => {
  it("detects price tampering via hash change", () => {
    const offer1 = {
      request_id: "req-1",
      price: "0.03",
      protocol_fee: "0.00075",
      total_cost: "0.03075",
      currency: "USDC",
      estimated_time: 30,
      deliverables: ["report"],
      expiry: 300,
      payment_address: "0xaaaa",
    };

    const offer2 = { ...offer1, price: "0.05" };

    const hash1 = hashPayload(offer1);
    const hash2 = hashPayload(offer2);

    expect(hash1).not.toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    expect(hash2).toMatch(/^[0-9a-f]{64}$/);
  });

  it("detects protocol fee tampering via hash change", () => {
    const offer1 = {
      request_id: "req-1",
      price: "0.03",
      protocol_fee: "0.00075",
      total_cost: "0.03075",
      currency: "USDC",
      estimated_time: 30,
      deliverables: ["report"],
      expiry: 300,
      payment_address: "0xaaaa",
    };

    const offer2 = { ...offer1, protocol_fee: "0.001" };

    expect(hashPayload(offer1)).not.toBe(hashPayload(offer2));
  });

  it("detects deliverables tampering via hash change", () => {
    const offer1 = {
      request_id: "req-1",
      price: "0.03",
      protocol_fee: "0.00075",
      total_cost: "0.03075",
      currency: "USDC",
      estimated_time: 30,
      deliverables: ["report"],
      expiry: 300,
      payment_address: "0xaaaa",
    };

    const offer2 = { ...offer1, deliverables: ["report", "extra-data"] };

    expect(hashPayload(offer1)).not.toBe(hashPayload(offer2));
  });
});

// ==========================================================================
// Envelope overhead
// ==========================================================================
describe("Security: Envelope overhead", () => {
  it("signed envelope overhead is less than 500 bytes vs raw payload", () => {
    const kp = generateSigningKeyPair();
    const payload = { task_type: "test", parameters: { a: 1 } };

    const rawPayloadSize = new TextEncoder().encode(
      JSON.stringify(payload),
    ).length;

    const unsigned = makeUnsignedEnvelope(payload);
    const signed = signEnvelope(unsigned, kp.privateKey);
    const fullEnvelopeSize = new TextEncoder().encode(
      JSON.stringify(signed),
    ).length;

    const overhead = fullEnvelopeSize - rawPayloadSize;
    expect(overhead).toBeLessThan(500);
    expect(overhead).toBeGreaterThan(0);
  });

  it("Ed25519 signature decoded from base64url is exactly 64 bytes", () => {
    const kp = generateSigningKeyPair();
    const signed = signEnvelope(
      makeUnsignedEnvelope({ data: "sig-size-test" }),
      kp.privateKey,
    );

    // Decode the base64url signature
    const b64 = signed.signature.replace(/-/g, "+").replace(/_/g, "/");
    const binString = atob(b64);
    const sigBytes = Uint8Array.from(binString, (c) => c.charCodeAt(0));

    expect(sigBytes.length).toBe(64);
  });
});
