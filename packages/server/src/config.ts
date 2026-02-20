/**
 * x811 Protocol — Server configuration.
 *
 * Loads environment variables with sensible defaults for local development.
 * In production these are set via Dokploy / Docker environment.
 */

export interface ServerConfig {
  /** HTTP port (default 3811) */
  port: number;
  /** "development" | "production" | "test" */
  nodeEnv: string;
  /** Pino log level */
  logLevel: string;

  /** SQLite database file path */
  databaseUrl: string;

  /** Base L2 JSON-RPC endpoint */
  baseRpcUrl: string;
  /** X811TrustAnchor contract address */
  contractAddress: string;
  /** Relayer wallet private key (hex, with or without 0x prefix) */
  relayerPrivateKey: string;

  /** USDC contract address on Base L2 */
  usdcContractAddress: string;

  /** Number of interactions that trigger an automatic batch submission */
  batchSizeThreshold: number;
  /** Milliseconds between time-based batch submissions */
  batchTimeThresholdMs: number;

  /** Read endpoints: max requests per minute per IP */
  rateLimitRead: number;
  /** Write endpoints: max requests per minute per DID */
  rateLimitWrite: number;

  /** Public domain for the server (used in DID documents) */
  serverDomain: string;
  /** DID domain (used in did:web identifiers) */
  didDomain: string;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function envStr(key: string, fallback: string): string {
  const raw = process.env[key];
  return raw !== undefined && raw !== "" ? raw : fallback;
}

export const config: ServerConfig = {
  port: envInt("PORT", 3811),
  nodeEnv: envStr("NODE_ENV", "development"),
  logLevel: envStr("LOG_LEVEL", "info"),

  databaseUrl: envStr("DATABASE_URL", "./data/x811.db"),

  baseRpcUrl: envStr("BASE_RPC_URL", "https://mainnet.base.org"),
  contractAddress: envStr("CONTRACT_ADDRESS", ""),
  relayerPrivateKey: envStr("RELAYER_PRIVATE_KEY", ""),

  usdcContractAddress: envStr(
    "USDC_CONTRACT_ADDRESS",
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  ),

  batchSizeThreshold: envInt("BATCH_SIZE_THRESHOLD", 100),
  batchTimeThresholdMs: envInt("BATCH_TIME_THRESHOLD_MS", 300_000),

  rateLimitRead: envInt("RATE_LIMIT_READ", 100),
  rateLimitWrite: envInt("RATE_LIMIT_WRITE", 20),

  serverDomain: envStr("SERVER_DOMAIN", "api.x811.org"),
  didDomain: envStr("DID_DOMAIN", "x811.org"),
};
