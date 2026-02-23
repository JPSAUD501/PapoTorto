import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
const convexInternal = internal as any;
import { RUNNER_LEASE_MS } from "./constants";
import { toClientRound } from "./rounds";
import { getEngineState, getOrCreateEngineState, normalizeScoreRecord } from "./state";

async function readViewerCount(ctx: any): Promise<number> {
  const rows = await ctx.db.query("viewerCountShards").collect();
  return rows.reduce((sum: number, row: any) => sum + row.count, 0);
}

export const getState = query({
  args: {},
  returns: v.object({
    data: v.object({
      active: v.union(v.any(), v.null()),
      lastCompleted: v.union(v.any(), v.null()),
      scores: v.record(v.string(), v.number()),
      humanScores: v.record(v.string(), v.number()),
      humanVoteTotals: v.record(v.string(), v.number()),
      done: v.boolean(),
      isPaused: v.boolean(),
      generation: v.number(),
    }),
    totalRounds: v.union(v.number(), v.null()),
    viewerCount: v.number(),
  }),
  handler: async (ctx) => {
    const state = await getEngineState(ctx as any);
    if (!state) {
      return {
        data: {
          active: null,
          lastCompleted: null,
          scores: {},
          humanScores: {},
          humanVoteTotals: {},
          done: false,
          isPaused: false,
          generation: 1,
        },
        totalRounds: null,
        viewerCount: 0,
      };
    }

    const activeRound = state.activeRoundId ? await ctx.db.get(state.activeRoundId) : null;
    const lastCompletedRound = state.lastCompletedRoundId
      ? await ctx.db.get(state.lastCompletedRoundId)
      : null;

    let activeClient = toClientRound(activeRound);
    if (activeRound?.phase === "voting") {
      const tallies = await ctx.db
        .query("viewerVoteTallies")
        .withIndex("by_round", (q: any) => q.eq("roundId", activeRound._id))
        .collect();
      const viewerVotesA = tallies
        .filter((x: any) => x.side === "A")
        .reduce((sum: number, x: any) => sum + x.count, 0);
      const viewerVotesB = tallies
        .filter((x: any) => x.side === "B")
        .reduce((sum: number, x: any) => sum + x.count, 0);
      if (activeClient) {
        activeClient = {
          ...activeClient,
          viewerVotesA,
          viewerVotesB,
        };
      }
    }

    return {
      data: {
        active: activeClient,
        lastCompleted: toClientRound(lastCompletedRound),
        scores: state.scores,
        humanScores: normalizeScoreRecord(state.humanScores),
        humanVoteTotals: normalizeScoreRecord(state.humanVoteTotals),
        done: state.done,
        isPaused: state.isPaused,
        generation: state.generation,
      },
      totalRounds: state.runsMode === "finite" ? (state.totalRounds ?? null) : null,
      viewerCount: await readViewerCount(ctx),
    };
  },
});

async function ensureStartedImpl(ctx: any) {
  const now = Date.now();
  const state = await getOrCreateEngineState(ctx as any);
  if (state.humanScores === undefined || state.humanVoteTotals === undefined) {
    await ctx.db.patch(state._id, {
      humanScores: normalizeScoreRecord(state.humanScores),
      humanVoteTotals: normalizeScoreRecord(state.humanVoteTotals),
      updatedAt: now,
    });
  }

  const hasValidLease = Boolean(state.runnerLeaseId && state.runnerLeaseUntil && state.runnerLeaseUntil > now);
  if (!hasValidLease) {
    const leaseId = crypto.randomUUID();
    await ctx.db.patch(state._id, {
      runnerLeaseId: leaseId,
      runnerLeaseUntil: now + RUNNER_LEASE_MS,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, convexInternal.engine.runLoop, { leaseId });
  }
}

export const ensureStarted = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ensureStartedImpl(ctx);
    return null;
  },
});

export const ensureStartedInternal = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ensureStartedImpl(ctx);
    return null;
  },
});

