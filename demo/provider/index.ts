/**
 * x811 Protocol — Provider Agent (Demo)
 *
 * Implements the provider's perspective of the 10-step demo:
 *
 *   Registration:  Register as "FinAnalyst-Pro" with capability "financial-analysis"
 *   Heartbeat:     Signal online status with capacity
 *   Step 4:        NEGOTIATION — receive request, create offer
 *   Step 6:        EXECUTION   — execute AAPL financial analysis (mock)
 *   Step 7:        DELIVERY    — send result with analysis data and result_hash
 *   Payment:       Wait for payment confirmation
 *
 * Run with: npx tsx demo/provider/index.ts
 */

import {
  type X811Envelope,
  type RequestPayload,
  hashPayload,
  generateDID,
} from "@x811/core";
import { X811Client } from "@x811/sdk";

// ---------------------------------------------------------------------------
// ANSI colors
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const MAGENTA = "\x1b[35m";

function log(step: number | string, label: string, msg: string): void {
  const prefix = typeof step === "number"
    ? `${BOLD}${BLUE}[STEP ${step}/10]${RESET}`
    : `${BOLD}${BLUE}[${step}]${RESET}`;
  const tag = `${BOLD}${YELLOW}${label}${RESET}`;
  console.log(`${prefix} ${tag}: ${msg}`);
}

function logDetail(msg: string): void {
  console.log(`  ${DIM}${msg}${RESET}`);
}

function logSuccess(msg: string): void {
  console.log(`  ${GREEN}✓ ${msg}${RESET}`);
}

function logError(msg: string): void {
  console.error(`  ${RED}✗ ${msg}${RESET}`);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:3811";
const CAPABILITY = "financial-analysis";
const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Mock AAPL Analysis
// ---------------------------------------------------------------------------

const MOCK_AAPL_ANALYSIS = {
  ticker: "AAPL",
  recommendation: "BUY",
  confidence: 0.87,
  target_price: 245.0,
  current_price: 228.5,
  analysis: {
    revenue_growth: "8.2% YoY",
    pe_ratio: 28.5,
    market_cap: "3.5T",
    key_catalysts: [
      "AI integration",
      "Services revenue growth",
      "Vision Pro adoption",
    ],
    risks: [
      "China exposure",
      "Antitrust regulation",
      "Hardware cycle dependency",
    ],
  },
  methodology: "Fundamental analysis with DCF valuation model",
};

// ---------------------------------------------------------------------------
// Protocol fee rate (2.5%)
// ---------------------------------------------------------------------------

const PROTOCOL_FEE_RATE = 0.025;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollForMessage<T>(
  client: X811Client,
  expectedType: string,
  timeoutMs: number = POLL_TIMEOUT_MS,
): Promise<X811Envelope<T>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const messages = await client.poll();
    for (const msg of messages) {
      if (msg.type === expectedType) {
        return msg as X811Envelope<T>;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timeout waiting for message type "${expectedType}" after ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Main demo flow
// ---------------------------------------------------------------------------

export async function runProvider(): Promise<void> {
  console.log(`\n${BOLD}${MAGENTA}═══ PROVIDER AGENT ═══${RESET}\n`);

  // Generate identity
  const generated = generateDID();
  const client = new X811Client({
    serverUrl: SERVER_URL,
    keyPair: generated.keyPair,
  });

  logDetail(`DID: ${client.did}`);
  logDetail(`Server: ${SERVER_URL}`);

  // -----------------------------------------------------------------------
  // REGISTRATION
  // -----------------------------------------------------------------------

  log("REG", "REGISTRATION", 'Registering as "FinAnalyst-Pro"');

  const regResult = await client.register({
    name: "FinAnalyst-Pro",
    description: "Professional AI financial analysis agent — DCF, fundamentals, technicals",
    payment_address: `0x${Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`,
    capabilities: [
      {
        name: CAPABILITY,
        description: "Comprehensive financial analysis for equities",
        pricing: {
          model: "range",
          range: { min: "0.01", max: "0.05" },
          currency: "USDC",
        },
        input_schema: {
          type: "object",
          properties: {
            ticker: { type: "string" },
            analysis_type: { type: "string" },
          },
          required: ["ticker"],
        },
        output_schema: {
          type: "object",
          properties: {
            ticker: { type: "string" },
            recommendation: { type: "string", enum: ["BUY", "HOLD", "SELL"] },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            target_price: { type: "number" },
            current_price: { type: "number" },
          },
          required: ["ticker", "recommendation", "confidence"],
        },
      },
    ],
  });

  const agentId = (regResult as Record<string, unknown>).id as string;
  logSuccess(`Registered successfully — agent_id: ${agentId}`);
  logDetail(`Trust score: ${(regResult as Record<string, unknown>).trust_score ?? 0.5} (new agent)`);

  // -----------------------------------------------------------------------
  // HEARTBEAT
  // -----------------------------------------------------------------------

  log("HB", "HEARTBEAT", "Signaling online status (capacity: 5)");

  await client.heartbeat("online", 5, 300);
  logSuccess("Heartbeat sent — status: online, capacity: 5");

  // -----------------------------------------------------------------------
  // STEP 4: NEGOTIATION — Wait for incoming request
  // -----------------------------------------------------------------------

  log(4, "NEGOTIATION", "Polling for incoming requests...");

  const requestEnvelope = await pollForMessage<RequestPayload>(client, "x811/request");
  const requestPayload = requestEnvelope.payload;
  const initiatorDid = requestEnvelope.from;

  logSuccess("Request received!");
  logDetail(`From: ${initiatorDid}`);
  logDetail(`Task: ${requestPayload.task_type}`);
  logDetail(`Parameters: ticker=${(requestPayload.parameters as Record<string, unknown>).ticker}`);
  logDetail(`Max budget: $${requestPayload.max_budget} ${requestPayload.currency}`);
  logDetail(`Deadline: ${requestPayload.deadline}s`);
  logDetail(`Policy: ${requestPayload.acceptance_policy}`);

  // Determine interaction_id from the send response metadata
  // The interaction_id is the request_id we need for the offer
  const requestId = (requestEnvelope as Record<string, unknown>).id as string
    ?? requestEnvelope.id;

  // Calculate pricing
  const price = "0.029";
  const protocolFee = (parseFloat(price) * PROTOCOL_FEE_RATE).toFixed(6);
  const totalCost = (parseFloat(price) + parseFloat(protocolFee)).toFixed(6);

  logDetail(`Calculated price: $${price} USDC`);
  logDetail(`Protocol fee (2.5%): $${protocolFee} USDC`);
  logDetail(`Total cost: $${totalCost} USDC`);

  // We need to find the interaction_id. It's returned by the server when
  // the request is processed. We query the server for recent interactions.
  // The interaction_id is what we use as request_id in the offer.
  let interactionId = "";
  try {
    // Poll the interactions via the agent details or rely on the message structure
    // The negotiation service uses the interaction_id internally.
    // For the offer, we use the envelope ID as the request_id lookup key.
    // Actually, the NegotiationService stores the interaction with its own UUID.
    // The offer's request_id should match the interaction.id stored by the server.
    // Since the server returns interaction_id in the response to POST /messages,
    // we need a way to get it. The interaction_id is returned in the response
    // to the initiator's request message. For the provider, we use the envelope.id.
    // Let's use the message envelope id — the negotiation service will look it up.
    interactionId = requestEnvelope.id;
  } catch {
    interactionId = requestEnvelope.id;
  }

  // Send offer
  const offerResult = await client.send(initiatorDid, "x811/offer", {
    request_id: interactionId,
    price,
    protocol_fee: protocolFee,
    total_cost: totalCost,
    currency: "USDC",
    estimated_time: 30,
    deliverables: ["AAPL analysis report"],
    terms: "Result delivered within estimated time. Methodology: fundamental + DCF.",
    expiry: 300,
  });

  logSuccess(`Offer sent — message_id: ${offerResult.message_id}`);

  // Wait for ACCEPT
  log(5, "WAITING", "Waiting for initiator's accept/reject decision...");

  const acceptEnvelope = await pollForMessage<{ offer_id: string; offer_hash: string }>(
    client,
    "x811/accept",
  );

  logSuccess("Offer ACCEPTED by initiator!");
  logDetail(`Offer hash: ${acceptEnvelope.payload.offer_hash.slice(0, 16)}...`);

  // -----------------------------------------------------------------------
  // STEP 6: EXECUTION
  // -----------------------------------------------------------------------

  log(6, "EXECUTION", "Executing AAPL financial analysis...");

  const executionStart = Date.now();

  // Simulate analysis execution (1-2 seconds)
  logDetail("Running DCF valuation model...");
  await sleep(500);
  logDetail("Analyzing revenue growth trends...");
  await sleep(300);
  logDetail("Evaluating key catalysts and risk factors...");
  await sleep(400);
  logDetail("Computing target price...");
  await sleep(300);

  const executionTimeMs = Date.now() - executionStart;

  logSuccess(`Analysis complete in ${executionTimeMs}ms`);
  logDetail(`Recommendation: ${MOCK_AAPL_ANALYSIS.recommendation}`);
  logDetail(`Confidence: ${(MOCK_AAPL_ANALYSIS.confidence * 100).toFixed(0)}%`);
  logDetail(`Target price: $${MOCK_AAPL_ANALYSIS.target_price}`);
  logDetail(`Current price: $${MOCK_AAPL_ANALYSIS.current_price}`);

  // -----------------------------------------------------------------------
  // STEP 7: DELIVERY
  // -----------------------------------------------------------------------

  log(7, "DELIVERY", "Sending signed result with analysis data");

  const resultContent = JSON.stringify(MOCK_AAPL_ANALYSIS);
  const resultHash = hashPayload(resultContent);

  logDetail(`Result hash: ${resultHash.slice(0, 16)}...`);
  logDetail(`Content size: ${new TextEncoder().encode(resultContent).length} bytes`);

  const deliverResult = await client.send(initiatorDid, "x811/result", {
    request_id: interactionId,
    offer_id: interactionId,
    content: resultContent,
    content_type: "application/json",
    result_hash: resultHash,
    execution_time_ms: executionTimeMs,
    model_used: "FinAnalyst-Pro v1.0",
    methodology: MOCK_AAPL_ANALYSIS.methodology,
  });

  logSuccess(`Result delivered — message_id: ${deliverResult.message_id}`);

  // -----------------------------------------------------------------------
  // Wait for VERIFY acknowledgment
  // -----------------------------------------------------------------------

  log(8, "WAITING", "Waiting for verification from initiator...");

  try {
    const verifyEnvelope = await pollForMessage<{
      request_id: string;
      result_hash: string;
      verified: boolean;
    }>(client, "x811/verify", 30_000);

    logSuccess("Result verified by initiator");
    logDetail(`Verified: ${verifyEnvelope.payload.verified}`);
  } catch {
    logDetail("Verification message not received (may have been processed server-side)");
  }

  // -----------------------------------------------------------------------
  // Wait for PAYMENT confirmation
  // -----------------------------------------------------------------------

  log(9, "WAITING", "Waiting for payment...");

  try {
    const paymentEnvelope = await pollForMessage<{
      request_id: string;
      tx_hash: string;
      amount: number;
      currency: string;
      network: string;
    }>(client, "x811/payment", 30_000);

    logSuccess("Payment received!");
    logDetail(`Amount: $${paymentEnvelope.payload.amount} ${paymentEnvelope.payload.currency}`);
    logDetail(`Network: ${paymentEnvelope.payload.network}`);
    logDetail(`Tx hash: ${paymentEnvelope.payload.tx_hash.slice(0, 18)}...`);
  } catch {
    logDetail("Payment confirmation not received via polling (may have been processed)");
  }

  console.log(`\n${BOLD}${GREEN}═══ PROVIDER COMPLETE ═══${RESET}\n`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const isMain = process.argv[1] &&
  (process.argv[1].includes("provider") || process.argv[1].endsWith("index.ts"));

if (isMain && !process.env.X811_ORCHESTRATED) {
  runProvider()
    .then(() => {
      console.log(`${BOLD}${GREEN}Provider demo complete!${RESET}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`${RED}${BOLD}Provider failed:${RESET}`, err);
      process.exit(1);
    });
}
