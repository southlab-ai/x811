import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateDID } from "../did/generate.js";
import {
  buildDIDDocument,
  extractPublicKey,
  extractEncryptionKey,
} from "../did/document.js";
import { resolveDID } from "../did/resolve.js";
import { isValidTransition, validateDIDStatus } from "../did/status.js";
import { generateSigningKeyPair, generateEncryptionKeyPair } from "../crypto/keys.js";
import { X811Error, X811ErrorCode } from "../types/errors.js";

// ---------------------------------------------------------------------------
// generateDID
// ---------------------------------------------------------------------------
describe("generateDID", () => {
  it("produces a DID in the correct format", () => {
    const result = generateDID();
    expect(result.did).toMatch(/^did:x811:[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("generates unique DIDs on each call", () => {
    const a = generateDID();
    const b = generateDID();
    expect(a.did).not.toBe(b.did);
  });

  it("returns a valid DID Document", () => {
    const result = generateDID("https://agent.example.com");
    expect(result.document).toBeDefined();
    expect(result.document.id).toBe(result.did);
  });

  it("returns a key pair bound to the DID", () => {
    const result = generateDID();
    expect(result.keyPair.did).toBe(result.did);
    expect(result.keyPair.signingKey.publicKey.length).toBe(32);
    expect(result.keyPair.signingKey.privateKey.length).toBe(32);
    expect(result.keyPair.encryptionKey.publicKey.length).toBe(32);
    expect(result.keyPair.encryptionKey.privateKey.length).toBe(32);
  });

  it("includes service endpoint when provided", () => {
    const result = generateDID("https://agent.example.com");
    expect(result.document.service).toHaveLength(1);
    expect(result.document.service[0].type).toBe("X811AgentService");
    expect(result.document.service[0].serviceEndpoint).toBe("https://agent.example.com");
  });

  it("has empty service array when no endpoint is given", () => {
    const result = generateDID();
    expect(result.document.service).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DID Document — W3C compliance
// ---------------------------------------------------------------------------
describe("DID Document (W3C Compliance)", () => {
  it("has the required @context entries", () => {
    const result = generateDID();
    const ctx = result.document["@context"];
    expect(ctx).toContain("https://www.w3.org/ns/did/v1");
    expect(ctx).toContain("https://w3id.org/security/suites/ed25519-2020/v1");
    expect(ctx).toContain("https://w3id.org/security/suites/x25519-2020/v1");
  });

  it("has a verificationMethod with Ed25519VerificationKey2020", () => {
    const result = generateDID();
    const vm = result.document.verificationMethod[0];
    expect(vm.type).toBe("Ed25519VerificationKey2020");
    expect(vm.controller).toBe(result.did);
    expect(vm.publicKeyMultibase).toMatch(/^z/);
  });

  it("has an authentication reference", () => {
    const result = generateDID();
    expect(result.document.authentication).toHaveLength(1);
    expect(result.document.authentication[0]).toBe(
      result.document.verificationMethod[0].id,
    );
  });

  it("has a keyAgreement with X25519KeyAgreementKey2020", () => {
    const result = generateDID();
    const ka = result.document.keyAgreement[0];
    expect(ka.type).toBe("X25519KeyAgreementKey2020");
    expect(ka.controller).toBe(result.did);
    expect(ka.publicKeyMultibase).toMatch(/^z/);
  });
});

// ---------------------------------------------------------------------------
// extractPublicKey / extractEncryptionKey roundtrip
// ---------------------------------------------------------------------------
describe("Key Extraction Roundtrip", () => {
  it("extractPublicKey returns the original Ed25519 public key bytes", () => {
    const signing = generateSigningKeyPair();
    const encryption = generateEncryptionKeyPair();
    const did = "did:x811:test-roundtrip";
    const doc = buildDIDDocument(did, signing.publicKey, encryption.publicKey);

    const extracted = extractPublicKey(doc);
    expect(extracted).toEqual(signing.publicKey);
  });

  it("extractEncryptionKey returns the original X25519 public key bytes", () => {
    const signing = generateSigningKeyPair();
    const encryption = generateEncryptionKeyPair();
    const did = "did:x811:test-roundtrip";
    const doc = buildDIDDocument(did, signing.publicKey, encryption.publicKey);

    const extracted = extractEncryptionKey(doc);
    expect(extracted).toEqual(encryption.publicKey);
  });

  it("roundtrips through generateDID", () => {
    const result = generateDID();
    const extractedSigning = extractPublicKey(result.document);
    const extractedEncryption = extractEncryptionKey(result.document);

    expect(extractedSigning).toEqual(result.keyPair.signingKey.publicKey);
    expect(extractedEncryption).toEqual(result.keyPair.encryptionKey.publicKey);
  });
});

// ---------------------------------------------------------------------------
// DID Status transitions
// ---------------------------------------------------------------------------
describe("DID Status Transitions", () => {
  it("allows active -> revoked", () => {
    expect(isValidTransition("active", "revoked")).toBe(true);
  });

  it("allows active -> deactivated", () => {
    expect(isValidTransition("active", "deactivated")).toBe(true);
  });

  it("allows deactivated -> active (reactivation)", () => {
    expect(isValidTransition("deactivated", "active")).toBe(true);
  });

  it("disallows revoked -> active (permanent)", () => {
    expect(isValidTransition("revoked", "active")).toBe(false);
  });

  it("disallows revoked -> deactivated", () => {
    expect(isValidTransition("revoked", "deactivated")).toBe(false);
  });

  it("disallows active -> active (no-op)", () => {
    expect(isValidTransition("active", "active")).toBe(false);
  });

  it("disallows deactivated -> revoked", () => {
    expect(isValidTransition("deactivated", "revoked")).toBe(false);
  });
});

describe("validateDIDStatus", () => {
  it("does not throw for active status", () => {
    expect(() => validateDIDStatus("active")).not.toThrow();
  });

  it("throws X811Error for revoked status", () => {
    expect(() => validateDIDStatus("revoked")).toThrow(X811Error);
    try {
      validateDIDStatus("revoked");
    } catch (e) {
      expect((e as X811Error).code).toBe(X811ErrorCode.DID_REVOKED);
    }
  });

  it("throws X811Error for deactivated status", () => {
    expect(() => validateDIDStatus("deactivated")).toThrow(X811Error);
    try {
      validateDIDStatus("deactivated");
    } catch (e) {
      expect((e as X811Error).code).toBe(X811ErrorCode.DID_DEACTIVATED);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveDID (with fetch mock)
// ---------------------------------------------------------------------------
describe("resolveDID", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(status: number, body?: unknown): void {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as Response);
  }

  it("resolves an active DID from the registry", async () => {
    const result = generateDID("https://agent.example.com");

    mockFetch(200, {
      document: result.document,
      status: "active",
    });

    const resolved = await resolveDID(result.did, "https://registry.example.com");
    expect(resolved.status).toBe("active");
    expect(resolved.document.id).toBe(result.did);
    expect(resolved.publicKey).toEqual(result.keyPair.signingKey.publicKey);
    expect(resolved.encryptionKey).toEqual(result.keyPair.encryptionKey.publicKey);
  });

  it("throws DID_NOT_FOUND for 404 response", async () => {
    mockFetch(404);

    await expect(
      resolveDID("did:x811:nonexistent", "https://registry.example.com"),
    ).rejects.toThrow(X811Error);

    try {
      await resolveDID("did:x811:nonexistent", "https://registry.example.com");
    } catch (e) {
      expect((e as X811Error).code).toBe(X811ErrorCode.DID_NOT_FOUND);
    }
  });

  it("throws DID_REVOKED for revoked status", async () => {
    const result = generateDID();
    mockFetch(200, { document: result.document, status: "revoked" });

    await expect(
      resolveDID(result.did, "https://registry.example.com"),
    ).rejects.toThrow(X811Error);

    try {
      await resolveDID(result.did, "https://registry.example.com");
    } catch (e) {
      expect((e as X811Error).code).toBe(X811ErrorCode.DID_REVOKED);
    }
  });

  it("throws DID_DEACTIVATED for deactivated status", async () => {
    const result = generateDID();
    mockFetch(200, { document: result.document, status: "deactivated" });

    await expect(
      resolveDID(result.did, "https://registry.example.com"),
    ).rejects.toThrow(X811Error);

    try {
      await resolveDID(result.did, "https://registry.example.com");
    } catch (e) {
      expect((e as X811Error).code).toBe(X811ErrorCode.DID_DEACTIVATED);
    }
  });

  it("throws INVALID_DID_FORMAT for non-x811 DID", async () => {
    await expect(
      resolveDID("did:web:example.com", "https://registry.example.com"),
    ).rejects.toThrow(X811Error);

    try {
      await resolveDID("did:web:example.com", "https://registry.example.com");
    } catch (e) {
      expect((e as X811Error).code).toBe(X811ErrorCode.INVALID_DID_FORMAT);
    }
  });

  it("throws INVALID_DID_FORMAT for empty agent ID", async () => {
    await expect(
      resolveDID("did:x811:", "https://registry.example.com"),
    ).rejects.toThrow(X811Error);

    try {
      await resolveDID("did:x811:", "https://registry.example.com");
    } catch (e) {
      expect((e as X811Error).code).toBe(X811ErrorCode.INVALID_DID_FORMAT);
    }
  });

  it("constructs the correct registry URL", async () => {
    const result = generateDID();
    mockFetch(200, { document: result.document, status: "active" });

    await resolveDID(result.did, "https://registry.example.com/");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/dids/${encodeURIComponent(result.did)}`),
    );
    // Verify no double slashes from trailing slash
    const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).not.toContain("//dids");
  });
});
