/**
 * x811 Protocol — DID resolution from a registry endpoint.
 */

import type { DIDDocument, DIDStatus } from "../types/did.js";
import { X811Error, X811ErrorCode } from "../types/errors.js";
import { extractPublicKey, extractEncryptionKey } from "./document.js";

/** Result of resolving a DID from the registry. */
export interface ResolvedDID {
  /** The resolved DID Document. */
  document: DIDDocument;
  /** Current status of the DID. */
  status: DIDStatus;
  /** Raw Ed25519 public key bytes. */
  publicKey: Uint8Array;
  /** Raw X25519 encryption public key bytes. */
  encryptionKey: Uint8Array;
}

/**
 * Resolve a DID by fetching its document from a registry endpoint.
 * @param did - The DID to resolve (e.g., "did:x811:<uuid>").
 * @param registryUrl - Base URL of the DID registry API.
 * @throws {X811Error} If the DID is not found, revoked, or the format is invalid.
 */
export async function resolveDID(
  did: string,
  registryUrl: string,
): Promise<ResolvedDID> {
  // Validate DID format
  if (!did.startsWith("did:x811:")) {
    throw new X811Error(
      X811ErrorCode.INVALID_DID_FORMAT,
      `Invalid DID format: expected "did:x811:<id>", got "${did}"`,
    );
  }

  const agentId = did.slice("did:x811:".length);
  if (!agentId) {
    throw new X811Error(
      X811ErrorCode.INVALID_DID_FORMAT,
      "DID is missing the agent identifier",
    );
  }

  // Normalize registry URL (strip trailing slash)
  const baseUrl = registryUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/dids/${encodeURIComponent(did)}`;

  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new X811Error(
      X811ErrorCode.INTERNAL_ERROR,
      `Failed to reach DID registry at ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (response.status === 404) {
    throw new X811Error(
      X811ErrorCode.DID_NOT_FOUND,
      `DID not found: ${did}`,
    );
  }

  if (!response.ok) {
    throw new X811Error(
      X811ErrorCode.INTERNAL_ERROR,
      `Registry returned HTTP ${response.status} for DID ${did}`,
    );
  }

  const body = (await response.json()) as {
    document: DIDDocument;
    status: DIDStatus;
  };

  const { document, status } = body;

  // Reject revoked or deactivated DIDs
  if (status === "revoked") {
    throw new X811Error(
      X811ErrorCode.DID_REVOKED,
      `DID has been revoked: ${did}`,
    );
  }
  if (status === "deactivated") {
    throw new X811Error(
      X811ErrorCode.DID_DEACTIVATED,
      `DID has been deactivated: ${did}`,
    );
  }

  const publicKey = extractPublicKey(document);
  const encryptionKey = extractEncryptionKey(document);

  return { document, status, publicKey, encryptionKey };
}
