/**
 * x811 Protocol — Message routes.
 *
 * POST /api/v1/messages          — Send signed envelope (auth required)
 * GET  /api/v1/messages/:agentId — Poll messages (auth: verify DID matches agentId)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { verifyEnvelopeAuth, verifyAgentAccess } from "../middleware/auth.js";
import { writeLimitConfig } from "../middleware/rateLimit.js";
import { isNegotiationMessage, NegotiationError } from "../services/negotiation.js";
import { RouterError, type Envelope } from "../services/router.js";

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

function handleServiceError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof RouterError) {
    const status =
      error.code === "X811-3001" ? 404 :
        error.code === "X811-2002" ? 401 :
          error.code === "X811-2003" ? 401 :
            400;
    return sendError(reply, status, error.code, error.message, error.details);
  }
  if (error instanceof NegotiationError) {
    const status =
      error.code === "X811-3001" ? 404 :
        error.code === "X811-4003" ? 400 :
          error.code === "X811-5001" ? 400 :
            error.code === "X811-5003" ? 400 :
              error.code === "X811-6002" ? 400 :
                error.code === "X811-2004" ? 403 :
                  400;
    return sendError(reply, status, error.code, error.message, error.details);
  }
  throw error;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default async function messageRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // ---------- POST /api/v1/messages — Send signed envelope ----------

  fastify.post(
    "/api/v1/messages",
    {
      preHandler: [verifyEnvelopeAuth],
      config: writeLimitConfig,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = request.body as { envelope: Envelope };
        const envelope = body.envelope;

        // Route through MessageRouterService for storage/delivery
        const sendResult = fastify.messageRouter.sendMessage(envelope);

        // If the message is negotiation-related, also process through NegotiationService
        let negotiationResult: { interaction_id: string; status: string } | undefined;

        if (isNegotiationMessage(envelope.type)) {
          try {
            negotiationResult = await fastify.negotiation.handleMessage(envelope);
          } catch (error) {
            // If negotiation processing fails, we still delivered the message,
            // but we report the negotiation error
            if (error instanceof NegotiationError) {
              return reply.status(200).send({
                message_id: sendResult.message_id,
                status: sendResult.status,
                recipient_availability: sendResult.recipient_availability,
                negotiation_error: {
                  code: error.code,
                  message: error.message,
                  details: error.details,
                },
              });
            }
            throw error;
          }
        }

        const response: Record<string, unknown> = {
          message_id: sendResult.message_id,
          status: sendResult.status,
          recipient_availability: sendResult.recipient_availability,
        };

        if (negotiationResult) {
          response.interaction_id = negotiationResult.interaction_id;
          response.interaction_status = negotiationResult.status;
        }

        return reply.send(response);
      } catch (error) {
        return handleServiceError(error, reply);
      }
    },
  );

  // ---------- GET /api/v1/messages/:agentId — Poll messages ----------

  fastify.get<{
    Params: { agentId: string };
    Querystring: { did?: string };
  }>(
    "/api/v1/messages/:agentId",
    {
      preHandler: [verifyAgentAccess],
    },
    async (request, reply) => {
      try {
        const { agentId } = request.params;
        const agent = fastify.db.getAgent(agentId);

        if (!agent) {
          return sendError(reply, 404, "X811-3001", "Agent not found", {
            id: agentId,
          });
        }

        const messages = fastify.messageRouter.pollMessages(
          agentId,
          agent.did,
        );

        return reply.send({
          agent_id: agentId,
          messages,
          count: messages.length,
        });
      } catch (error) {
        return handleServiceError(error, reply);
      }
    },
  );
}
