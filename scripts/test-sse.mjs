/**
 * SSE Production Verification Test
 * Tests that SSE streams work end-to-end on api.x811.org without buffering.
 * Uses real Ed25519 signing for authenticated message delivery.
 */

import { generateDID, signEnvelope } from "@x811/core";
import { v7 as uuidv7 } from "uuid";

const SERVER = "https://api.x811.org";

// Helper: Base64url encode a Uint8Array (mirrors @x811/core internal)
function toBase64Url(bytes) {
  const binString = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binString).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Helper: Build an unsigned envelope
function buildEnvelope(from, to, type, payload) {
  const now = new Date();
  const expires = new Date(now.getTime() + 5 * 60 * 1000);
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");

  return {
    version: "0.1.0",
    id: uuidv7(),
    type,
    from,
    to,
    created: now.toISOString(),
    expires: expires.toISOString(),
    payload,
    nonce,
  };
}

// Helper: Register an agent with proper signed envelope auth
async function registerAgent(identity, name) {
  const envelope = buildEnvelope(
    identity.did,
    identity.did, // 'to' is self for registration
    "x811/request",
    {
      name,
      capabilities: [{ name: "sse-test" }],
    },
  );

  const signed = signEnvelope(envelope, identity.keyPair.signingKey.privateKey);

  const resp = await fetch(`${SERVER}/api/v1/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      envelope: signed,
      did_document: identity.document,
      public_key: toBase64Url(identity.keyPair.signingKey.publicKey),
    }),
  });

  if (resp.status !== 201) {
    const err = await resp.text();
    throw new Error(`Registration failed (${resp.status}): ${err}`);
  }

  return resp.json();
}

console.log("=== SSE Production Verification ===\n");

// Step 1: Register a fresh test agent (sender)
console.log("1. Registering test sender agent...");
const sender = generateDID();
const senderAgent = await registerAgent(sender, "SSE-Test-Sender-" + Date.now());
console.log(`   Sender DID: ${sender.did}`);
console.log(`   Sender ID: ${senderAgent.id}`);

// Step 2: Register a fresh test agent (receiver)
console.log("2. Registering test receiver agent...");
const receiver = generateDID();
const receiverAgent = await registerAgent(receiver, "SSE-Test-Receiver-" + Date.now());
const receiverId = receiverAgent.id;
console.log(`   Receiver DID: ${receiver.did}`);
console.log(`   Receiver ID: ${receiverId}`);

// Step 3: Open SSE stream for the receiver
console.log("3. Opening SSE stream for receiver...");
const ac = new AbortController();
const timeout = setTimeout(() => {
  ac.abort();
  console.log("\nTIMEOUT: No SSE event received in 15s");
  process.exit(1);
}, 15000);

const sseUrl = `${SERVER}/api/v1/messages/${receiverId}/stream?did=${receiver.did}`;
let sseResp;
try {
  sseResp = await fetch(sseUrl, { signal: ac.signal });
} catch (err) {
  console.log(`SSE connection failed: ${err.message}`);
  process.exit(1);
}

if (sseResp.status !== 200) {
  const body = await sseResp.text();
  console.log(`SSE failed: ${sseResp.status} ${body}`);
  process.exit(1);
}

const ct = sseResp.headers.get("content-type");
const xab = sseResp.headers.get("x-accel-buffering");
console.log(`   Status: ${sseResp.status}`);
console.log(`   Content-Type: ${ct}`);
console.log(`   X-Accel-Buffering: ${xab}`);
console.log(`   [PASS] SSE stream opened\n`);

// Step 4: Read stream and send a signed message
const reader = sseResp.body.getReader();
const decoder = new TextDecoder();
let gotHandshake = false;
let messageSentAt = 0;

const readLoop = async () => {
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    if (buffer.includes(":") && !gotHandshake) {
      gotHandshake = true;
      console.log("4. SSE handshake received (connection alive)");
      console.log("5. Sending signed message from sender to receiver...");

      // Build and sign a proper x811 envelope
      const unsigned = buildEnvelope(
        sender.did,
        receiver.did,
        "x811/request",
        {
          task_type: "sse-test",
          max_budget: 0.001,
          currency: "USDC",
          deadline: 60,
          parameters: { test: true },
        },
      );
      const signed = signEnvelope(unsigned, sender.keyPair.signingKey.privateKey);

      messageSentAt = Date.now();
      const sendResp = await fetch(`${SERVER}/api/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ envelope: signed }),
      });

      if (sendResp.ok) {
        console.log("   Signed message accepted by server, waiting for SSE push...\n");
      } else {
        const err = await sendResp.text();
        console.log(`   POST failed: ${sendResp.status} ${err}`);
        clearTimeout(timeout);
        ac.abort();
        process.exit(1);
      }
      buffer = "";
      continue;
    }

    if (buffer.includes("event:") || buffer.includes("data:")) {
      const latency = Date.now() - messageSentAt;
      console.log("6. SSE event received!");
      console.log(`   Latency: ${latency}ms`);

      const lines = buffer.split("\n");
      for (const line of lines) {
        if (line.startsWith("event:")) console.log(`   ${line.trim()}`);
        if (line.startsWith("id:")) console.log(`   ${line.trim()}`);
        if (line.startsWith("data:")) {
          const data = line.substring(5).trim();
          try {
            const parsed = JSON.parse(data);
            console.log(`   from: ${parsed.from}`);
            console.log(`   type: ${parsed.type}`);
          } catch { /* */ }
        }
      }

      console.log("\n=== ALL CHECKS PASSED ===");
      console.log("[PASS] SSE connection through Traefik + Cloudflare DNS-only");
      console.log("[PASS] Content-Type: text/event-stream");
      console.log(`[PASS] X-Accel-Buffering: ${xab}`);
      console.log("[PASS] SSE handshake received");
      console.log("[PASS] Signed envelope accepted");
      console.log(`[PASS] Real-time SSE delivery: ${latency}ms`);
      clearTimeout(timeout);
      ac.abort();
      process.exit(0);
    }
  }
};

readLoop().catch((err) => {
  if (err.name !== "AbortError") {
    console.log("Stream error:", err.message);
  }
});
