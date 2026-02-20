/**
 * x811 Protocol — Batching Service.
 *
 * Collects completed interaction hashes and batches them into Merkle
 * trees for on-chain anchoring. Batches are submitted when either:
 * - Size threshold is reached (default 100 interactions), or
 * - Time threshold elapses (default 5 minutes)
 *
 * Each interaction gets a Merkle proof stored in the database for
 * later independent verification.
 */

import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

import type { Database } from "../db/schema.js";
import type { IRelayerService } from "./relayer.js";

// ---------------------------------------------------------------------------
// Minimal Merkle Tree implementation (server-side)
// If @x811/core's MerkleTree is available, this can be swapped.
// ---------------------------------------------------------------------------

class MerkleTree {
  private leaves: Uint8Array[];
  private layers: Uint8Array[][];

  constructor(items: string[]) {
    this.leaves = items
      .map((item) => sha256(new TextEncoder().encode(item)))
      .sort((a, b) => compareBytes(a, b));
    this.layers = this.buildTree();
  }

  private buildTree(): Uint8Array[][] {
    if (this.leaves.length === 0) return [[]];
    let layer = [...this.leaves];
    const layers = [layer];
    while (layer.length > 1) {
      const nextLayer: Uint8Array[] = [];
      for (let i = 0; i < layer.length; i += 2) {
        const left = layer[i];
        const right = i + 1 < layer.length ? layer[i + 1] : left;
        const [a, b] =
          compareBytes(left, right) <= 0 ? [left, right] : [right, left];
        const combined = new Uint8Array(a.length + b.length);
        combined.set(a, 0);
        combined.set(b, a.length);
        nextLayer.push(sha256(combined));
      }
      layers.push(nextLayer);
      layer = nextLayer;
    }
    return layers;
  }

  get root(): string {
    const topLayer = this.layers[this.layers.length - 1];
    return topLayer.length > 0
      ? bytesToHex(topLayer[0])
      : bytesToHex(sha256(new Uint8Array()));
  }

  getProof(item: string): string[] {
    const leaf = sha256(new TextEncoder().encode(item));
    let index = this.layers[0].findIndex(
      (l) => compareBytes(l, leaf) === 0,
    );
    if (index === -1) throw new Error("Item not found in tree");
    const proof: string[] = [];
    for (let i = 0; i < this.layers.length - 1; i++) {
      const layer = this.layers[i];
      const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
      if (siblingIndex >= 0 && siblingIndex < layer.length) {
        proof.push(bytesToHex(layer[siblingIndex]));
      }
      index = Math.floor(index / 2);
    }
    return proof;
  }

  getLeafHash(item: string): string {
    return bytesToHex(sha256(new TextEncoder().encode(item)));
  }

  static verify(leaf: string, proof: string[], root: string): boolean {
    let hash = sha256(new TextEncoder().encode(leaf));
    for (const sibling of proof) {
      const siblingBytes = hexToBytes(sibling);
      const [a, b] =
        compareBytes(hash, siblingBytes) <= 0
          ? [hash, siblingBytes]
          : [siblingBytes, hash];
      const combined = new Uint8Array(a.length + b.length);
      combined.set(a, 0);
      combined.set(b, a.length);
      hash = sha256(combined);
    }
    return bytesToHex(hash) === root;
  }
}

/** Compare two Uint8Arrays lexicographically. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

// ---------------------------------------------------------------------------
// Batching Service
// ---------------------------------------------------------------------------

export interface BatchingConfig {
  sizeThreshold: number;
  timeThresholdMs: number;
}

export class BatchingService {
  private pendingHashes: string[] = [];
  private lastBatchTime: number = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private db: Database,
    private relayer: IRelayerService,
    private config: BatchingConfig = {
      sizeThreshold: 100,
      timeThresholdMs: 300_000,
    },
  ) {}

  /**
   * Add an interaction hash to the pending buffer.
   * If the buffer reaches the size threshold, a batch is submitted automatically.
   */
  async addInteraction(interactionHash: string): Promise<void> {
    this.pendingHashes.push(interactionHash);
    if (this.pendingHashes.length >= this.config.sizeThreshold) {
      await this.submitBatch();
    }
  }

  /**
   * Build a Merkle tree from pending hashes, store proofs, and submit
   * the root to the blockchain via the relayer.
   */
  async submitBatch(): Promise<void> {
    if (this.pendingHashes.length === 0) return;

    // Take a snapshot of pending hashes and clear the buffer
    const hashes = [...this.pendingHashes];
    this.pendingHashes = [];
    this.lastBatchTime = Date.now();

    // 1. Build Merkle tree
    const tree = new MerkleTree(hashes);

    // 2. Store batch and proofs in the database
    const batchId = this.db.insertBatch(tree.root, hashes.length);

    for (const hash of hashes) {
      const proof = tree.getProof(hash);
      const leafHash = tree.getLeafHash(hash);
      this.db.insertMerkleProof(hash, batchId, proof, leafHash);
      this.db.updateInteractionBatch(hash, batchId);
    }

    // 3. Submit to chain via relayer
    try {
      const txHash = await this.relayer.submitBatch(
        `0x${tree.root}`,
        hashes.length,
      );
      this.db.updateBatchStatus(batchId, "submitted", txHash);
    } catch (error) {
      // On failure, mark batch as failed and re-queue hashes
      this.db.updateBatchStatus(batchId, "failed");
      this.pendingHashes.push(...hashes);
      // Log but don't throw — the hashes will be retried
      console.error("Batch submission failed:", error);
    }
  }

  /**
   * Check if the time threshold has been exceeded and submit if so.
   * Called periodically by the timer.
   */
  async checkTimeThreshold(): Promise<void> {
    const elapsed = Date.now() - this.lastBatchTime;
    if (
      elapsed >= this.config.timeThresholdMs &&
      this.pendingHashes.length > 0
    ) {
      await this.submitBatch();
    }
  }

  /**
   * Start the periodic timer that checks the time threshold every 30 seconds.
   */
  startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      try {
        await this.checkTimeThreshold();
      } catch (error) {
        console.error("Batch time threshold check failed:", error);
      }
    }, 30_000);
  }

  /**
   * Stop the periodic timer.
   */
  stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Get the current count of pending (unbatched) hashes. */
  get pendingCount(): number {
    return this.pendingHashes.length;
  }
}

export { MerkleTree };
