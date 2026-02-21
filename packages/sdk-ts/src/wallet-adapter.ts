/**
 * x811 Protocol — WalletAdapter interface and implementations.
 *
 * Unified contract for all wallet operations: AgentKit (gasless CDP),
 * Ethers (raw private key), and Mock (test-only).
 */

import type { PaymentPayload } from "@x811/core";

// ---------------------------------------------------------------------------
// Address validation
// ---------------------------------------------------------------------------

const ZERO_ADDRESS = "0x" + "0".repeat(40);
const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
/** USDC contract on Base — cannot pay to the token contract itself. */
const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/**
 * Validate an Ethereum address for payment: non-zero, correct format, not USDC contract.
 */
export function isValidPaymentAddress(addr: string): boolean {
  if (!addr || typeof addr !== "string") return false;
  if (!ADDRESS_REGEX.test(addr)) return false;
  if (addr === ZERO_ADDRESS) return false;
  if (addr.toLowerCase() === BASE_USDC_ADDRESS.toLowerCase()) return false;
  return true;
}

// ---------------------------------------------------------------------------
// WalletPayParams
// ---------------------------------------------------------------------------

export interface WalletPayParams {
  /** Recipient's checksummed Ethereum address (non-zero, validated). */
  to_address: string;
  /** Amount in USDC whole units (e.g., "0.03"). */
  amount: string;
  /** DID of the payment recipient. */
  providerDid: string;
  /** Request ID this payment settles. */
  requestId: string;
  /** Offer ID this payment settles. */
  offerId: string;
}

// ---------------------------------------------------------------------------
// WalletAdapter interface
// ---------------------------------------------------------------------------

export interface WalletAdapter {
  /** Execute a USDC transfer and return a PaymentPayload. */
  pay(params: WalletPayParams): Promise<PaymentPayload>;
  /** Get the current USDC balance (6-decimal precision). */
  getBalance(): Promise<number>;
  /** The wallet's checksummed Ethereum address. */
  get address(): string;
  /** Which wallet backend is active. */
  get mode(): "agentkit" | "ethers" | "mock";
}

// ---------------------------------------------------------------------------
// EthersWalletAdapter — wraps existing WalletService
// ---------------------------------------------------------------------------

export class EthersWalletAdapter implements WalletAdapter {
  private readonly _walletService: {
    pay(params: { to_address: string; amount: number; providerDid: string; requestId: string; offerId: string }): Promise<PaymentPayload>;
    getBalance(): Promise<number>;
    address: string;
  };

  constructor(walletService: {
    pay(params: { to_address: string; amount: number; providerDid: string; requestId: string; offerId: string }): Promise<PaymentPayload>;
    getBalance(): Promise<number>;
    address: string;
  }) {
    this._walletService = walletService;
  }

  get address(): string {
    return this._walletService.address;
  }

  get mode(): "ethers" {
    return "ethers";
  }

  async pay(params: WalletPayParams): Promise<PaymentPayload> {
    if (!isValidPaymentAddress(params.to_address)) {
      throw new Error(`X811-5001: Invalid payment address: ${params.to_address}`);
    }
    return this._walletService.pay({
      to_address: params.to_address,
      amount: parseFloat(params.amount),
      providerDid: params.providerDid,
      requestId: params.requestId,
      offerId: params.offerId,
    });
  }

  async getBalance(): Promise<number> {
    return this._walletService.getBalance();
  }
}

// ---------------------------------------------------------------------------
// MockWalletAdapter — test-only, wraps existing MockWalletService
// ---------------------------------------------------------------------------

export class MockWalletAdapter implements WalletAdapter {
  private readonly _mockService: {
    pay(params: { to_address: string; amount: number; providerDid: string; requestId: string; offerId: string }): Promise<PaymentPayload>;
    getBalance(): Promise<number>;
    address: string;
  };

  constructor(mockService: {
    pay(params: { to_address: string; amount: number; providerDid: string; requestId: string; offerId: string }): Promise<PaymentPayload>;
    getBalance(): Promise<number>;
    address: string;
  }) {
    if (process.env.NODE_ENV !== "test") {
      process.stderr.write("[x811:wallet] WARNING: MockWalletAdapter active outside NODE_ENV=test\n");
    }
    this._mockService = mockService;
  }

  get address(): string {
    return this._mockService.address;
  }

  get mode(): "mock" {
    return "mock";
  }

  async pay(params: WalletPayParams): Promise<PaymentPayload> {
    return this._mockService.pay({
      to_address: params.to_address,
      amount: parseFloat(params.amount),
      providerDid: params.providerDid,
      requestId: params.requestId,
      offerId: params.offerId,
    });
  }

  async getBalance(): Promise<number> {
    return this._mockService.getBalance();
  }
}

// ---------------------------------------------------------------------------
// AgentKitWalletAdapter — gasless USDC on Base via CDP
// ---------------------------------------------------------------------------

export class AgentKitWalletAdapter implements WalletAdapter {
  private _walletProvider: unknown;
  private _address: string;

  constructor(walletProvider: unknown, address: string) {
    this._walletProvider = walletProvider;
    this._address = address;
  }

  get address(): string {
    return this._address;
  }

  get mode(): "agentkit" {
    return "agentkit";
  }

  async pay(params: WalletPayParams): Promise<PaymentPayload> {
    if (!isValidPaymentAddress(params.to_address)) {
      throw new Error(`X811-5001: Invalid payment address: ${params.to_address}`);
    }

    // Dynamic access to AgentKit's action provider
    const provider = this._walletProvider as {
      sendTransaction(tx: { to: string; data: string }): Promise<string>;
      getAddress(): string;
    };

    // Use direct ERC-20 transfer via AgentKit
    // The AgentKit CdpEvmWalletProvider handles gasless transactions
    const { ethers } = await import("ethers");
    const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const iface = new ethers.Interface(["function transfer(address to, uint256 amount) returns (bool)"]);
    const amountWei = ethers.parseUnits(params.amount, 6);
    const data = iface.encodeFunctionData("transfer", [params.to_address, amountWei]);

    const txHash = await provider.sendTransaction({ to: USDC_ADDRESS, data });

    return {
      request_id: params.requestId,
      offer_id: params.offerId,
      tx_hash: txHash,
      amount: params.amount,
      currency: "USDC",
      network: "base",
      payer_address: this._address,
      payee_address: params.to_address,
    };
  }

  async getBalance(): Promise<number> {
    const { ethers } = await import("ethers");
    const provider = this._walletProvider as {
      getAddress(): string;
      request(args: { method: string; params: unknown[] }): Promise<string>;
    };
    const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const iface = new ethers.Interface(["function balanceOf(address owner) view returns (uint256)"]);
    const data = iface.encodeFunctionData("balanceOf", [this._address]);

    try {
      const result = await provider.request({
        method: "eth_call",
        params: [{ to: USDC_ADDRESS, data }, "latest"],
      });
      const decoded = iface.decodeFunctionResult("balanceOf", result);
      return Number(ethers.formatUnits(decoded[0], 6));
    } catch {
      process.stderr.write("[x811:wallet] AgentKit balance check failed, returning 0\n");
      return 0;
    }
  }

  /**
   * Create an AgentKitWalletAdapter from CDP credentials.
   * Uses dynamic import to avoid requiring @coinbase/agentkit at bundle time.
   */
  static async create(config: {
    apiKeyId: string;
    apiKeySecret: string;
    walletSecret: string;
    walletDataPath?: string;
  }): Promise<AgentKitWalletAdapter> {
    try {
      const agentkit = await import("@coinbase/agentkit");
      const { CdpWalletProvider } = agentkit;

      const walletDataPath = config.walletDataPath;
      let walletData: string | undefined;

      // Try to load persisted wallet data
      if (walletDataPath) {
        try {
          const { readFileSync, existsSync } = await import("node:fs");
          if (existsSync(walletDataPath)) {
            walletData = readFileSync(walletDataPath, "utf-8");
            process.stderr.write("[x811:wallet] Loaded persisted AgentKit wallet data\n");
          }
        } catch {
          // No persisted data, will create new wallet
        }
      }

      const walletProvider = await CdpWalletProvider.configureWithWallet({
        apiKeyId: config.apiKeyId,
        apiKeySecret: config.apiKeySecret,
        walletSecret: config.walletSecret,
        networkId: "base-mainnet",
        ...(walletData ? { cdpWalletData: walletData } : {}),
      });

      const address = walletProvider.getAddress();

      // Persist wallet data for reconnection
      if (walletDataPath) {
        try {
          const { writeFileSync, mkdirSync } = await import("node:fs");
          const { dirname } = await import("node:path");
          mkdirSync(dirname(walletDataPath), { recursive: true, mode: 0o700 });
          const exportedData = await walletProvider.exportWallet();
          writeFileSync(walletDataPath, JSON.stringify(exportedData), { mode: 0o600 });
          process.stderr.write("[x811:wallet] Persisted AgentKit wallet data\n");
        } catch (err) {
          process.stderr.write(`[x811:wallet] Failed to persist wallet data: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }

      return new AgentKitWalletAdapter(walletProvider, address);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Sanitize error — strip potential credential values
      const sanitized = sanitizeError(msg, [config.apiKeyId, config.apiKeySecret, config.walletSecret]);
      throw new Error(`[x811:wallet] Failed to initialize AgentKit: ${sanitized}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Utility: sanitize error messages
// ---------------------------------------------------------------------------

function sanitizeError(message: string, secrets: string[]): string {
  let result = message;
  for (const secret of secrets) {
    if (secret && secret.length > 4) {
      result = result.replaceAll(secret, "***");
    }
  }
  return result;
}
