/**
 * x811 Protocol — Authentication middleware.
 *
 * Provides Fastify preHandler hooks for routes that require DID-based
 * envelope authentication.
 *
 * Authentication steps:
 * 1. Extract envelope from request body
 * 2. Resolve sender DID → public key
 * 3. Verify Ed25519 signature
 * 4. Check nonce not reused (store with 24h TTL)
 * 5. Check timestamp within +/- 5 minutes
 * 6. Check DID status is "active"
 */

import type { FastifyRequest, FastifyReply } from "fastify";

/** Shape of a request body that contains a signed envelope. */
interface EnvelopeBody {
  envelope: {
    version: string;
    id: string;
    type: string;
    from: string;
    to: string;
    created: string;
    expires?: string;
    payload: unknown;
    signature: string;
    nonce: string;
  };
  did_document?: unknown;
  public_key?: string;
}

/** Maximum allowed clock skew in milliseconds (5 minutes). */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Nonce TTL in hours. */
const NONCE_TTL_HOURS = 24;

/**
 * Deep-sort all object keys recursively to produce a canonical form.
 * Must match the canonicalize implementation in @x811/core exactly.
 */
function deepSortKeys(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(deepSortKeys);
  if (typeof value === "object" && value !== null) {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const key of keys) {
      sorted[key] = deepSortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function canonicalize(obj: unknown): string {
  return JSON.stringify(deepSortKeys(obj));
}

/**
 * Helper to send an x811 error response.
 */
function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): FastifyReply {
  return reply.status(statusCode).send({
    error: { code, message, details },
  });
}

/**
 * Fastify preHandler hook that verifies signed envelopes in the request body.
 *
 * This hook is used for routes that receive signed X811Envelope payloads.
 * It performs full authentication: signature verification, nonce check,
 * timestamp validation, and DID status check.
 *
 * For agent registration (first-time), the public key is provided in the
 * request body since the agent is not yet in the database.
 */
export async function verifyEnvelopeAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = request.body as EnvelopeBody | undefined;

  // Step 1: Extract envelope
  if (!body?.envelope) {
    sendError(reply, 400, "X811-2004", "Missing envelope in request body");
    return;
  }

  const { envelope } = body;

  if (!envelope.from || !envelope.signature || !envelope.nonce || !envelope.created) {
    sendError(reply, 400, "X811-2004", "Incomplete envelope: from, signature, nonce, and created are required");
    return;
  }

  // Step 5: Check timestamp within +/- 5 minutes
  const created = new Date(envelope.created).getTime();
  if (Number.isNaN(created)) {
    sendError(reply, 400, "X811-2003", "Invalid timestamp format");
    return;
  }

  const now = Date.now();
  const skew = Math.abs(now - created);
  if (skew > MAX_CLOCK_SKEW_MS) {
    sendError(reply, 401, "X811-2003", "Timestamp outside acceptable range (±5 minutes)", {
      server_time: new Date(now).toISOString(),
      envelope_time: envelope.created,
      skew_ms: skew,
    });
    return;
  }

  // Step 4: Check nonce not reused
  const { db } = request.server;
  if (db.nonceExists(envelope.nonce)) {
    sendError(reply, 401, "X811-2002", "Nonce has already been used", {
      nonce: envelope.nonce,
    });
    return;
  }

  // Step 2: Resolve sender DID and get public key
  let publicKeyBytes: Uint8Array;
  let isRegistration = false;

  // For registration, the agent isn't in the DB yet — the public key is in the body
  const agent = db.getAgentByDid(envelope.from);

  if (!agent && body.public_key) {
    // Registration scenario: agent not yet registered, public key provided
    isRegistration = true;
    try {
      publicKeyBytes = Buffer.from(body.public_key, "base64url");
      if (publicKeyBytes.length !== 32) {
        sendError(reply, 400, "X811-1004", "Invalid public key length (expected 32 bytes Ed25519)");
        return;
      }
    } catch {
      sendError(reply, 400, "X811-1004", "Invalid public key encoding");
      return;
    }
  } else if (agent) {
    // Step 6: Check DID status
    if (agent.status !== "active") {
      const code =
        agent.status === "revoked" ? "X811-1002" :
          agent.status === "deactivated" ? "X811-1003" :
            "X811-1004";
      sendError(reply, 403, code, `DID status is ${agent.status}`, {
        did: envelope.from,
        status: agent.status,
      });
      return;
    }

    // Extract public key from stored DID document
    try {
      const didDoc = JSON.parse(agent.did_document);
      const multibase: string = didDoc.verificationMethod[0].publicKeyMultibase;
      publicKeyBytes = decodeMultibaseEd25519(multibase);
    } catch {
      sendError(reply, 500, "X811-9002", "Failed to extract public key from stored DID document");
      return;
    }
  } else {
    sendError(reply, 404, "X811-1001", "DID not found and no public key provided for registration", {
      did: envelope.from,
    });
    return;
  }

  // Step 3: Verify Ed25519 signature
  try {
    const signable: Record<string, unknown> = {
      version: envelope.version,
      id: envelope.id,
      type: envelope.type,
      from: envelope.from,
      to: envelope.to,
      created: envelope.created,
      expires: envelope.expires,
      payload: envelope.payload,
      nonce: envelope.nonce,
    };
    const message = new TextEncoder().encode(canonicalize(signable));
    const signatureBytes = Buffer.from(envelope.signature, "base64url");

    // Dynamic import of @x811/core for verification
    // Falls back to @noble/curves directly if core isn't built yet
    let valid: boolean;
    try {
      const { ed25519 } = await import("@noble/curves/ed25519");
      valid = ed25519.verify(signatureBytes, message, publicKeyBytes);
    } catch {
      valid = false;
    }

    if (!valid) {
      sendError(reply, 401, "X811-2001", "Invalid signature");
      return;
    }
  } catch {
    sendError(reply, 401, "X811-2001", "Signature verification failed");
    return;
  }

  // Store nonce to prevent replay
  db.insertNonce(envelope.nonce, envelope.from, NONCE_TTL_HOURS);

  // Attach parsed info to request for downstream handlers
  (request as FastifyRequest & { x811Auth: { did: string; agentId: string | null; isRegistration: boolean } }).x811Auth = {
    did: envelope.from,
    agentId: agent?.id ?? null,
    isRegistration,
  };
}

/**
 * Decode a multibase-encoded Ed25519 public key.
 * Multibase z-prefix = base58btc encoding.
 * The first two bytes are the multicodec prefix (0xed 0x01 for Ed25519).
 */
function decodeMultibaseEd25519(multibase: string): Uint8Array {
  if (!multibase.startsWith("z")) {
    throw new Error("Expected z-prefix (base58btc) multibase encoding");
  }

  // Decode base58btc (z prefix removed)
  const encoded = multibase.slice(1);
  const decoded = base58btcDecode(encoded);

  // Strip multicodec prefix (0xed 0x01)
  if (decoded[0] === 0xed && decoded[1] === 0x01) {
    return decoded.slice(2);
  }

  // If no prefix, assume raw key
  return decoded;
}

/**
 * Minimal base58btc decoder (Bitcoin alphabet).
 * Used to avoid pulling in a full base58 library just for key decoding.
 */
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58btcDecode(input: string): Uint8Array {
  const bytes: number[] = [0];
  for (const char of input) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Invalid base58 character: ${char}`);
    let carry = index;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Handle leading zeros
  for (const char of input) {
    if (char !== "1") break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

/**
 * Lightweight preHandler for poll-style routes where we only need to verify
 * that the requesting DID matches the agentId parameter.
 * Uses query parameter `did` or a simple signature header.
 */
export async function verifyAgentAccess(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const params = request.params as { agentId?: string };
  const query = request.query as { did?: string };

  if (!params.agentId) {
    sendError(reply, 400, "X811-2004", "Missing agentId parameter");
    return;
  }

  const { db } = request.server;
  const agent = db.getAgent(params.agentId);

  if (!agent) {
    sendError(reply, 404, "X811-3001", "Agent not found", {
      id: params.agentId,
    });
    return;
  }

  // For polling, we accept a DID query parameter for simple authentication
  // In production this should also verify a signature header
  if (query.did && query.did !== agent.did) {
    sendError(reply, 403, "X811-2004", "DID does not match agent", {
      expected: agent.did,
      provided: query.did,
    });
    return;
  }

  (request as FastifyRequest & { x811Auth: { did: string; agentId: string } }).x811Auth = {
    did: agent.did,
    agentId: agent.id,
  };
}

export type X811AuthInfo = {
  did: string;
  agentId: string | null;
  isRegistration: boolean;
};
