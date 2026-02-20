/**
 * x811 Protocol — Relayer Service.
 *
 * Submits Merkle batch roots to the X811TrustAnchor smart contract
 * on Base L2. Uses a gas-subsidy pattern: the relayer pays gas so
 * individual agents never need ETH.
 *
 * Also exports MockRelayerService for local development / testing.
 */

import { ethers } from "ethers";

// ---------------------------------------------------------------------------
// Contract ABI (minimal interface for X811TrustAnchor)
// ---------------------------------------------------------------------------

const X811_TRUST_ANCHOR_ABI = [
  "function submitBatch(bytes32 _merkleRoot, uint256 _count) external",
  "function verifyInclusion(uint256 _batchId, bytes32 _leaf, bytes32[] calldata _proof) external view returns (bool)",
  "function batchCount() external view returns (uint256)",
  "function batches(uint256) external view returns (bytes32, uint256, uint256)",
  "event BatchSubmitted(uint256 indexed batchId, bytes32 merkleRoot, uint256 interactionCount)",
];

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface IRelayerService {
  submitBatch(merkleRoot: string, count: number): Promise<string>;
  verifyInclusion(
    batchId: number,
    leaf: string,
    proof: string[],
  ): Promise<boolean>;
  getBalance(): Promise<string>;
}

// ---------------------------------------------------------------------------
// Production relayer
// ---------------------------------------------------------------------------

export class RelayerService implements IRelayerService {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private contract: ethers.Contract;

  constructor(rpcUrl: string, privateKey: string, contractAddress: string) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.contract = new ethers.Contract(
      contractAddress,
      X811_TRUST_ANCHOR_ABI,
      this.wallet,
    );
  }

  /**
   * Submit a Merkle root to the on-chain trust anchor.
   * @param merkleRoot - Hex-encoded Merkle root (with 0x prefix)
   * @param count - Number of interactions in this batch
   * @returns Transaction hash
   */
  async submitBatch(merkleRoot: string, count: number): Promise<string> {
    const root = merkleRoot.startsWith("0x")
      ? merkleRoot
      : `0x${merkleRoot}`;

    const tx = await this.contract.submitBatch(root, count);
    const receipt = await tx.wait();
    return receipt.hash;
  }

  /**
   * Verify that a leaf is included in a batch's Merkle tree on-chain.
   * @param batchId - Batch ID on the contract
   * @param leaf - Hex-encoded leaf hash (with 0x prefix)
   * @param proof - Array of hex-encoded proof nodes
   * @returns true if the leaf is proven to be in the batch
   */
  async verifyInclusion(
    batchId: number,
    leaf: string,
    proof: string[],
  ): Promise<boolean> {
    const leafHex = leaf.startsWith("0x") ? leaf : `0x${leaf}`;
    const proofHex = proof.map((p) => (p.startsWith("0x") ? p : `0x${p}`));
    return this.contract.verifyInclusion(batchId, leafHex, proofHex);
  }

  /**
   * Get the relayer wallet's ETH balance on Base L2.
   * Used by the health endpoint to monitor gas reserves.
   */
  async getBalance(): Promise<string> {
    const balance = await this.provider.getBalance(this.wallet.address);
    return ethers.formatEther(balance);
  }
}

// ---------------------------------------------------------------------------
// Mock relayer for local development / testing
// ---------------------------------------------------------------------------

interface MockBatch {
  id: number;
  merkleRoot: string;
  count: number;
  txHash: string;
  timestamp: number;
}

export class MockRelayerService implements IRelayerService {
  private batches: MockBatch[] = [];
  private nextId = 0;

  /**
   * Simulate a batch submission. Returns a fake transaction hash.
   */
  async submitBatch(merkleRoot: string, count: number): Promise<string> {
    const id = this.nextId++;
    const txHash = `0x${"0".repeat(24)}${id.toString(16).padStart(40, "0")}`;
    this.batches.push({
      id,
      merkleRoot,
      count,
      txHash,
      timestamp: Date.now(),
    });
    return txHash;
  }

  /**
   * In mock mode, always returns true for simplicity.
   * Real verification happens via the on-chain contract.
   */
  async verifyInclusion(
    _batchId: number,
    _leaf: string,
    _proof: string[],
  ): Promise<boolean> {
    return true;
  }

  /**
   * Return a mock balance.
   */
  async getBalance(): Promise<string> {
    return "1.000000000000000000";
  }

  /** Get all mock batches (for testing). */
  getBatches(): MockBatch[] {
    return [...this.batches];
  }
}
