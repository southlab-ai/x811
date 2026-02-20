/**
 * x811 Protocol — Agent routes.
 *
 * POST   /api/v1/agents            — Register agent (auth required)
 * GET    /api/v1/agents            — Discovery with query filters
 * GET    /api/v1/agents/:id        — Agent details
 * GET    /api/v1/agents/:id/card   — Agent card (A2A compatible)
 * GET    /api/v1/agents/:id/did    — DID document
 * GET    /api/v1/agents/:id/status — Status + availability
 * PUT    /api/v1/agents/:id        — Update (auth required)
 * DELETE /api/v1/agents/:id        — Deactivate (auth required)
 * POST   /api/v1/agents/:id/heartbeat — Heartbeat (auth required)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { verifyEnvelopeAuth, type X811AuthInfo } from "../middleware/auth.js";
import { writeLimitConfig } from "../middleware/rateLimit.js";
import { RegistryError } from "../services/registry.js";

// ---------------------------------------------------------------------------
// Helper: send structured error response
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

function handleRegistryError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof RegistryError) {
    const status =
      error.code === "X811-3001" ? 404 :
        error.code === "X811-3002" ? 409 :
          400;
    return sendError(reply, status, error.code, error.message, error.details);
  }
  throw error;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default async function agentRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // ---------- POST /api/v1/agents — Register agent ----------

  fastify.post(
    "/api/v1/agents",
    {
      preHandler: [verifyEnvelopeAuth],
      config: writeLimitConfig,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = request.body as {
          envelope: {
            from: string;
            payload: {
              name: string;
              description?: string;
              endpoint?: string;
              payment_address?: string;
              capabilities?: Array<{ name: string; metadata?: Record<string, unknown> }>;
              agent_card?: Record<string, unknown>;
            };
          };
          did_document: Record<string, unknown>;
          public_key: string;
        };

        if (!body.envelope?.payload?.name) {
          return sendError(reply, 400, "X811-3002", "Agent name is required");
        }

        if (!body.did_document) {
          return sendError(reply, 400, "X811-3002", "DID document is required");
        }

        const agent = fastify.registry.registerAgent({
          envelope: body.envelope,
          didDocument: body.did_document,
          publicKey: body.public_key,
        });

        const capabilities = fastify.db.getCapabilitiesForAgent(agent.id);

        return reply.status(201).send({
          id: agent.id,
          did: agent.did,
          name: agent.name,
          status: agent.status,
          trust_score: agent.trust_score,
          capabilities: capabilities.map((c) => c.name),
          created_at: agent.created_at,
        });
      } catch (error) {
        return handleRegistryError(error, reply);
      }
    },
  );

  // ---------- GET /api/v1/agents — Discovery ----------

  fastify.get(
    "/api/v1/agents",
    async (
      request: FastifyRequest<{
        Querystring: {
          capability?: string;
          trust_min?: string;
          status?: string;
          availability?: string;
          limit?: string;
          offset?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const query = request.query;
      const result = fastify.registry.discoverAgents({
        capability: query.capability,
        trust_min: query.trust_min ? parseFloat(query.trust_min) : undefined,
        status: query.status ?? "active",
        availability: query.availability,
        limit: query.limit ? parseInt(query.limit, 10) : 20,
        offset: query.offset ? parseInt(query.offset, 10) : 0,
      });

      return reply.send(result);
    },
  );

  // ---------- GET /api/v1/agents/:id — Agent details ----------

  fastify.get(
    "/api/v1/agents/:id",
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const agent = fastify.registry.getAgent(request.params.id);
        const capabilities = fastify.db.getCapabilitiesForAgent(agent.id);

        return reply.send({
          id: agent.id,
          did: agent.did,
          name: agent.name,
          description: agent.description,
          endpoint: agent.endpoint,
          payment_address: agent.payment_address,
          status: agent.status,
          availability: agent.availability,
          trust_score: agent.trust_score,
          interaction_count: agent.interaction_count,
          successful_count: agent.successful_count,
          failed_count: agent.failed_count,
          capabilities: capabilities.map((c) => ({
            id: c.id,
            name: c.name,
            metadata: c.metadata ? JSON.parse(c.metadata) : null,
          })),
          last_seen_at: agent.last_seen_at,
          created_at: agent.created_at,
          updated_at: agent.updated_at,
        });
      } catch (error) {
        return handleRegistryError(error, reply);
      }
    },
  );

  // ---------- GET /api/v1/agents/:id/card — Agent card ----------

  fastify.get(
    "/api/v1/agents/:id/card",
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const card = fastify.registry.getAgentCard(request.params.id);
        return reply.send(card);
      } catch (error) {
        return handleRegistryError(error, reply);
      }
    },
  );

  // ---------- GET /api/v1/agents/:id/did — DID document ----------

  fastify.get(
    "/api/v1/agents/:id/did",
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const didDoc = fastify.registry.getDIDDocument(request.params.id);
        return reply
          .header("content-type", "application/did+ld+json")
          .send(didDoc);
      } catch (error) {
        return handleRegistryError(error, reply);
      }
    },
  );

  // ---------- GET /api/v1/agents/:id/status — Status + availability ----------

  fastify.get(
    "/api/v1/agents/:id/status",
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const status = fastify.registry.getAgentStatus(request.params.id);
        return reply.send(status);
      } catch (error) {
        return handleRegistryError(error, reply);
      }
    },
  );

  // ---------- PUT /api/v1/agents/:id — Update agent ----------

  fastify.put<{ Params: { id: string } }>(
    "/api/v1/agents/:id",
    {
      preHandler: [verifyEnvelopeAuth],
      config: writeLimitConfig,
    },
    async (request, reply) => {
      try {
        const auth = (request as FastifyRequest & { x811Auth: X811AuthInfo }).x811Auth;
        const agent = fastify.registry.getAgent(request.params.id);

        // Only the agent itself can update its own record
        if (auth.did !== agent.did) {
          return sendError(reply, 403, "X811-2004", "Not authorized to update this agent", {
            expected_did: agent.did,
            actual_did: auth.did,
          });
        }

        const body = request.body as {
          envelope: {
            payload: {
              name?: string;
              description?: string;
              endpoint?: string;
              payment_address?: string;
              capabilities?: Array<{ name: string; metadata?: Record<string, unknown> }>;
              agent_card?: Record<string, unknown>;
            };
          };
        };

        const updated = fastify.registry.updateAgent(
          request.params.id,
          body.envelope.payload,
        );

        return reply.send({
          id: updated.id,
          did: updated.did,
          name: updated.name,
          status: updated.status,
          updated_at: updated.updated_at,
        });
      } catch (error) {
        return handleRegistryError(error, reply);
      }
    },
  );

  // ---------- DELETE /api/v1/agents/:id — Deactivate agent ----------

  fastify.delete<{ Params: { id: string } }>(
    "/api/v1/agents/:id",
    {
      preHandler: [verifyEnvelopeAuth],
      config: writeLimitConfig,
    },
    async (request, reply) => {
      try {
        const auth = (request as FastifyRequest & { x811Auth: X811AuthInfo }).x811Auth;
        const agent = fastify.registry.getAgent(request.params.id);

        if (auth.did !== agent.did) {
          return sendError(reply, 403, "X811-2004", "Not authorized to deactivate this agent", {
            expected_did: agent.did,
            actual_did: auth.did,
          });
        }

        fastify.registry.deactivateAgent(request.params.id);

        return reply.send({
          id: agent.id,
          status: "deactivated",
          message: "Agent has been deactivated",
        });
      } catch (error) {
        return handleRegistryError(error, reply);
      }
    },
  );

  // ---------- POST /api/v1/agents/:id/heartbeat — Heartbeat ----------

  fastify.post<{ Params: { id: string } }>(
    "/api/v1/agents/:id/heartbeat",
    {
      preHandler: [verifyEnvelopeAuth],
      config: writeLimitConfig,
    },
    async (request, reply) => {
      try {
        const auth = (request as FastifyRequest & { x811Auth: X811AuthInfo }).x811Auth;
        const agent = fastify.registry.getAgent(request.params.id);

        if (auth.did !== agent.did) {
          return sendError(reply, 403, "X811-2004", "Not authorized to send heartbeat for this agent", {
            expected_did: agent.did,
            actual_did: auth.did,
          });
        }

        const body = request.body as {
          envelope: {
            payload: {
              availability: string;
              capacity?: number;
              ttl?: number;
            };
          };
        };

        fastify.registry.handleHeartbeat(
          request.params.id,
          body.envelope.payload,
        );

        return reply.send({
          status: "ok",
          availability: body.envelope.payload.availability,
          last_seen_at: new Date().toISOString(),
        });
      } catch (error) {
        return handleRegistryError(error, reply);
      }
    },
  );
}
