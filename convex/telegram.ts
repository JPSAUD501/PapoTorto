import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { TELEGRAM_UPDATES_POLL_INTERVAL_MS, hashToShard } from "./constants";
import { getEngineState } from "./state";

const convexInternal = internal as any;

function normalizeNumber(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.floor(numeric));
}

function normalizeTelegramToken(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTelegramChannelId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isTelegramConfigured(state: {
  telegramEnabled?: unknown;
  telegramBotToken?: unknown;
  telegramChannelId?: unknown;
} | null): boolean {
  if (!state || state.telegramEnabled !== true) return false;
  return Boolean(normalizeTelegramToken(state.telegramBotToken) && normalizeTelegramChannelId(state.telegramChannelId));
}

function getPollIntervalMs(): number {
  const raw = Number.parseInt(process.env.TELEGRAM_UPDATES_POLL_INTERVAL_MS ?? "", 10);
  if (!Number.isFinite(raw) || raw <= 0) return TELEGRAM_UPDATES_POLL_INTERVAL_MS;
  return raw;
}

function pollShard(pollId: string): number {
  return hashToShard(`telegram:poll:${pollId}`);
}

async function getPollingStateRow(ctx: any) {
  return await ctx.db
    .query("telegramPollingState")
    .withIndex("by_key", (q: any) => q.eq("key", "main"))
    .first();
}

async function getOrCreatePollingState(ctx: any) {
  const existing = await getPollingStateRow(ctx);
  if (existing) return existing;
  const id = await ctx.db.insert("telegramPollingState", {
    key: "main",
    updatedAt: Date.now(),
  });
  return await ctx.db.get(id);
}

async function adjustVoteTally(
  ctx: any,
  roundId: any,
  generation: number,
  side: "A" | "B",
  shard: number,
  delta: number,
) {
  if (delta === 0) return;

  const row = await ctx.db
    .query("viewerVoteTallies")
    .withIndex("by_round_side_shard", (q: any) =>
      q.eq("roundId", roundId).eq("side", side).eq("shard", shard),
    )
    .first();

  const now = Date.now();
  if (!row) {
    if (delta <= 0) return;
    await ctx.db.insert("viewerVoteTallies", {
      generation,
      roundId,
      side,
      shard,
      count: delta,
      updatedAt: now,
    });
    return;
  }

  await ctx.db.patch(row._id, {
    count: Math.max(0, row.count + delta),
    updatedAt: now,
  });
}

export const getRoundPollByRoundId = internalQuery({
  args: {
    roundId: v.id("rounds"),
  },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("telegramRoundPolls")
      .withIndex("by_roundId", (q: any) => q.eq("roundId", args.roundId))
      .first();
  },
});

export const getPollingState = internalQuery({
  args: {},
  returns: v.union(v.any(), v.null()),
  handler: async (ctx) => {
    return await getPollingStateRow(ctx);
  },
});

export const syncPollCounts = internalMutation({
  args: {
    pollId: v.string(),
    votesA: v.number(),
    votesB: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("telegramRoundPolls")
      .withIndex("by_pollId", (q: any) => q.eq("pollId", args.pollId))
      .first();
    if (!row) return null;

    const nextA = normalizeNumber(args.votesA);
    const nextB = normalizeNumber(args.votesB);
    const deltaA = nextA - normalizeNumber(row.votesA);
    const deltaB = nextB - normalizeNumber(row.votesB);
    const shard = pollShard(row.pollId);

    if (deltaA !== 0) {
      await adjustVoteTally(ctx, row.roundId, row.generation, "A", shard, deltaA);
    }
    if (deltaB !== 0) {
      await adjustVoteTally(ctx, row.roundId, row.generation, "B", shard, deltaB);
    }

    await ctx.db.patch(row._id, {
      votesA: nextA,
      votesB: nextB,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const upsertRoundPoll = internalMutation({
  args: {
    generation: v.number(),
    roundId: v.id("rounds"),
    pollId: v.string(),
    chatId: v.string(),
    messageId: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existingByRound = await ctx.db
      .query("telegramRoundPolls")
      .withIndex("by_roundId", (q: any) => q.eq("roundId", args.roundId))
      .first();
    if (existingByRound) {
      return null;
    }

    const existingByPoll = await ctx.db
      .query("telegramRoundPolls")
      .withIndex("by_pollId", (q: any) => q.eq("pollId", args.pollId))
      .first();
    if (existingByPoll) {
      return null;
    }

    const now = Date.now();
    await ctx.db.insert("telegramRoundPolls", {
      generation: args.generation,
      roundId: args.roundId,
      pollId: args.pollId,
      chatId: args.chatId,
      messageId: args.messageId,
      votesA: 0,
      votesB: 0,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return null;
  },
});

export const setRoundPollStatus = internalMutation({
  args: {
    roundId: v.id("rounds"),
    status: v.union(v.literal("active"), v.literal("closed"), v.literal("deleted"), v.literal("error")),
    lastError: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("telegramRoundPolls")
      .withIndex("by_roundId", (q: any) => q.eq("roundId", args.roundId))
      .first();
    if (!row) return null;
    await ctx.db.patch(row._id, {
      status: args.status,
      lastError: args.lastError,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const recordPollingSuccess = internalMutation({
  args: {
    lastUpdateId: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await getOrCreatePollingState(ctx);
    if (!row) return null;

    const now = Date.now();
    const patch: Record<string, unknown> = {};
    let changed = false;

    const prevLastPolledAt =
      typeof row.lastPolledAt === "number" && Number.isFinite(row.lastPolledAt)
        ? row.lastPolledAt
        : 0;
    if (now - prevLastPolledAt >= 60_000) {
      patch.lastPolledAt = now;
      changed = true;
    }

    if (typeof args.lastUpdateId === "number" && Number.isFinite(args.lastUpdateId)) {
      const nextUpdateId = Math.floor(args.lastUpdateId);
      if (row.lastUpdateId !== nextUpdateId) {
        patch.lastUpdateId = nextUpdateId;
        changed = true;
      }
    }

    if (row.lastError !== undefined) {
      patch.lastError = undefined;
      changed = true;
    }

    if (!changed) return null;
    patch.updatedAt = now;
    await ctx.db.patch(row._id, patch);
    return null;
  },
});

export const setPollingError = internalMutation({
  args: {
    message: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await getOrCreatePollingState(ctx);
    if (!row) return null;
    const now = Date.now();
    if (row.lastError === args.message && typeof row.lastPolledAt === "number" && now - row.lastPolledAt < 10_000) {
      return null;
    }
    await ctx.db.patch(row._id, {
      lastError: args.message,
      lastPolledAt: now,
      updatedAt: now,
    });
    return null;
  },
});

export const clearPollingError = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const row = await getPollingStateRow(ctx);
    if (!row || row.lastError === undefined) {
      return null;
    }
    await ctx.db.patch(row._id, {
      lastError: undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const resetPollingState = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const row = await getOrCreatePollingState(ctx);
    if (!row) return null;
    await ctx.db.patch(row._id, {
      lastUpdateId: undefined,
      lastPolledAt: undefined,
      lastError: undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const ensurePollingStarted = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const state = await getEngineState(ctx as any);
    if (!state) return null;
    if (!isTelegramConfigured(state)) return null;

    await ctx.scheduler.runAfter(0, convexInternal.telegramActions.pollUpdates, {});
    return null;
  },
});

export const scheduleNextPoll = internalMutation({
  args: {
    shouldSchedule: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!args.shouldSchedule) return null;
    const interval = getPollIntervalMs();
    await ctx.scheduler.runAfter(interval, convexInternal.telegramActions.pollUpdates, {});
    return null;
  },
});

