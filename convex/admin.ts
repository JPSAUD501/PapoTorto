import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
const convexInternal = internal as any;
import { DEFAULT_SCORES } from "./constants";
import { getEngineState, getOrCreateEngineState, normalizeScoreRecord } from "./state";
import { toClientRound } from "./rounds";

async function readViewerCount(ctx: any): Promise<number> {
  const rows = await ctx.db.query("viewerCountShards").collect();
  return rows.reduce((sum: number, row: any) => sum + row.count, 0);
}

export const getSnapshot = internalQuery({
  args: {},
  returns: v.object({
    isPaused: v.boolean(),
    isRunningRound: v.boolean(),
    done: v.boolean(),
    completedInMemory: v.number(),
    persistedRounds: v.number(),
    viewerCount: v.number(),
  }),
  handler: async (ctx) => {
    const state = await getEngineState(ctx as any);
    if (!state) {
      return {
        isPaused: false,
        isRunningRound: false,
        done: false,
        completedInMemory: 0,
        persistedRounds: 0,
        viewerCount: 0,
      };
    }

    const doneRounds = await ctx.db
      .query("rounds")
      .withIndex("by_generation_and_phase", (q: any) =>
        q.eq("generation", state.generation).eq("phase", "done"),
      )
      .collect();

    return {
      isPaused: state.isPaused,
      isRunningRound: Boolean(state.activeRoundId),
      done: state.done,
      completedInMemory: state.completedRounds,
      persistedRounds: doneRounds.length,
      viewerCount: await readViewerCount(ctx),
    };
  },
});

export const pause = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const state = await getOrCreateEngineState(ctx as any);
    await ctx.db.patch(state._id, {
      isPaused: true,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const resume = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const state = await getOrCreateEngineState(ctx as any);
    await ctx.db.patch(state._id, {
      isPaused: false,
      done: false,
      updatedAt: Date.now(),
    });

    const now = Date.now();
    const validLease = Boolean(state.runnerLeaseId && state.runnerLeaseUntil && state.runnerLeaseUntil > now);
    if (!validLease) {
      const leaseId = crypto.randomUUID();
      await ctx.db.patch(state._id, {
        runnerLeaseId: leaseId,
        runnerLeaseUntil: now + 60_000,
        updatedAt: now,
      });
      await ctx.scheduler.runAfter(0, convexInternal.engine.runLoop, { leaseId });
    }

    return null;
  },
});

export const reset = internalMutation({
  args: {},
  returns: v.object({ generation: v.number() }),
  handler: async (ctx) => {
    const state = await getOrCreateEngineState(ctx as any);
    const oldGeneration = state.generation;
    const nextGeneration = oldGeneration + 1;

    await ctx.db.patch(state._id, {
      generation: nextGeneration,
      isPaused: true,
      done: false,
      nextRoundNum: 1,
      activeRoundId: undefined,
      lastCompletedRoundId: undefined,
      completedRounds: 0,
      scores: { ...DEFAULT_SCORES },
      humanScores: { ...DEFAULT_SCORES },
      humanVoteTotals: { ...DEFAULT_SCORES },
      runnerLeaseId: undefined,
      runnerLeaseUntil: undefined,
      reaperScheduledAt: undefined,
      updatedAt: Date.now(),
    });

    const presences = await ctx.db.query("viewerPresence").collect();
    for (const row of presences) {
      await ctx.db.delete(row._id);
    }

    const shards = await ctx.db.query("viewerCountShards").collect();
    for (const shard of shards) {
      await ctx.db.patch(shard._id, { count: 0, updatedAt: Date.now() });
    }

    await ctx.scheduler.runAfter(0, convexInternal.admin.purgeGenerationRoundBatch, {
      generation: oldGeneration,
      cursor: undefined,
      numItems: 500,
    });
    await ctx.scheduler.runAfter(0, convexInternal.admin.purgeGenerationViewerVoteBatch, {
      generation: oldGeneration,
      cursor: undefined,
      numItems: 500,
    });
    await ctx.scheduler.runAfter(0, convexInternal.admin.purgeGenerationTalliesBatch, {
      generation: oldGeneration,
      cursor: undefined,
      numItems: 500,
    });

    return { generation: nextGeneration };
  },
});

export const backfillEngineStateHumanScores = internalMutation({
  args: {},
  returns: v.object({ updated: v.boolean() }),
  handler: async (ctx) => {
    const state = await getOrCreateEngineState(ctx as any);
    const hasHumanScores = state.humanScores !== undefined;
    const hasHumanVoteTotals = state.humanVoteTotals !== undefined;
    if (hasHumanScores && hasHumanVoteTotals) {
      return { updated: false };
    }

    await ctx.db.patch(state._id, {
      humanScores: normalizeScoreRecord(state.humanScores),
      humanVoteTotals: normalizeScoreRecord(state.humanVoteTotals),
      updatedAt: Date.now(),
    });

    return { updated: true };
  },
});

export const getExportData = internalQuery({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const state = await getEngineState(ctx as any);
    if (!state) {
      return {
        exportedAt: new Date().toISOString(),
        state: null,
        rounds: [],
      };
    }

    const rounds = await ctx.db
      .query("rounds")
      .withIndex("by_generation_and_num", (q: any) => q.eq("generation", state.generation))
      .collect();

    return {
      exportedAt: new Date().toISOString(),
      state,
      rounds: rounds.map((round: any) => toClientRound(round)).filter(Boolean),
    };
  },
});

export const purgeGenerationRoundBatch = internalMutation({
  args: {
    generation: v.number(),
    cursor: v.optional(v.string()),
    numItems: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("rounds")
      .withIndex("by_generation_and_num", (q: any) => q.eq("generation", args.generation))
      .paginate({ cursor: args.cursor ?? null, numItems: args.numItems });

    for (const row of result.page) {
      await ctx.db.delete(row._id);
    }

    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, convexInternal.admin.purgeGenerationRoundBatch, {
        generation: args.generation,
        cursor: result.continueCursor,
        numItems: args.numItems,
      });
    }

    return null;
  },
});

export const purgeGenerationViewerVoteBatch = internalMutation({
  args: {
    generation: v.number(),
    cursor: v.optional(v.string()),
    numItems: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("viewerVotes")
      .withIndex("by_generation", (q: any) => q.eq("generation", args.generation))
      .paginate({ cursor: args.cursor ?? null, numItems: args.numItems });

    for (const row of result.page) {
      await ctx.db.delete(row._id);
    }

    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, convexInternal.admin.purgeGenerationViewerVoteBatch, {
        generation: args.generation,
        cursor: result.continueCursor,
        numItems: args.numItems,
      });
    }

    return null;
  },
});

export const purgeGenerationTalliesBatch = internalMutation({
  args: {
    generation: v.number(),
    cursor: v.optional(v.string()),
    numItems: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("viewerVoteTallies")
      .withIndex("by_generation", (q: any) => q.eq("generation", args.generation))
      .paginate({ cursor: args.cursor ?? null, numItems: args.numItems });

    for (const row of result.page) {
      await ctx.db.delete(row._id);
    }

    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, convexInternal.admin.purgeGenerationTalliesBatch, {
        generation: args.generation,
        cursor: result.continueCursor,
        numItems: args.numItems,
      });
    }

    return null;
  },
});

