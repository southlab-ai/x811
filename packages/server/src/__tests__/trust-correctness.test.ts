/**
 * x811 Protocol -- Trust formula correctness proofs.
 *
 * Exhaustively tests calculateTrustScore, applyTimeDecay, recordSuccess,
 * recordFailure, and trust-gated filtering to ensure the trust subsystem
 * is mathematically sound.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Database } from "../db/schema.js";
import { TrustService } from "../services/trust.js";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let db: Database;
let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `x811-trust-test-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
  db = new Database(join(testDir, "test.db"));
});

afterEach(() => {
  db.close();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // cleanup best-effort
  }
});

// ---------------------------------------------------------------------------
// Helper: create a test agent in DB
// ---------------------------------------------------------------------------

function createTestAgent(overrides: Partial<Parameters<Database["insertAgent"]>[0]> = {}) {
  const id = randomUUID();
  return db.insertAgent({
    id,
    did: `did:web:x811.org:agents:${id}`,
    status: "active",
    availability: "online",
    last_seen_at: new Date().toISOString(),
    name: `Agent ${id.slice(0, 8)}`,
    description: "Test agent",
    endpoint: "https://example.com",
    payment_address: "0xabc",
    trust_score: 0.5,
    interaction_count: 0,
    successful_count: 0,
    failed_count: 0,
    did_document: JSON.stringify({ id: `did:web:x811.org:agents:${id}` }),
    agent_card: JSON.stringify({ name: "Test" }),
    ...overrides,
  });
}

// ===========================================================================
// Trust Score Correctness
// ===========================================================================

describe("TrustService — Correctness Proofs", () => {
  let trust: TrustService;

  beforeEach(() => {
    trust = new TrustService(db);
  });

  // -------------------------------------------------------------------------
  // Initial conditions
  // -------------------------------------------------------------------------

  describe("Initial conditions", () => {
    it("should return 0.5 for a new agent with zero interactions", () => {
      const score = trust.calculateTrustScore({
        successful: 0,
        failed: 0,
        disputes: 0,
        time_active_days: 0,
      });
      expect(score).toBe(0.5);
    });

    it("should insert agent with default trust_score of 0.5 in the DB", () => {
      const agent = createTestAgent();
      const fetched = db.getAgent(agent.id);
      expect(fetched).toBeDefined();
      expect(fetched!.trust_score).toBe(0.5);
    });
  });

  // -------------------------------------------------------------------------
  // Success increases
  // -------------------------------------------------------------------------

  describe("Success increases", () => {
    it("should produce monotonically non-decreasing scores for increasing successes", () => {
      const successCounts = [1, 5, 10, 50, 100];
      const scores = successCounts.map((s) =>
        trust.calculateTrustScore({
          successful: s,
          failed: 0,
          disputes: 0,
          time_active_days: 30,
        }),
      );

      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
      }
    });

    it("should return >= 0.95 for 50+ successes with 0 failures", () => {
      const score = trust.calculateTrustScore({
        successful: 50,
        failed: 0,
        disputes: 0,
        time_active_days: 30,
      });
      expect(score).toBeGreaterThanOrEqual(0.95);
    });

    it("should increment successful_count and interaction_count via recordSuccess", () => {
      const agent = createTestAgent();
      trust.recordSuccess(agent.did);

      const updated = db.getAgent(agent.id);
      expect(updated!.successful_count).toBe(1);
      expect(updated!.interaction_count).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Failure decreases
  // -------------------------------------------------------------------------

  describe("Failure decreases", () => {
    it("should score 90s+10f lower than 100s+0f", () => {
      const scoreMixed = trust.calculateTrustScore({
        successful: 90,
        failed: 10,
        disputes: 0,
        time_active_days: 30,
      });
      const scorePerfect = trust.calculateTrustScore({
        successful: 100,
        failed: 0,
        disputes: 0,
        time_active_days: 30,
      });
      expect(scoreMixed).toBeLessThan(scorePerfect);
    });

    it("should increment failed_count and interaction_count via recordFailure", () => {
      const agent = createTestAgent();
      trust.recordFailure(agent.did);

      const updated = db.getAgent(agent.id);
      expect(updated!.failed_count).toBe(1);
      expect(updated!.interaction_count).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Dispute 3x penalty
  // -------------------------------------------------------------------------

  describe("Dispute 3x penalty", () => {
    it("should make disputes worse than equivalent failures (90s+0f+10d < 90s+10f+0d)", () => {
      const scoreWithFailures = trust.calculateTrustScore({
        successful: 90,
        failed: 10,
        disputes: 0,
        time_active_days: 30,
      });
      const scoreWithDisputes = trust.calculateTrustScore({
        successful: 90,
        failed: 0,
        disputes: 10,
        time_active_days: 30,
      });
      expect(scoreWithDisputes).toBeLessThan(scoreWithFailures);
    });

    it("should treat 3 disputes as approximately equal to 9 failures (within 0.05)", () => {
      const scoreWith9Failures = trust.calculateTrustScore({
        successful: 90,
        failed: 9,
        disputes: 0,
        time_active_days: 30,
      });
      const scoreWith3Disputes = trust.calculateTrustScore({
        successful: 90,
        failed: 0,
        disputes: 3,
        time_active_days: 30,
      });
      // 3 disputes = 3*3 = 9 adjusted failures; raw rate differs slightly
      // due to total denominator, but adjusted component should be close
      expect(Math.abs(scoreWith9Failures - scoreWith3Disputes)).toBeLessThan(0.05);
    });

    it("should resist manipulation: 1000s+50d significantly lower than 1000s+0d", () => {
      const scoreClean = trust.calculateTrustScore({
        successful: 1000,
        failed: 0,
        disputes: 0,
        time_active_days: 90,
      });
      const scoreDirty = trust.calculateTrustScore({
        successful: 1000,
        failed: 0,
        disputes: 50,
        time_active_days: 90,
      });
      // 50 disputes = 150 adjusted failures on a pool of 1000+150
      // Should show a meaningful difference
      expect(scoreDirty).toBeLessThan(scoreClean);
      expect(scoreClean - scoreDirty).toBeGreaterThan(0.05);
    });
  });

  // -------------------------------------------------------------------------
  // Time decay
  // -------------------------------------------------------------------------

  describe("Time decay", () => {
    it("should apply no decay at 0 days", () => {
      expect(trust.applyTimeDecay(0.9, 0)).toBe(0.9);
    });

    it("should apply no decay at 3 days", () => {
      expect(trust.applyTimeDecay(0.9, 3)).toBe(0.9);
    });

    it("should apply no decay at exactly 7 days (grace period boundary)", () => {
      expect(trust.applyTimeDecay(0.9, 7)).toBe(0.9);
    });

    it("should apply gentle decay at 30 days (< 0.9 but > 0.7)", () => {
      const decayed = trust.applyTimeDecay(0.9, 30);
      expect(decayed).toBeLessThan(0.9);
      // decay factor at 30 days = 0.5 + 0.5 * 0.5^((30-7)/60) ~ 0.883
      // 0.9 * 0.883 ~ 0.79 -- gentle enough to stay well above 0.7
      expect(decayed).toBeGreaterThan(0.7);
    });

    it("should apply monotonically increasing decay: 90 days < 30 days", () => {
      const decayed30 = trust.applyTimeDecay(0.9, 30);
      const decayed90 = trust.applyTimeDecay(0.9, 90);
      expect(decayed90).toBeLessThan(decayed30);
    });

    it("should never decay below 0 even for extreme inactivity", () => {
      const decayed = trust.applyTimeDecay(0.01, 365);
      expect(decayed).toBeGreaterThanOrEqual(0);
    });
  });

  // -------------------------------------------------------------------------
  // Score bounds
  // -------------------------------------------------------------------------

  describe("Score bounds", () => {
    it("should keep extreme negative inputs within [0, 1]", () => {
      const score = trust.calculateTrustScore({
        successful: 0,
        failed: 100,
        disputes: 50,
        time_active_days: 1,
      });
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it("should keep extreme positive inputs within [0, 1]", () => {
      const score = trust.calculateTrustScore({
        successful: 1000,
        failed: 0,
        disputes: 0,
        time_active_days: 365,
      });
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // Trust gating
  // -------------------------------------------------------------------------

  describe("Trust gating", () => {
    it("should support trust_min filtering via listAgents", () => {
      // This verifies the AcceptancePolicy trust gating works at the DB level
      createTestAgent({ trust_score: 0.3 });
      createTestAgent({ trust_score: 0.9 });

      const highTrust = db.listAgents({ trust_min: 0.8 });
      expect(highTrust.total).toBe(1);
      expect(highTrust.agents[0].trust_score).toBe(0.9);

      const allAgents = db.listAgents({ trust_min: 0.2 });
      expect(allAgents.total).toBe(2);
    });

    it("should filter agents by trust_min threshold correctly", () => {
      createTestAgent({ trust_score: 0.1 });
      createTestAgent({ trust_score: 0.5 });
      createTestAgent({ trust_score: 0.7 });
      createTestAgent({ trust_score: 0.95 });

      const result = db.listAgents({ trust_min: 0.6 });
      expect(result.total).toBe(2);
      for (const agent of result.agents) {
        expect(agent.trust_score).toBeGreaterThanOrEqual(0.6);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Formula weights verification
  // -------------------------------------------------------------------------

  describe("Formula weights", () => {
    it("should produce expected output for known inputs (manual calculation)", () => {
      // For 80 successful, 10 failed, 10 disputes:
      // total = 80 + 10 + 10 = 100
      // raw success rate = 80 / 100 = 0.8
      // adjusted failures = 10 + 10*3 = 40
      // adjusted total = 80 + 40 = 120
      // adjusted rate = 80 / 120 = 0.6667
      // activity factor = min(1, log10(101) / 3) = min(1, 2.004/3) = min(1, 0.668) = 0.668
      // raw score = 0.7 * 0.6667 + 0.2 * 0.8 + 0.1 * 0.668
      //           = 0.4667 + 0.16 + 0.0668
      //           = 0.6935
      // Clamped and rounded to 2 decimals = 0.69
      const score = trust.calculateTrustScore({
        successful: 80,
        failed: 10,
        disputes: 10,
        time_active_days: 30,
      });
      expect(score).toBe(0.69);
    });

    it("should have logarithmic activity bonus: log10(n+1)/3 capped at 1.0", () => {
      // Verify the activity bonus contribution at different scales
      // For 100% success rate: score = 0.7*1 + 0.2*1 + 0.1*activity = 0.9 + 0.1*activity
      const bonus = (n: number) => {
        const score = trust.calculateTrustScore({
          successful: n,
          failed: 0,
          disputes: 0,
          time_active_days: 30,
        });
        // score = 0.9 + 0.1 * min(1, log10(n+1)/3)
        // activity = (score - 0.9) / 0.1
        return Math.round(((score - 0.9) / 0.1) * 100) / 100;
      };

      // log10(2)/3 ~ 0.100, log10(11)/3 ~ 0.347, log10(101)/3 ~ 0.668, log10(1001)/3 ~ 1.0
      const b1 = bonus(1);
      const b10 = bonus(10);
      const b100 = bonus(100);
      const b1000 = bonus(1000);

      // Activity bonus should increase logarithmically
      expect(b10).toBeGreaterThan(b1);
      expect(b100).toBeGreaterThan(b10);
      expect(b1000).toBeGreaterThanOrEqual(b100);

      // At 1000 interactions, log10(1001)/3 ~ 1.0 so bonus caps at 1.0
      expect(b1000).toBeGreaterThanOrEqual(0.99);
    });
  });
});
