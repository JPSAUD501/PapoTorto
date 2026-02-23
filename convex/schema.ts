import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const modelValidator = v.object({
  id: v.string(),
  name: v.string(),
});

const taskValidator = v.object({
  model: modelValidator,
  startedAt: v.number(),
  finishedAt: v.optional(v.number()),
  result: v.optional(v.string()),
  error: v.optional(v.string()),
});

const storedVoteValidator = v.object({
  voter: modelValidator,
  startedAt: v.number(),
  finishedAt: v.optional(v.number()),
  votedForSide: v.optional(v.union(v.literal("A"), v.literal("B"))),
  error: v.optional(v.boolean()),
});

export default defineSchema({
  engineState: defineTable({
    key: v.literal("main"),
    generation: v.number(),
    isPaused: v.boolean(),
    done: v.boolean(),
    runsMode: v.union(v.literal("infinite"), v.literal("finite")),
    totalRounds: v.optional(v.number()),
    nextRoundNum: v.number(),
    activeRoundId: v.optional(v.id("rounds")),
    lastCompletedRoundId: v.optional(v.id("rounds")),
    scores: v.record(v.string(), v.number()),
    humanScores: v.optional(v.record(v.string(), v.number())),
    humanVoteTotals: v.optional(v.record(v.string(), v.number())),
    completedRounds: v.number(),
    updatedAt: v.number(),
    runnerLeaseId: v.optional(v.string()),
    runnerLeaseUntil: v.optional(v.number()),
    reaperScheduledAt: v.optional(v.number()),
    platformPollScheduledAt: v.optional(v.number()),
  }).index("by_key", ["key"]),

  rounds: defineTable({
    generation: v.number(),
    num: v.number(),
    phase: v.union(
      v.literal("prompting"),
      v.literal("answering"),
      v.literal("voting"),
      v.literal("done"),
    ),
    prompter: modelValidator,
    promptTask: taskValidator,
    prompt: v.optional(v.string()),
    contestants: v.array(modelValidator),
    answerTasks: v.array(taskValidator),
    votes: v.array(storedVoteValidator),
    scoreA: v.optional(v.number()),
    scoreB: v.optional(v.number()),
    viewerVotesA: v.optional(v.number()),
    viewerVotesB: v.optional(v.number()),
    viewerVotingEndsAt: v.optional(v.number()),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_generation_and_num", ["generation", "num"])
    .index("by_generation_and_completedAt", ["generation", "completedAt"])
    .index("by_generation_and_phase", ["generation", "phase"]),

  viewerVotes: defineTable({
    generation: v.number(),
    roundId: v.id("rounds"),
    viewerId: v.string(),
    side: v.union(v.literal("A"), v.literal("B")),
    shard: v.number(),
    updatedAt: v.number(),
  })
    .index("by_round_and_viewer", ["roundId", "viewerId"])
    .index("by_round", ["roundId"])
    .index("by_generation", ["generation"]),

  viewerVoteTallies: defineTable({
    generation: v.number(),
    roundId: v.id("rounds"),
    side: v.union(v.literal("A"), v.literal("B")),
    shard: v.number(),
    count: v.number(),
    updatedAt: v.number(),
  })
    .index("by_round_side_shard", ["roundId", "side", "shard"])
    .index("by_round", ["roundId"])
    .index("by_generation", ["generation"]),

  viewerPresence: defineTable({
    viewerId: v.string(),
    page: v.union(v.literal("live"), v.literal("broadcast")),
    expiresAt: v.number(),
    lastSeenAt: v.number(),
    countShard: v.number(),
    updatedAt: v.number(),
  })
    .index("by_viewerId", ["viewerId"])
    .index("by_expiresAt", ["expiresAt"])
    .index("by_page_and_expiresAt", ["page", "expiresAt"]),

  viewerCountShards: defineTable({
    shard: v.number(),
    count: v.number(),
    updatedAt: v.number(),
  }).index("by_shard", ["shard"]),

  viewerTargets: defineTable({
    platform: v.union(v.literal("twitch"), v.literal("youtube")),
    target: v.string(),
    enabled: v.boolean(),
    viewerCount: v.number(),
    isLive: v.boolean(),
    lastPolledAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    updatedAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_enabled", ["enabled"])
    .index("by_platform_and_target", ["platform", "target"])
    .index("by_platform", ["platform"]),
});
