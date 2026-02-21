/**
 * x811 Protocol --- SSE (Server-Sent Events) route.
 *
 * GET /api/v1/messages/:agentId/stream
 *
 * Opens a persistent SSE connection for real-time push notifications.
 * The SSE stream does NOT mark messages as delivered --- the client
 * still polls to consume messages canonically. SSE is a fast-path
 * notification channel only.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { verifyAgentAccess } from "../middleware/auth.js";

export default async function sseRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get<{
    Params: { agentId: string };
    Querystring: { did?: string; lastEventId?: string };
  }>(
    "/api/v1/messages/:agentId/stream",
    {
      preHandler: [verifyAgentAccess],
    },
    async (request, reply) => {
      const { agentId } = request.params;
      const lastEventId =
        (request.headers["last-event-id"] as string | undefined) ??
        request.query.lastEventId;

      // Require DID for SSE auth
      if (!request.query.did) {
        return reply.status(401).send({
          error: {
            code: "X811-2004",
            message: "Missing did query parameter",
          },
        });
      }

      // Verify agent exists
      const agent = fastify.db.getAgent(agentId);
      if (!agent) {
        return reply.status(404).send({
          error: { code: "X811-3001", message: "Agent not found" },
        });
      }

      // Attempt to subscribe
      const subscribed = fastify.sseManager.subscribe(agentId, reply.raw);
      if (!subscribed) {
        return reply.status(429).send({
          error: {
            code: "X811-9001",
            message: "SSE connection limit exceeded",
          },
        });
      }

      // Set SSE headers BEFORE hijacking
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      // Take control of raw socket
      reply.hijack();

      // Flush headers with initial comment
      reply.raw.write(":\n\n");

      // Replay undelivered messages (read-only; client still polls to consume)
      try {
        const messages = fastify.messageRouter.getQueuedMessages(agent.did);
        for (const msg of messages) {
          const id = msg.id;
          reply.raw.write(
            `id: ${id}\nevent: message\ndata: ${JSON.stringify(msg)}\n\n`,
          );
        }
      } catch {
        // Non-fatal: just continue with live stream
      }

      // Cleanup on client disconnect
      request.raw.on("close", () => {
        fastify.sseManager.unsubscribe(agentId, reply.raw);
      });
    },
  );
}
