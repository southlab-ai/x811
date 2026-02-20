/**
 * x811 Protocol — Envelope signing, verification, and canonical serialization.
 */

import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import type { X811Envelope } from "../types/messages.js";

/**
 * Deep-sort all object keys recursively to produce a canonical form.
 * Arrays preserve element order but objects within arrays are also sorted.
 */
export function canonicalize(obj: unknown): string {
  return JSON.stringify(deepSortKeys(obj));
}

function deepSortKeys(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(deepSortKeys);
  }
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

/** Base64url encode a Uint8Array (no padding). */
function toBase64Url(bytes: Uint8Array): string {
  const binString = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binString).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode a base64url string to Uint8Array. */
function fromBase64Url(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binString = atob(padded);
  return Uint8Array.from(binString, (c) => c.charCodeAt(0));
}

/**
 * Extract the signable fields from an envelope (everything except the signature).
 */
function extractSignableFields<T>(envelope: X811Envelope<T>): Record<string, unknown> {
  const { signature: _sig, ...signable } = envelope;
  return signable;
}

/**
 * Sign an x811 envelope. Takes an envelope without a signature and a private key,
 * returns a complete envelope with a base64url-encoded Ed25519 signature.
 */
export function signEnvelope<T>(
  envelope: Omit<X811Envelope<T>, "signature">,
  privateKey: Uint8Array,
): X811Envelope<T> {
  const canonical = canonicalize(envelope);
  const messageBytes = new TextEncoder().encode(canonical);
  const sig = ed25519.sign(messageBytes, privateKey);
  return {
    ...envelope,
    signature: toBase64Url(sig),
  };
}

/**
 * Verify the Ed25519 signature on an x811 envelope.
 * @returns true if the signature is valid, false otherwise.
 */
export function verifyEnvelope<T>(
  envelope: X811Envelope<T>,
  publicKey: Uint8Array,
): boolean {
  try {
    const signable = extractSignableFields(envelope);
    const canonical = canonicalize(signable);
    const messageBytes = new TextEncoder().encode(canonical);
    const sigBytes = fromBase64Url(envelope.signature);
    return ed25519.verify(sigBytes, messageBytes, publicKey);
  } catch {
    return false;
  }
}

/**
 * Compute the SHA-256 hex digest of canonicalized data.
 */
export function hashPayload(data: unknown): string {
  const canonical = canonicalize(data);
  const bytes = new TextEncoder().encode(canonical);
  return bytesToHex(sha256(bytes));
}
