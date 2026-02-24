/**
 * x811 Protocol -- Benchmark Report Generator.
 *
 * Generates benchmarks/BENCHMARK-REPORT.md from vitest bench results.
 *
 * Usage:
 *   node --import tsx benchmarks/report-generator.ts
 *
 * If benchmarks/benchmark-results.json exists (from vitest bench --reporter=json),
 * it parses the results and includes them. Otherwise, it generates a template
 * report with the protocol comparison matrix.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { platform, arch, release, version as nodeVersion } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Types for vitest bench JSON output
// ---------------------------------------------------------------------------

interface BenchResult {
  name: string;
  rank: number;
  rme: number;
  totalTime: number;
  min: number;
  max: number;
  hz: number;
  period: number;
  mean: number;
  variance: number;
  sd: number;
  sem: number;
  df: number;
  critical: number;
  moe: number;
  p75: number;
  p99: number;
  p995: number;
  p999: number;
  samples: number[];
  sampleCount: number;
}

interface BenchGroup {
  name: string;
  children?: BenchGroup[];
  benchmarks?: BenchResult[];
}

interface BenchFile {
  name: string;
  groups: BenchGroup[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(2) + "K";
  return n.toFixed(2);
}

function formatTime(ns: number): string {
  if (ns >= 1_000_000) return (ns / 1_000_000).toFixed(2) + " ms";
  if (ns >= 1_000) return (ns / 1_000).toFixed(2) + " us";
  return ns.toFixed(2) + " ns";
}

// ---------------------------------------------------------------------------
// Report sections
// ---------------------------------------------------------------------------

function generateHeader(): string {
  const date = new Date().toISOString().split("T")[0];
  return `# x811 AEEP Protocol -- Benchmark Report

Generated: ${date}
Node: ${process.version}
OS: ${platform()} ${arch()} ${release()}
`;
}

function generateComparisonMatrix(): string {
  return `## Protocol Comparison Matrix

| Feature | x811 AEEP | ERC-8004 | x402 | A2A | ANP |
|---------|:---------:|:--------:|:----:|:---:|:---:|
| DID-based identity | Y | Y | - | - | Y |
| Signed message envelopes | Y | - | - | - | - |
| Price negotiation | Y | - | - | - | - |
| Budget constraints | Y | - | - | - | - |
| Rejection with reason codes | Y | - | - | - | - |
| Trust scoring (0.0-1.0) | Y | Y | - | - | - |
| Trust-gated acceptance | Y | - | - | - | - |
| Result verification | Y | - | - | - | - |
| Verify-then-pay | Y | - | - | - | - |
| Merkle proof anchoring | Y | - | - | - | - |
| 10-state machine | Y | - | - | Y | - |
| TTL-bounded transitions | Y | - | - | - | - |
| Protocol fee structure | Y | - | - | - | - |
| Idempotency keys | Y | - | - | - | - |
| Nonce replay protection | Y | - | - | - | - |
| Gas subsidized settlement | Y | - | - | - | - |
| Dispute signaling | Y | - | - | - | - |
| **Total** | **17/17** | **2/17** | **0/17** | **1/17** | **1/17** |
`;
}

function generateBenchmarkTable(files: BenchFile[]): string {
  let md = `## Performance Benchmarks

| Benchmark | ops/sec | Mean | p99 | Samples |
|-----------|--------:|-----:|----:|--------:|
`;

  for (const file of files) {
    for (const group of file.groups) {
      md += `| **${group.name}** | | | | |\n`;
      const benchmarks = group.benchmarks ?? [];
      for (const b of benchmarks) {
        const opsPerSec = formatNumber(b.hz);
        const mean = formatTime(b.mean * 1_000_000); // seconds to ns
        const p99 = formatTime(b.p99 * 1_000_000);
        md += `| ${b.name} | ${opsPerSec} | ${mean} | ${p99} | ${b.sampleCount} |\n`;
      }
      // Recurse into children
      if (group.children) {
        for (const child of group.children) {
          md += `| **${child.name}** | | | | |\n`;
          const childBenchmarks = child.benchmarks ?? [];
          for (const b of childBenchmarks) {
            const opsPerSec = formatNumber(b.hz);
            const mean = formatTime(b.mean * 1_000_000);
            const p99 = formatTime(b.p99 * 1_000_000);
            md += `| ${b.name} | ${opsPerSec} | ${mean} | ${p99} | ${b.sampleCount} |\n`;
          }
        }
      }
    }
  }

  return md;
}

function generatePlaceholderBenchmarks(): string {
  return `## Performance Benchmarks

> No benchmark results found. Run benchmarks to generate data:
>
> \`\`\`bash
> npx vitest bench --config benchmarks/vitest.config.ts --reporter=json > benchmarks/benchmark-results.json
> \`\`\`

| Benchmark | ops/sec | Mean | p99 | Samples |
|-----------|--------:|-----:|----:|--------:|
| **Trust Score Calculation** | | | | |
| Calculate trust score | (pending) | (pending) | (pending) | - |
| Apply time decay | (pending) | (pending) | (pending) | - |
| **Full Negotiation Cycle** | | | | |
| Complete 6-message flow | (pending) | (pending) | (pending) | - |
| **Individual Operations** | | | | |
| Handle REQUEST message | (pending) | (pending) | (pending) | - |
| Insert agent to DB | (pending) | (pending) | (pending) | - |
| Insert interaction to DB | (pending) | (pending) | (pending) | - |
| **Key Generation** | | | | |
| Ed25519 key pair generation | (pending) | (pending) | (pending) | - |
| X25519 key pair generation | (pending) | (pending) | (pending) | - |
| Full DID generation | (pending) | (pending) | (pending) | - |
| **Merkle Tree Construction** | | | | |
| Build tree with 100 items | (pending) | (pending) | (pending) | - |
| Build tree with 1,000 items | (pending) | (pending) | (pending) | - |
| Build tree with 10,000 items | (pending) | (pending) | (pending) | - |
`;
}

function generateConclusion(): string {
  return `## Conclusion

x811 AEEP is the only protocol providing all 17 capabilities required for autonomous AI agent economic interactions. It combines DID-based identity, cryptographic message signing, price negotiation with budget constraints, trust scoring with gated acceptance, result verification, Merkle proof anchoring, and on-chain settlement into a single cohesive protocol.

No existing protocol -- ERC-8004 (2/17), x402 (0/17), A2A (1/17), or ANP (1/17) -- provides more than a fraction of these features.
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const resultsPath = join(__dirname, "benchmark-results.json");
  const outputPath = join(__dirname, "BENCHMARK-REPORT.md");

  let benchmarkSection: string;

  if (existsSync(resultsPath)) {
    try {
      const raw = readFileSync(resultsPath, "utf-8");
      const parsed = JSON.parse(raw);

      // The vitest bench JSON output is an object with "testResults" array
      // Each testResult has "benchmarks" or a nested structure
      let files: BenchFile[] = [];

      if (Array.isArray(parsed)) {
        files = parsed as BenchFile[];
      } else if (parsed.testResults && Array.isArray(parsed.testResults)) {
        files = parsed.testResults as BenchFile[];
      } else if (parsed.files && Array.isArray(parsed.files)) {
        files = parsed.files as BenchFile[];
      }

      if (files.length > 0) {
        benchmarkSection = generateBenchmarkTable(files);
      } else {
        console.log("Benchmark results file found but format not recognized. Using placeholder.");
        benchmarkSection = generatePlaceholderBenchmarks();
      }
    } catch (e) {
      console.error("Failed to parse benchmark results:", e);
      benchmarkSection = generatePlaceholderBenchmarks();
    }
  } else {
    console.log("No benchmark-results.json found. Generating template report.");
    benchmarkSection = generatePlaceholderBenchmarks();
  }

  const report = [
    generateHeader(),
    generateComparisonMatrix(),
    benchmarkSection,
    generateConclusion(),
  ].join("\n");

  writeFileSync(outputPath, report, "utf-8");
  console.log(`Report written to ${outputPath}`);
}

main();
