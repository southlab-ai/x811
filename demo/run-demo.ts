/**
 * x811 Protocol — End-to-End Demo Orchestrator
 *
 * Starts the x811 server, runs the provider and initiator agents concurrently,
 * and prints a summary of all 10 protocol steps.
 *
 * Run with: npx tsx demo/run-demo.ts
 */

// ---------------------------------------------------------------------------
// Set environment BEFORE any module imports so the server config picks them up.
// This must happen before the dynamic import() of @x811/server.
// ---------------------------------------------------------------------------

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.PORT = "3811";

import type { FastifyInstance } from "fastify";

// ---------------------------------------------------------------------------
// ANSI colors
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const MAGENTA = "\x1b[35m";

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

function printBanner(): void {
  console.log(`
${BOLD}${CYAN}╔═══════════════════════════════════════════════════╗
║  x811 Protocol MVP — End-to-End Demo             ║
║  Two AI agents: discover, negotiate, execute,     ║
║  verify, and settle a financial analysis task     ║
║  ($0.03 USDC on Base L2)                         ║
╚═══════════════════════════════════════════════════╝${RESET}
`);
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

async function startServer(): Promise<{ app: FastifyInstance; port: number }> {
  const port = 3811;

  // Dynamic import so that the server module reads our env vars set above
  const { buildApp } = await import("@x811/server");

  const app = await buildApp({
    databaseUrl: ":memory:", // In-memory SQLite for the demo
    skipRateLimit: true,     // Skip rate limits for demo speed
  });

  // Start the batching timer
  app.batching.startTimer();

  await app.listen({ port, host: "127.0.0.1" });

  return { app, port };
}

async function waitForServer(port: number, maxRetries: number = 30): Promise<void> {
  const url = `http://localhost:${port}/health`;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Server failed to start on port ${port} after ${maxRetries} retries`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

interface DemoResult {
  success: boolean;
  durationMs: number;
  interactionId: string;
  interactionHash: string;
  providerDid: string;
  totalPaid: string;
  error?: string;
}

function printSummary(result: DemoResult): void {
  const border = `${BOLD}${CYAN}${"═".repeat(60)}${RESET}`;

  console.log(`\n${border}`);
  console.log(`${BOLD}${CYAN}  x811 Protocol Demo — Summary${RESET}`);
  console.log(border);
  console.log();

  const steps = [
    { num: 1,  name: "DISCOVERY",              desc: "Found provider via capability search" },
    { num: 2,  name: "IDENTITY VERIFICATION",  desc: "Resolved + verified provider DID" },
    { num: 3,  name: "REQUEST",                desc: "Sent signed AAPL analysis request" },
    { num: 4,  name: "NEGOTIATION",            desc: "Provider created signed offer" },
    { num: 5,  name: "AUTONOMOUS ACCEPTANCE",  desc: "Auto-accepted (price/time/trust OK)" },
    { num: 6,  name: "EXECUTION",              desc: "Provider executed financial analysis" },
    { num: 7,  name: "DELIVERY",               desc: "Result delivered with hash + signature" },
    { num: 8,  name: "VERIFICATION",           desc: "Signature, schema, hash verified" },
    { num: 9,  name: "SETTLEMENT",             desc: `Paid $${result.totalPaid} USDC (mock)` },
    { num: 10, name: "RECORD",                 desc: "Interaction hash anchored on-chain" },
  ];

  for (const step of steps) {
    const status = result.success ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    const stepNum = `${BOLD}Step ${String(step.num).padStart(2)}${RESET}`;
    const name = `${YELLOW}${step.name.padEnd(24)}${RESET}`;
    console.log(`  ${status} ${stepNum}  ${name} ${DIM}${step.desc}${RESET}`);
  }

  console.log();
  console.log(`  ${BOLD}Status:${RESET}          ${result.success ? `${GREEN}SUCCESS${RESET}` : `${RED}FAILED${RESET}`}`);
  console.log(`  ${BOLD}Duration:${RESET}        ${(result.durationMs / 1000).toFixed(2)}s`);
  console.log(`  ${BOLD}Interaction ID:${RESET}  ${result.interactionId || "(pending)"}`);
  console.log(`  ${BOLD}Provider DID:${RESET}    ${result.providerDid || "(n/a)"}`);
  console.log(`  ${BOLD}Total paid:${RESET}      $${result.totalPaid} USDC on Base L2`);

  if (result.error) {
    console.log(`  ${BOLD}${RED}Error:${RESET}           ${result.error}`);
  }

  console.log();
  console.log(border);
  console.log();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  printBanner();

  // Mark as orchestrated so individual agents don't auto-start
  process.env.X811_ORCHESTRATED = "true";

  const startTime = Date.now();
  let app: FastifyInstance | null = null;

  try {
    // -----------------------------------------------------------------------
    // 1. Start x811 server
    // -----------------------------------------------------------------------

    console.log(`${BOLD}${MAGENTA}[SERVER]${RESET} Starting x811 server on port 3811...`);

    const server = await startServer();
    app = server.app;

    console.log(`${BOLD}${MAGENTA}[SERVER]${RESET} Waiting for server readiness...`);
    await waitForServer(server.port);

    console.log(`${BOLD}${GREEN}[SERVER]${RESET} Server ready at http://localhost:${server.port}`);

    // Dynamic imports for the demo agents (after server is running)
    const { runProvider } = await import("./provider/index.js");
    const { runInitiator } = await import("./initiator/index.js");

    // -----------------------------------------------------------------------
    // 2. Run provider first (it needs to register before discovery)
    // -----------------------------------------------------------------------

    console.log(`\n${BOLD}${MAGENTA}[DEMO]${RESET} Starting Provider agent...`);

    // Run the provider registration in the foreground, then start polling in background
    const providerPromise = runProvider();

    // Give the provider time to register and start polling
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    // -----------------------------------------------------------------------
    // 3. Run initiator (discovery -> full flow)
    // -----------------------------------------------------------------------

    console.log(`\n${BOLD}${MAGENTA}[DEMO]${RESET} Starting Initiator agent...`);

    // Run both agents concurrently from this point
    const [, initiatorResult] = await Promise.all([
      providerPromise.catch((err: Error) => {
        console.error(`${RED}Provider error:${RESET}`, err.message);
        throw err;
      }),
      runInitiator().catch((err: Error) => {
        console.error(`${RED}Initiator error:${RESET}`, err.message);
        throw err;
      }),
    ]);

    // -----------------------------------------------------------------------
    // 4. Print summary
    // -----------------------------------------------------------------------

    const durationMs = Date.now() - startTime;

    printSummary({
      success: true,
      durationMs,
      interactionId: initiatorResult.interactionId,
      interactionHash: initiatorResult.interactionHash,
      providerDid: initiatorResult.providerDid,
      totalPaid: initiatorResult.totalPaid,
    });

  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : String(err);

    printSummary({
      success: false,
      durationMs,
      interactionId: "",
      interactionHash: "",
      providerDid: "",
      totalPaid: "0",
      error: errorMessage,
    });

    process.exitCode = 1;
  } finally {
    // -----------------------------------------------------------------------
    // 5. Shut down server
    // -----------------------------------------------------------------------

    if (app) {
      console.log(`${BOLD}${MAGENTA}[SERVER]${RESET} Shutting down...`);
      try {
        await app.close();
        console.log(`${BOLD}${GREEN}[SERVER]${RESET} Server stopped.`);
      } catch {
        // Server may already be closed
      }
    }

    // Force exit after a short delay to clean up any lingering timers
    setTimeout(() => process.exit(process.exitCode ?? 0), 500);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error(`${RED}${BOLD}Fatal error:${RESET}`, err);
  process.exit(1);
});
