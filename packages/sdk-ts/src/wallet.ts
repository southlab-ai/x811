/**
 * x811 Protocol — Wallet abstraction for x402 USDC payments on Base L2.
 *
 * Provides WalletService for real on-chain transactions and MockWalletService
 * for testing without network access.
 */

import { ethers } from "ethers";
import { randomBytes } from "node:crypto";
import type { PaymentPayload } from "@x811/core";

// ---------------------------------------------------------------------------
// Constants — USDC on Base L2
// ---------------------------------------------------------------------------

/** USDC contract address on Base mainnet. */
const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** Base mainnet RPC URL (public). */
const BASE_RPC_URL = "https://mainnet.base.org";

/** Minimal ERC-20 ABI for transfer and balanceOf. */
const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

// ---------------------------------------------------------------------------
// WalletService — Real on-chain USDC payments
// ---------------------------------------------------------------------------

export class WalletService {
  private readonly _wallet: ethers.Wallet;
  private readonly _provider: ethers.JsonRpcProvider;
  private readonly _usdc: ethers.Contract;

  /**
   * Create a WalletService with a private key for signing transactions.
   * @param privateKey - Hex-encoded Ethereum private key (with or without 0x prefix).
   * @param rpcUrl - Optional custom RPC URL. Defaults to Base mainnet public RPC.
   */
  constructor(privateKey: string, rpcUrl?: string) {
    this._provider = new ethers.JsonRpcProvider(rpcUrl ?? BASE_RPC_URL);
    this._wallet = new ethers.Wallet(privateKey, this._provider);
    this._usdc = new ethers.Contract(BASE_USDC_ADDRESS, ERC20_ABI, this._wallet);
  }

  /** The wallet's Ethereum address. */
  get address(): string {
    return this._wallet.address;
  }

  /**
   * Execute a USDC transfer on Base L2 and return a PaymentPayload.
   *
   * @param params - Payment parameters.
   * @param params.to_address - Recipient's Ethereum address.
   * @param params.amount - Amount in USDC (human-readable, e.g., 1.50).
   * @param params.providerDid - DID of the payment recipient (for the payload).
   * @param params.requestId - Request ID this payment settles.
   * @param params.offerId - Offer ID this payment settles.
   * @returns A PaymentPayload suitable for sending via X811Client.pay().
   */
  async pay(params: {
    to_address: string;
    amount: number;
    providerDid: string;
    requestId: string;
    offerId: string;
  }): Promise<PaymentPayload> {
    // USDC has 6 decimals
    const amountWei = ethers.parseUnits(String(params.amount), 6);

    const tx = await this._usdc.transfer(params.to_address, amountWei) as ethers.ContractTransactionResponse;
    const receipt = await tx.wait();

    if (!receipt) {
      throw new Error("Transaction receipt is null — transaction may have been dropped");
    }

    return {
      request_id: params.requestId,
      offer_id: params.offerId,
      tx_hash: receipt.hash,
      amount: String(params.amount),
      currency: "USDC",
      network: "base",
      payer_address: this._wallet.address,
      payee_address: params.to_address,
    };
  }

  /**
   * Get the USDC balance for this wallet on Base L2.
   * @returns Balance in human-readable USDC (e.g., 100.50).
   */
  async getBalance(): Promise<number> {
    const balance = await this._usdc.balanceOf(this._wallet.address) as bigint;
    return Number(ethers.formatUnits(balance, 6));
  }
}

// ---------------------------------------------------------------------------
// MockWalletService — Testing without network access
// ---------------------------------------------------------------------------

export class MockWalletService {
  private readonly _address: string;
  private _balance: number;

  /**
   * Create a mock wallet for testing.
   * @param address - Optional mock address. Defaults to a random address.
   * @param balance - Optional initial mock balance in USDC. Defaults to 1000.
   */
  constructor(address?: string, balance?: number) {
    this._address = address ?? `0x${randomBytes(20).toString("hex")}`;
    this._balance = balance ?? 1000;
  }

  /** The mock wallet's Ethereum address. */
  get address(): string {
    return this._address;
  }

  /**
   * Simulate a USDC payment. Returns a PaymentPayload with a mock tx hash.
   * Deducts the amount from the mock balance.
   */
  async pay(params: {
    to_address: string;
    amount: number;
    providerDid: string;
    requestId: string;
    offerId: string;
  }): Promise<PaymentPayload> {
    if (params.amount > this._balance) {
      throw new Error(
        `Insufficient mock balance: have ${this._balance} USDC, need ${params.amount} USDC`,
      );
    }

    this._balance -= params.amount;

    // Generate a realistic-looking mock tx hash
    const mockTxHash = `0x${randomBytes(32).toString("hex")}`;

    return {
      request_id: params.requestId,
      offer_id: params.offerId,
      tx_hash: mockTxHash,
      amount: String(params.amount),
      currency: "USDC",
      network: "base",
      payer_address: this._address,
      payee_address: params.to_address,
    };
  }

  /**
   * Get the mock USDC balance.
   */
  async getBalance(): Promise<number> {
    return this._balance;
  }
}
