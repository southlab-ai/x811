/**
 * x811 Protocol — Well-known and health routes.
 *
 * GET /.well-known/did.json                — Server's own DID document
 * GET /agents/:id/.well-known/agent.json   — Per-agent card
 * GET /health                              — Health check
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { config } from "../config.js";
import { RegistryError } from "../services/registry.js";

// ---------------------------------------------------------------------------
// Server DID document (generated once at startup)
// ---------------------------------------------------------------------------

function generateServerDIDDocument(): Record<string, unknown> {
  const did = `did:web:${config.didDomain}`;
  return {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/suites/ed25519-2020/v1",
      "https://w3id.org/security/suites/x25519-2020/v1",
    ],
    id: did,
    verificationMethod: [
      {
        id: `${did}#key-1`,
        type: "Ed25519VerificationKey2020",
        controller: did,
        // Server key is generated at deployment time — placeholder for runtime
        publicKeyMultibase: "z" + "1".repeat(43),
      },
    ],
    authentication: [`${did}#key-1`],
    service: [
      {
        id: `${did}#x811-server`,
        type: "X811ProtocolServer",
        serviceEndpoint: `https://${config.serverDomain}`,
      },
      {
        id: `${did}#registry`,
        type: "X811AgentRegistry",
        serviceEndpoint: `https://${config.serverDomain}/api/v1/agents`,
      },
      {
        id: `${did}#messages`,
        type: "X811MessageRouter",
        serviceEndpoint: `https://${config.serverDomain}/api/v1/messages`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): FastifyReply {
  return reply.status(statusCode).send({
    error: { code, message, details },
  });
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default async function wellKnownRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // Cache server DID document (immutable for the lifetime of the process)
  const serverDIDDoc = generateServerDIDDocument();

  // ---------- GET /.well-known/did.json — Server DID document ----------

  fastify.get(
    "/.well-known/did.json",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply
        .header("content-type", "application/did+ld+json")
        .header("cache-control", "public, max-age=3600")
        .send(serverDIDDoc);
    },
  );

  // ---------- GET /agents/:id/.well-known/agent.json — Per-agent card ----------

  fastify.get(
    "/agents/:id/.well-known/agent.json",
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const card = fastify.registry.getAgentCard(request.params.id);
        return reply
          .header("content-type", "application/json")
          .header("cache-control", "public, max-age=300")
          .send(card);
      } catch (error) {
        if (error instanceof RegistryError && error.code === "X811-3001") {
          return sendError(reply, 404, error.code, error.message, error.details);
        }
        throw error;
      }
    },
  );

  // ---------- GET /health — Health check ----------

  fastify.get(
    "/health",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      let relayerBalance = "0.0";
      try {
        relayerBalance = await fastify.relayer.getBalance();
      } catch {
        // If relayer is unavailable, report 0
        relayerBalance = "unavailable";
      }

      const uptimeSeconds = Math.floor(
        (Date.now() - fastify.startedAt) / 1000,
      );

      return reply.send({
        status: "ok",
        version: "0.1.0",
        agents_count: fastify.db.getAgentCount(),
        batches_count: fastify.db.getBatchCount(),
        relayer_balance_eth: relayerBalance,
        pending_interactions: fastify.db.getPendingInteractionCount(),
        uptime_seconds: uptimeSeconds,
      });
    },
  );
}
