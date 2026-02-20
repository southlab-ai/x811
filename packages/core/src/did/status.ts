/**
 * x811 Protocol — DID status validation and transition rules.
 */

import type { DIDStatus } from "../types/did.js";
import { X811Error, X811ErrorCode } from "../types/errors.js";

/**
 * Valid DID status transitions.
 * - active -> revoked (permanent)
 * - active -> deactivated (recoverable)
 * - deactivated -> active (reactivation)
 */
const VALID_TRANSITIONS: ReadonlyMap<DIDStatus, ReadonlySet<DIDStatus>> = new Map([
  ["active", new Set<DIDStatus>(["revoked", "deactivated"])],
  ["deactivated", new Set<DIDStatus>(["active"])],
  ["revoked", new Set<DIDStatus>()], // terminal — no transitions allowed
]);

/**
 * Check whether a DID status transition is valid.
 * @param from - Current status.
 * @param to - Target status.
 * @returns true if the transition is allowed.
 */
export function isValidTransition(from: DIDStatus, to: DIDStatus): boolean {
  const allowed = VALID_TRANSITIONS.get(from);
  return allowed !== undefined && allowed.has(to);
}

/**
 * Validate that a DID status allows operations.
 * @throws {X811Error} If the DID is revoked or deactivated.
 */
export function validateDIDStatus(status: DIDStatus): void {
  if (status === "revoked") {
    throw new X811Error(
      X811ErrorCode.DID_REVOKED,
      "DID has been permanently revoked",
    );
  }
  if (status === "deactivated") {
    throw new X811Error(
      X811ErrorCode.DID_DEACTIVATED,
      "DID is currently deactivated",
    );
  }
}
