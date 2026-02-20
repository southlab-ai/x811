/**
 * x811 Protocol — Database schema and typed wrapper for SQLite.
 *
 * Uses better-sqlite3 (synchronous) with WAL mode for optimal
 * concurrent read performance.
 */

import BetterSqlite3 from "better-sqlite3";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentRow {
  id: string;
  did: string;
  status: string;
  availability: string;
  last_seen_at: string | null;
  name: string;
  description: string | null;
  endpoint: string | null;
  payment_address: string | null;
  trust_score: number;
  interaction_count: number;
  successful_count: number;
  failed_count: number;
  created_at: string;
  updated_at: string;
  did_document: string;
  agent_card: string;
}

export interface CapabilityRow {
  id: string;
  agent_id: string;
  name: string;
  metadata: string | null;
}

export interface InteractionRow {
  id: string;
  interaction_hash: string;
  initiator_did: string;
  provider_did: string;
  capability: string;
  status: string;
  outcome: string | null;
  payment_tx: string | null;
  payment_amount: number | null;
  created_at: string;
  updated_at: string;
  batch_id: number | null;
  request_payload: string | null;
  offer_payload: string | null;
  result_payload: string | null;
  idempotency_key: string | null;
}

export interface BatchRow {
  id: number;
  merkle_root: string;
  interaction_count: number;
  tx_hash: string | null;
  status: string;
  created_at: string;
  confirmed_at: string | null;
}

export interface MerkleProofRow {
  interaction_hash: string;
  batch_id: number;
  proof: string;
  leaf_hash: string;
}

export interface MessageRow {
  id: string;
  type: string;
  from_did: string;
  to_did: string;
  envelope: string;
  created_at: string;
  expires_at: string | null;
  status: string;
  delivered_at: string | null;
  retry_count: number;
  last_error: string | null;
}

export interface NonceRow {
  nonce: string;
  did: string;
  created_at: string;
  expires_at: string;
}

export interface AgentFilters {
  capability?: string;
  trust_min?: number;
  status?: string;
  availability?: string;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Schema initialization
// ---------------------------------------------------------------------------

export function initializeDatabase(dbPath: string): BetterSqlite3.Database {
  const db = new BetterSqlite3(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  // Create all tables inside a transaction for atomicity
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id                TEXT PRIMARY KEY,
      did               TEXT UNIQUE NOT NULL,
      status            TEXT NOT NULL DEFAULT 'active',
      availability      TEXT NOT NULL DEFAULT 'unknown',
      last_seen_at      TEXT,
      name              TEXT NOT NULL,
      description       TEXT,
      endpoint          TEXT,
      payment_address   TEXT,
      trust_score       REAL NOT NULL DEFAULT 0.5,
      interaction_count INTEGER NOT NULL DEFAULT 0,
      successful_count  INTEGER NOT NULL DEFAULT 0,
      failed_count      INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      did_document      TEXT NOT NULL,
      agent_card        TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agents_did ON agents(did);
    CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
    CREATE INDEX IF NOT EXISTS idx_agents_trust ON agents(trust_score DESC);
    CREATE INDEX IF NOT EXISTS idx_agents_availability ON agents(availability);
    CREATE INDEX IF NOT EXISTS idx_agents_last_seen ON agents(last_seen_at);

    CREATE TABLE IF NOT EXISTS capabilities (
      id        TEXT PRIMARY KEY,
      agent_id  TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      name      TEXT NOT NULL,
      metadata  TEXT,
      UNIQUE(agent_id, name)
    );

    CREATE INDEX IF NOT EXISTS idx_capabilities_name ON capabilities(name);
    CREATE INDEX IF NOT EXISTS idx_capabilities_agent ON capabilities(agent_id);

    CREATE TABLE IF NOT EXISTS interactions (
      id                TEXT PRIMARY KEY,
      interaction_hash  TEXT UNIQUE NOT NULL,
      initiator_did     TEXT NOT NULL,
      provider_did      TEXT NOT NULL,
      capability        TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending',
      outcome           TEXT,
      payment_tx        TEXT,
      payment_amount    REAL,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      batch_id          INTEGER,
      request_payload   TEXT,
      offer_payload     TEXT,
      result_payload    TEXT,
      idempotency_key   TEXT UNIQUE
    );

    CREATE INDEX IF NOT EXISTS idx_interactions_hash ON interactions(interaction_hash);
    CREATE INDEX IF NOT EXISTS idx_interactions_batch ON interactions(batch_id);
    CREATE INDEX IF NOT EXISTS idx_interactions_unbatched ON interactions(batch_id) WHERE batch_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_interactions_status ON interactions(status);
    CREATE INDEX IF NOT EXISTS idx_interactions_initiator ON interactions(initiator_did);
    CREATE INDEX IF NOT EXISTS idx_interactions_provider ON interactions(provider_did);
    CREATE INDEX IF NOT EXISTS idx_interactions_idempotency ON interactions(idempotency_key);

    CREATE TABLE IF NOT EXISTS batches (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      merkle_root       TEXT NOT NULL,
      interaction_count INTEGER NOT NULL,
      tx_hash           TEXT,
      status            TEXT NOT NULL DEFAULT 'pending',
      created_at        TEXT NOT NULL,
      confirmed_at      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_batches_status ON batches(status);

    CREATE TABLE IF NOT EXISTS merkle_proofs (
      interaction_hash  TEXT PRIMARY KEY,
      batch_id          INTEGER NOT NULL REFERENCES batches(id),
      proof             TEXT NOT NULL,
      leaf_hash         TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_merkle_proofs_batch ON merkle_proofs(batch_id);

    CREATE TABLE IF NOT EXISTS messages (
      id            TEXT PRIMARY KEY,
      type          TEXT NOT NULL,
      from_did      TEXT NOT NULL,
      to_did        TEXT NOT NULL,
      envelope      TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      expires_at    TEXT,
      status        TEXT NOT NULL DEFAULT 'queued',
      delivered_at  TEXT,
      retry_count   INTEGER NOT NULL DEFAULT 0,
      last_error    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_to_did ON messages(to_did, status);
    CREATE INDEX IF NOT EXISTS idx_messages_from_did ON messages(from_did);
    CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at) WHERE status = 'queued';
    CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);

    CREATE TABLE IF NOT EXISTS nonces (
      nonce       TEXT PRIMARY KEY,
      did         TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      expires_at  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_nonces_expires ON nonces(expires_at);
    CREATE INDEX IF NOT EXISTS idx_nonces_did ON nonces(did);
  `);

  return db;
}

// ---------------------------------------------------------------------------
// Database wrapper class with typed methods
// ---------------------------------------------------------------------------

export class Database {
  private db: BetterSqlite3.Database;

  constructor(dbPath: string) {
    this.db = initializeDatabase(dbPath);
  }

  /** Expose raw db for transactions / advanced usage. */
  get raw(): BetterSqlite3.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  // -----------------------------------------------------------------------
  // Agent CRUD
  // -----------------------------------------------------------------------

  insertAgent(agent: Omit<AgentRow, "created_at" | "updated_at">): AgentRow {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO agents (
        id, did, status, availability, last_seen_at, name, description,
        endpoint, payment_address, trust_score, interaction_count,
        successful_count, failed_count, created_at, updated_at,
        did_document, agent_card
      ) VALUES (
        @id, @did, @status, @availability, @last_seen_at, @name, @description,
        @endpoint, @payment_address, @trust_score, @interaction_count,
        @successful_count, @failed_count, @created_at, @updated_at,
        @did_document, @agent_card
      )
    `);
    const row = {
      ...agent,
      created_at: now,
      updated_at: now,
    };
    stmt.run(row);
    return row as AgentRow;
  }

  getAgent(id: string): AgentRow | undefined {
    const stmt = this.db.prepare("SELECT * FROM agents WHERE id = ?");
    return stmt.get(id) as AgentRow | undefined;
  }

  getAgentByDid(did: string): AgentRow | undefined {
    const stmt = this.db.prepare("SELECT * FROM agents WHERE did = ?");
    return stmt.get(did) as AgentRow | undefined;
  }

  updateAgent(
    id: string,
    updates: Partial<
      Pick<
        AgentRow,
        | "name"
        | "description"
        | "endpoint"
        | "payment_address"
        | "status"
        | "availability"
        | "last_seen_at"
        | "trust_score"
        | "interaction_count"
        | "successful_count"
        | "failed_count"
        | "did_document"
        | "agent_card"
      >
    >,
  ): boolean {
    const fields = Object.keys(updates).filter(
      (k) => (updates as Record<string, unknown>)[k] !== undefined,
    );
    if (fields.length === 0) return false;
    const sets = fields.map((f) => `${f} = @${f}`).join(", ");
    const stmt = this.db.prepare(
      `UPDATE agents SET ${sets}, updated_at = @updated_at WHERE id = @id`,
    );
    const result = stmt.run({
      ...updates,
      updated_at: new Date().toISOString(),
      id,
    });
    return result.changes > 0;
  }

  listAgents(filters: AgentFilters = {}): {
    agents: AgentRow[];
    total: number;
  } {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filters.status) {
      conditions.push("a.status = @status");
      params.status = filters.status;
    }
    if (filters.availability) {
      conditions.push("a.availability = @availability");
      params.availability = filters.availability;
    }
    if (filters.trust_min !== undefined) {
      conditions.push("a.trust_score >= @trust_min");
      params.trust_min = filters.trust_min;
    }
    if (filters.capability) {
      conditions.push(
        "EXISTS (SELECT 1 FROM capabilities c WHERE c.agent_id = a.id AND c.name = @capability)",
      );
      params.capability = filters.capability;
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(filters.limit ?? 20, 100);
    const offset = filters.offset ?? 0;

    const countStmt = this.db.prepare(
      `SELECT COUNT(*) as total FROM agents a ${where}`,
    );
    const { total } = countStmt.get(params) as { total: number };

    const selectStmt = this.db.prepare(
      `SELECT a.* FROM agents a ${where} ORDER BY a.trust_score DESC LIMIT @limit OFFSET @offset`,
    );
    const agents = selectStmt.all({
      ...params,
      limit,
      offset,
    }) as AgentRow[];

    return { agents, total };
  }

  // -----------------------------------------------------------------------
  // Capability
  // -----------------------------------------------------------------------

  insertCapability(
    capability: Omit<CapabilityRow, "id"> & { id?: string },
  ): CapabilityRow {
    const row: CapabilityRow = {
      id: capability.id ?? randomUUID(),
      agent_id: capability.agent_id,
      name: capability.name,
      metadata: capability.metadata ?? null,
    };
    const stmt = this.db.prepare(
      "INSERT INTO capabilities (id, agent_id, name, metadata) VALUES (@id, @agent_id, @name, @metadata)",
    );
    stmt.run(row);
    return row;
  }

  getCapabilitiesForAgent(agentId: string): CapabilityRow[] {
    const stmt = this.db.prepare(
      "SELECT * FROM capabilities WHERE agent_id = ?",
    );
    return stmt.all(agentId) as CapabilityRow[];
  }

  findAgentsByCapability(capabilityName: string): AgentRow[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT a.* FROM agents a
      INNER JOIN capabilities c ON c.agent_id = a.id
      WHERE c.name = ? AND a.status = 'active'
      ORDER BY a.trust_score DESC
    `);
    return stmt.all(capabilityName) as AgentRow[];
  }

  // -----------------------------------------------------------------------
  // Interaction
  // -----------------------------------------------------------------------

  insertInteraction(
    interaction: Omit<InteractionRow, "created_at" | "updated_at">,
  ): InteractionRow {
    const now = new Date().toISOString();
    const row = {
      ...interaction,
      created_at: now,
      updated_at: now,
    };
    const stmt = this.db.prepare(`
      INSERT INTO interactions (
        id, interaction_hash, initiator_did, provider_did, capability,
        status, outcome, payment_tx, payment_amount, created_at, updated_at,
        batch_id, request_payload, offer_payload, result_payload, idempotency_key
      ) VALUES (
        @id, @interaction_hash, @initiator_did, @provider_did, @capability,
        @status, @outcome, @payment_tx, @payment_amount, @created_at, @updated_at,
        @batch_id, @request_payload, @offer_payload, @result_payload, @idempotency_key
      )
    `);
    stmt.run(row);
    return row as InteractionRow;
  }

  getInteraction(id: string): InteractionRow | undefined {
    const stmt = this.db.prepare("SELECT * FROM interactions WHERE id = ?");
    return stmt.get(id) as InteractionRow | undefined;
  }

  getInteractionByHash(hash: string): InteractionRow | undefined {
    const stmt = this.db.prepare(
      "SELECT * FROM interactions WHERE interaction_hash = ?",
    );
    return stmt.get(hash) as InteractionRow | undefined;
  }

  getInteractionByIdempotencyKey(key: string): InteractionRow | undefined {
    const stmt = this.db.prepare(
      "SELECT * FROM interactions WHERE idempotency_key = ?",
    );
    return stmt.get(key) as InteractionRow | undefined;
  }

  updateInteraction(
    id: string,
    updates: Partial<
      Pick<
        InteractionRow,
        | "status"
        | "outcome"
        | "payment_tx"
        | "payment_amount"
        | "batch_id"
        | "offer_payload"
        | "result_payload"
      >
    >,
  ): boolean {
    const fields = Object.keys(updates).filter(
      (k) => (updates as Record<string, unknown>)[k] !== undefined,
    );
    if (fields.length === 0) return false;
    const sets = fields.map((f) => `${f} = @${f}`).join(", ");
    const stmt = this.db.prepare(
      `UPDATE interactions SET ${sets}, updated_at = @updated_at WHERE id = @id`,
    );
    const result = stmt.run({
      ...updates,
      updated_at: new Date().toISOString(),
      id,
    });
    return result.changes > 0;
  }

  getUnbatchedInteractions(
    limit: number = 100,
  ): InteractionRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM interactions
      WHERE batch_id IS NULL AND (status = 'completed' OR status = 'verified')
      ORDER BY created_at ASC
      LIMIT ?
    `);
    return stmt.all(limit) as InteractionRow[];
  }

  // -----------------------------------------------------------------------
  // Batch
  // -----------------------------------------------------------------------

  insertBatch(merkleRoot: string, interactionCount: number): number {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO batches (merkle_root, interaction_count, status, created_at)
      VALUES (@merkle_root, @interaction_count, 'pending', @created_at)
    `);
    const result = stmt.run({
      merkle_root: merkleRoot,
      interaction_count: interactionCount,
      created_at: now,
    });
    return Number(result.lastInsertRowid);
  }

  updateBatchStatus(
    id: number,
    status: string,
    txHash?: string,
  ): boolean {
    const confirmedAt =
      status === "confirmed" ? new Date().toISOString() : null;
    const stmt = this.db.prepare(`
      UPDATE batches SET status = @status, tx_hash = COALESCE(@tx_hash, tx_hash),
        confirmed_at = COALESCE(@confirmed_at, confirmed_at)
      WHERE id = @id
    `);
    const result = stmt.run({
      id,
      status,
      tx_hash: txHash ?? null,
      confirmed_at: confirmedAt,
    });
    return result.changes > 0;
  }

  getBatch(id: number): BatchRow | undefined {
    const stmt = this.db.prepare("SELECT * FROM batches WHERE id = ?");
    return stmt.get(id) as BatchRow | undefined;
  }

  listBatches(
    limit: number = 20,
    offset: number = 0,
  ): { batches: BatchRow[]; total: number } {
    const countStmt = this.db.prepare("SELECT COUNT(*) as total FROM batches");
    const { total } = countStmt.get() as { total: number };
    const stmt = this.db.prepare(
      "SELECT * FROM batches ORDER BY id DESC LIMIT ? OFFSET ?",
    );
    const batches = stmt.all(limit, offset) as BatchRow[];
    return { batches, total };
  }

  // -----------------------------------------------------------------------
  // Merkle Proof
  // -----------------------------------------------------------------------

  insertMerkleProof(
    interactionHash: string,
    batchId: number,
    proof: string[],
    leafHash: string,
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO merkle_proofs (interaction_hash, batch_id, proof, leaf_hash)
      VALUES (@interaction_hash, @batch_id, @proof, @leaf_hash)
    `);
    stmt.run({
      interaction_hash: interactionHash,
      batch_id: batchId,
      proof: JSON.stringify(proof),
      leaf_hash: leafHash,
    });
  }

  getMerkleProof(
    interactionHash: string,
  ): (MerkleProofRow & { parsed_proof: string[] }) | undefined {
    const stmt = this.db.prepare(
      "SELECT * FROM merkle_proofs WHERE interaction_hash = ?",
    );
    const row = stmt.get(interactionHash) as MerkleProofRow | undefined;
    if (!row) return undefined;
    return {
      ...row,
      parsed_proof: JSON.parse(row.proof) as string[],
    };
  }

  updateInteractionBatch(interactionHash: string, batchId: number): boolean {
    const stmt = this.db.prepare(
      "UPDATE interactions SET batch_id = ?, updated_at = ? WHERE interaction_hash = ?",
    );
    const result = stmt.run(batchId, new Date().toISOString(), interactionHash);
    return result.changes > 0;
  }

  // -----------------------------------------------------------------------
  // Message
  // -----------------------------------------------------------------------

  insertMessage(
    message: Omit<MessageRow, "status" | "delivered_at" | "retry_count" | "last_error">,
  ): MessageRow {
    const row: MessageRow = {
      ...message,
      status: "queued",
      delivered_at: null,
      retry_count: 0,
      last_error: null,
    };
    const stmt = this.db.prepare(`
      INSERT INTO messages (
        id, type, from_did, to_did, envelope, created_at, expires_at,
        status, delivered_at, retry_count, last_error
      ) VALUES (
        @id, @type, @from_did, @to_did, @envelope, @created_at, @expires_at,
        @status, @delivered_at, @retry_count, @last_error
      )
    `);
    stmt.run(row);
    return row;
  }

  getMessagesByRecipient(
    toDid: string,
    status: string = "queued",
  ): MessageRow[] {
    const stmt = this.db.prepare(
      "SELECT * FROM messages WHERE to_did = ? AND status = ? ORDER BY created_at ASC",
    );
    return stmt.all(toDid, status) as MessageRow[];
  }

  updateMessageStatus(
    id: string,
    status: string,
    error?: string,
  ): boolean {
    const deliveredAt = status === "delivered" ? new Date().toISOString() : null;
    const stmt = this.db.prepare(`
      UPDATE messages SET
        status = @status,
        delivered_at = COALESCE(@delivered_at, delivered_at),
        last_error = COALESCE(@last_error, last_error),
        retry_count = CASE WHEN @last_error IS NOT NULL THEN retry_count + 1 ELSE retry_count END
      WHERE id = @id
    `);
    const result = stmt.run({
      id,
      status,
      delivered_at: deliveredAt,
      last_error: error ?? null,
    });
    return result.changes > 0;
  }

  deleteExpiredMessages(): number {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      "DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at < ? AND status = 'queued'",
    );
    const result = stmt.run(now);
    return result.changes;
  }

  // -----------------------------------------------------------------------
  // Nonce
  // -----------------------------------------------------------------------

  insertNonce(nonce: string, did: string, ttlHours: number = 24): void {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);
    const stmt = this.db.prepare(
      "INSERT INTO nonces (nonce, did, created_at, expires_at) VALUES (?, ?, ?, ?)",
    );
    stmt.run(nonce, did, now.toISOString(), expiresAt.toISOString());
  }

  nonceExists(nonce: string): boolean {
    const stmt = this.db.prepare("SELECT 1 FROM nonces WHERE nonce = ?");
    return stmt.get(nonce) !== undefined;
  }

  deleteExpiredNonces(): number {
    const now = new Date().toISOString();
    const stmt = this.db.prepare("DELETE FROM nonces WHERE expires_at < ?");
    const result = stmt.run(now);
    return result.changes;
  }

  // -----------------------------------------------------------------------
  // Stats
  // -----------------------------------------------------------------------

  getAgentCount(): number {
    const stmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM agents WHERE status = 'active'",
    );
    return (stmt.get() as { count: number }).count;
  }

  getBatchCount(): number {
    const stmt = this.db.prepare("SELECT COUNT(*) as count FROM batches");
    return (stmt.get() as { count: number }).count;
  }

  getPendingInteractionCount(): number {
    const stmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM interactions WHERE status NOT IN ('completed', 'failed', 'expired')",
    );
    return (stmt.get() as { count: number }).count;
  }
}
