/**
 * x811 Protocol --- SSE (Server-Sent Events) Manager.
 *
 * Manages persistent SSE connections per agent for real-time push
 * notifications. Messages are pushed as SSE events; the client still
 * polls to mark messages as delivered (SSE is a "fast path" only).
 */

import type http from "node:http";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SSEConnection {
  response: http.ServerResponse;
  connectedAt: number;
  keepaliveTimer: NodeJS.Timeout;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SSEManager {
  private connections = new Map<string, SSEConnection[]>();
  private readonly MAX_PER_AGENT = 3;
  private readonly MAX_GLOBAL = 100;
  private globalCount = 0;

  /** Returns false if limit reached (do not subscribe). */
  subscribe(agentId: string, res: http.ServerResponse): boolean {
    if (this.globalCount >= this.MAX_GLOBAL) return false;
    const existing = this.connections.get(agentId) ?? [];
    if (existing.length >= this.MAX_PER_AGENT) return false;

    const keepaliveTimer = setInterval(() => {
      try {
        res.write("event: keepalive\ndata: {}\n\n");
      } catch {
        this.unsubscribe(agentId, res);
      }
    }, 30_000);

    existing.push({ response: res, connectedAt: Date.now(), keepaliveTimer });
    this.connections.set(agentId, existing);
    this.globalCount++;
    return true;
  }

  unsubscribe(agentId: string, res: http.ServerResponse): void {
    const existing = this.connections.get(agentId);
    if (!existing) return;
    const idx = existing.findIndex((c) => c.response === res);
    if (idx === -1) return;
    clearInterval(existing[idx].keepaliveTimer);
    existing.splice(idx, 1);
    this.globalCount--;
    if (existing.length === 0) this.connections.delete(agentId);
    else this.connections.set(agentId, existing);
  }

  /** Emit a message event to all SSE connections for this agent. */
  emit(agentId: string, messageId: string, message: unknown): void {
    const conns = this.connections.get(agentId);
    if (!conns || conns.length === 0) return;
    const data = `id: ${messageId}\nevent: message\ndata: ${JSON.stringify(message)}\n\n`;
    for (const conn of [...conns]) {
      try {
        conn.response.write(data);
      } catch {
        this.unsubscribe(agentId, conn.response);
      }
    }
  }

  /** Close all connections for an agent (e.g., on heartbeat expiry). */
  evictAgent(agentId: string): void {
    const conns = this.connections.get(agentId);
    if (!conns) return;
    for (const conn of [...conns]) {
      clearInterval(conn.keepaliveTimer);
      try {
        conn.response.end();
      } catch {
        /* ignore */
      }
    }
    this.globalCount -= conns.length;
    this.connections.delete(agentId);
  }

  getStats(): { global: number; perAgent: Record<string, number> } {
    const perAgent: Record<string, number> = {};
    for (const [id, conns] of this.connections) perAgent[id] = conns.length;
    return { global: this.globalCount, perAgent };
  }
}
