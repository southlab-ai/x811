/**
 * x811 Protocol — DID generation with UUIDv7 agent identifiers.
 */

import { v7 as uuidv7 } from "uuid";
import type { DIDDocument, DIDKeyPair } from "../types/did.js";
import { generateDIDKeyPair } from "../crypto/keys.js";
import { buildDIDDocument } from "./document.js";

/** Result of generating a new DID. */
export interface GeneratedDID {
  /** The DID string (did:x811:<uuid>). */
  did: string;
  /** The W3C DID Document. */
  document: DIDDocument;
  /** The cryptographic key pair bound to this DID. */
  keyPair: DIDKeyPair;
}

/**
 * Generate a new x811 DID with a UUIDv7 agent identifier, cryptographic keys,
 * and a W3C-compliant DID Document.
 * @param serviceEndpoint - Optional service endpoint URL for agent communication.
 */
export function generateDID(serviceEndpoint?: string): GeneratedDID {
  const agentId = uuidv7();
  const keyPair = generateDIDKeyPair(agentId);
  const did = keyPair.did;

  const document = buildDIDDocument(
    did,
    keyPair.signingKey.publicKey,
    keyPair.encryptionKey.publicKey,
    serviceEndpoint,
  );

  return { did, document, keyPair };
}
