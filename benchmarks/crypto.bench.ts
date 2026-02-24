import { bench, describe } from "vitest";
import {
  generateSigningKeyPair,
  generateEncryptionKeyPair,
  generateDIDKeyPair,
} from "@x811/core";
import {
  signEnvelope,
  verifyEnvelope,
  hashPayload,
  canonicalize,
} from "@x811/core";
import type { X811Envelope } from "@x811/core";

// ---------------------------------------------------------------------------
// Key Generation
// ---------------------------------------------------------------------------
describe("Key Generation", () => {
  bench("Ed25519 key pair generation", () => {
    generateSigningKeyPair();
  });

  bench("X25519 key pair generation", () => {
    generateEncryptionKeyPair();
  });

  bench("Full DID generation", () => {
    generateDIDKeyPair("bench-" + Math.random());
  });
});

// ---------------------------------------------------------------------------
// Envelope Signing
// ---------------------------------------------------------------------------
describe("Envelope Signing", () => {
  const kp = generateSigningKeyPair();

  const unsigned: Omit<X811Envelope<{ data: string }>, "signature"> = {
    version: "0.1.0",
    id: "019c0000-0000-7000-8000-000000000001",
    type: "x811/request",
    from: "did:x811:bench-sender",
    to: "did:x811:bench-receiver",
    created: "2025-01-01T00:00:00Z",
    payload: { data: "benchmark-payload" },
    nonce: "bench-nonce-001",
  };

  const signed = signEnvelope(unsigned, kp.privateKey);

  bench("Sign envelope", () => {
    signEnvelope(unsigned, kp.privateKey);
  });

  bench("Verify envelope", () => {
    verifyEnvelope(signed, kp.publicKey);
  });

  bench("Sign + Verify roundtrip", () => {
    const s = signEnvelope(unsigned, kp.privateKey);
    verifyEnvelope(s, kp.publicKey);
  });
});

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------
describe("Hashing", () => {
  const smallPayload = { task_type: "test", parameters: {} };
  const largePayload = { task_type: "test", parameters: { data: "x".repeat(10000) } };
  const smallObject = { x: 1, y: 2, z: 3 };
  const nestedObject = { a: { b: { c: { d: 1, e: 2 }, f: 3 }, g: 4 }, h: 5 };

  bench("SHA-256 hash small (~50 bytes)", () => {
    hashPayload(smallPayload);
  });

  bench("SHA-256 hash large (~10KB)", () => {
    hashPayload(largePayload);
  });

  bench("Canonicalize small object", () => {
    canonicalize(smallObject);
  });

  bench("Canonicalize nested 3-level object", () => {
    canonicalize(nestedObject);
  });
});

// ---------------------------------------------------------------------------
// Envelope Size
// ---------------------------------------------------------------------------
describe("Envelope Size", () => {
  const kp = generateSigningKeyPair();
  const payload = { task_type: "financial-analysis", parameters: { symbol: "ETH" } };

  const unsigned: Omit<X811Envelope<typeof payload>, "signature"> = {
    version: "0.1.0",
    id: "019c0000-0000-7000-8000-000000000002",
    type: "x811/request",
    from: "did:x811:bench-sender",
    to: "did:x811:bench-receiver",
    created: "2025-01-01T00:00:00Z",
    payload,
    nonce: "bench-nonce-size",
  };

  const signed = signEnvelope(unsigned, kp.privateKey);

  bench("Measure envelope overhead", () => {
    const rawSize = new TextEncoder().encode(JSON.stringify(payload)).length;
    const fullSize = new TextEncoder().encode(JSON.stringify(signed)).length;
    const overhead = fullSize - rawSize;
    if (overhead >= 500) {
      throw new Error(`Overhead ${overhead} exceeds 500 bytes`);
    }
  });

  bench("Verify signature is exactly 64 bytes", () => {
    const b64 = signed.signature.replace(/-/g, "+").replace(/_/g, "/");
    const binString = atob(b64);
    const sigBytes = Uint8Array.from(binString, (c) => c.charCodeAt(0));
    if (sigBytes.length !== 64) {
      throw new Error(`Signature is ${sigBytes.length} bytes, expected 64`);
    }
  });
});
