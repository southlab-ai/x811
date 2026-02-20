/**
 * x811 Protocol — TypeScript SDK Client.
 *
 * X811Client is the main entry point for interacting with the x811 Protocol.
 * It handles DID generation, envelope signing, agent registration, discovery,
 * messaging, negotiation shortcuts, heartbeats, and on-chain verification.
 */

import { v7 as uuidv7 } from "uuid";
import { randomBytes } from "node:crypto";
import {
  type DIDKeyPair,
  type DIDDocument,
  type X811Envelope,
  type X811MessageType,
  type AgentCard,
  type RequestPayload,
  type OfferPayload,
  type AcceptPayload,
  type RejectPayload,
  type ResultPayload,
  type PaymentPayload,
  X811Error,
  X811ErrorCode,
  signEnvelope,
  generateDID,
  buildDIDDocument,
  type ResolvedDID,
} from "@x811/core";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configuration options for the X811Client. */
export interface X811ClientConfig {
  /** Base URL of the x811 registry/relay server (e.g., "http://localhost:3000"). */
  serverUrl: string;
  /** Optional pre-existing key pair. If omitted, a new DID is generated. */
  keyPair?: DIDKeyPair;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Base64url encode a Uint8Array (no padding). */
function toBase64Url(bytes: Uint8Array): string {
  const binString = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binString).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generate a random hex nonce. */
function randomNonce(): string {
  return Array.from(randomBytes(16), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// X811Client
// ---------------------------------------------------------------------------

export class X811Client {
  private readonly _serverUrl: string;
  private readonly _keyPair: DIDKeyPair;
  private readonly _didDocument: DIDDocument;

  constructor(config: X811ClientConfig) {
    this._serverUrl = config.serverUrl.replace(/\/+$/, "");

    if (config.keyPair) {
      this._keyPair = config.keyPair;
      this._didDocument = buildDIDDocument(
        config.keyPair.did,
        config.keyPair.signingKey.publicKey,
        config.keyPair.encryptionKey.publicKey,
      );
    } else {
      const generated = generateDID();
      this._keyPair = generated.keyPair;
      this._didDocument = generated.document;
    }
  }

  /** The client's DID string (e.g., "did:x811:<uuid>"). */
  get did(): string {
    return this._keyPair.did;
  }

  /** The client's cryptographic key pair. */
  get keyPair(): DIDKeyPair {
    return this._keyPair;
  }

  // -----------------------------------------------------------------------
  // Agent registration
  // -----------------------------------------------------------------------

  /**
   * Register this agent with the x811 registry.
   * Builds a signed registration envelope and POSTs it to the server.
   */
  async register(agentInfo: {
    name: string;
    description?: string;
    endpoint?: string;
    payment_address?: string;
    capabilities?: Array<{
      name: string;
      description?: string;
      input_schema?: Record<string, unknown>;
      output_schema?: Record<string, unknown>;
      pricing?: Record<string, unknown>;
    }>;
  }): Promise<AgentCard> {
    const envelope = this.buildEnvelope(
      this.did, // 'to' is self for registration
      "x811/request",
      agentInfo,
    );

    const signed = signEnvelope(envelope, this._keyPair.signingKey.privateKey);

    const body = {
      envelope: signed,
      did_document: this._didDocument,
      public_key: toBase64Url(this._keyPair.signingKey.publicKey),
    };

    const result = await this.fetchJSON<AgentCard>(
      "/api/v1/agents",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    return result;
  }

  // -----------------------------------------------------------------------
  // DID resolution
  // -----------------------------------------------------------------------

  /**
   * Resolve a DID by fetching its DID Document from the registry.
   */
  async resolve(did: string): Promise<ResolvedDID> {
    const agentId = this.extractAgentId(did);
    const doc = await this.fetchJSON<DIDDocument>(
      `/api/v1/agents/${encodeURIComponent(agentId)}/did`,
    );

    // We return a minimal ResolvedDID. The server returns the DID document directly.
    return {
      document: doc,
      status: "active",
      publicKey: new Uint8Array(0), // extracted by caller if needed
      encryptionKey: new Uint8Array(0),
    } as ResolvedDID;
  }

  // -----------------------------------------------------------------------
  // Discovery
  // -----------------------------------------------------------------------

  /**
   * Discover agents matching the given query parameters.
   */
  async discover(params: {
    capability?: string;
    trust_min?: number;
    status?: string;
    availability?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ agents: AgentCard[]; total: number }> {
    const query = new URLSearchParams();
    if (params.capability !== undefined) query.set("capability", params.capability);
    if (params.trust_min !== undefined) query.set("trust_min", String(params.trust_min));
    if (params.status !== undefined) query.set("status", params.status);
    if (params.availability !== undefined) query.set("availability", params.availability);
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.offset !== undefined) query.set("offset", String(params.offset));

    const qs = query.toString();
    const path = qs ? `/api/v1/agents?${qs}` : "/api/v1/agents";
    return this.fetchJSON<{ agents: AgentCard[]; total: number }>(path);
  }

  // -----------------------------------------------------------------------
  // Agent card
  // -----------------------------------------------------------------------

  /**
   * Retrieve the Agent Card for a given agent ID.
   */
  async getAgentCard(agentId: string): Promise<AgentCard> {
    return this.fetchJSON<AgentCard>(
      `/api/v1/agents/${encodeURIComponent(agentId)}/card`,
    );
  }

  // -----------------------------------------------------------------------
  // Generic message sending
  // -----------------------------------------------------------------------

  /**
   * Build, sign, and send an envelope to the given recipient.
   * Returns the message_id and status from the server.
   */
  async send<T>(
    to: string,
    type: X811MessageType,
    payload: T,
  ): Promise<{ message_id: string; status: string }> {
    const envelope = this.buildEnvelope(to, type, payload);
    return this.signAndSend(envelope);
  }

  // -----------------------------------------------------------------------
  // Polling
  // -----------------------------------------------------------------------

  /**
   * Poll for messages addressed to this agent.
   * Uses the agent's DID as a query parameter for simple auth.
   */
  async poll(): Promise<X811Envelope<unknown>[]> {
    const agentId = this.extractAgentId(this.did);
    const result = await this.fetchJSON<{
      agent_id: string;
      messages: X811Envelope<unknown>[];
      count: number;
    }>(`/api/v1/messages/${encodeURIComponent(agentId)}?did=${encodeURIComponent(this.did)}`);

    return result.messages;
  }

  // -----------------------------------------------------------------------
  // Negotiation shortcuts
  // -----------------------------------------------------------------------

  /**
   * Send a task request to a provider.
   * @returns The message_id from the server.
   */
  async request(providerDid: string, task: RequestPayload): Promise<string> {
    const result = await this.send(providerDid, "x811/request", task);
    return result.message_id;
  }

  /**
   * Send an offer to the initiator in response to a request.
   * @returns The message_id from the server.
   */
  async offer(initiatorDid: string, offer: OfferPayload): Promise<string> {
    const result = await this.send(initiatorDid, "x811/offer", offer);
    return result.message_id;
  }

  /**
   * Accept a provider's offer.
   * @returns The message_id from the server.
   */
  async accept(providerDid: string, accept: AcceptPayload): Promise<string> {
    const result = await this.send(providerDid, "x811/accept", accept);
    return result.message_id;
  }

  /**
   * Reject a provider's offer.
   * @returns The message_id from the server.
   */
  async reject(providerDid: string, reject: RejectPayload): Promise<string> {
    const result = await this.send(providerDid, "x811/reject", reject);
    return result.message_id;
  }

  /**
   * Deliver a task result to the initiator.
   * @returns The message_id from the server.
   */
  async deliverResult(initiatorDid: string, result: ResultPayload): Promise<string> {
    const res = await this.send(initiatorDid, "x811/result", result);
    return res.message_id;
  }

  /**
   * Send a verification request for an interaction.
   * @returns The message_id from the server.
   */
  async sendVerify(providerDid: string, interactionId: string): Promise<string> {
    const result = await this.send(providerDid, "x811/verify", {
      interaction_id: interactionId,
    });
    return result.message_id;
  }

  /**
   * Send a payment message.
   * @returns The message_id from the server.
   */
  async pay(providerDid: string, payment: PaymentPayload): Promise<string> {
    const result = await this.send(providerDid, "x811/payment", payment);
    return result.message_id;
  }

  // -----------------------------------------------------------------------
  // Heartbeat
  // -----------------------------------------------------------------------

  /**
   * Send a heartbeat to signal availability and capacity.
   */
  async heartbeat(
    availability: "online" | "busy" | "offline",
    capacity: number,
    ttl?: number,
  ): Promise<void> {
    const agentId = this.extractAgentId(this.did);

    const payload: Record<string, unknown> = { availability, capacity };
    if (ttl !== undefined) {
      payload.ttl = ttl;
    }

    const envelope = this.buildEnvelope(this.did, "x811/heartbeat", payload);
    const signed = signEnvelope(envelope, this._keyPair.signingKey.privateKey);

    await this.fetchJSON(
      `/api/v1/agents/${encodeURIComponent(agentId)}/heartbeat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ envelope: signed }),
      },
    );
  }

  // -----------------------------------------------------------------------
  // On-chain verification
  // -----------------------------------------------------------------------

  /**
   * Verify an interaction hash against the on-chain Merkle root.
   */
  async verifyInteraction(hash: string): Promise<{
    included: boolean;
    proof: string[];
    batch_tx_hash?: string;
    basescan_url?: string;
  }> {
    const result = await this.fetchJSON<{
      interaction_hash: string;
      included: boolean;
      proof: string[];
      batch_tx_hash: string | null;
      basescan_url: string | null;
    }>(`/api/v1/verify/${encodeURIComponent(hash)}`);

    return {
      included: result.included,
      proof: result.proof,
      batch_tx_hash: result.batch_tx_hash ?? undefined,
      basescan_url: result.basescan_url ?? undefined,
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Build an unsigned envelope with UUIDv7 id, protocol version, and timestamps.
   */
  private buildEnvelope<T>(
    to: string,
    type: X811MessageType,
    payload: T,
  ): Omit<X811Envelope<T>, "signature"> {
    const now = new Date();
    const expires = new Date(now.getTime() + 5 * 60 * 1000); // 5 minutes

    return {
      version: "0.1.0",
      id: uuidv7(),
      type,
      from: this.did,
      to,
      created: now.toISOString(),
      expires: expires.toISOString(),
      payload,
      nonce: randomNonce(),
    };
  }

  /**
   * Sign an envelope and POST it to the messages endpoint.
   */
  private async signAndSend<T>(
    envelope: Omit<X811Envelope<T>, "signature">,
  ): Promise<{ message_id: string; status: string }> {
    const signed = signEnvelope(envelope, this._keyPair.signingKey.privateKey);

    return this.fetchJSON<{ message_id: string; status: string }>(
      "/api/v1/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ envelope: signed }),
      },
    );
  }

  /**
   * Extract the agent UUID from a DID string.
   * "did:x811:<uuid>" -> "<uuid>"
   */
  private extractAgentId(did: string): string {
    const prefix = "did:x811:";
    if (!did.startsWith(prefix)) {
      throw new X811Error(
        X811ErrorCode.INVALID_DID_FORMAT,
        `Invalid DID format: expected "did:x811:<id>", got "${did}"`,
      );
    }
    return did.slice(prefix.length);
  }

  /**
   * Fetch wrapper that throws X811Error on non-2xx responses.
   */
  private async fetchJSON<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this._serverUrl}${path}`;

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      throw new X811Error(
        X811ErrorCode.INTERNAL_ERROR,
        `Network error reaching ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      let errorBody: { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | undefined;
      try {
        errorBody = (await response.json()) as typeof errorBody;
      } catch {
        // Response body may not be JSON
      }

      const code = errorBody?.error?.code ?? `HTTP-${response.status}`;
      const message = errorBody?.error?.message ?? `HTTP ${response.status}: ${response.statusText}`;
      const details = errorBody?.error?.details;

      // Map known error codes to X811ErrorCode enum values
      const knownCode = Object.values(X811ErrorCode).find((c) => c === code);
      throw new X811Error(
        (knownCode as X811ErrorCode) ?? X811ErrorCode.INTERNAL_ERROR,
        message,
        details,
      );
    }

    return (await response.json()) as T;
  }
}
