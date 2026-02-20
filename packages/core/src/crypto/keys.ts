/**
 * x811 Protocol — Cryptographic key generation for Ed25519 signing and X25519 encryption.
 */

import { ed25519, x25519 } from "@noble/curves/ed25519";
import { randomBytes } from "node:crypto";
import type { DIDKeyPair } from "../types/did.js";

/** A raw cryptographic key pair. */
export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/** Generate an Ed25519 signing key pair. */
export function generateSigningKeyPair(): KeyPair {
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

/** Generate an X25519 encryption key pair for key agreement. */
export function generateEncryptionKeyPair(): KeyPair {
  const privateKey = new Uint8Array(randomBytes(32));
  const publicKey = x25519.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

/**
 * Generate a full DID key pair containing both signing and encryption keys.
 * @param agentId - The agent identifier to embed in the DID.
 */
export function generateDIDKeyPair(agentId: string): DIDKeyPair {
  const signing = generateSigningKeyPair();
  const encryption = generateEncryptionKeyPair();

  return {
    did: `did:x811:${agentId}`,
    signingKey: {
      publicKey: signing.publicKey,
      privateKey: signing.privateKey,
    },
    encryptionKey: {
      publicKey: encryption.publicKey,
      privateKey: encryption.privateKey,
    },
  };
}
