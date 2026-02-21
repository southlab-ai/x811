/**
 * Minimal type declarations for @coinbase/agentkit.
 * The actual package is an optional peer dependency loaded via dynamic import().
 */
declare module "@coinbase/agentkit" {
  export class CdpWalletProvider {
    static configureWithWallet(config: {
      apiKeyId: string;
      apiKeySecret: string;
      walletSecret: string;
      networkId: string;
      cdpWalletData?: string;
    }): Promise<CdpWalletProvider>;
    getAddress(): string;
    sendTransaction(tx: { to: string; data: string }): Promise<string>;
    exportWallet(): Promise<unknown>;
    request(args: { method: string; params: unknown[] }): Promise<string>;
  }
}
