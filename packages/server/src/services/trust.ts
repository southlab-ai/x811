/**
 * x811 Protocol — Trust Service.
 *
 * Calculates and manages agent trust scores based on interaction history.
 *
 * Trust score range: 0.0 - 1.0
 * New agent default: 0.5
 *
 * Formula: 70% adjusted_rate + 20% raw_success + 10% activity_bonus
 * - Disputes carry a 3x penalty multiplier
 * - Activity bonus: min(1, log10(total + 1) / 3)
 * - Inactive agents receive gradual time decay
 */

import type { Database } from "../db/schema.js";

export interface TrustScoreInputs {
  successful: number;
  failed: number;
  disputes: number;
  time_active_days: number;
}

export class TrustService {
  constructor(private db: Database) {}

  /**
   * Calculate a trust score from raw interaction counts.
   *
   * New agents (zero interactions) receive the neutral score of 0.5.
   */
  calculateTrustScore(inputs: TrustScoreInputs): number {
    const { successful, failed, disputes, time_active_days: _timeActiveDays } = inputs;
    const total = successful + failed + disputes;

    // New agent — neutral score
    if (total === 0) return 0.5;

    // Raw success rate
    const successRate = successful / total;

    // Activity bonus: logarithmic scaling — rewards consistent usage
    const activityFactor = Math.min(1.0, Math.log10(total + 1) / 3);

    // Adjusted rate: disputes count 3x as failures
    const adjustedFailures = failed + disputes * 3;
    const adjustedTotal = successful + adjustedFailures;
    const adjustedRate = adjustedTotal > 0 ? successful / adjustedTotal : 0;

    // Weighted composite score
    const rawScore =
      0.7 * adjustedRate + 0.2 * successRate + 0.1 * activityFactor;

    // Clamp to [0, 1] and round to 2 decimal places
    return Math.round(Math.max(0, Math.min(1, rawScore)) * 100) / 100;
  }

  /**
   * Recalculate trust score for an agent from their interaction history
   * stored in the database, and update the agent record.
   */
  updateTrustScore(agentDid: string): number {
    const agent = this.db.getAgentByDid(agentDid);
    if (!agent) {
      throw new Error(`Agent not found: ${agentDid}`);
    }

    // Compute days active
    const createdAt = new Date(agent.created_at).getTime();
    const now = Date.now();
    const timeActiveDays = Math.max(
      0,
      (now - createdAt) / (1000 * 60 * 60 * 24),
    );

    // For disputes, count interactions with outcome = 'dispute'
    // We use the agent's stored counts plus query disputed interactions
    const disputeCountStmt = this.db.raw.prepare(
      `SELECT COUNT(*) as count FROM interactions
       WHERE (initiator_did = ? OR provider_did = ?) AND outcome = 'dispute'`,
    );
    const { count: disputes } = disputeCountStmt.get(agentDid, agentDid) as {
      count: number;
    };

    const score = this.calculateTrustScore({
      successful: agent.successful_count,
      failed: agent.failed_count,
      disputes,
      time_active_days: timeActiveDays,
    });

    // Apply time decay if the agent has been inactive
    const lastSeenAt = agent.last_seen_at
      ? new Date(agent.last_seen_at).getTime()
      : createdAt;
    const daysSinceActive = Math.max(
      0,
      (now - lastSeenAt) / (1000 * 60 * 60 * 24),
    );
    const finalScore = this.applyTimeDecay(score, daysSinceActive);

    this.db.updateAgent(agent.id, { trust_score: finalScore });

    return finalScore;
  }

  /**
   * Apply gradual time decay for inactive agents.
   *
   * Decay begins after 7 days of inactivity and approaches 50% of the
   * original score as inactivity increases. The decay follows a sigmoid-like
   * curve to avoid sudden drops.
   *
   * - 0-7 days: no decay
   * - 7-30 days: gentle decay (up to ~10% reduction)
   * - 30-90 days: moderate decay (up to ~25% reduction)
   * - 90+ days: significant decay (approaching 50% of original)
   */
  applyTimeDecay(score: number, daysSinceActive: number): number {
    if (daysSinceActive <= 7) return score;

    // Decay factor: starts at 1.0, decays toward 0.5
    // Uses an exponential decay with a half-life of ~60 days
    const decayDays = daysSinceActive - 7; // grace period
    const halfLife = 60;
    const decayFactor = 0.5 + 0.5 * Math.pow(0.5, decayDays / halfLife);

    const decayed = score * decayFactor;
    return Math.round(Math.max(0, Math.min(1, decayed)) * 100) / 100;
  }

  /**
   * Increment an agent's successful interaction count.
   */
  recordSuccess(agentDid: string): void {
    const agent = this.db.getAgentByDid(agentDid);
    if (!agent) return;
    this.db.updateAgent(agent.id, {
      successful_count: agent.successful_count + 1,
      interaction_count: agent.interaction_count + 1,
    });
    this.updateTrustScore(agentDid);
  }

  /**
   * Increment an agent's failed interaction count.
   */
  recordFailure(agentDid: string): void {
    const agent = this.db.getAgentByDid(agentDid);
    if (!agent) return;
    this.db.updateAgent(agent.id, {
      failed_count: agent.failed_count + 1,
      interaction_count: agent.interaction_count + 1,
    });
    this.updateTrustScore(agentDid);
  }
}
