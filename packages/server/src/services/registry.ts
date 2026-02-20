/**
 * x811 Protocol — Registry Service.
 *
 * Handles agent registration, discovery, agent cards, DID documents,
 * heartbeat / availability tracking, and agent lifecycle management.
 */

import { randomUUID } from "node:crypto";
import type { Database, AgentRow, AgentFilters, CapabilityRow } from "../db/schema.js";
import type { TrustService } from "./trust.js";
import { config } from "../config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegisterAgentInput {
  envelope: {
    from: string;
    payload: {
      name: string;
      description?: string;
      endpoint?: string;
      payment_address?: string;
      capabilities?: Array<{
        name: string;
        metadata?: Record<string, unknown>;
      }>;
      agent_card?: Record<string, unknown>;
    };
  };
  didDocument: Record<string, unknown>;
  publicKey: string;
}

export interface UpdateAgentInput {
  name?: string;
  description?: string;
  endpoint?: string;
  payment_address?: string;
  capabilities?: Array<{
    name: string;
    metadata?: Record<string, unknown>;
  }>;
  agent_card?: Record<string, unknown>;
}

export interface HeartbeatInput {
  availability: string;
  capacity?: number;
  ttl?: number;
}

export interface AgentDiscoveryResult {
  id: string;
  did: string;
  name: string;
  trust_score: number;
  capabilities: string[];
  pricing_hint?: Record<string, unknown>;
  status: string;
  availability: string;
  last_seen_at: string | null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class RegistryService {
  /** Default heartbeat TTL in seconds. */
  private static readonly DEFAULT_HEARTBEAT_TTL = 300;

  constructor(
    private db: Database,
    private trust: TrustService,
  ) {}

  /**
   * Register a new agent.
   *
   * Creates the agent record, stores capabilities, DID document, and agent card.
   * The agent starts with trust_score = 0.5 and availability = "unknown".
   */
  registerAgent(input: RegisterAgentInput): AgentRow {
    const { envelope, didDocument } = input;
    const { from: did, payload } = envelope;

    // Check for duplicate DID
    const existing = this.db.getAgentByDid(did);
    if (existing) {
      throw new RegistryError("X811-3002", "Agent with this DID already exists", {
        did,
        existing_id: existing.id,
      });
    }

    // Extract agent ID from DID (last segment)
    const idFromDid = did.split(":").pop() ?? randomUUID();

    // Build agent card
    const agentCard = this.buildAgentCard(idFromDid, did, payload, didDocument);

    // Insert agent record
    const agent = this.db.insertAgent({
      id: idFromDid,
      did,
      status: "active",
      availability: "unknown",
      last_seen_at: null,
      name: payload.name,
      description: payload.description ?? null,
      endpoint: payload.endpoint ?? null,
      payment_address: payload.payment_address ?? null,
      trust_score: 0.5,
      interaction_count: 0,
      successful_count: 0,
      failed_count: 0,
      did_document: JSON.stringify(didDocument),
      agent_card: JSON.stringify(agentCard),
    });

    // Insert capabilities
    if (payload.capabilities && payload.capabilities.length > 0) {
      for (const cap of payload.capabilities) {
        this.db.insertCapability({
          agent_id: idFromDid,
          name: cap.name,
          metadata: cap.metadata ? JSON.stringify(cap.metadata) : null,
        });
      }
    }

    return agent;
  }

  /**
   * Get an agent by internal ID.
   */
  getAgent(id: string): AgentRow {
    const agent = this.db.getAgent(id);
    if (!agent) {
      throw new RegistryError("X811-3001", "Agent not found", { id });
    }
    return agent;
  }

  /**
   * Get an agent by DID.
   */
  getAgentByDid(did: string): AgentRow {
    const agent = this.db.getAgentByDid(did);
    if (!agent) {
      throw new RegistryError("X811-3001", "Agent not found", { did });
    }
    return agent;
  }

  /**
   * Discover agents matching filters.
   * Returns a paginated list with capability names and pricing hints.
   */
  discoverAgents(filters: AgentFilters): {
    agents: AgentDiscoveryResult[];
    total: number;
    limit: number;
    offset: number;
  } {
    const limit = Math.min(filters.limit ?? 20, 100);
    const offset = filters.offset ?? 0;

    const result = this.db.listAgents({
      ...filters,
      limit,
      offset,
    });

    const agents: AgentDiscoveryResult[] = result.agents.map((agent) => {
      const capabilities = this.db.getCapabilitiesForAgent(agent.id);
      const capNames = capabilities.map((c) => c.name);

      // Extract pricing hint from first capability metadata
      let pricingHint: Record<string, unknown> | undefined;
      if (capabilities.length > 0 && capabilities[0].metadata) {
        try {
          const meta = JSON.parse(capabilities[0].metadata);
          if (meta.pricing) pricingHint = meta.pricing;
        } catch {
          // ignore parse errors
        }
      }

      return {
        id: agent.id,
        did: agent.did,
        name: agent.name,
        trust_score: agent.trust_score,
        capabilities: capNames,
        pricing_hint: pricingHint,
        status: agent.status,
        availability: agent.availability,
        last_seen_at: agent.last_seen_at,
      };
    });

    return { agents, total: result.total, limit, offset };
  }

  /**
   * Update an agent's details. Only the agent itself (matching DID) can update.
   */
  updateAgent(id: string, updates: UpdateAgentInput): AgentRow {
    const agent = this.getAgent(id);

    // Update basic fields
    const dbUpdates: Record<string, unknown> = {};
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.description !== undefined)
      dbUpdates.description = updates.description;
    if (updates.endpoint !== undefined) dbUpdates.endpoint = updates.endpoint;
    if (updates.payment_address !== undefined)
      dbUpdates.payment_address = updates.payment_address;

    // Rebuild agent card if relevant fields changed
    if (updates.agent_card || updates.name || updates.description) {
      const didDoc = JSON.parse(agent.did_document);
      const payload = {
        name: updates.name ?? agent.name,
        description: updates.description ?? agent.description ?? undefined,
        endpoint: updates.endpoint ?? agent.endpoint ?? undefined,
        payment_address:
          updates.payment_address ?? agent.payment_address ?? undefined,
        capabilities: updates.capabilities,
        agent_card: updates.agent_card,
      };
      const card = this.buildAgentCard(id, agent.did, payload, didDoc);
      dbUpdates.agent_card = JSON.stringify(card);
    }

    this.db.updateAgent(id, dbUpdates as Parameters<Database["updateAgent"]>[1]);

    // Update capabilities if provided
    if (updates.capabilities) {
      // Remove existing capabilities
      const existing = this.db.getCapabilitiesForAgent(id);
      for (const cap of existing) {
        this.db.raw
          .prepare("DELETE FROM capabilities WHERE id = ?")
          .run(cap.id);
      }
      // Insert new capabilities
      for (const cap of updates.capabilities) {
        this.db.insertCapability({
          agent_id: id,
          name: cap.name,
          metadata: cap.metadata ? JSON.stringify(cap.metadata) : null,
        });
      }
    }

    return this.getAgent(id);
  }

  /**
   * Deactivate an agent. Sets status to "deactivated".
   */
  deactivateAgent(id: string): void {
    const agent = this.getAgent(id);
    this.db.updateAgent(id, {
      status: "deactivated",
      availability: "offline",
    });
  }

  /**
   * Get the agent card (A2A compatible with x811 extensions).
   */
  getAgentCard(id: string): Record<string, unknown> {
    const agent = this.getAgent(id);
    return JSON.parse(agent.agent_card);
  }

  /**
   * Get the DID document for an agent.
   */
  getDIDDocument(id: string): Record<string, unknown> {
    const agent = this.getAgent(id);
    return JSON.parse(agent.did_document);
  }

  /**
   * Get the current status and availability of an agent.
   */
  getAgentStatus(id: string): {
    status: string;
    availability: string;
    last_seen_at: string | null;
  } {
    const agent = this.getAgent(id);
    return {
      status: agent.status,
      availability: agent.availability,
      last_seen_at: agent.last_seen_at,
    };
  }

  /**
   * Handle a heartbeat from an agent.
   * Updates availability and last_seen_at timestamp.
   */
  handleHeartbeat(agentId: string, heartbeat: HeartbeatInput): void {
    const agent = this.getAgent(agentId);
    this.db.updateAgent(agentId, {
      availability: heartbeat.availability,
      last_seen_at: new Date().toISOString(),
    });
  }

  /**
   * Check for agents whose heartbeat TTL has expired and mark them as "unknown".
   * Should be called periodically (e.g. every 60 seconds).
   */
  checkExpiredHeartbeats(): void {
    const cutoff = new Date(
      Date.now() - RegistryService.DEFAULT_HEARTBEAT_TTL * 1000,
    ).toISOString();

    const stmt = this.db.raw.prepare(`
      UPDATE agents SET
        availability = 'unknown',
        updated_at = ?
      WHERE availability NOT IN ('unknown', 'offline')
        AND status = 'active'
        AND (last_seen_at IS NULL OR last_seen_at < ?)
    `);
    stmt.run(new Date().toISOString(), cutoff);
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Build an A2A-compatible agent card with x811 extensions.
   */
  private buildAgentCard(
    agentId: string,
    did: string,
    payload: {
      name: string;
      description?: string;
      endpoint?: string;
      payment_address?: string;
      capabilities?: Array<{
        name: string;
        metadata?: Record<string, unknown>;
      }>;
      agent_card?: Record<string, unknown>;
    },
    _didDocument: Record<string, unknown>,
  ): Record<string, unknown> {
    const capabilities = (payload.capabilities ?? []).map((cap) => ({
      id: randomUUID(),
      name: cap.name,
      ...(cap.metadata ?? {}),
    }));

    // Merge with any user-provided agent card fields
    const userCard = payload.agent_card ?? {};

    return {
      ...userCard,
      name: payload.name,
      description: payload.description ?? "",
      url: `https://${config.serverDomain}/api/v1/agents/${agentId}/card`,
      version: "0.1.0",
      capabilities,
      x811: {
        did,
        trust_score: 0.5,
        verified_since: new Date().toISOString(),
        interaction_count: 0,
        payment_address: payload.payment_address ?? "",
        network: "base",
        status: "active",
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Registry-specific error
// ---------------------------------------------------------------------------

export class RegistryError extends Error {
  constructor(
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RegistryError";
  }
}
