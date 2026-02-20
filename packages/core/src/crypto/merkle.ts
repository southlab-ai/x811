/**
 * x811 Protocol — Merkle tree for trust-anchor batch proofs.
 */

import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

/** Compute the SHA-256 hex digest of a string. */
function hashLeaf(data: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(data)));
}

/** Compute the SHA-256 hex digest of two concatenated hex hashes (sorted). */
function hashPair(a: string, b: string): string {
  const [left, right] = a < b ? [a, b] : [b, a];
  return bytesToHex(sha256(new TextEncoder().encode(left + right)));
}

/**
 * Sorted Merkle tree for batching interaction hashes on-chain.
 *
 * Leaves are SHA-256 hashed, sorted, then paired bottom-up.
 * Supports inclusion proofs and static verification.
 */
export class MerkleTree {
  private readonly leaves: string[];
  private readonly layers: string[][];

  constructor(items: string[]) {
    if (items.length === 0) {
      this.leaves = [];
      this.layers = [[]];
      return;
    }

    // Hash and sort leaves
    this.leaves = items.map(hashLeaf).sort();

    // Build layers bottom-up
    this.layers = [this.leaves];
    let current = this.leaves;

    while (current.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < current.length; i += 2) {
        if (i + 1 < current.length) {
          next.push(hashPair(current[i], current[i + 1]));
        } else {
          // Odd element promoted as-is
          next.push(current[i]);
        }
      }
      this.layers.push(next);
      current = next;
    }
  }

  /** The Merkle root hash (hex). Returns empty string for an empty tree. */
  get root(): string {
    const topLayer = this.layers[this.layers.length - 1];
    return topLayer.length > 0 ? topLayer[0] : "";
  }

  /**
   * Get an inclusion proof for an item (original unhashed value).
   * @returns Array of sibling hashes from leaf to root.
   * @throws If the item is not in the tree.
   */
  getProof(item: string): string[] {
    const leaf = hashLeaf(item);
    let index = this.leaves.indexOf(leaf);
    if (index === -1) {
      throw new Error(`Item not found in Merkle tree: ${item}`);
    }

    const proof: string[] = [];
    for (let layerIdx = 0; layerIdx < this.layers.length - 1; layerIdx++) {
      const layer = this.layers[layerIdx];
      // Find sibling
      const siblingIdx = index % 2 === 0 ? index + 1 : index - 1;
      if (siblingIdx < layer.length) {
        proof.push(layer[siblingIdx]);
      }
      // Move to parent index
      index = Math.floor(index / 2);
    }

    return proof;
  }

  /**
   * Verify that a leaf (original unhashed value) is included in a tree with the given root.
   */
  static verify(leaf: string, proof: string[], root: string): boolean {
    let current = hashLeaf(leaf);

    for (const sibling of proof) {
      current = hashPair(current, sibling);
    }

    return current === root;
  }
}
