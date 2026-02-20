import { describe, it, expect } from "vitest";
import {
  generateSigningKeyPair,
  generateEncryptionKeyPair,
  generateDIDKeyPair,
} from "../crypto/keys.js";
import {
  canonicalize,
  signEnvelope,
  verifyEnvelope,
  hashPayload,
} from "../crypto/signing.js";
import { MerkleTree } from "../crypto/merkle.js";
import type { X811Envelope } from "../types/messages.js";

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------
describe("Key Generation", () => {
  it("generates an Ed25519 signing key pair with 32-byte keys", () => {
    const kp = generateSigningKeyPair();
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.privateKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.length).toBe(32);
    expect(kp.privateKey.length).toBe(32);
  });

  it("generates unique signing key pairs on each call", () => {
    const a = generateSigningKeyPair();
    const b = generateSigningKeyPair();
    expect(a.publicKey).not.toEqual(b.publicKey);
    expect(a.privateKey).not.toEqual(b.privateKey);
  });

  it("generates an X25519 encryption key pair with 32-byte keys", () => {
    const kp = generateEncryptionKeyPair();
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.privateKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.length).toBe(32);
    expect(kp.privateKey.length).toBe(32);
  });

  it("generates unique encryption key pairs on each call", () => {
    const a = generateEncryptionKeyPair();
    const b = generateEncryptionKeyPair();
    expect(a.publicKey).not.toEqual(b.publicKey);
  });

  it("generates a DID key pair with correct structure", () => {
    const kp = generateDIDKeyPair("test-agent-001");
    expect(kp.did).toBe("did:x811:test-agent-001");
    expect(kp.signingKey.publicKey.length).toBe(32);
    expect(kp.signingKey.privateKey.length).toBe(32);
    expect(kp.encryptionKey.publicKey.length).toBe(32);
    expect(kp.encryptionKey.privateKey.length).toBe(32);
  });
});

// ---------------------------------------------------------------------------
// Canonicalize
// ---------------------------------------------------------------------------
describe("canonicalize", () => {
  it("sorts top-level keys alphabetically", () => {
    const result = canonicalize({ z: 1, a: 2, m: 3 });
    expect(result).toBe('{"a":2,"m":3,"z":1}');
  });

  it("deep-sorts nested objects", () => {
    const result = canonicalize({ b: { z: 1, a: 2 }, a: 1 });
    expect(result).toBe('{"a":1,"b":{"a":2,"z":1}}');
  });

  it("deep-sorts objects inside arrays", () => {
    const result = canonicalize({ items: [{ z: 1, a: 2 }] });
    expect(result).toBe('{"items":[{"a":2,"z":1}]}');
  });

  it("preserves array element order", () => {
    const result = canonicalize({ arr: [3, 1, 2] });
    expect(result).toBe('{"arr":[3,1,2]}');
  });

  it("produces deterministic output regardless of insertion order", () => {
    const a = canonicalize({ x: 1, y: 2, z: 3 });
    const b = canonicalize({ z: 3, x: 1, y: 2 });
    expect(a).toBe(b);
  });

  it("handles null and undefined values", () => {
    const result = canonicalize({ a: null, b: undefined });
    // JSON.stringify omits undefined values
    expect(result).toBe('{"a":null}');
  });

  it("handles deeply nested structures", () => {
    const obj = { c: { b: { a: { z: 1, y: 2 } } } };
    const result = canonicalize(obj);
    expect(result).toBe('{"c":{"b":{"a":{"y":2,"z":1}}}}');
  });
});

// ---------------------------------------------------------------------------
// Sign / Verify envelope roundtrip
// ---------------------------------------------------------------------------
describe("Envelope Signing and Verification", () => {
  function makeTestEnvelope(): Omit<X811Envelope<{ data: string }>, "signature"> {
    return {
      version: "0.1.0",
      id: "019c0000-0000-7000-8000-000000000001",
      type: "x811/request",
      from: "did:x811:sender",
      to: "did:x811:receiver",
      created: "2025-01-01T00:00:00Z",
      payload: { data: "test-payload" },
      nonce: "unique-nonce-001",
    };
  }

  it("signs and verifies an envelope successfully", () => {
    const kp = generateSigningKeyPair();
    const unsigned = makeTestEnvelope();
    const signed = signEnvelope(unsigned, kp.privateKey);

    expect(signed.signature).toBeDefined();
    expect(signed.signature.length).toBeGreaterThan(0);
    // Verify base64url: no +, /, or = characters
    expect(signed.signature).toMatch(/^[A-Za-z0-9_-]+$/);

    const valid = verifyEnvelope(signed, kp.publicKey);
    expect(valid).toBe(true);
  });

  it("rejects a tampered envelope (modified payload)", () => {
    const kp = generateSigningKeyPair();
    const unsigned = makeTestEnvelope();
    const signed = signEnvelope(unsigned, kp.privateKey);

    const tampered = { ...signed, payload: { data: "tampered" } };
    expect(verifyEnvelope(tampered, kp.publicKey)).toBe(false);
  });

  it("rejects a tampered envelope (modified nonce)", () => {
    const kp = generateSigningKeyPair();
    const unsigned = makeTestEnvelope();
    const signed = signEnvelope(unsigned, kp.privateKey);

    const tampered = { ...signed, nonce: "different-nonce" };
    expect(verifyEnvelope(tampered, kp.publicKey)).toBe(false);
  });

  it("rejects verification with wrong public key", () => {
    const kp1 = generateSigningKeyPair();
    const kp2 = generateSigningKeyPair();
    const signed = signEnvelope(makeTestEnvelope(), kp1.privateKey);

    expect(verifyEnvelope(signed, kp2.publicKey)).toBe(false);
  });

  it("rejects a corrupted signature", () => {
    const kp = generateSigningKeyPair();
    const signed = signEnvelope(makeTestEnvelope(), kp.privateKey);

    const corrupted = { ...signed, signature: "AAAA" + signed.signature.slice(4) };
    expect(verifyEnvelope(corrupted, kp.publicKey)).toBe(false);
  });

  it("preserves all envelope fields after signing", () => {
    const kp = generateSigningKeyPair();
    const unsigned = makeTestEnvelope();
    const signed = signEnvelope(unsigned, kp.privateKey);

    expect(signed.version).toBe(unsigned.version);
    expect(signed.id).toBe(unsigned.id);
    expect(signed.type).toBe(unsigned.type);
    expect(signed.from).toBe(unsigned.from);
    expect(signed.to).toBe(unsigned.to);
    expect(signed.created).toBe(unsigned.created);
    expect(signed.payload).toEqual(unsigned.payload);
    expect(signed.nonce).toBe(unsigned.nonce);
  });
});

// ---------------------------------------------------------------------------
// hashPayload
// ---------------------------------------------------------------------------
describe("hashPayload", () => {
  it("returns a 64-character hex string (SHA-256)", () => {
    const hash = hashPayload({ foo: "bar" });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces the same hash for equivalent objects with different key order", () => {
    const a = hashPayload({ x: 1, y: 2 });
    const b = hashPayload({ y: 2, x: 1 });
    expect(a).toBe(b);
  });

  it("produces different hashes for different data", () => {
    const a = hashPayload({ value: "alpha" });
    const b = hashPayload({ value: "beta" });
    expect(a).not.toBe(b);
  });

  it("handles nested objects consistently", () => {
    const a = hashPayload({ outer: { z: 1, a: 2 } });
    const b = hashPayload({ outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// MerkleTree
// ---------------------------------------------------------------------------
describe("MerkleTree", () => {
  it("builds a tree from multiple items and has a hex root", () => {
    const tree = new MerkleTree(["alpha", "beta", "gamma", "delta"]);
    expect(tree.root).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces a deterministic root for the same items regardless of order", () => {
    const tree1 = new MerkleTree(["alpha", "beta", "gamma"]);
    const tree2 = new MerkleTree(["gamma", "alpha", "beta"]);
    expect(tree1.root).toBe(tree2.root);
  });

  it("generates and verifies inclusion proofs for every item", () => {
    const items = ["item-a", "item-b", "item-c", "item-d", "item-e"];
    const tree = new MerkleTree(items);

    for (const item of items) {
      const proof = tree.getProof(item);
      expect(MerkleTree.verify(item, proof, tree.root)).toBe(true);
    }
  });

  it("rejects an invalid proof (wrong item)", () => {
    const tree = new MerkleTree(["alpha", "beta", "gamma"]);
    const proof = tree.getProof("alpha");
    expect(MerkleTree.verify("not-in-tree", proof, tree.root)).toBe(false);
  });

  it("rejects an invalid proof (wrong root)", () => {
    const tree = new MerkleTree(["alpha", "beta"]);
    const proof = tree.getProof("alpha");
    const fakeRoot = "0".repeat(64);
    expect(MerkleTree.verify("alpha", proof, fakeRoot)).toBe(false);
  });

  it("handles a single-item tree", () => {
    const tree = new MerkleTree(["only-one"]);
    expect(tree.root).toMatch(/^[0-9a-f]{64}$/);

    const proof = tree.getProof("only-one");
    expect(proof).toHaveLength(0);
    expect(MerkleTree.verify("only-one", proof, tree.root)).toBe(true);
  });

  it("handles an empty tree gracefully", () => {
    const tree = new MerkleTree([]);
    expect(tree.root).toBe("");
  });

  it("throws when requesting proof for an absent item", () => {
    const tree = new MerkleTree(["a", "b"]);
    expect(() => tree.getProof("missing")).toThrow("Item not found");
  });

  it("handles odd number of items correctly", () => {
    const items = ["one", "two", "three"];
    const tree = new MerkleTree(items);
    for (const item of items) {
      const proof = tree.getProof(item);
      expect(MerkleTree.verify(item, proof, tree.root)).toBe(true);
    }
  });

  it("handles power-of-two number of items correctly", () => {
    const items = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const tree = new MerkleTree(items);
    for (const item of items) {
      const proof = tree.getProof(item);
      expect(MerkleTree.verify(item, proof, tree.root)).toBe(true);
    }
  });
});
