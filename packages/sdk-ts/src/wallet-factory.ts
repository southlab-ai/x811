/**
 * x811 Protocol — Wallet Factory for conditional adapter initialization.
 *
 * Priority chain:
 *   1. CDP env vars → AgentKitWalletAdapter (gasless USDC on Base)
 *   2. X811_PRIVATE_KEY → EthersWalletAdapter (raw key, pays own gas)
 *   3. NODE_ENV=test → MockWalletAdapter (test-only)
 *   4. Otherwise → null (no wallet; payment tools return setup instructions)
 */

import type { WalletAdapter } from "./wallet-adapter.js";
import {
  AgentKitWalletAdapter,
  EthersWalletAdapter,
  MockWalletAdapter,
} from "./wallet-adapter.js";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Detect available credentials and create the appropriate WalletAdapter.
 * Returns null if no wallet can be configured (non-test, no credentials).
 */
export async function createWalletAdapter(): Promise<WalletAdapter | null> {
  const stateDir = process.env.X811_STATE_DIR || join(homedir(), ".x811");

  // 1. AgentKit (CDP credentials)
  const cdpKeyId = process.env.CDP_API_KEY_ID;
  const cdpKeySecret = process.env.CDP_API_KEY_SECRET;
  const cdpWalletSecret = process.env.CDP_WALLET_SECRET;

  if (cdpKeyId && cdpKeySecret && cdpWalletSecret) {
    try {
      process.stderr.write("[x811:wallet] CDP credentials detected, initializing AgentKit...\n");
      const adapter = await AgentKitWalletAdapter.create({
        apiKeyId: cdpKeyId,
        apiKeySecret: cdpKeySecret,
        walletSecret: cdpWalletSecret,
        walletDataPath: join(stateDir, "wallet.json"),
      });
      process.stderr.write(`[x811:wallet] Mode: agentkit | Address: ${adapter.address}\n`);
      clearSensitiveEnvVars();
      return adapter;
    } catch (err) {
      process.stderr.write(`[x811:wallet] AgentKit init failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.stderr.write("[x811:wallet] Falling through to next wallet option...\n");
    }
  }

  // 2. Ethers (raw private key)
  const privateKey = process.env.X811_PRIVATE_KEY;
  if (privateKey) {
    try {
      process.stderr.write("[x811:wallet] X811_PRIVATE_KEY detected, initializing Ethers adapter...\n");
      const { WalletService } = await import("./wallet.js");
      const rpcUrl = process.env.BASE_RPC_URL || "https://mainnet.base.org";
      const walletService = new WalletService(privateKey, rpcUrl);
      const adapter = new EthersWalletAdapter(walletService);
      process.stderr.write(`[x811:wallet] Mode: ethers | Address: ${adapter.address}\n`);
      clearSensitiveEnvVars();
      return adapter;
    } catch (err) {
      process.stderr.write(`[x811:wallet] Ethers init failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // 3. Mock (test-only)
  if (process.env.NODE_ENV === "test") {
    process.stderr.write("[x811:wallet] Mode: mock (NODE_ENV=test)\n");
    const { MockWalletService } = await import("./wallet.js");
    const mockService = new MockWalletService();
    return new MockWalletAdapter(mockService);
  }

  // 4. No wallet
  process.stderr.write("[x811:wallet] Mode: none — no wallet credentials configured\n");
  return null;
}

/**
 * Clear sensitive environment variables after reading them.
 * Prevents credential leakage through process inspection or error serialization.
 */
function clearSensitiveEnvVars(): void {
  delete process.env.CDP_API_KEY_ID;
  delete process.env.CDP_API_KEY_SECRET;
  delete process.env.CDP_WALLET_SECRET;
  delete process.env.X811_PRIVATE_KEY;
}
