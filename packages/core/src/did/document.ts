/**
 * x811 Protocol — DID Document construction and key extraction.
 */

import { base58btc } from "multiformats/bases/base58";
import type { DIDDocument } from "../types/did.js";

/** Ed25519 multicodec prefix: 0xed 0x01 */
const ED25519_MULTICODEC_PREFIX = new Uint8Array([0xed, 0x01]);

/** X25519 multicodec prefix: 0xec 0x01 */
const X25519_MULTICODEC_PREFIX = new Uint8Array([0xec, 0x01]);

/**
 * Build a W3C-compliant DID Document for an x811 agent.
 * @param did - The agent's DID (e.g., "did:x811:<uuid>").
 * @param edPublicKey - Raw Ed25519 public key bytes (32 bytes).
 * @param x25519PublicKey - Raw X25519 public key bytes (32 bytes).
 * @param serviceEndpoint - Optional service endpoint URL.
 */
export function buildDIDDocument(
  did: string,
  edPublicKey: Uint8Array,
  x25519PublicKey: Uint8Array,
  serviceEndpoint?: string,
): DIDDocument {
  // Multibase encode: z prefix + base58btc(multicodec_prefix + raw_key)
  const edMultibase = base58btc.encode(
    concatBytes(ED25519_MULTICODEC_PREFIX, edPublicKey),
  );
  const x25519Multibase = base58btc.encode(
    concatBytes(X25519_MULTICODEC_PREFIX, x25519PublicKey),
  );

  const verificationMethodId = `${did}#key-1`;
  const keyAgreementId = `${did}#key-2`;

  const services = serviceEndpoint
    ? [
        {
          id: `${did}#agent-service`,
          type: "X811AgentService" as const,
          serviceEndpoint,
        },
      ]
    : [];

  return {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/suites/ed25519-2020/v1",
      "https://w3id.org/security/suites/x25519-2020/v1",
    ],
    id: did,
    verificationMethod: [
      {
        id: verificationMethodId,
        type: "Ed25519VerificationKey2020",
        controller: did,
        publicKeyMultibase: edMultibase,
      },
    ],
    authentication: [verificationMethodId],
    keyAgreement: [
      {
        id: keyAgreementId,
        type: "X25519KeyAgreementKey2020",
        controller: did,
        publicKeyMultibase: x25519Multibase,
      },
    ],
    service: services,
  };
}

/**
 * Extract the raw Ed25519 public key bytes from a DID Document.
 * @throws If no Ed25519VerificationKey2020 is found.
 */
export function extractPublicKey(document: DIDDocument): Uint8Array {
  const method = document.verificationMethod.find(
    (vm) => vm.type === "Ed25519VerificationKey2020",
  );
  if (!method) {
    throw new Error("No Ed25519VerificationKey2020 found in DID Document");
  }
  return decodeMultibase(method.publicKeyMultibase, ED25519_MULTICODEC_PREFIX);
}

/**
 * Extract the raw X25519 public key bytes from a DID Document.
 * @throws If no X25519KeyAgreementKey2020 is found.
 */
export function extractEncryptionKey(document: DIDDocument): Uint8Array {
  const method = document.keyAgreement.find(
    (ka) => ka.type === "X25519KeyAgreementKey2020",
  );
  if (!method) {
    throw new Error("No X25519KeyAgreementKey2020 found in DID Document");
  }
  return decodeMultibase(method.publicKeyMultibase, X25519_MULTICODEC_PREFIX);
}

/**
 * Decode a multibase-encoded public key, stripping the multicodec prefix.
 */
function decodeMultibase(multibase: string, expectedPrefix: Uint8Array): Uint8Array {
  const decoded = base58btc.decode(multibase);
  // Verify multicodec prefix
  for (let i = 0; i < expectedPrefix.length; i++) {
    if (decoded[i] !== expectedPrefix[i]) {
      throw new Error(
        `Invalid multicodec prefix: expected ${bytesToHex(expectedPrefix)}, ` +
        `got ${bytesToHex(decoded.slice(0, expectedPrefix.length))}`,
      );
    }
  }
  return decoded.slice(expectedPrefix.length);
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
