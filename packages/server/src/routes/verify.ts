/**
 * x811 Protocol — Verification routes.
 *
 * GET /api/v1/verify/:interactionHash — Merkle proof + batch info + BaseScan URL
 * GET /api/v1/batches                 — List all batches
 * GET /api/v1/batches/:id             — Batch details
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

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

export default async function verifyRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // ---------- GET /api/v1/verify/:interactionHash — Merkle proof ----------

  fastify.get(
    "/api/v1/verify/:interactionHash",
    async (
      request: FastifyRequest<{ Params: { interactionHash: string } }>,
      reply: FastifyReply,
    ) => {
      const { interactionHash } = request.params;

      // Check if the interaction exists
      const interaction = fastify.db.getInteractionByHash(interactionHash);
      if (!interaction) {
        return sendError(reply, 404, "X811-3001", "Interaction not found", {
          interaction_hash: interactionHash,
        });
      }

      // Get Merkle proof
      const proofData = fastify.db.getMerkleProof(interactionHash);

      if (!proofData) {
        // Interaction exists but has not been batched yet
        return reply.send({
          interaction_hash: interactionHash,
          included: false,
          batch_id: null,
          merkle_root: null,
          proof: [],
          batch_tx_hash: null,
          basescan_url: null,
          batch_timestamp: null,
          batch_interaction_count: null,
          status: interaction.status,
          message: "Interaction has not been batched yet",
        });
      }

      // Get batch details
      const batch = fastify.db.getBatch(proofData.batch_id);
      if (!batch) {
        return sendError(reply, 500, "X811-9002", "Batch data inconsistency", {
          batch_id: proofData.batch_id,
        });
      }

      const basescanUrl = batch.tx_hash
        ? `https://basescan.org/tx/${batch.tx_hash}`
        : null;

      return reply.send({
        interaction_hash: interactionHash,
        included: true,
        batch_id: batch.id,
        merkle_root: batch.merkle_root,
        proof: proofData.parsed_proof,
        leaf_hash: proofData.leaf_hash,
        batch_tx_hash: batch.tx_hash,
        basescan_url: basescanUrl,
        batch_timestamp: batch.created_at,
        batch_interaction_count: batch.interaction_count,
        batch_status: batch.status,
      });
    },
  );

  // ---------- GET /api/v1/batches — List all batches ----------

  fastify.get(
    "/api/v1/batches",
    async (
      request: FastifyRequest<{
        Querystring: { limit?: string; offset?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const limit = request.query.limit
        ? Math.min(parseInt(request.query.limit, 10), 100)
        : 20;
      const offset = request.query.offset
        ? parseInt(request.query.offset, 10)
        : 0;

      const result = fastify.db.listBatches(limit, offset);

      return reply.send({
        batches: result.batches.map((batch) => ({
          id: batch.id,
          merkle_root: batch.merkle_root,
          interaction_count: batch.interaction_count,
          tx_hash: batch.tx_hash,
          status: batch.status,
          created_at: batch.created_at,
          confirmed_at: batch.confirmed_at,
          basescan_url: batch.tx_hash
            ? `https://basescan.org/tx/${batch.tx_hash}`
            : null,
        })),
        total: result.total,
        limit,
        offset,
      });
    },
  );

  // ---------- GET /api/v1/batches/:id — Batch details ----------

  fastify.get(
    "/api/v1/batches/:id",
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const batchId = parseInt(request.params.id, 10);
      if (Number.isNaN(batchId)) {
        return sendError(reply, 400, "X811-9002", "Invalid batch ID");
      }

      const batch = fastify.db.getBatch(batchId);
      if (!batch) {
        return sendError(reply, 404, "X811-3001", "Batch not found", {
          id: batchId,
        });
      }

      // Count interactions in this batch
      const interactionsStmt = fastify.db.raw.prepare(
        "SELECT COUNT(*) as count FROM interactions WHERE batch_id = ?",
      );
      const { count: actualCount } = interactionsStmt.get(batchId) as {
        count: number;
      };

      // Get proof count
      const proofsStmt = fastify.db.raw.prepare(
        "SELECT COUNT(*) as count FROM merkle_proofs WHERE batch_id = ?",
      );
      const { count: proofCount } = proofsStmt.get(batchId) as {
        count: number;
      };

      const basescanUrl = batch.tx_hash
        ? `https://basescan.org/tx/${batch.tx_hash}`
        : null;

      return reply.send({
        id: batch.id,
        merkle_root: batch.merkle_root,
        interaction_count: batch.interaction_count,
        actual_interaction_count: actualCount,
        proof_count: proofCount,
        tx_hash: batch.tx_hash,
        status: batch.status,
        created_at: batch.created_at,
        confirmed_at: batch.confirmed_at,
        basescan_url: basescanUrl,
      });
    },
  );
}
