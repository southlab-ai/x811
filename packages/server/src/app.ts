/**
 * x811 Protocol — Fastify application setup.
 *
 * Exports `buildApp()` for testing and `start()` for production.
 */

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { config } from "./config.js";
import { Database } from "./db/schema.js";
import { RegistryService } from "./services/registry.js";
import { MessageRouterService } from "./services/router.js";
import { SSEManager } from "./services/sse-manager.js";
import { NegotiationService } from "./services/negotiation.js";
import { TrustService } from "./services/trust.js";
import { BatchingService } from "./services/batching.js";
import {
  RelayerService,
  MockRelayerService,
  type IRelayerService,
} from "./services/relayer.js";

import agentRoutes from "./routes/agents.js";
import messageRoutes from "./routes/messages.js";
import sseRoutes from "./routes/sse.js";
import verifyRoutes from "./routes/verify.js";
import wellKnownRoutes from "./routes/well-known.js";

// ---------------------------------------------------------------------------
// Fastify type augmentation — decorate instance with services
// ---------------------------------------------------------------------------

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
    registry: RegistryService;
    messageRouter: MessageRouterService;
    negotiation: NegotiationService;
    trust: TrustService;
    batching: BatchingService;
    relayer: IRelayerService;
    sseManager: SSEManager;
    startedAt: number;
  }
}

// ---------------------------------------------------------------------------
// Build application
// ---------------------------------------------------------------------------

export async function buildApp(
  overrides?: Partial<{
    databaseUrl: string;
    skipRateLimit: boolean;
  }>,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      ...(config.nodeEnv === "development"
        ? { transport: { target: "pino-pretty" } }
        : {}),
    },
  });

  // -----------------------------------------------------------------------
  // Plugins
  // -----------------------------------------------------------------------

  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  });

  if (!overrides?.skipRateLimit) {
    await app.register(rateLimit, {
      global: true,
      max: config.rateLimitRead,
      timeWindow: "1 minute",
    });
  }

  // -----------------------------------------------------------------------
  // Database
  // -----------------------------------------------------------------------

  const dbPath = overrides?.databaseUrl ?? config.databaseUrl;

  // Ensure the directory exists
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
  } catch {
    // directory may already exist
  }

  const db = new Database(dbPath);

  // -----------------------------------------------------------------------
  // SSE Manager (before services so it can be injected into MessageRouter)
  // -----------------------------------------------------------------------

  const sseManager = new SSEManager();

  // -----------------------------------------------------------------------
  // Services
  // -----------------------------------------------------------------------

  let relayer: IRelayerService;
  if (
    config.nodeEnv === "production" &&
    config.relayerPrivateKey &&
    config.contractAddress
  ) {
    relayer = new RelayerService(
      config.baseRpcUrl,
      config.relayerPrivateKey,
      config.contractAddress,
    );
  } else {
    relayer = new MockRelayerService();
    if (config.nodeEnv === "production") {
      app.log.warn(
        "WARNING: Running in production with MockRelayerService — on-chain batching is disabled. " +
        "Set RELAYER_PRIVATE_KEY and CONTRACT_ADDRESS for real Merkle anchoring.",
      );
    }
  }

  const trust = new TrustService(db);
  const batching = new BatchingService(db, relayer, {
    sizeThreshold: config.batchSizeThreshold,
    timeThresholdMs: config.batchTimeThresholdMs,
  });
  const registry = new RegistryService(db, trust);
  const messageRouter = new MessageRouterService(db, sseManager);
  const negotiation = new NegotiationService(db, messageRouter, batching, trust);

  // -----------------------------------------------------------------------
  // Decorate Fastify instance
  // -----------------------------------------------------------------------

  app.decorate("db", db);
  app.decorate("registry", registry);
  app.decorate("messageRouter", messageRouter);
  app.decorate("negotiation", negotiation);
  app.decorate("trust", trust);
  app.decorate("batching", batching);
  app.decorate("relayer", relayer);
  app.decorate("sseManager", sseManager);
  app.decorate("startedAt", Date.now());

  // -----------------------------------------------------------------------
  // Routes
  // -----------------------------------------------------------------------

  await app.register(agentRoutes);
  await app.register(messageRoutes);
  await app.register(sseRoutes);
  await app.register(verifyRoutes);
  await app.register(wellKnownRoutes);

  // -----------------------------------------------------------------------
  // Global error handler
  // -----------------------------------------------------------------------

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    const statusCode = error.statusCode ?? 500;

    // Rate limit errors from @fastify/rate-limit
    if (statusCode === 429) {
      return reply.status(429).send({
        error: {
          code: "X811-9001",
          message: "Rate limit exceeded",
          details: { retryAfter: error.message },
        },
      });
    }

    app.log.error(error);

    return reply.status(statusCode).send({
      error: {
        code: "X811-9002",
        message:
          config.nodeEnv === "production"
            ? "Internal server error"
            : error.message,
        details:
          config.nodeEnv === "production" ? {} : { stack: error.stack },
      },
    });
  });

  // -----------------------------------------------------------------------
  // Graceful shutdown — clean up resources on Fastify close
  // -----------------------------------------------------------------------

  app.addHook("onClose", async () => {
    batching.stopTimer();
    db.close();
  });

  return app;
}

// ---------------------------------------------------------------------------
// Production start
// ---------------------------------------------------------------------------

export async function start(): Promise<void> {
  const app = await buildApp();

  // Start the batching timer
  app.batching.startTimer();

  // Start periodic heartbeat expiry check (every 60 seconds)
  const heartbeatInterval = setInterval(() => {
    try {
      app.registry.checkExpiredHeartbeats();
    } catch (err) {
      app.log.error(err, "Error checking expired heartbeats");
    }
  }, 60_000);

  // Start periodic message cleanup (every 5 minutes)
  const messageCleanupInterval = setInterval(() => {
    try {
      app.messageRouter.cleanupExpiredMessages();
    } catch (err) {
      app.log.error(err, "Error cleaning up expired messages");
    }
  }, 300_000);

  // Start periodic nonce cleanup (every hour)
  const nonceCleanupInterval = setInterval(() => {
    try {
      app.db.deleteExpiredNonces();
    } catch (err) {
      app.log.error(err, "Error cleaning up expired nonces");
    }
  }, 3_600_000);

  // Clean up intervals on close
  app.addHook("onClose", () => {
    clearInterval(heartbeatInterval);
    clearInterval(messageCleanupInterval);
    clearInterval(nonceCleanupInterval);
  });

  // Graceful shutdown on signals (production only)
  const shutdown = async () => {
    app.log.info("Shutting down...");
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await app.listen({ port: config.port, host: "0.0.0.0" });
    app.log.info(
      `x811 server listening on port ${config.port} (${config.nodeEnv})`,
    );
  } catch (err) {
    app.log.fatal(err);
    process.exit(1);
  }
}

// If this module is the entry point, start the server
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("/app.js") ||
    process.argv[1].endsWith("/app.ts") ||
    process.argv[1].endsWith("\\app.js") ||
    process.argv[1].endsWith("\\app.ts"));

if (isMain) {
  start();
}
