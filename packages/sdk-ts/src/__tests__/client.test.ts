/**
 * x811 Protocol — SDK Client comprehensive tests.
 *
 * All HTTP calls are mocked via global.fetch to test the client
 * in isolation from the server.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { X811Client } from "../client.js";
import {
  generateDID,
  signEnvelope,
  verifyEnvelope,
  type X811Envelope,
  type DIDKeyPair,
  type RequestPayload,
  type OfferPayload,
  type AcceptPayload,
  type RejectPayload,
  type ResultPayload,
  type PaymentPayload,
  X811Error,
} from "@x811/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SERVER_URL = "http://localhost:3000";

/** Create a mock Response object. */
function mockResponse(body: unknown, status = 200, statusText = "OK"): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
    headers: new Headers(),
    redirected: false,
    type: "basic" as ResponseType,
    url: "",
    clone: () => mockResponse(body, status, statusText),
    body: null,
    bodyUsed: false,
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob(),
    formData: async () => new FormData(),
    text: async () => JSON.stringify(body),
    bytes: async () => new Uint8Array(),
  } as Response;
}

/** Create a pre-generated key pair for deterministic tests. */
function createTestKeyPair(): DIDKeyPair {
  const generated = generateDID();
  return generated.keyPair;
}

/** Extract the body from the most recent fetch call. */
function getLastFetchBody(): Record<string, unknown> {
  const calls = vi.mocked(global.fetch).mock.calls;
  const lastCall = calls[calls.length - 1];
  const init = lastCall[1] as RequestInit | undefined;
  return JSON.parse(init?.body as string);
}

/** Extract the URL from the most recent fetch call. */
function getLastFetchUrl(): string {
  const calls = vi.mocked(global.fetch).mock.calls;
  const lastCall = calls[calls.length - 1];
  return lastCall[0] as string;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("X811Client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  describe("constructor", () => {
    it("generates a DID and key pair when none is provided", () => {
      const client = new X811Client({ serverUrl: SERVER_URL });

      expect(client.did).toMatch(/^did:x811:[0-9a-f-]{36}$/);
      expect(client.keyPair).toBeDefined();
      expect(client.keyPair.signingKey.publicKey).toBeInstanceOf(Uint8Array);
      expect(client.keyPair.signingKey.publicKey.length).toBe(32);
      expect(client.keyPair.signingKey.privateKey).toBeInstanceOf(Uint8Array);
      expect(client.keyPair.signingKey.privateKey.length).toBe(32);
    });

    it("uses the provided key pair when given", () => {
      const kp = createTestKeyPair();
      const client = new X811Client({ serverUrl: SERVER_URL, keyPair: kp });

      expect(client.did).toBe(kp.did);
      expect(client.keyPair).toBe(kp);
    });

    it("generates unique DIDs on each instantiation", () => {
      const client1 = new X811Client({ serverUrl: SERVER_URL });
      const client2 = new X811Client({ serverUrl: SERVER_URL });

      expect(client1.did).not.toBe(client2.did);
    });

    it("strips trailing slashes from the server URL", () => {
      fetchMock.mockResolvedValueOnce(
        mockResponse({ agents: [], total: 0 }),
      );

      const client = new X811Client({ serverUrl: "http://localhost:3000///" });
      client.discover();

      // The URL in the fetch call should not have trailing slashes before the path
      const url = getLastFetchUrl();
      expect(url).toMatch(/^http:\/\/localhost:3000\/api/);
    });
  });

  // -----------------------------------------------------------------------
  // register()
  // -----------------------------------------------------------------------

  describe("register()", () => {
    it("sends correct envelope structure with DID document and public key", async () => {
      const kp = createTestKeyPair();
      const client = new X811Client({ serverUrl: SERVER_URL, keyPair: kp });

      const mockCard = {
        id: "test-id",
        did: kp.did,
        name: "Test Agent",
        status: "active",
        trust_score: 0.5,
        capabilities: ["code-review"],
        created_at: new Date().toISOString(),
      };

      fetchMock.mockResolvedValueOnce(mockResponse(mockCard, 201));

      const result = await client.register({
        name: "Test Agent",
        description: "A test agent",
        endpoint: "http://localhost:4000",
        payment_address: "0x1234567890abcdef1234567890abcdef12345678",
        capabilities: [
          {
            name: "code-review",
            description: "Review code",
            input_schema: { type: "object" },
            output_schema: { type: "object" },
            pricing: { model: "fixed", amount: "1.00", currency: "USDC" },
          },
        ],
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Verify URL
      const url = getLastFetchUrl();
      expect(url).toBe(`${SERVER_URL}/api/v1/agents`);

      // Verify body structure
      const body = getLastFetchBody();
      expect(body).toHaveProperty("envelope");
      expect(body).toHaveProperty("did_document");
      expect(body).toHaveProperty("public_key");

      // Verify envelope
      const envelope = body.envelope as Record<string, unknown>;
      expect(envelope.version).toBe("0.1.0");
      expect(envelope.from).toBe(kp.did);
      expect(envelope.type).toBe("x811/request");
      expect(envelope.signature).toBeDefined();
      expect(envelope.nonce).toBeDefined();
      expect(envelope.id).toMatch(/^[0-9a-f-]{36}$/);

      // Verify payload contains agent info
      const payload = envelope.payload as Record<string, unknown>;
      expect(payload.name).toBe("Test Agent");
      expect(payload.description).toBe("A test agent");
      expect(payload.capabilities).toHaveLength(1);

      // Verify DID document
      const didDoc = body.did_document as Record<string, unknown>;
      expect(didDoc.id).toBe(kp.did);

      // Verify public key is base64url encoded
      const pubKey = body.public_key as string;
      expect(pubKey).toMatch(/^[A-Za-z0-9_-]+$/);

      // Verify result
      expect(result).toEqual(mockCard);
    });

    it("signs the registration envelope with the client's private key", async () => {
      const kp = createTestKeyPair();
      const client = new X811Client({ serverUrl: SERVER_URL, keyPair: kp });

      fetchMock.mockResolvedValueOnce(mockResponse({ id: "test" }, 201));

      await client.register({ name: "Test" });

      const body = getLastFetchBody();
      const envelope = body.envelope as X811Envelope<unknown>;

      // Verify the signature is valid using the public key
      const valid = verifyEnvelope(envelope, kp.signingKey.publicKey);
      expect(valid).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // discover()
  // -----------------------------------------------------------------------

  describe("discover()", () => {
    it("passes query parameters correctly", async () => {
      const client = new X811Client({ serverUrl: SERVER_URL });

      fetchMock.mockResolvedValueOnce(
        mockResponse({ agents: [], total: 0 }),
      );

      await client.discover({
        capability: "code-review",
        trust_min: 0.7,
        status: "active",
        availability: "online",
        limit: 10,
        offset: 5,
      });

      const url = getLastFetchUrl();
      expect(url).toContain("capability=code-review");
      expect(url).toContain("trust_min=0.7");
      expect(url).toContain("status=active");
      expect(url).toContain("availability=online");
      expect(url).toContain("limit=10");
      expect(url).toContain("offset=5");
    });

    it("sends no query params when none are provided", async () => {
      const client = new X811Client({ serverUrl: SERVER_URL });

      fetchMock.mockResolvedValueOnce(
        mockResponse({ agents: [], total: 0 }),
      );

      await client.discover();

      const url = getLastFetchUrl();
      expect(url).toBe(`${SERVER_URL}/api/v1/agents`);
    });

    it("returns agents and total count", async () => {
      const client = new X811Client({ serverUrl: SERVER_URL });

      const mockResult = {
        agents: [
          { name: "Agent A", did: "did:x811:aaa" },
          { name: "Agent B", did: "did:x811:bbb" },
        ],
        total: 2,
      };

      fetchMock.mockResolvedValueOnce(mockResponse(mockResult));

      const result = await client.discover({ capability: "test" });
      expect(result.agents).toHaveLength(2);
      expect(result.total).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // getAgentCard()
  // -----------------------------------------------------------------------

  describe("getAgentCard()", () => {
    it("fetches the agent card by agent ID", async () => {
      const client = new X811Client({ serverUrl: SERVER_URL });

      const mockCard = {
        name: "Test Agent",
        capabilities: [],
        x811: { did: "did:x811:test-id" },
      };

      fetchMock.mockResolvedValueOnce(mockResponse(mockCard));

      const result = await client.getAgentCard("test-id");

      expect(getLastFetchUrl()).toBe(`${SERVER_URL}/api/v1/agents/test-id/card`);
      expect(result.name).toBe("Test Agent");
    });
  });

  // -----------------------------------------------------------------------
  // resolve()
  // -----------------------------------------------------------------------

  describe("resolve()", () => {
    it("fetches DID document from the correct endpoint", async () => {
      const client = new X811Client({ serverUrl: SERVER_URL });

      const mockDoc = {
        "@context": ["https://www.w3.org/ns/did/v1"],
        id: "did:x811:some-uuid",
        verificationMethod: [],
      };

      fetchMock.mockResolvedValueOnce(mockResponse(mockDoc));

      const result = await client.resolve("did:x811:some-uuid");

      expect(getLastFetchUrl()).toBe(`${SERVER_URL}/api/v1/agents/some-uuid/did`);
      expect(result.document).toEqual(mockDoc);
    });

    it("throws on invalid DID format", async () => {
      const client = new X811Client({ serverUrl: SERVER_URL });

      await expect(client.resolve("invalid-did")).rejects.toThrow(X811Error);
      await expect(client.resolve("invalid-did")).rejects.toThrow("Invalid DID format");
    });
  });

  // -----------------------------------------------------------------------
  // send()
  // -----------------------------------------------------------------------

  describe("send()", () => {
    it("signs the envelope and posts to /api/v1/messages", async () => {
      const kp = createTestKeyPair();
      const client = new X811Client({ serverUrl: SERVER_URL, keyPair: kp });

      fetchMock.mockResolvedValueOnce(
        mockResponse({ message_id: "msg-001", status: "delivered" }),
      );

      const result = await client.send(
        "did:x811:recipient-uuid",
        "x811/request",
        { task_type: "code-review", parameters: {} },
      );

      // Verify URL
      expect(getLastFetchUrl()).toBe(`${SERVER_URL}/api/v1/messages`);

      // Verify envelope structure
      const body = getLastFetchBody();
      const envelope = body.envelope as X811Envelope<unknown>;
      expect(envelope.version).toBe("0.1.0");
      expect(envelope.from).toBe(kp.did);
      expect(envelope.to).toBe("did:x811:recipient-uuid");
      expect(envelope.type).toBe("x811/request");
      expect(envelope.signature).toBeDefined();
      expect(envelope.nonce).toBeDefined();
      expect(envelope.created).toBeDefined();
      expect(envelope.expires).toBeDefined();

      // Verify signature
      const valid = verifyEnvelope(envelope, kp.signingKey.publicKey);
      expect(valid).toBe(true);

      // Verify result
      expect(result.message_id).toBe("msg-001");
      expect(result.status).toBe("delivered");
    });

    it("includes a UUIDv7 message ID in the envelope", async () => {
      const client = new X811Client({ serverUrl: SERVER_URL });

      fetchMock.mockResolvedValueOnce(
        mockResponse({ message_id: "msg-001", status: "delivered" }),
      );

      await client.send("did:x811:target", "x811/request", {});

      const body = getLastFetchBody();
      const envelope = body.envelope as Record<string, unknown>;
      // UUIDv7 format: 8-4-4-4-12 hex chars with dashes
      expect(envelope.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it("includes a unique nonce in each envelope", async () => {
      const client = new X811Client({ serverUrl: SERVER_URL });

      fetchMock.mockResolvedValue(
        mockResponse({ message_id: "msg-001", status: "delivered" }),
      );

      await client.send("did:x811:target", "x811/request", {});
      const body1 = getLastFetchBody();
      const nonce1 = (body1.envelope as Record<string, unknown>).nonce;

      await client.send("did:x811:target", "x811/request", {});
      const body2 = getLastFetchBody();
      const nonce2 = (body2.envelope as Record<string, unknown>).nonce;

      expect(nonce1).not.toBe(nonce2);
    });
  });

  // -----------------------------------------------------------------------
  // poll()
  // -----------------------------------------------------------------------

  describe("poll()", () => {
    it("returns messages from the server", async () => {
      const kp = createTestKeyPair();
      const client = new X811Client({ serverUrl: SERVER_URL, keyPair: kp });

      const agentId = kp.did.slice("did:x811:".length);
      const mockMessages = [
        { id: "msg-1", type: "x811/offer", from: "did:x811:provider", payload: {} },
        { id: "msg-2", type: "x811/result", from: "did:x811:provider", payload: {} },
      ];

      fetchMock.mockResolvedValueOnce(
        mockResponse({
          agent_id: agentId,
          messages: mockMessages,
          count: 2,
        }),
      );

      const messages = await client.poll();

      expect(messages).toHaveLength(2);
      expect(messages[0].id).toBe("msg-1");
      expect(messages[1].id).toBe("msg-2");

      // Verify correct URL with DID query param
      const url = getLastFetchUrl();
      expect(url).toContain(`/api/v1/messages/${agentId}`);
      expect(url).toContain(`did=${encodeURIComponent(kp.did)}`);
    });

    it("returns an empty array when no messages are pending", async () => {
      const kp = createTestKeyPair();
      const client = new X811Client({ serverUrl: SERVER_URL, keyPair: kp });

      fetchMock.mockResolvedValueOnce(
        mockResponse({
          agent_id: kp.did.slice("did:x811:".length),
          messages: [],
          count: 0,
        }),
      );

      const messages = await client.poll();
      expect(messages).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Negotiation shortcuts
  // -----------------------------------------------------------------------

  describe("request()", () => {
    it("sends an x811/request envelope and returns message_id", async () => {
      const kp = createTestKeyPair();
      const client = new X811Client({ serverUrl: SERVER_URL, keyPair: kp });

      fetchMock.mockResolvedValueOnce(
        mockResponse({ message_id: "msg-req-001", status: "delivered" }),
      );

      const task: RequestPayload = {
        task_type: "code-review",
        parameters: { repo: "github.com/test/repo", branch: "main" },
        max_budget: 10,
        currency: "USDC",
        deadline: 3600,
        acceptance_policy: "auto",
        idempotency_key: "idem-001",
      };

      const messageId = await client.request("did:x811:provider-uuid", task);

      expect(messageId).toBe("msg-req-001");

      const body = getLastFetchBody();
      const envelope = body.envelope as X811Envelope<RequestPayload>;
      expect(envelope.type).toBe("x811/request");
      expect(envelope.to).toBe("did:x811:provider-uuid");
      expect(envelope.payload.task_type).toBe("code-review");
      expect(envelope.payload.max_budget).toBe(10);
    });
  });

  describe("offer()", () => {
    it("sends an x811/offer envelope and returns message_id", async () => {
      const kp = createTestKeyPair();
      const client = new X811Client({ serverUrl: SERVER_URL, keyPair: kp });

      fetchMock.mockResolvedValueOnce(
        mockResponse({ message_id: "msg-offer-001", status: "delivered" }),
      );

      const offerPayload: OfferPayload = {
        request_id: "req-001",
        price: "5.00",
        protocol_fee: "0.125",
        total_cost: "5.125",
        currency: "USDC",
        estimated_time: 1800,
        deliverables: ["reviewed code with annotations"],
        expiry: 300,
      };

      const messageId = await client.offer("did:x811:initiator-uuid", offerPayload);

      expect(messageId).toBe("msg-offer-001");

      const body = getLastFetchBody();
      const envelope = body.envelope as X811Envelope<OfferPayload>;
      expect(envelope.type).toBe("x811/offer");
      expect(envelope.to).toBe("did:x811:initiator-uuid");
      expect(envelope.payload.price).toBe("5.00");
    });
  });

  describe("accept()", () => {
    it("sends an x811/accept envelope and returns message_id", async () => {
      const kp = createTestKeyPair();
      const client = new X811Client({ serverUrl: SERVER_URL, keyPair: kp });

      fetchMock.mockResolvedValueOnce(
        mockResponse({ message_id: "msg-accept-001", status: "delivered" }),
      );

      const acceptPayload: AcceptPayload = {
        offer_id: "offer-001",
        offer_hash: "a".repeat(64),
      };

      const messageId = await client.accept("did:x811:provider-uuid", acceptPayload);

      expect(messageId).toBe("msg-accept-001");

      const body = getLastFetchBody();
      const envelope = body.envelope as X811Envelope<AcceptPayload>;
      expect(envelope.type).toBe("x811/accept");
      expect(envelope.payload.offer_id).toBe("offer-001");
    });
  });

  describe("reject()", () => {
    it("sends an x811/reject envelope and returns message_id", async () => {
      const kp = createTestKeyPair();
      const client = new X811Client({ serverUrl: SERVER_URL, keyPair: kp });

      fetchMock.mockResolvedValueOnce(
        mockResponse({ message_id: "msg-reject-001", status: "delivered" }),
      );

      const rejectPayload: RejectPayload = {
        offer_id: "offer-001",
        reason: "Price too high",
        code: "PRICE_TOO_HIGH",
      };

      const messageId = await client.reject("did:x811:provider-uuid", rejectPayload);

      expect(messageId).toBe("msg-reject-001");

      const body = getLastFetchBody();
      const envelope = body.envelope as X811Envelope<RejectPayload>;
      expect(envelope.type).toBe("x811/reject");
      expect(envelope.payload.code).toBe("PRICE_TOO_HIGH");
    });
  });

  describe("deliverResult()", () => {
    it("sends an x811/result envelope and returns message_id", async () => {
      const kp = createTestKeyPair();
      const client = new X811Client({ serverUrl: SERVER_URL, keyPair: kp });

      fetchMock.mockResolvedValueOnce(
        mockResponse({ message_id: "msg-result-001", status: "delivered" }),
      );

      const resultPayload: ResultPayload = {
        request_id: "req-001",
        offer_id: "offer-001",
        content: "Here is the code review...",
        content_type: "text/markdown",
        result_hash: "b".repeat(64),
        execution_time_ms: 15000,
        model_used: "claude-3.5-sonnet",
      };

      const messageId = await client.deliverResult("did:x811:initiator-uuid", resultPayload);

      expect(messageId).toBe("msg-result-001");

      const body = getLastFetchBody();
      const envelope = body.envelope as X811Envelope<ResultPayload>;
      expect(envelope.type).toBe("x811/result");
      expect(envelope.to).toBe("did:x811:initiator-uuid");
      expect(envelope.payload.result_hash).toBe("b".repeat(64));
    });
  });

  describe("sendVerify()", () => {
    it("sends an x811/verify envelope with interaction_id", async () => {
      const kp = createTestKeyPair();
      const client = new X811Client({ serverUrl: SERVER_URL, keyPair: kp });

      fetchMock.mockResolvedValueOnce(
        mockResponse({ message_id: "msg-verify-001", status: "delivered" }),
      );

      const messageId = await client.sendVerify("did:x811:provider-uuid", "interaction-123");

      expect(messageId).toBe("msg-verify-001");

      const body = getLastFetchBody();
      const envelope = body.envelope as X811Envelope<{ interaction_id: string }>;
      expect(envelope.type).toBe("x811/verify");
      expect(envelope.payload.interaction_id).toBe("interaction-123");
    });
  });

  describe("pay()", () => {
    it("sends an x811/payment envelope and returns message_id", async () => {
      const kp = createTestKeyPair();
      const client = new X811Client({ serverUrl: SERVER_URL, keyPair: kp });

      fetchMock.mockResolvedValueOnce(
        mockResponse({ message_id: "msg-pay-001", status: "delivered" }),
      );

      const paymentPayload: PaymentPayload = {
        request_id: "req-001",
        offer_id: "offer-001",
        tx_hash: "0x" + "a".repeat(64),
        amount: "5.125",
        currency: "USDC",
        network: "base",
        payer_address: "0x1111111111111111111111111111111111111111",
        payee_address: "0x2222222222222222222222222222222222222222",
      };

      const messageId = await client.pay("did:x811:provider-uuid", paymentPayload);

      expect(messageId).toBe("msg-pay-001");

      const body = getLastFetchBody();
      const envelope = body.envelope as X811Envelope<PaymentPayload>;
      expect(envelope.type).toBe("x811/payment");
      expect(envelope.payload.tx_hash).toBe("0x" + "a".repeat(64));
    });
  });

  // -----------------------------------------------------------------------
  // heartbeat()
  // -----------------------------------------------------------------------

  describe("heartbeat()", () => {
    it("sends signed heartbeat to the correct endpoint", async () => {
      const kp = createTestKeyPair();
      const client = new X811Client({ serverUrl: SERVER_URL, keyPair: kp });
      const agentId = kp.did.slice("did:x811:".length);

      fetchMock.mockResolvedValueOnce(
        mockResponse({
          status: "ok",
          availability: "online",
          last_seen_at: new Date().toISOString(),
        }),
      );

      await client.heartbeat("online", 5, 60);

      // Verify URL
      const url = getLastFetchUrl();
      expect(url).toBe(`${SERVER_URL}/api/v1/agents/${agentId}/heartbeat`);

      // Verify body
      const body = getLastFetchBody();
      const envelope = body.envelope as X811Envelope<{
        availability: string;
        capacity: number;
        ttl: number;
      }>;
      expect(envelope.type).toBe("x811/heartbeat");
      expect(envelope.from).toBe(kp.did);
      expect(envelope.payload.availability).toBe("online");
      expect(envelope.payload.capacity).toBe(5);
      expect(envelope.payload.ttl).toBe(60);

      // Verify the envelope is properly signed
      const valid = verifyEnvelope(envelope, kp.signingKey.publicKey);
      expect(valid).toBe(true);
    });

    it("omits ttl from payload when not provided", async () => {
      const kp = createTestKeyPair();
      const client = new X811Client({ serverUrl: SERVER_URL, keyPair: kp });

      fetchMock.mockResolvedValueOnce(
        mockResponse({ status: "ok", availability: "busy" }),
      );

      await client.heartbeat("busy", 0);

      const body = getLastFetchBody();
      const envelope = body.envelope as X811Envelope<Record<string, unknown>>;
      expect(envelope.payload.availability).toBe("busy");
      expect(envelope.payload.capacity).toBe(0);
      expect(envelope.payload).not.toHaveProperty("ttl");
    });
  });

  // -----------------------------------------------------------------------
  // verifyInteraction()
  // -----------------------------------------------------------------------

  describe("verifyInteraction()", () => {
    it("returns proof data for a batched interaction", async () => {
      const client = new X811Client({ serverUrl: SERVER_URL });

      const mockProof = {
        interaction_hash: "abc123",
        included: true,
        batch_id: 1,
        merkle_root: "root-hash",
        proof: ["hash-a", "hash-b", "hash-c"],
        leaf_hash: "leaf-hash",
        batch_tx_hash: "0x" + "f".repeat(64),
        basescan_url: `https://basescan.org/tx/0x${"f".repeat(64)}`,
        batch_timestamp: "2025-01-01T00:00:00Z",
        batch_interaction_count: 10,
        batch_status: "confirmed",
      };

      fetchMock.mockResolvedValueOnce(mockResponse(mockProof));

      const result = await client.verifyInteraction("abc123");

      expect(getLastFetchUrl()).toBe(`${SERVER_URL}/api/v1/verify/abc123`);
      expect(result.included).toBe(true);
      expect(result.proof).toEqual(["hash-a", "hash-b", "hash-c"]);
      expect(result.batch_tx_hash).toBe("0x" + "f".repeat(64));
      expect(result.basescan_url).toBe(`https://basescan.org/tx/0x${"f".repeat(64)}`);
    });

    it("returns included: false for unbatched interactions", async () => {
      const client = new X811Client({ serverUrl: SERVER_URL });

      fetchMock.mockResolvedValueOnce(
        mockResponse({
          interaction_hash: "pending-hash",
          included: false,
          batch_id: null,
          merkle_root: null,
          proof: [],
          batch_tx_hash: null,
          basescan_url: null,
          batch_timestamp: null,
          batch_interaction_count: null,
          status: "pending",
          message: "Interaction has not been batched yet",
        }),
      );

      const result = await client.verifyInteraction("pending-hash");

      expect(result.included).toBe(false);
      expect(result.proof).toEqual([]);
      expect(result.batch_tx_hash).toBeUndefined();
      expect(result.basescan_url).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  describe("error handling", () => {
    it("throws X811Error on non-2xx response with structured error body", async () => {
      const client = new X811Client({ serverUrl: SERVER_URL });

      fetchMock.mockResolvedValueOnce(
        mockResponse(
          {
            error: {
              code: "X811-3001",
              message: "Agent not found",
              details: { id: "nonexistent" },
            },
          },
          404,
          "Not Found",
        ),
      );

      await expect(client.getAgentCard("nonexistent")).rejects.toThrow(X811Error);

      try {
        fetchMock.mockResolvedValueOnce(
          mockResponse(
            {
              error: {
                code: "X811-3001",
                message: "Agent not found",
                details: { id: "nonexistent" },
              },
            },
            404,
            "Not Found",
          ),
        );
        await client.getAgentCard("nonexistent");
      } catch (err) {
        const x811Err = err as X811Error;
        expect(x811Err.message).toBe("Agent not found");
        expect(x811Err.details).toEqual({ id: "nonexistent" });
      }
    });

    it("throws X811Error on non-2xx response without structured error body", async () => {
      const client = new X811Client({ serverUrl: SERVER_URL });

      const brokenResponse = {
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: async () => { throw new Error("Not JSON"); },
        headers: new Headers(),
        redirected: false,
        type: "basic" as ResponseType,
        url: "",
        clone: () => brokenResponse,
        body: null,
        bodyUsed: false,
        arrayBuffer: async () => new ArrayBuffer(0),
        blob: async () => new Blob(),
        formData: async () => new FormData(),
        text: async () => "Internal Server Error",
        bytes: async () => new Uint8Array(),
      } as Response;

      fetchMock.mockResolvedValueOnce(brokenResponse);

      await expect(client.getAgentCard("test")).rejects.toThrow(X811Error);
      try {
        fetchMock.mockResolvedValueOnce(brokenResponse);
        await client.getAgentCard("test");
      } catch (err) {
        const x811Err = err as X811Error;
        expect(x811Err.message).toBe("HTTP 500: Internal Server Error");
      }
    });

    it("throws X811Error on network failure", async () => {
      const client = new X811Client({ serverUrl: SERVER_URL });

      fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      await expect(client.getAgentCard("test")).rejects.toThrow(X811Error);
      try {
        fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
        await client.getAgentCard("test");
      } catch (err) {
        const x811Err = err as X811Error;
        expect(x811Err.message).toContain("ECONNREFUSED");
      }
    });

    it("throws X811Error with rate limit code on 429 response", async () => {
      const client = new X811Client({ serverUrl: SERVER_URL });

      fetchMock.mockResolvedValueOnce(
        mockResponse(
          {
            error: {
              code: "X811-9001",
              message: "Rate limit exceeded",
              details: { retry_after: 60 },
            },
          },
          429,
          "Too Many Requests",
        ),
      );

      await expect(client.discover()).rejects.toThrow("Rate limit exceeded");
    });
  });

  // -----------------------------------------------------------------------
  // Envelope structure validation
  // -----------------------------------------------------------------------

  describe("envelope structure", () => {
    it("sets version to 0.1.0 in all envelopes", async () => {
      const client = new X811Client({ serverUrl: SERVER_URL });

      fetchMock.mockResolvedValueOnce(
        mockResponse({ message_id: "m1", status: "ok" }),
      );

      await client.send("did:x811:target", "x811/request", {});

      const body = getLastFetchBody();
      const envelope = body.envelope as Record<string, unknown>;
      expect(envelope.version).toBe("0.1.0");
    });

    it("sets created and expires timestamps in ISO 8601 format", async () => {
      const client = new X811Client({ serverUrl: SERVER_URL });

      fetchMock.mockResolvedValueOnce(
        mockResponse({ message_id: "m1", status: "ok" }),
      );

      await client.send("did:x811:target", "x811/request", {});

      const body = getLastFetchBody();
      const envelope = body.envelope as Record<string, unknown>;

      // ISO 8601 validation
      const created = new Date(envelope.created as string);
      const expires = new Date(envelope.expires as string);
      expect(created.toISOString()).toBe(envelope.created);
      expect(expires.toISOString()).toBe(envelope.expires);

      // Expires should be after created (5 minute window)
      expect(expires.getTime()).toBeGreaterThan(created.getTime());
    });

    it("sets from to the client's DID in all envelopes", async () => {
      const kp = createTestKeyPair();
      const client = new X811Client({ serverUrl: SERVER_URL, keyPair: kp });

      fetchMock.mockResolvedValueOnce(
        mockResponse({ message_id: "m1", status: "ok" }),
      );

      await client.send("did:x811:target", "x811/request", {});

      const body = getLastFetchBody();
      const envelope = body.envelope as Record<string, unknown>;
      expect(envelope.from).toBe(kp.did);
    });
  });
});
