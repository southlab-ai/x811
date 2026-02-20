/**
 * x811 Protocol — Rate limiting configuration.
 *
 * Read routes: 100 req/min per IP (default, set globally in app.ts)
 * Write routes: 20 req/min per DID (extracted from envelope.from)
 */

import type { FastifyInstance, FastifyRequest, RouteOptions } from "fastify";
import { config } from "../config.js";

/**
 * Rate limit configuration for write routes.
 * Applied per-DID using the envelope sender identity.
 */
export const writeLimitConfig: RouteOptions["config"] = {
  rateLimit: {
    max: config.rateLimitWrite,
    timeWindow: "1 minute",
    keyGenerator: (request: FastifyRequest) => {
      // Use the DID from the envelope if available; otherwise fall back to IP
      const body = request.body as { envelope?: { from?: string } } | undefined;
      const did = body?.envelope?.from;
      return did ?? request.ip;
    },
  },
};

/**
 * Rate limit configuration for read routes.
 * Applied per-IP (the Fastify global default handles this,
 * but this export is available for explicit per-route overrides).
 */
export const readLimitConfig: RouteOptions["config"] = {
  rateLimit: {
    max: config.rateLimitRead,
    timeWindow: "1 minute",
  },
};

/**
 * Helper to apply write rate limits to a Fastify route definition.
 * Usage: `{ ...writeRateLimit() }` spread into route options.
 */
export function writeRateLimit(): { config: RouteOptions["config"] } {
  return { config: writeLimitConfig };
}

/**
 * Helper to apply read rate limits to a Fastify route definition.
 */
export function readRateLimit(): { config: RouteOptions["config"] } {
  return { config: readLimitConfig };
}

/**
 * Plugin-level helper that can be registered on a Fastify instance
 * to set write-rate-limit as the default for all routes in that scope.
 */
export async function applyWriteRateLimit(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.addHook("onRoute", (routeOptions) => {
    if (
      routeOptions.method === "POST" ||
      routeOptions.method === "PUT" ||
      routeOptions.method === "DELETE"
    ) {
      if (!routeOptions.config) {
        routeOptions.config = {};
      }
      if (!(routeOptions.config as Record<string, unknown>).rateLimit) {
        (routeOptions.config as Record<string, unknown>).rateLimit =
          (writeLimitConfig as Record<string, unknown>)?.rateLimit;
      }
    }
  });
}
