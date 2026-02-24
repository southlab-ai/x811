#!/usr/bin/env node

// ---------------------------------------------------------------------------
// Node.js v22+ enforcement — AgentKit SDK requires Node 22+
// ---------------------------------------------------------------------------
if (parseInt(process.versions.node) < 22) {
  process.stderr.write(
    "[x811] ERROR: Node.js v22+ required (found v" +
      process.versions.node +
      "). AgentKit SDK requires Node 22+.\n",
  );
  process.exit(1);
}

/**
 * x811 Protocol — MCP Server Plugin for Claude Code
 *
 * Wraps @x811/sdk as an MCP server so Claude Code can interact with the
 * x811 protocol: register agents, discover providers, negotiate tasks,
 * deliver results, verify, and settle payments (USDC on Base L2).
 *
 * Install in Claude Code settings:
 *   "mcpServers": {
 *     "x811": {
 *       "command": "node",
 *       "args": ["/path/to/packages/mcp-server/dist/index.js"],
 *       "env": { "X811_SERVER_URL": "https://api.x811.org" }
 *     }
 *   }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { X811Client, generateDID, createWalletAdapter } from "@x811/sdk";
import type { WalletAdapter, VerifyPayload } from "@x811/sdk";
import type { DIDKeyPair } from "@x811/core";
import { initBuffer, pushToBuffer, consumeFromBuffer, drainBuffer, bufferSize } from "./buffer-utils.js";
import { SSEClient } from "./sse-client.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SERVER_URL = process.env.X811_SERVER_URL || "https://api.x811.org";
const STATE_DIR = process.env.X811_STATE_DIR || join(homedir(), ".x811");
const KEYS_FILE = join(STATE_DIR, "keys.json");

// ---------------------------------------------------------------------------
// Key persistence — save DID keys so agent identity survives restarts
// ---------------------------------------------------------------------------

interface SerializedKeys {
  did: string;
  signingPublicKey: string;
  signingPrivateKey: string;
  encryptionPublicKey: string;
  encryptionPrivateKey: string;
}

function saveKeys(keyPair: DIDKeyPair): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  }
  const data: SerializedKeys = {
    did: keyPair.did,
    signingPublicKey: Buffer.from(keyPair.signingKey.publicKey).toString("hex"),
    signingPrivateKey: Buffer.from(keyPair.signingKey.privateKey).toString("hex"),
    encryptionPublicKey: Buffer.from(keyPair.encryptionKey.publicKey).toString("hex"),
    encryptionPrivateKey: Buffer.from(keyPair.encryptionKey.privateKey).toString("hex"),
  };
  writeFileSync(KEYS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function loadKeys(): DIDKeyPair | null {
  if (!existsSync(KEYS_FILE)) return null;
  try {
    const data: SerializedKeys = JSON.parse(readFileSync(KEYS_FILE, "utf-8"));
    return {
      did: data.did,
      signingKey: {
        publicKey: Uint8Array.from(Buffer.from(data.signingPublicKey, "hex")),
        privateKey: Uint8Array.from(Buffer.from(data.signingPrivateKey, "hex")),
      },
      encryptionKey: {
        publicKey: Uint8Array.from(Buffer.from(data.encryptionPublicKey, "hex")),
        privateKey: Uint8Array.from(Buffer.from(data.encryptionPrivateKey, "hex")),
      },
    };
  } catch {
    return null;
  }
}

function getOrCreateKeys(): DIDKeyPair {
  const existing = loadKeys();
  if (existing) return existing;

  const generated = generateDID();
  saveKeys(generated.keyPair);
  return generated.keyPair;
}

// ---------------------------------------------------------------------------
// Initialize client + wallet
// ---------------------------------------------------------------------------

const keyPair = getOrCreateKeys();
const client = new X811Client({ serverUrl: SERVER_URL, keyPair });

// Wallet adapter — initialized async, null means no wallet configured
let wallet: WalletAdapter | null = null;

let registered = false;
let agentName = "";

// Log startup info for diagnostics
process.stderr.write(`[x811] MCP server starting\n`);
process.stderr.write(`[x811]   DID: ${client.did}\n`);
process.stderr.write(`[x811]   Server: ${SERVER_URL}\n`);
process.stderr.write(`[x811]   State dir: ${STATE_DIR}\n`);
process.stderr.write(`[x811]   Keys file: ${KEYS_FILE}\n`);

// Initialize persistent message buffer from disk
initBuffer();

// SSE client — connects on startup, falls back to poll mode on failure
const sseClient = new SSEClient();

// Initialize wallet adapter (async — runs before server starts)
const walletInitPromise = createWalletAdapter().then((adapter: WalletAdapter | null) => {
  wallet = adapter;
  if (adapter) {
    process.stderr.write(`[x811:wallet] Ready: mode=${adapter.mode}, address=${adapter.address}\n`);
  }
}).catch((err: unknown) => {
  process.stderr.write(`[x811:wallet] Init error: ${err instanceof Error ? err.message : String(err)}\n`);
});

// Connect to SSE push stream (non-blocking — startup continues regardless)
// Wait for wallet init to complete first, then connect
walletInitPromise.finally(() => {
  sseClient.connect(
    SERVER_URL,
    client.did,
    () => "", // SSE uses ?did= query param auth, no auth header needed
    pushToBuffer,
  ).catch((err: unknown) => {
    process.stderr.write(`[x811:sse] connection error: ${err instanceof Error ? err.message : String(err)}\n`);
  });
});

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "x811",
  version: "0.1.0",
});

// ---------------------------------------------------------------------------
// Tool: x811_status — Show current agent info
// ---------------------------------------------------------------------------

server.tool(
  "x811_status",
  "Show your x811 agent identity: DID, server URL, registration status, and wallet address",
  {},
  async () => {
    const walletMode = wallet?.mode ?? "none";
    const walletAddress = wallet?.address ?? "N/A";
    let walletBalance: string | number = "N/A";
    if (wallet) {
      try { walletBalance = await wallet.getBalance(); } catch { walletBalance = "error"; }
    }
    const warnings: string[] = [];
    if (walletMode === "mock") warnings.push("WARNING: Using test wallet — no real USDC will be transferred");
    if (walletMode === "none") warnings.push("No wallet configured. Set CDP_API_KEY_* env vars for AgentKit or X811_PRIVATE_KEY for Ethers.");

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          did: client.did,
          server: SERVER_URL,
          registered,
          agent_name: agentName || "(not registered)",
          wallet_mode: walletMode,
          wallet_address: walletAddress,
          wallet_balance_usdc: walletBalance,
          keys_file: KEYS_FILE,
          ...(warnings.length > 0 ? { warnings } : {}),
        }, null, 2),
      }],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: x811_register — Register as an agent on the network
// ---------------------------------------------------------------------------

server.tool(
  "x811_register",
  "Register your AI agent on the x811 network with a name, description, and capabilities. This gives you a DID identity that other agents can discover.",
  {
    name: z.string().describe("Agent display name (e.g. 'CodeReviewer-Pro')"),
    description: z.string().optional().describe("What this agent does"),
    capabilities: z.array(z.object({
      name: z.string().describe("Capability identifier (e.g. 'code-review', 'financial-analysis')"),
      description: z.string().optional().describe("What this capability does"),
    })).optional().describe("List of capabilities this agent offers"),
    payment_address: z.string().optional().describe("Ethereum address for receiving USDC payments"),
  },
  async ({ name, description, capabilities, payment_address }) => {
    try {
      const card = await client.register({
        name,
        description,
        capabilities,
        payment_address,
      });
      registered = true;
      agentName = name;
      return {
        content: [{
          type: "text",
          text: `Agent registered successfully!\n\n${JSON.stringify(card, null, 2)}`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Registration failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: x811_discover — Find agents by capability
// ---------------------------------------------------------------------------

server.tool(
  "x811_discover",
  "Discover other AI agents on the x811 network by capability, trust score, or availability. Use this to find a provider for a task.",
  {
    capability: z.string().optional().describe("Filter by capability (e.g. 'financial-analysis')"),
    trust_min: z.number().optional().describe("Minimum trust score 0.0-1.0"),
    availability: z.string().optional().describe("Filter by availability: online, busy, offline"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ capability, trust_min, availability, limit }) => {
    try {
      const result = await client.discover({ capability, trust_min, availability, limit });
      return {
        content: [{
          type: "text",
          text: `Found ${result.total} agent(s):\n\n${JSON.stringify(result.agents, null, 2)}`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Discovery failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: x811_resolve — Resolve a DID to verify identity
// ---------------------------------------------------------------------------

server.tool(
  "x811_resolve",
  "Resolve a DID to retrieve and verify its DID Document. Use this to verify another agent's identity before interacting.",
  {
    did: z.string().describe("The DID to resolve (e.g. 'did:x811:abc-123')"),
  },
  async ({ did }) => {
    try {
      const resolved = await client.resolve(did);
      return {
        content: [{
          type: "text",
          text: `DID resolved successfully:\n\n${JSON.stringify(resolved.document, null, 2)}\n\nStatus: ${resolved.status}`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `DID resolution failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: x811_request — Send a task request to a provider
// ---------------------------------------------------------------------------

server.tool(
  "x811_request",
  "Send a signed task request to a provider agent. Starts the negotiation flow. The provider will respond with an offer.",
  {
    provider_did: z.string().describe("DID of the provider agent"),
    task_type: z.string().describe("Type of task (e.g. 'code-review', 'financial-analysis')"),
    parameters: z.record(z.unknown()).optional().describe("Task parameters as key-value pairs"),
    max_budget: z.number().describe("Maximum budget in USDC (e.g. 0.05)"),
    deadline: z.number().optional().describe("Deadline in seconds (default 60)"),
    acceptance_policy: z.enum(["auto", "human_approval", "threshold"]).optional()
      .describe("How to handle offers: auto (accept if within budget), human_approval (ask user), threshold"),
  },
  async ({ provider_did, task_type, parameters, max_budget, deadline, acceptance_policy }) => {
    try {
      const messageId = await client.request(provider_did, {
        task_type,
        parameters: parameters || {},
        max_budget,
        currency: "USDC",
        deadline: deadline || 60,
        acceptance_policy: acceptance_policy || "auto",
        idempotency_key: crypto.randomUUID(),
      });
      return {
        content: [{
          type: "text",
          text: `Request sent! message_id: ${messageId}\n\nNow poll for the provider's offer using x811_poll.`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Request failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: x811_poll — Check for incoming messages
// ---------------------------------------------------------------------------

server.tool(
  "x811_poll",
  "Poll for incoming messages (offers, requests, results, payments, etc.). Call this periodically to check for new messages from other agents.",
  {},
  async () => {
    try {
      // Include any buffered messages from autonomous tool polls
      const buffered = drainBuffer();
      const serverMessages = await client.poll();
      const allMessages = [
        ...buffered,
        ...serverMessages.map((m) => m as unknown as Record<string, unknown>),
      ];

      if (allMessages.length === 0) {
        return {
          content: [{ type: "text", text: "No new messages." }],
        };
      }
      return {
        content: [{
          type: "text",
          text: `${allMessages.length} message(s) received${buffered.length > 0 ? ` (${buffered.length} from buffer)` : ""}:\n\n${JSON.stringify(allMessages, null, 2)}`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Poll failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: x811_offer — Send an offer (as provider)
// ---------------------------------------------------------------------------

server.tool(
  "x811_offer",
  "Respond to a task request with a price offer. As a provider, use this after receiving a request via x811_poll.",
  {
    initiator_did: z.string().describe("DID of the initiator who sent the request"),
    request_id: z.string().describe("Interaction/request ID from the incoming request"),
    price: z.string().describe("Your price in USDC (e.g. '0.029')"),
    estimated_time: z.number().describe("Estimated completion time in seconds"),
    deliverables: z.array(z.string()).describe("List of deliverables"),
    terms: z.string().optional().describe("Additional terms or conditions"),
    expiry: z.number().optional().describe("Offer expiry in seconds (default 300)"),
    payment_address: z.string().optional().describe("Checksummed Ethereum address for receiving USDC payment (defaults to wallet address)"),
  },
  async ({ initiator_did, request_id, price, estimated_time, deliverables, terms, expiry, payment_address }) => {
    try {
      // Validate payment address — reject empty or zero address
      const resolvedAddress = payment_address || wallet?.address || "";
      if (!resolvedAddress || resolvedAddress === "0x" + "0".repeat(40)) {
        return {
          content: [{ type: "text" as const, text: "Offer failed: No payment address configured. Set X811_PRIVATE_KEY env var or provide payment_address parameter. Run x811_setup_wallet for instructions." }],
          isError: true,
        };
      }

      const priceNum = parseFloat(price);
      const protocolFee = (priceNum * 0.025).toFixed(6);
      const totalCost = (priceNum + parseFloat(protocolFee)).toFixed(6);

      const messageId = await client.offer(initiator_did, {
        request_id,
        price,
        protocol_fee: protocolFee,
        total_cost: totalCost,
        currency: "USDC",
        estimated_time,
        deliverables,
        terms,
        expiry: expiry || 300,
        payment_address: resolvedAddress,
      });
      return {
        content: [{
          type: "text",
          text: `Offer sent! message_id: ${messageId}\nPrice: $${price} USDC + $${protocolFee} protocol fee = $${totalCost} total`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Offer failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: x811_accept — Accept a provider's offer
// ---------------------------------------------------------------------------

server.tool(
  "x811_accept",
  "Accept a provider's offer. After receiving an offer via x811_poll, use this to agree to the terms and let the provider begin work.",
  {
    provider_did: z.string().describe("DID of the provider"),
    offer_id: z.string().describe("Interaction/offer ID"),
    offer_hash: z.string().describe("SHA-256 hash of the offer payload (from the offer message)"),
  },
  async ({ provider_did, offer_id, offer_hash }) => {
    try {
      const messageId = await client.accept(provider_did, {
        offer_id,
        offer_hash,
      });
      return {
        content: [{
          type: "text",
          text: `Offer accepted! message_id: ${messageId}\n\nThe provider will now execute the task. Poll for the result.`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Accept failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: x811_reject — Reject a provider's offer
// ---------------------------------------------------------------------------

server.tool(
  "x811_reject",
  "Reject a provider's offer. Use this if the price is too high, deadline too short, or trust too low.",
  {
    provider_did: z.string().describe("DID of the provider"),
    offer_id: z.string().describe("Interaction/offer ID"),
    reason: z.enum(["PRICE_TOO_HIGH", "DEADLINE_TOO_SHORT", "TRUST_TOO_LOW", "POLICY_REJECTED", "OTHER"])
      .describe("Reason for rejection"),
  },
  async ({ provider_did, offer_id, reason }) => {
    try {
      const messageId = await client.reject(provider_did, {
        offer_id,
        reason,
        code: reason,
      });
      return {
        content: [{
          type: "text",
          text: `Offer rejected. message_id: ${messageId}`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Reject failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: x811_deliver_result — Deliver task result (as provider)
// ---------------------------------------------------------------------------

server.tool(
  "x811_deliver_result",
  "Deliver the completed task result to the initiator. As a provider, use this after finishing the work.",
  {
    initiator_did: z.string().describe("DID of the initiator"),
    request_id: z.string().describe("Interaction/request ID"),
    offer_id: z.string().describe("Interaction/offer ID"),
    content: z.string().describe("The result content (JSON string or text)"),
    content_type: z.string().optional().describe("MIME type (default 'application/json')"),
    execution_time_ms: z.number().describe("How long execution took in milliseconds"),
    methodology: z.string().optional().describe("Methodology used"),
  },
  async ({ initiator_did, request_id, offer_id, content, content_type, execution_time_ms, methodology }) => {
    try {
      const { hashPayload } = await import("@x811/core");
      const resultHash = hashPayload(content);

      const messageId = await client.deliverResult(initiator_did, {
        request_id,
        offer_id,
        content,
        content_type: content_type || "application/json",
        result_hash: resultHash,
        execution_time_ms,
        methodology,
      });
      return {
        content: [{
          type: "text",
          text: `Result delivered! message_id: ${messageId}\nResult hash: ${resultHash}`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Delivery failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: x811_verify — Verify a delivered result
// ---------------------------------------------------------------------------

server.tool(
  "x811_verify",
  "Verify a task result from the provider. Confirms the result is valid and signals approval before payment.",
  {
    provider_did: z.string().describe("DID of the provider"),
    interaction_id: z.string().describe("Interaction ID to verify"),
    result_hash: z.string().optional().describe("SHA-256 hash of the result (from the result message)"),
    verified: z.boolean().optional().describe("true = result accepted; false = disputed (default: true)"),
    dispute_reason: z.string().optional().describe("Human-readable dispute reason (required if verified=false)"),
    dispute_code: z.enum(["WRONG_RESULT", "INCOMPLETE", "TIMEOUT", "QUALITY", "OTHER"]).optional()
      .describe("Machine-readable dispute code (required if verified=false)"),
  },
  async ({ provider_did, interaction_id, result_hash, verified, dispute_reason, dispute_code }) => {
    try {
      const isVerified = verified ?? true;
      const verifyPayload: VerifyPayload = {
        request_id: interaction_id,
        offer_id: interaction_id,
        result_hash: result_hash || "",
        verified: isVerified,
        ...(dispute_reason ? { dispute_reason } : {}),
        ...(dispute_code ? { dispute_code } : {}),
      };

      const sendResult = await client.send(provider_did, "x811/verify", verifyPayload);
      const messageId = sendResult.message_id;
      return {
        content: [{
          type: "text" as const,
          text: `Verification sent! message_id: ${messageId}\nverified: ${isVerified}${!isVerified ? `\ndispute: ${dispute_code} — ${dispute_reason}` : ""}\n\nNow send payment with x811_pay.`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Verify failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: x811_pay — Send payment
// ---------------------------------------------------------------------------

server.tool(
  "x811_pay",
  "Send USDC payment to the provider after verifying their work. Completes the negotiation cycle.",
  {
    provider_did: z.string().describe("DID of the provider"),
    request_id: z.string().describe("Interaction/request ID"),
    offer_id: z.string().describe("Interaction/offer ID"),
    amount: z.number().describe("Amount in USDC to pay"),
    payee_address: z.string().describe("Provider's Ethereum address"),
  },
  async ({ provider_did, request_id, offer_id, amount, payee_address }) => {
    if (!wallet) {
      return { content: [{ type: "text" as const, text: "No wallet configured. Set CDP_API_KEY_* env vars for AgentKit or X811_PRIVATE_KEY for Ethers. Run x811_setup_wallet for instructions." }], isError: true };
    }
    try {
      // Calculate fee split: 2.5% protocol fee
      const providerAmount = amount;
      const protocolFee = parseFloat((amount * 0.025).toFixed(6));
      const treasuryAddress = process.env.X811_TREASURY_ADDRESS;

      // Transfer 1: Pay provider
      const paymentResult = await wallet.pay({
        to_address: payee_address,
        amount: String(providerAmount),
        providerDid: provider_did,
        requestId: request_id,
        offerId: offer_id,
      });

      // Transfer 2: Pay protocol fee to treasury (if configured and fee > 0)
      let feeTxHash: string | undefined;
      if (treasuryAddress && protocolFee > 0) {
        try {
          const feeResult = await wallet.pay({
            to_address: treasuryAddress,
            amount: String(protocolFee),
            providerDid: "x811-treasury",
            requestId: request_id,
            offerId: offer_id,
          });
          feeTxHash = feeResult.tx_hash;
          process.stderr.write(`[x811:pay] Protocol fee $${protocolFee} sent to treasury: ${feeTxHash}\n`);
        } catch (feeErr) {
          process.stderr.write(`[x811:pay] Protocol fee transfer failed (non-fatal): ${feeErr instanceof Error ? feeErr.message : String(feeErr)}\n`);
        }
      }

      // Report total_cost (price + protocol fee) to server — server validates against offer's total_cost
      const totalReported = amount + protocolFee;
      const messageId = await client.pay(provider_did, {
        request_id,
        offer_id,
        tx_hash: paymentResult.tx_hash,
        amount: String(totalReported),
        currency: "USDC",
        network: "base",
        payer_address: paymentResult.payer_address,
        payee_address: paymentResult.payee_address,
        fee_tx_hash: feeTxHash,
      });

      const feeInfo = feeTxHash ? `\nfee_tx_hash: ${feeTxHash} ($${protocolFee} protocol fee)` : (treasuryAddress ? "\nfee: failed (logged, non-fatal)" : "\nfee: skipped (no treasury configured)");
      return {
        content: [{
          type: "text",
          text: `Payment sent! $${totalReported} USDC (provider: $${amount}, fee: $${protocolFee})\nmessage_id: ${messageId}\ntx_hash: ${paymentResult.tx_hash}${feeInfo}`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Payment failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: x811_heartbeat — Signal availability
// ---------------------------------------------------------------------------

server.tool(
  "x811_heartbeat",
  "Send a heartbeat to signal your agent is online and available for work. Call this after registering.",
  {
    availability: z.enum(["online", "busy", "offline"]).describe("Current availability status"),
    capacity: z.number().optional().describe("Number of concurrent tasks you can handle (default 5)"),
  },
  async ({ availability, capacity }) => {
    try {
      await client.heartbeat(availability, capacity ?? 5);
      return {
        content: [{
          type: "text",
          text: `Heartbeat sent: ${availability}, capacity: ${capacity ?? 5}`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Heartbeat failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: x811_verify_onchain — Verify interaction on-chain
// ---------------------------------------------------------------------------

server.tool(
  "x811_verify_onchain",
  "Verify that an interaction has been recorded on-chain via Merkle proof on Base L2.",
  {
    interaction_hash: z.string().describe("The interaction hash to verify"),
  },
  async ({ interaction_hash }) => {
    try {
      const result = await client.verifyInteraction(interaction_hash);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Verification failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: x811_get_agent_card — Get detailed agent info
// ---------------------------------------------------------------------------

server.tool(
  "x811_get_agent_card",
  "Get the full Agent Card for a specific agent, including capabilities, trust score, and payment info.",
  {
    agent_id: z.string().describe("Agent UUID (from discovery results)"),
  },
  async ({ agent_id }) => {
    try {
      const card = await client.getAgentCard(agent_id);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(card, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Internal: polling helper
// ---------------------------------------------------------------------------

async function pollForMessage(
  type: string,
  timeoutMs: number = 60_000,
  intervalMs: number = 10_000,
): Promise<{ message: Record<string, unknown> | null; all: unknown[] }> {
  const deadline = Date.now() + timeoutMs;
  const collected: unknown[] = [];
  const remainingSec = () => Math.round((deadline - Date.now()) / 1000);
  process.stderr.write(`[x811] pollForMessage: waiting for "${type}" (timeout: ${timeoutMs / 1000}s, buffer: ${bufferSize()})\n`);

  while (Date.now() < deadline) {
    // Step 1: Check persistent buffer FIRST (messages from previous polls)
    const buffered = consumeFromBuffer(type);
    if (buffered) {
      process.stderr.write(`[x811] pollForMessage: MATCHED "${type}" from LOCAL BUFFER!\n`);
      return { message: buffered, all: [buffered] };
    }

    // Step 2: Poll server for new messages
    try {
      const messages = await client.poll();
      if (messages.length > 0) {
        process.stderr.write(`[x811] poll: ${messages.length} message(s) received — types: ${messages.map((m) => (m as unknown as Record<string, unknown>).type).join(", ")}\n`);
      }

      let matched: Record<string, unknown> | null = null;
      for (const m of messages) {
        const msg = m as unknown as Record<string, unknown>;
        if (!matched && msg.type === type) {
          matched = msg;
        } else {
          // Buffer ALL non-matching messages to prevent loss (persisted to disk)
          pushToBuffer(msg);
        }
      }

      if (matched) {
        process.stderr.write(`[x811] pollForMessage: MATCHED "${type}" from SERVER!\n`);
        return { message: matched, all: messages };
      }
    } catch (err) {
      process.stderr.write(`[x811] poll error: ${err instanceof Error ? err.message : String(err)}\n`);
    }

    process.stderr.write(`[x811] poll: no "${type}" yet, ${remainingSec()}s remaining, buffer: ${bufferSize()}\n`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  process.stderr.write(`[x811] pollForMessage: TIMEOUT waiting for "${type}" (buffer has ${bufferSize()} unmatched)\n`);
  return { message: null, all: collected };
}

// ---------------------------------------------------------------------------
// Tool: x811_provide_service — AUTONOMOUS provider flow
// ---------------------------------------------------------------------------

server.tool(
  "x811_provide_service",
  `AUTONOMOUS provider mode. Registers your agent, goes online, waits for a task request (polls automatically), sends an offer, waits for acceptance, then returns the task details so you can do the work. After you do the work, call x811_deliver_result. Zero human intervention needed for the protocol steps.`,
  {
    name: z.string().describe("Your agent name (e.g. 'CodeReviewer-Pro')"),
    capability: z.string().describe("Capability to offer (e.g. 'code-review')"),
    description: z.string().optional().describe("What your agent does"),
    price: z.string().optional().describe("Price in USDC (default: 90% of requester's max budget)"),
    timeout_seconds: z.number().optional().describe("How long to wait for a request (default 120)"),
  },
  async ({ name, capability, description, price, timeout_seconds }) => {
    const timeout = (timeout_seconds || 120) * 1000;
    const log: string[] = [];

    try {
      process.stderr.write(`[x811:provider] Starting autonomous provider flow: "${name}" (${capability})\n`);

      // Step 1: Register (handle "already exists" gracefully)
      log.push(`[1/5] Registering as "${name}" with capability "${capability}"...`);
      try {
        await client.register({
          name,
          description,
          capabilities: [{ name: capability, description }],
        });
        log.push(`  ✓ Registered. DID: ${client.did}`);
        process.stderr.write(`[x811:provider] Registered. DID: ${client.did}\n`);
      } catch (regErr) {
        const msg = regErr instanceof Error ? regErr.message : String(regErr);
        if (msg.includes("already exists")) {
          log.push(`  ✓ Already registered. DID: ${client.did} (reusing existing identity)`);
          process.stderr.write(`[x811:provider] Reusing existing registration. DID: ${client.did}\n`);
        } else {
          throw regErr;
        }
      }
      registered = true;
      agentName = name;

      // Step 2: Heartbeat
      log.push(`[2/5] Going online...`);
      await client.heartbeat("online", 5);
      log.push(`  ✓ Online, capacity: 5`);
      process.stderr.write(`[x811:provider] Heartbeat sent: online, capacity: 5\n`);

      // Step 3: Wait for request
      log.push(`[3/5] Waiting for incoming task request (timeout: ${timeout / 1000}s)...`);
      const requestResult = await pollForMessage("x811/request", timeout);

      if (!requestResult.message) {
        log.push(`  ✗ No request received within timeout.`);
        return { content: [{ type: "text" as const, text: log.join("\n") }] };
      }

      const requestMsg = requestResult.message;
      const requestPayload = requestMsg.payload as Record<string, unknown>;
      const initiatorDid = requestMsg.from as string;
      const interactionId = requestPayload.idempotency_key as string || crypto.randomUUID();
      process.stderr.write(`[x811:provider] Request received! from=${initiatorDid} task=${requestPayload.task_type} budget=${requestPayload.max_budget}\n`);
      log.push(`  ✓ Request received from ${initiatorDid}`);
      log.push(`    Task: ${requestPayload.task_type}, Budget: $${requestPayload.max_budget} USDC`);

      // Step 4: Send offer
      const offerPrice = price || String(Number(requestPayload.max_budget) * 0.9);
      const priceNum = parseFloat(offerPrice);
      const protocolFee = (priceNum * 0.025).toFixed(6);
      const totalCost = (priceNum + parseFloat(protocolFee)).toFixed(6);

      // Validate payment address — reject empty or zero address
      const providerAddress = wallet?.address ?? "";
      if (!providerAddress || providerAddress === "0x" + "0".repeat(40)) {
        log.push(`  ✗ No payment address configured. Set X811_PRIVATE_KEY env var. Run x811_setup_wallet for instructions.`);
        return { content: [{ type: "text" as const, text: log.join("\n") }], isError: true };
      }

      log.push(`[4/5] Sending offer: $${offerPrice} USDC (+ $${protocolFee} fee)...`);
      process.stderr.write(`[x811:provider] Sending offer to ${initiatorDid}: $${offerPrice} + $${protocolFee} fee = $${totalCost}\n`);
      await client.offer(initiatorDid, {
        request_id: interactionId,
        price: offerPrice,
        protocol_fee: protocolFee,
        total_cost: totalCost,
        currency: "USDC",
        estimated_time: 30,
        deliverables: [`${capability} result`],
        expiry: 300,
        payment_address: providerAddress,
      });
      log.push(`  ✓ Offer sent`);
      process.stderr.write(`[x811:provider] Offer sent successfully!\n`);

      // Step 5: Wait for accept
      log.push(`[5/5] Waiting for acceptance...`);
      const acceptResult = await pollForMessage("x811/accept", 60_000);

      if (!acceptResult.message) {
        // Check buffer and collected messages for a reject
        const bufferedMsgs = drainBuffer();
        const allMsgs = [...bufferedMsgs, ...acceptResult.all.map((m) => m as Record<string, unknown>)];
        const rejectMsg = allMsgs.find(
          (m) => m.type === "x811/reject"
        );
        if (rejectMsg) {
          log.push(`  ✗ Offer REJECTED: ${JSON.stringify(rejectMsg.payload)}`);
          process.stderr.write(`[x811:provider] Offer was REJECTED\n`);
          return { content: [{ type: "text" as const, text: log.join("\n") }] };
        }
        log.push(`  ✗ No acceptance received within timeout.`);
        process.stderr.write(`[x811:provider] Timed out waiting for accept\n`);
        return { content: [{ type: "text" as const, text: log.join("\n") }] };
      }

      log.push(`  ✓ Offer ACCEPTED!`);
      process.stderr.write(`[x811:provider] Offer ACCEPTED! Task is ready.\n`);
      log.push(``);
      log.push(`═══ TASK READY ═══`);
      log.push(`Initiator DID: ${initiatorDid}`);
      log.push(`Request ID: ${interactionId}`);
      log.push(`Offer ID: ${interactionId}`);
      log.push(`Task: ${requestPayload.task_type}`);
      log.push(`Parameters: ${JSON.stringify(requestPayload.parameters)}`);
      log.push(`Price: $${totalCost} USDC`);
      log.push(``);
      log.push(`NOW: Do the work and call x811_deliver_result with:`);
      log.push(`  initiator_did: "${initiatorDid}"`);
      log.push(`  request_id: "${interactionId}"`);
      log.push(`  offer_id: "${interactionId}"`);

      return { content: [{ type: "text" as const, text: log.join("\n") }] };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[x811:provider] ERROR: ${errMsg}\n`);
      log.push(`ERROR: ${errMsg}`);
      return { content: [{ type: "text" as const, text: log.join("\n") }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: x811_request_and_pay — AUTONOMOUS initiator flow
// ---------------------------------------------------------------------------

server.tool(
  "x811_request_and_pay",
  `AUTONOMOUS initiator mode. Discovers a provider, sends a task request, waits for offer, auto-accepts if within budget, waits for the result, verifies it, and pays — all in one call. Zero human intervention. Returns the provider's delivered result.`,
  {
    name: z.string().describe("Your agent name (e.g. 'DataAnalyst-Alpha')"),
    capability: z.string().describe("Capability to request (e.g. 'code-review')"),
    task_description: z.string().optional().describe("Description of the task for the provider"),
    parameters: z.record(z.unknown()).optional().describe("Task parameters as key-value pairs"),
    max_budget: z.number().describe("Maximum budget in USDC (e.g. 0.05)"),
    timeout_seconds: z.number().optional().describe("How long to wait for each step (default 120)"),
  },
  async ({ name, capability, task_description, parameters, max_budget, timeout_seconds }) => {
    const timeout = (timeout_seconds || 120) * 1000;
    const log: string[] = [];

    try {
      process.stderr.write(`[x811:initiator] Starting autonomous initiator flow: "${name}" seeking "${capability}"\n`);

      // Step 1: Register (handle "already exists" gracefully)
      log.push(`[1/8] Registering as "${name}"...`);
      try {
        await client.register({
          name,
          description: task_description || `Initiator seeking ${capability}`,
          capabilities: [],
        });
        log.push(`  ✓ Registered. DID: ${client.did}`);
        process.stderr.write(`[x811:initiator] Registered. DID: ${client.did}\n`);
      } catch (regErr) {
        const msg = regErr instanceof Error ? regErr.message : String(regErr);
        if (msg.includes("already exists")) {
          log.push(`  ✓ Already registered. DID: ${client.did} (reusing existing identity)`);
          process.stderr.write(`[x811:initiator] Reusing existing registration. DID: ${client.did}\n`);
        } else {
          throw regErr;
        }
      }
      registered = true;
      agentName = name;

      // Step 2: Discover (with retry — provider may not be registered yet)
      log.push(`[2/8] Discovering providers with capability "${capability}"...`);
      let discovery: { agents: unknown[]; total: number } = { agents: [], total: 0 };
      const discoveryDeadline = Date.now() + timeout;
      while (Date.now() < discoveryDeadline) {
        discovery = await client.discover({ capability });
        if (discovery.agents.length > 0) break;
        process.stderr.write(`[x811:initiator] No providers found yet, retrying in 10s...\n`);
        await new Promise((r) => setTimeout(r, 10_000));
      }
      if (discovery.agents.length === 0) {
        log.push(`  ✗ No providers found within timeout. Make sure a provider is registered and online.`);
        return { content: [{ type: "text" as const, text: log.join("\n") }] };
      }
      // discovery() returns AgentDiscoveryResult (flat: {id, did, name, trust_score})
      // NOT AgentCard (nested: {x811: {did, trust_score}}) — cast to access real fields
      const provider = discovery.agents[0] as unknown as Record<string, unknown>;
      const providerDid = provider.did as string;
      const providerName = provider.name as string;
      const providerTrust = provider.trust_score as number;
      log.push(`  ✓ Found: ${providerName} (trust: ${providerTrust}, DID: ${providerDid})`);
      process.stderr.write(`[x811:initiator] Discovered provider: ${providerName} DID=${providerDid} trust=${providerTrust}\n`);

      // Step 3: Send request
      log.push(`[3/8] Sending task request (budget: $${max_budget} USDC)...`);
      const idempotencyKey = crypto.randomUUID();
      process.stderr.write(`[x811:initiator] Sending request to ${providerDid} task=${capability} budget=${max_budget}\n`);
      await client.request(providerDid, {
        task_type: capability,
        parameters: { ...parameters, description: task_description },
        max_budget,
        currency: "USDC",
        deadline: 60,
        acceptance_policy: "auto",
        idempotency_key: idempotencyKey,
      });
      log.push(`  ✓ Request sent`);
      process.stderr.write(`[x811:initiator] Request sent successfully!\n`);

      // Step 4: Wait for offer
      log.push(`[4/8] Waiting for provider's offer...`);
      process.stderr.write(`[x811:initiator] Waiting for offer from provider...\n`);
      const offerResult = await pollForMessage("x811/offer", timeout);
      if (!offerResult.message) {
        log.push(`  ✗ No offer received within timeout.`);
        process.stderr.write(`[x811:initiator] TIMEOUT waiting for offer\n`);
        return { content: [{ type: "text" as const, text: log.join("\n") }] };
      }
      const offerPayload = offerResult.message.payload as Record<string, unknown>;
      const totalCost = parseFloat(offerPayload.total_cost as string || offerPayload.price as string);
      log.push(`  ✓ Offer received: $${offerPayload.price} + $${offerPayload.protocol_fee} fee = $${totalCost} USDC`);
      process.stderr.write(`[x811:initiator] Offer received! price=${offerPayload.price} total=${totalCost}\n`);

      // Step 5: Auto-accept (if within budget)
      if (totalCost > max_budget) {
        log.push(`  ✗ Total cost $${totalCost} exceeds budget $${max_budget}. Rejecting.`);
        await client.reject(providerDid, {
          offer_id: offerPayload.request_id as string,
          reason: "PRICE_TOO_HIGH",
          code: "PRICE_TOO_HIGH",
        });
        return { content: [{ type: "text" as const, text: log.join("\n") }] };
      }

      log.push(`[5/8] Auto-accepting offer ($${totalCost} <= $${max_budget} budget)...`);
      process.stderr.write(`[x811:initiator] Auto-accepting offer ($${totalCost} <= $${max_budget} budget)\n`);
      const { hashPayload } = await import("@x811/core");
      const offerHash = hashPayload(offerPayload);
      await client.accept(providerDid, {
        offer_id: offerPayload.request_id as string,
        offer_hash: offerHash,
      });
      log.push(`  ✓ Offer accepted`);
      process.stderr.write(`[x811:initiator] Offer accepted!\n`);

      // Step 6: Wait for result
      log.push(`[6/8] Waiting for provider to deliver result...`);
      process.stderr.write(`[x811:initiator] Waiting for provider to deliver result...\n`);
      const resultResult = await pollForMessage("x811/result", timeout);
      if (!resultResult.message) {
        log.push(`  ✗ No result received within timeout.`);
        process.stderr.write(`[x811:initiator] TIMEOUT waiting for result\n`);
        return { content: [{ type: "text" as const, text: log.join("\n") }] };
      }
      const resultPayload = resultResult.message.payload as Record<string, unknown>;
      log.push(`  ✓ Result received! Hash: ${resultPayload.result_hash}`);
      process.stderr.write(`[x811:initiator] Result received! hash=${resultPayload.result_hash}\n`);

      // Step 7: Verify — send with correct payload format for negotiation service
      log.push(`[7/8] Verifying result...`);
      const interactionId = offerPayload.request_id as string;
      const autoVerifyPayload: VerifyPayload = {
        request_id: interactionId,
        offer_id: interactionId,
        result_hash: resultPayload.result_hash as string,
        verified: true,
      };
      await client.send(providerDid, "x811/verify", autoVerifyPayload);
      log.push(`  ✓ Verification sent`);

      // Step 8: Pay — extract provider's payment address from offer, with fee split
      if (!wallet) {
        log.push(`  ✗ No wallet configured. Set CDP_API_KEY_* env vars for AgentKit or X811_PRIVATE_KEY for Ethers.`);
        return { content: [{ type: "text" as const, text: log.join("\n") }], isError: true };
      }
      let payToAddress = (offerPayload.payment_address as string) || "";
      if (!payToAddress || payToAddress === "0x" + "0".repeat(40)) {
        // Fallback: try to get from agent card
        try {
          const agentCard = await client.getAgentCard(providerDid);
          const cardAddress = (agentCard as unknown as Record<string, unknown>)?.payment_address as string;
          if (cardAddress && cardAddress !== "0x" + "0".repeat(40)) {
            payToAddress = cardAddress;
            log.push(`  -> Using payment address from agent card: ${cardAddress}`);
          } else {
            log.push(`  ✗ Provider has no payment address registered (X811-5002)`);
            return { content: [{ type: "text" as const, text: log.join("\n") }], isError: true };
          }
        } catch {
          log.push(`  ✗ Cannot resolve provider payment address (X811-5002). Provider must register with a payment_address.`);
          return { content: [{ type: "text" as const, text: log.join("\n") }], isError: true };
        }
      }

      // Fee split: provider payment + protocol fee
      const providerPayment = offerPayload.price as string || String(totalCost);
      const protocolFeeStr = offerPayload.protocol_fee as string || "0";
      const protocolFee = parseFloat(protocolFeeStr);
      const treasuryAddress = process.env.X811_TREASURY_ADDRESS;

      log.push(`[8/8] Paying $${providerPayment} USDC to provider ${payToAddress}...`);

      // Transfer 1: Pay provider
      const paymentResult = await wallet.pay({
        to_address: payToAddress,
        amount: providerPayment,
        providerDid,
        requestId: interactionId,
        offerId: interactionId,
      });
      log.push(`  ✓ Provider payment sent! tx: ${paymentResult.tx_hash}`);

      // Transfer 2: Pay protocol fee to treasury (if configured and fee > 0)
      let feeTxHash: string | undefined;
      if (treasuryAddress && protocolFee > 0) {
        try {
          const feeResult = await wallet.pay({
            to_address: treasuryAddress,
            amount: protocolFeeStr,
            providerDid: "x811-treasury",
            requestId: interactionId,
            offerId: interactionId,
          });
          feeTxHash = feeResult.tx_hash;
          log.push(`  ✓ Protocol fee $${protocolFeeStr} sent to treasury: ${feeTxHash}`);
          process.stderr.write(`[x811:initiator] Protocol fee $${protocolFeeStr} sent to treasury: ${feeTxHash}\n`);
        } catch (feeErr) {
          log.push(`  ! Protocol fee transfer failed (non-fatal): ${feeErr instanceof Error ? feeErr.message : String(feeErr)}`);
          process.stderr.write(`[x811:initiator] Protocol fee transfer failed (non-fatal): ${feeErr instanceof Error ? feeErr.message : String(feeErr)}\n`);
        }
      } else if (!treasuryAddress && protocolFee > 0) {
        log.push(`  ! Protocol fee $${protocolFeeStr} skipped (no X811_TREASURY_ADDRESS configured)`);
      }

      // Report total_cost (price + protocol fee) to server — server validates against offer's total_cost
      await client.pay(providerDid, {
        request_id: interactionId,
        offer_id: interactionId,
        tx_hash: paymentResult.tx_hash,
        amount: String(totalCost),
        currency: "USDC",
        network: "base",
        payer_address: paymentResult.payer_address,
        payee_address: paymentResult.payee_address,
        fee_tx_hash: feeTxHash,
      });

      // Summary
      log.push(``);
      log.push(`═══ NEGOTIATION COMPLETE ═══`);
      log.push(`Provider: ${providerName} (${providerDid})`);
      log.push(`Paid: $${totalCost} USDC`);
      log.push(`Result:`);

      let resultContent = resultPayload.content as string;
      try {
        resultContent = JSON.stringify(JSON.parse(resultContent), null, 2);
      } catch { /* not JSON, use as-is */ }
      log.push(resultContent);

      return { content: [{ type: "text" as const, text: log.join("\n") }] };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[x811:initiator] ERROR: ${errMsg}\n`);
      if (err instanceof Error && err.stack) process.stderr.write(`[x811:initiator] ${err.stack}\n`);
      log.push(`ERROR: ${errMsg}`);
      return { content: [{ type: "text" as const, text: log.join("\n") }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: x811_setup_wallet — Wallet configuration diagnostics
// ---------------------------------------------------------------------------

server.tool(
  "x811_setup_wallet",
  "Check wallet configuration and get setup instructions for real USDC payments.",
  {},
  async () => {
    const walletMode = wallet?.mode ?? "none";
    const walletAddress = wallet?.address ?? "N/A";
    let walletBalance: string | number = "N/A";
    if (wallet) {
      try { walletBalance = await wallet.getBalance(); } catch { walletBalance = "error"; }
    }

    // Check env var status (mask values for security)
    const envVars: Record<string, string> = {};
    const secretKeys = ["CDP_API_KEY_SECRET", "CDP_WALLET_SECRET", "X811_PRIVATE_KEY"];
    const envChecks = ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET", "X811_PRIVATE_KEY", "X811_TREASURY_ADDRESS"];

    for (const key of envChecks) {
      const val = process.env[key];
      if (!val) {
        envVars[key] = "missing";
      } else if (secretKeys.includes(key)) {
        envVars[key] = "set (***)";
      } else if (val.length > 6) {
        envVars[key] = `set (${val.slice(0, 3)}...${val.slice(-3)})`;
      } else {
        envVars[key] = "set";
      }
    }

    const setupInstructions = walletMode === "none"
      ? [
          "No wallet is configured. To enable real USDC payments, choose one option:",
          "",
          "Option 1: Coinbase AgentKit (recommended — gasless transactions)",
          "  Set these env vars in your MCP server config:",
          "    CDP_API_KEY_ID=<your-cdp-key-id>",
          "    CDP_API_KEY_SECRET=<your-cdp-key-secret>",
          "    CDP_WALLET_SECRET=<your-wallet-secret>",
          "  Get credentials at: https://portal.cdp.coinbase.com/",
          "",
          "Option 2: Raw private key (Ethers — you pay gas in ETH)",
          "  Set this env var in your MCP server config:",
          "    X811_PRIVATE_KEY=<your-hex-private-key>",
          "",
          "Optional: Set X811_TREASURY_ADDRESS for protocol fee collection.",
          "",
          "After setting env vars, restart Claude Code to pick up changes.",
        ].join("\n")
      : undefined;

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          wallet_mode: walletMode,
          wallet_address: walletAddress,
          wallet_balance_usdc: walletBalance,
          node_version: process.versions.node,
          env_vars: envVars,
          ...(setupInstructions ? { setup_instructions: setupInstructions } : {}),
        }, null, 2),
      }],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: x811_connection_status — Show SSE/poll transport state
// ---------------------------------------------------------------------------

server.tool(
  "x811_connection_status",
  "Show transport mode and connection state",
  {},
  async () => ({
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        transport: sseClient.getMode(),
        last_message_at: sseClient.getLastMessageAt() ?? "never",
        buffer_size: bufferSize(),
        server_url: SERVER_URL,
      }, null, 2),
    }],
  }),
);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`x811 MCP server error: ${err}\n`);
  process.exit(1);
});
