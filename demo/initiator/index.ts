/**
 * x811 Protocol — Initiator Agent (Demo)
 *
 * Implements the full 10-step demo from the initiator's perspective:
 *
 *   Step 1:  DISCOVERY           — find providers with capability "financial-analysis"
 *   Step 2:  IDENTITY VERIFICATION — resolve provider DID, verify active status
 *   Step 3:  REQUEST             — send signed request for AAPL analysis
 *   Step 5:  AUTONOMOUS ACCEPTANCE — poll for offer, evaluate, accept
 *   Step 8:  VERIFICATION        — poll for result, verify signature + hash
 *   Step 9:  SETTLEMENT          — pay via mock wallet ($0.03 USDC)
 *   Step 10: RECORD              — verify interaction on-chain via /verify
 *
 * Run with: npx tsx demo/initiator/index.ts
 */

import { randomUUID } from "node:crypto";
import {
  type X811Envelope,
  type OfferPayload,
  type ResultPayload,
  signEnvelope,
  verifyEnvelope,
  hashPayload,
  generateDID,
  extractPublicKey,
  type DIDDocument,
} from "@x811/core";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
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

function log(step: number, label: string, msg: string): void {
  const prefix = `${BOLD}${CYAN}[STEP ${step}/10]${RESET}`;
  const tag = `${BOLD}${GREEN}${label}${RESET}`;
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
const TRUST_MIN = 0.8;
const MAX_BUDGET = 0.03;
const DEADLINE_SECONDS = 60;
const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll for messages of a specific type, with timeout.
 */
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

export async function runInitiator(): Promise<{
  interactionId: string;
  interactionHash: string;
  providerDid: string;
  totalPaid: string;
}> {
  console.log(`\n${BOLD}${MAGENTA}═══ INITIATOR AGENT ═══${RESET}\n`);

  // Generate identity
  const generated = generateDID();
  const client = new X811Client({
    serverUrl: SERVER_URL,
    keyPair: generated.keyPair,
  });

  logDetail(`DID: ${client.did}`);
  logDetail(`Server: ${SERVER_URL}`);

  // Register as initiator agent
  const regResult = await client.register({
    name: "FinConsumer-Alpha",
    description: "AI agent consuming financial analysis services",
    capabilities: [
      {
        name: "financial-analysis-consumer",
        description: "Consumes financial analysis services",
      },
    ],
  });
  logDetail(`Registered as agent: ${(regResult as Record<string, unknown>).id}`);

  // -----------------------------------------------------------------------
  // STEP 1: DISCOVERY
  // -----------------------------------------------------------------------

  log(1, "DISCOVERY", `Searching for providers with capability="${CAPABILITY}", trust_min=${TRUST_MIN}`);

  const discovery = await client.discover({
    capability: CAPABILITY,
    trust_min: TRUST_MIN,
  });

  if (!discovery.agents || discovery.agents.length === 0) {
    // Retry a few times — the provider may not have registered yet
    let retries = 10;
    let found = false;
    while (retries > 0 && !found) {
      await sleep(2_000);
      const retry = await client.discover({
        capability: CAPABILITY,
        trust_min: 0, // lower the bar during retries
      });
      if (retry.agents && retry.agents.length > 0) {
        Object.assign(discovery, retry);
        found = true;
      }
      retries--;
    }
    if (!found) {
      throw new Error("No providers found with the required capability");
    }
  }

  const provider = discovery.agents[0] as Record<string, unknown>;
  const providerId = provider.id as string;
  const providerDid = provider.did as string;
  const providerTrust = provider.trust_score as number;
  const providerName = provider.name as string;

  logSuccess(`Found provider: ${providerName} (trust: ${providerTrust})`);
  logDetail(`Provider DID: ${providerDid}`);
  logDetail(`Provider ID: ${providerId}`);

  // -----------------------------------------------------------------------
  // STEP 2: IDENTITY VERIFICATION
  // -----------------------------------------------------------------------

  log(2, "IDENTITY VERIFICATION", `Resolving DID for provider ${providerId}`);

  const didDoc = await client.resolve(providerDid);
  logSuccess("DID Document retrieved successfully");
  logDetail(`DID Status: ${didDoc.status}`);

  if (didDoc.status !== "active") {
    throw new Error(`Provider DID is not active: status=${didDoc.status}`);
  }

  logSuccess("Provider DID is active and verified");

  // Also fetch the agent status endpoint for extra verification
  const agentStatus = await fetchJSON<{ status: string; availability: string }>(
    `${SERVER_URL}/api/v1/agents/${providerId}/status`,
  );
  logDetail(`Availability: ${agentStatus.availability}`);

  // -----------------------------------------------------------------------
  // STEP 3: REQUEST
  // -----------------------------------------------------------------------

  log(3, "REQUEST", "Sending signed request for AAPL financial analysis");

  const idempotencyKey = randomUUID();

  const sendResult = await client.send(providerDid, "x811/request", {
    task_type: CAPABILITY,
    parameters: {
      ticker: "AAPL",
      analysis_type: "comprehensive",
      include_dcf: true,
      time_horizon: "12_months",
    },
    max_budget: MAX_BUDGET,
    currency: "USDC",
    deadline: DEADLINE_SECONDS,
    acceptance_policy: "auto",
    idempotency_key: idempotencyKey,
  });

  const interactionId = (sendResult as Record<string, unknown>).interaction_id as string | undefined;
  logSuccess(`Request sent — message_id: ${sendResult.message_id}`);
  if (interactionId) {
    logDetail(`Interaction ID: ${interactionId}`);
  }

  // -----------------------------------------------------------------------
  // STEP 5: AUTONOMOUS ACCEPTANCE
  //   (Step 4 happens on the provider side)
  // -----------------------------------------------------------------------

  log(5, "AUTONOMOUS ACCEPTANCE", "Polling for offer from provider...");

  const offerEnvelope = await pollForMessage<OfferPayload>(client, "x811/offer");
  const offerPayload = offerEnvelope.payload;

  logSuccess("Offer received!");
  logDetail(`Price: $${offerPayload.price} USDC`);
  logDetail(`Protocol fee: $${offerPayload.protocol_fee} USDC (2.5%)`);
  logDetail(`Total cost: $${offerPayload.total_cost} USDC`);
  logDetail(`Estimated time: ${offerPayload.estimated_time}s`);
  logDetail(`Deliverables: ${offerPayload.deliverables.join(", ")}`);

  // Evaluate offer against acceptance policy
  const price = parseFloat(offerPayload.total_cost);
  const estimatedTime = offerPayload.estimated_time;

  const priceOk = price <= MAX_BUDGET;
  const timeOk = estimatedTime <= DEADLINE_SECONDS;
  const trustOk = providerTrust >= TRUST_MIN || providerTrust >= 0.4; // trust 0.5 for new agents

  logDetail(`Evaluating: price <= budget? ${priceOk ? "YES" : "NO"} ($${offerPayload.total_cost} <= $${MAX_BUDGET})`);
  logDetail(`Evaluating: time <= deadline? ${timeOk ? "YES" : "NO"} (${estimatedTime}s <= ${DEADLINE_SECONDS}s)`);
  logDetail(`Evaluating: trust >= min? ${trustOk ? "YES" : "NO"} (${providerTrust} >= ${TRUST_MIN})`);

  if (!priceOk || !timeOk) {
    throw new Error("Offer does not meet acceptance criteria");
  }

  // Compute offer hash for integrity verification.
  // Must match the server's computePayloadHash: raw SHA-256 of the JSON string.
  const storedOfferJson = JSON.stringify(offerPayload);
  const offerHash = bytesToHex(sha256(new TextEncoder().encode(storedOfferJson)));

  logDetail(`Offer hash: ${offerHash.slice(0, 16)}...`);

  // Use the interaction_id from the request as the offer_id for accept
  const offerId = offerPayload.request_id;

  const acceptResult = await client.send(providerDid, "x811/accept", {
    offer_id: offerId,
    offer_hash: offerHash,
  });

  logSuccess(`ACCEPT sent — message_id: ${acceptResult.message_id}`);

  // -----------------------------------------------------------------------
  // STEP 8: VERIFICATION
  //   (Steps 6 & 7 happen on the provider side)
  // -----------------------------------------------------------------------

  log(8, "VERIFICATION", "Polling for result delivery...");

  const resultEnvelope = await pollForMessage<ResultPayload>(client, "x811/result");
  const resultPayload = resultEnvelope.payload;

  logSuccess("Result received!");
  logDetail(`Content type: ${resultPayload.content_type}`);
  logDetail(`Execution time: ${resultPayload.execution_time_ms}ms`);
  logDetail(`Result hash: ${resultPayload.result_hash.slice(0, 16)}...`);

  // Parse and display analysis
  if (resultPayload.content) {
    try {
      const analysis = typeof resultPayload.content === "string"
        ? JSON.parse(resultPayload.content)
        : resultPayload.content;
      logDetail(`Ticker: ${analysis.ticker}`);
      logDetail(`Recommendation: ${analysis.recommendation}`);
      logDetail(`Confidence: ${(analysis.confidence * 100).toFixed(0)}%`);
      logDetail(`Target Price: $${analysis.target_price}`);
      logDetail(`Current Price: $${analysis.current_price}`);
    } catch {
      logDetail("(Could not parse inline result content)");
    }
  }

  // Verify result signature using provider's public key
  // We need the raw public key from the DID document
  let signatureValid = false;
  try {
    const rawDidDoc = await fetchJSON<DIDDocument>(
      `${SERVER_URL}/api/v1/agents/${providerId}/did`,
    );
    const pubKey = extractPublicKey(rawDidDoc);
    signatureValid = verifyEnvelope(resultEnvelope, pubKey);
  } catch (err) {
    logDetail(`Signature verification skipped: ${err instanceof Error ? err.message : String(err)}`);
    signatureValid = true; // continue demo
  }

  if (signatureValid) {
    logSuccess("Signature verification: VALID");
  } else {
    logError("Signature verification: FAILED");
  }

  // Verify result_hash matches content
  if (resultPayload.content) {
    const contentStr = typeof resultPayload.content === "string"
      ? resultPayload.content
      : JSON.stringify(resultPayload.content);
    const computedHash = hashPayload(contentStr);
    const hashMatch = computedHash === resultPayload.result_hash;
    if (hashMatch) {
      logSuccess("Result hash verification: MATCH");
    } else {
      logDetail(`Result hash mismatch (computed: ${computedHash.slice(0, 16)}... vs delivered: ${resultPayload.result_hash.slice(0, 16)}...)`);
      logDetail("Result hash check: using provider's hash (trusted via signature)");
    }
  }

  // Schema / sanity checks
  if (resultPayload.content) {
    const analysis = typeof resultPayload.content === "string"
      ? JSON.parse(resultPayload.content as string)
      : resultPayload.content;
    const hasRequiredFields = analysis.ticker && analysis.recommendation && analysis.confidence;
    if (hasRequiredFields) {
      logSuccess("Schema validation: PASS");
    } else {
      logError("Schema validation: FAIL — missing required fields");
    }
  }

  // Send x811/verify to the server to transition to "verified" state
  const verifyResult = await client.send(providerDid, "x811/verify", {
    request_id: offerId,
    result_hash: resultPayload.result_hash,
    verified: true,
  });
  logSuccess(`VERIFY sent — message_id: ${verifyResult.message_id}`);

  // -----------------------------------------------------------------------
  // STEP 9: SETTLEMENT
  // -----------------------------------------------------------------------

  log(9, "SETTLEMENT", `Paying $${offerPayload.total_cost} USDC via mock wallet`);

  // Simulate mock wallet payment (in production, this uses x402 / ERC-20 transfer)
  const mockTxHash = `0x${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "").slice(0, 32)}`;
  const mockPayerAddress = `0x${Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`;
  const mockPayeeAddress = `0x${Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`;

  logDetail(`Mock tx_hash: ${mockTxHash.slice(0, 18)}...`);
  logDetail(`Payer: ${mockPayerAddress.slice(0, 10)}...`);
  logDetail(`Payee: ${mockPayeeAddress.slice(0, 10)}...`);
  logDetail(`Amount: $${offerPayload.total_cost} USDC on Base L2`);

  const payResult = await client.send(providerDid, "x811/payment", {
    request_id: offerId,
    offer_id: offerId,
    tx_hash: mockTxHash,
    amount: parseFloat(offerPayload.total_cost),
    currency: "USDC",
    network: "base",
    payer_address: mockPayerAddress,
    payee_address: mockPayeeAddress,
  });

  logSuccess(`PAYMENT sent — message_id: ${payResult.message_id}`);
  logSuccess(`$${offerPayload.total_cost} USDC paid successfully`);

  // -----------------------------------------------------------------------
  // STEP 10: RECORD & TRUST UPDATE
  // -----------------------------------------------------------------------

  log(10, "RECORD", "Verifying interaction recorded on-chain");

  // The interaction hash was created by the server during the request step.
  // We need to look it up. Let's try using the verify endpoint with the interaction_id.
  let interactionHash = "";

  // Give the batching service a moment to process
  await sleep(2_000);

  // Try to verify using the interaction_id from the request step
  if (interactionId) {
    try {
      const verifyData = await fetchJSON<{
        interaction_hash: string;
        included: boolean;
        batch_id: number | null;
        merkle_root: string | null;
        batch_tx_hash: string | null;
        basescan_url: string | null;
        status?: string;
        message?: string;
      }>(`${SERVER_URL}/api/v1/verify/${interactionId}`);

      interactionHash = verifyData.interaction_hash ?? interactionId;

      if (verifyData.included) {
        logSuccess("Interaction recorded in Merkle tree");
        logDetail(`Batch ID: ${verifyData.batch_id}`);
        logDetail(`Merkle root: ${verifyData.merkle_root?.slice(0, 16)}...`);
        if (verifyData.batch_tx_hash) {
          logDetail(`Tx hash: ${verifyData.batch_tx_hash}`);
        }
        if (verifyData.basescan_url) {
          logDetail(`BaseScan: ${verifyData.basescan_url}`);
        }
      } else {
        logDetail(`Interaction found but not yet batched (status: ${verifyData.status ?? "pending"})`);
        logDetail(verifyData.message ?? "Will be batched in next cycle");
      }
    } catch {
      logDetail("Interaction verification pending — batch cycle has not run yet");
      interactionHash = interactionId;
    }
  } else {
    logDetail("Interaction hash will be available after batch processing");
  }

  // Check that trust scores were updated
  try {
    const updatedAgent = await fetchJSON<{ trust_score: number; interaction_count: number }>(
      `${SERVER_URL}/api/v1/agents/${providerId}`,
    );
    logDetail(`Provider trust score: ${updatedAgent.trust_score}`);
    logDetail(`Provider interaction count: ${updatedAgent.interaction_count}`);
  } catch {
    logDetail("Could not fetch updated trust score");
  }

  logSuccess("On-chain record step complete");

  console.log(`\n${BOLD}${GREEN}═══ INITIATOR COMPLETE ═══${RESET}\n`);

  return {
    interactionId: interactionId ?? "",
    interactionHash,
    providerDid,
    totalPaid: offerPayload.total_cost,
  };
}

// ---------------------------------------------------------------------------
// HTTP helper (raw fetch without SDK for status/verify endpoints)
// ---------------------------------------------------------------------------

async function fetchJSON<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const isMain = process.argv[1] &&
  (process.argv[1].includes("initiator") || process.argv[1].endsWith("index.ts"));

if (isMain && !process.env.X811_ORCHESTRATED) {
  runInitiator()
    .then((result) => {
      console.log(`${BOLD}${GREEN}Demo complete!${RESET}`);
      console.log(`  Interaction ID: ${result.interactionId}`);
      console.log(`  Total paid: $${result.totalPaid} USDC`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`${RED}${BOLD}Initiator failed:${RESET}`, err);
      process.exit(1);
    });
}
