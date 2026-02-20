/**
 * x811 Protocol — DID types following W3C DID Core specification.
 */

/** Status of a Decentralized Identifier. */
export type DIDStatus = "active" | "revoked" | "deactivated";

/** Agent availability for real-time discovery. */
export type AgentAvailability = "online" | "offline" | "busy" | "unknown";

/** Ed25519 verification method as per W3C DID spec. */
export interface Ed25519VerificationKey2020 {
  id: string;
  type: "Ed25519VerificationKey2020";
  controller: string;
  publicKeyMultibase: string;
}

/** X25519 key agreement method for encrypted communication. */
export interface X25519KeyAgreementKey2020 {
  id: string;
  type: "X25519KeyAgreementKey2020";
  controller: string;
  publicKeyMultibase: string;
}

/** Service endpoint for x811 agent-to-agent communication. */
export interface X811AgentService {
  id: string;
  type: "X811AgentService";
  serviceEndpoint: string;
}

/** W3C-compliant DID Document for an x811 agent. */
export interface DIDDocument {
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/suites/ed25519-2020/v1",
    "https://w3id.org/security/suites/x25519-2020/v1",
  ];
  id: string;
  verificationMethod: [Ed25519VerificationKey2020];
  authentication: [string];
  keyAgreement: [X25519KeyAgreementKey2020];
  service: X811AgentService[];
}

/** Cryptographic key pair bound to a DID. */
export interface DIDKeyPair {
  did: string;
  signingKey: {
    publicKey: Uint8Array;
    privateKey: Uint8Array;
  };
  encryptionKey: {
    publicKey: Uint8Array;
    privateKey: Uint8Array;
  };
}
