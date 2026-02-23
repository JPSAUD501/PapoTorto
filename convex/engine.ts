"use node";

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
const convexInternal = internal as any;
import {
  DEFAULT_SCORES,
  POST_ROUND_DELAY_MS,
  RUNNER_LEASE_MS,
  VIEWER_VOTE_WINDOW_ACTIVE_MS,
  VIEWER_VOTE_WINDOW_IDLE_MS,
  sleep,
  shuffle,
} from "./constants";
import { MODELS, type Model } from "../shared/models";
import { callGenerateAnswer, callGeneratePrompt, callVote } from "./ai";
import { getEngineState, getOrCreateEngineState, isFiniteRuns } from "./state";
import { readTotalViewerCount } from "./viewerCount";

function getVotingWindowMs(totalViewerCount: number): number {
  return totalViewerCount > 0 ? VIEWER_VOTE_WINDOW_ACTIVE_MS : VIEWER_VOTE_WINDOW_IDLE_MS;
}

function pickRoundModels(): {
  prompter: Model;
  contestants: [Model, Model];
  voters: Model[];
} {
  const shuffled = shuffle([...MODELS]);
  const prompter = shuffled[0]!;
  const contA = shuffled[1]!;
  const contB = shuffled[2]!;
  return {
    prompter,
    contestants: [contA, contB],
    voters: [prompter, ...shuffled.slice(3)],
  };
}

async function leaseStillValid(ctx: any, leaseId: string, generation: number): Promise<boolean> {
  const state = await ctx.runQuery(convexInternal.engine.getRunnerState, {});
  if (!state) return false;
  if (state.generation !== generation) return false;
  if (state.runnerLeaseId !== leaseId) return false;
  if (!state.runnerLeaseUntil || state.runnerLeaseUntil <= Date.now()) return false;
  return true;
}

export const getRunnerState = internalQuery({
  args: {},
  returns: v.union(v.any(), v.null()),
  handler: async (ctx) => {
    const state = await getEngineState(ctx as any);
    return state ?? null;
  },
});

export const renewLease = internalMutation({
  args: {
    leaseId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const state = await getOrCreateEngineState(ctx as any);
    if (state.runnerLeaseId !== args.leaseId) return false;
    await ctx.db.patch(state._id, {
      runnerLeaseUntil: Date.now() + RUNNER_LEASE_MS,
      updatedAt: Date.now(),
    });
    return true;
  },
});

export const createRound = internalMutation({
  args: {
    expectedGeneration: v.number(),
    prompter: v.object({ id: v.string(), name: v.string() }),
    contestants: v.array(v.object({ id: v.string(), name: v.string() })),
  },
  returns: v.union(v.object({ roundId: v.id("rounds"), num: v.number() }), v.null()),
  handler: async (ctx, args) => {
    const state = await getOrCreateEngineState(ctx as any);
    if (state.generation !== args.expectedGeneration) return null;
    if (state.activeRoundId) return null;
    if (state.done) return null;

    const now = Date.now();
    const num = state.nextRoundNum;
    const roundId = await ctx.db.insert("rounds", {
      generation: state.generation,
      num,
      phase: "prompting",
      prompter: args.prompter,
      promptTask: {
        model: args.prompter,
        startedAt: now,
      },
      contestants: args.contestants,
      answerTasks: [
        { model: args.contestants[0]!, startedAt: 0 },
        { model: args.contestants[1]!, startedAt: 0 },
      ],
      votes: [],
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.patch(state._id, {
      activeRoundId: roundId,
      updatedAt: now,
    });

    return { roundId, num };
  },
});

export const setPromptResult = internalMutation({
  args: {
    expectedGeneration: v.number(),
    roundId: v.id("rounds"),
    prompt: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const state = await getEngineState(ctx as any);
    const round = await ctx.db.get(args.roundId);
    if (!state || !round) return false;
    if (state.generation !== args.expectedGeneration || round.generation !== args.expectedGeneration) return false;

    await ctx.db.patch(args.roundId, {
      prompt: args.prompt,
      promptTask: {
        ...round.promptTask,
        finishedAt: Date.now(),
        result: args.prompt,
        error: undefined,
      },
      updatedAt: Date.now(),
    });
    return true;
  },
});

export const setPromptError = internalMutation({
  args: {
    expectedGeneration: v.number(),
    roundId: v.id("rounds"),
    error: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const state = await getEngineState(ctx as any);
    const round = await ctx.db.get(args.roundId);
    if (!state || !round) return false;
    if (state.generation !== args.expectedGeneration || round.generation !== args.expectedGeneration) return false;

    await ctx.db.patch(args.roundId, {
      phase: "done",
      promptTask: {
        ...round.promptTask,
        finishedAt: Date.now(),
        error: args.error,
      },
      completedAt: Date.now(),
      updatedAt: Date.now(),
    });

    await ctx.db.patch(state._id, {
      lastCompletedRoundId: args.roundId,
      activeRoundId: undefined,
      completedRounds: state.completedRounds + 1,
      nextRoundNum: state.nextRoundNum + 1,
      updatedAt: Date.now(),
    });

    return true;
  },
});

export const startAnswering = internalMutation({
  args: {
    expectedGeneration: v.number(),
    roundId: v.id("rounds"),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const state = await getEngineState(ctx as any);
    const round = await ctx.db.get(args.roundId);
    if (!state || !round) return false;
    if (state.generation !== args.expectedGeneration || round.generation !== args.expectedGeneration) return false;

    const answerStart = Date.now();
    const tasks = [
      { ...round.answerTasks[0], startedAt: answerStart },
      { ...round.answerTasks[1], startedAt: answerStart },
    ];

    await ctx.db.patch(args.roundId, {
      phase: "answering",
      answerTasks: tasks,
      updatedAt: Date.now(),
    });
    return true;
  },
});

export const setAnswerResult = internalMutation({
  args: {
    expectedGeneration: v.number(),
    roundId: v.id("rounds"),
    answerIndex: v.number(),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const state = await getEngineState(ctx as any);
    const round = await ctx.db.get(args.roundId);
    if (!state || !round) return false;
    if (state.generation !== args.expectedGeneration || round.generation !== args.expectedGeneration) return false;
    if (args.answerIndex !== 0 && args.answerIndex !== 1) return false;

    const task = round.answerTasks[args.answerIndex];
    const updatedTask = {
      ...task,
      finishedAt: Date.now(),
      result: args.result ?? task?.result ?? "[no answer]",
      error: args.error,
    };

    const answerTasks = [...round.answerTasks];
    answerTasks[args.answerIndex] = updatedTask;

    await ctx.db.patch(args.roundId, {
      answerTasks,
      updatedAt: Date.now(),
    });

    return true;
  },
});

export const startVoting = internalMutation({
  args: {
    expectedGeneration: v.number(),
    roundId: v.id("rounds"),
    voters: v.array(v.object({ id: v.string(), name: v.string() })),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const state = await getEngineState(ctx as any);
    const round = await ctx.db.get(args.roundId);
    if (!state || !round) return false;
    if (state.generation !== args.expectedGeneration || round.generation !== args.expectedGeneration) return false;

    const voteStart = Date.now();
    const totalViewerCount = await readTotalViewerCount(ctx as any);
    const windowMs = getVotingWindowMs(totalViewerCount);
    const votes = args.voters.map((voter) => ({ voter, startedAt: voteStart }));

    await ctx.db.patch(args.roundId, {
      phase: "voting",
      votes,
      viewerVotingEndsAt: voteStart + windowMs,
      updatedAt: Date.now(),
    });

    return true;
  },
});

export const setModelVote = internalMutation({
  args: {
    expectedGeneration: v.number(),
    roundId: v.id("rounds"),
    voteIndex: v.number(),
    side: v.optional(v.union(v.literal("A"), v.literal("B"))),
    error: v.optional(v.boolean()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const state = await getEngineState(ctx as any);
    const round = await ctx.db.get(args.roundId);
    if (!state || !round) return false;
    if (state.generation !== args.expectedGeneration || round.generation !== args.expectedGeneration) return false;
    if (args.voteIndex < 0 || args.voteIndex >= round.votes.length) return false;

    const votes = [...round.votes];
    const vote = votes[args.voteIndex];
    votes[args.voteIndex] = {
      ...vote,
      finishedAt: Date.now(),
      votedForSide: args.side,
      error: args.error,
    };

    await ctx.db.patch(args.roundId, {
      votes,
      updatedAt: Date.now(),
    });

    return true;
  },
});

export const maybeShortenVotingWindow = internalMutation({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const state = await getEngineState(ctx as any);
    if (!state?.activeRoundId) return false;

    const round = await ctx.db.get(state.activeRoundId);
    if (!round || round.phase !== "voting" || !round.viewerVotingEndsAt) return false;

    const now = Date.now();
    const remaining = round.viewerVotingEndsAt - now;
    if (remaining <= VIEWER_VOTE_WINDOW_ACTIVE_MS) {
      return false;
    }

    const totalViewerCount = await readTotalViewerCount(ctx as any);
    if (totalViewerCount <= 0) {
      return false;
    }

    await ctx.db.patch(round._id, {
      viewerVotingEndsAt: now + VIEWER_VOTE_WINDOW_ACTIVE_MS,
      updatedAt: now,
    });
    return true;
  },
});

export const finalizeRound = internalMutation({
  args: {
    expectedGeneration: v.number(),
    roundId: v.id("rounds"),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const state = await getEngineState(ctx as any);
    const round = await ctx.db.get(args.roundId);
    if (!state || !round) return false;
    if (state.generation !== args.expectedGeneration || round.generation !== args.expectedGeneration) return false;

    let votesA = 0;
    let votesB = 0;
    for (const vote of round.votes) {
      if (vote.votedForSide === "A") votesA += 1;
      else if (vote.votedForSide === "B") votesB += 1;
    }

    const tallies = await ctx.db
      .query("viewerVoteTallies")
      .withIndex("by_round", (q: any) => q.eq("roundId", round._id))
      .collect();

    const viewerVotesA = tallies
      .filter((x: any) => x.side === "A")
      .reduce((sum: number, x: any) => sum + x.count, 0);
    const viewerVotesB = tallies
      .filter((x: any) => x.side === "B")
      .reduce((sum: number, x: any) => sum + x.count, 0);

    const scoreA = votesA * 100;
    const scoreB = votesB * 100;
    const scores = { ...state.scores };
    const humanScores = { ...DEFAULT_SCORES, ...(state.humanScores ?? {}) };
    const humanVoteTotals = { ...DEFAULT_SCORES, ...(state.humanVoteTotals ?? {}) };
    const contA = round.contestants[0];
    const contB = round.contestants[1];

    if (contA && contB) {
      if (votesA > votesB) {
        scores[contA.name] = (scores[contA.name] ?? 0) + 1;
      } else if (votesB > votesA) {
        scores[contB.name] = (scores[contB.name] ?? 0) + 1;
      }

      humanVoteTotals[contA.name] = (humanVoteTotals[contA.name] ?? 0) + viewerVotesA;
      humanVoteTotals[contB.name] = (humanVoteTotals[contB.name] ?? 0) + viewerVotesB;
      if (viewerVotesA > viewerVotesB) {
        humanScores[contA.name] = (humanScores[contA.name] ?? 0) + 1;
      } else if (viewerVotesB > viewerVotesA) {
        humanScores[contB.name] = (humanScores[contB.name] ?? 0) + 1;
      }
    }

    const nextCompletedRounds = state.completedRounds + 1;
    const nextDone =
      isFiniteRuns(state) && typeof state.totalRounds === "number"
        ? nextCompletedRounds >= state.totalRounds
        : false;

    await ctx.db.patch(round._id, {
      phase: "done",
      scoreA,
      scoreB,
      viewerVotesA,
      viewerVotesB,
      completedAt: Date.now(),
      updatedAt: Date.now(),
    });

    await ctx.db.patch(state._id, {
      activeRoundId: undefined,
      lastCompletedRoundId: round._id,
      scores,
      humanScores,
      humanVoteTotals,
      completedRounds: nextCompletedRounds,
      nextRoundNum: state.nextRoundNum + 1,
      done: nextDone,
      updatedAt: Date.now(),
    });

    return true;
  },
});

export const runLoop = internalAction({
  args: {
    leaseId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const state = await ctx.runQuery(convexInternal.engine.getRunnerState, {});
    if (!state) return null;
    if (state.runnerLeaseId !== args.leaseId) return null;
    if (!state.runnerLeaseUntil || state.runnerLeaseUntil <= Date.now()) return null;

    if (state.done) {
      return null;
    }

    await ctx.runMutation(convexInternal.engine.renewLease, { leaseId: args.leaseId });

    if (state.isPaused) {
      await ctx.scheduler.runAfter(1_000, convexInternal.engine.runLoop, { leaseId: args.leaseId });
      return null;
    }

    const expectedGeneration = state.generation;
    const { prompter, contestants, voters } = pickRoundModels();

    const created = await ctx.runMutation(convexInternal.engine.createRound, {
      expectedGeneration,
      prompter,
      contestants,
    });

    if (!created) {
      await ctx.scheduler.runAfter(300, convexInternal.engine.runLoop, { leaseId: args.leaseId });
      return null;
    }

    const roundId = created.roundId;

    try {
      const prompt = await callGeneratePrompt(prompter);
      if (!(await leaseStillValid(ctx, args.leaseId, expectedGeneration))) return null;

      await ctx.runMutation(convexInternal.engine.setPromptResult, {
        expectedGeneration,
        roundId,
        prompt,
      });
    } catch {
      if (!(await leaseStillValid(ctx, args.leaseId, expectedGeneration))) return null;

      await ctx.runMutation(convexInternal.engine.setPromptError, {
        expectedGeneration,
        roundId,
        error: "Failed after 3 attempts",
      });

      await sleep(500);
      await ctx.runMutation(convexInternal.engine.renewLease, { leaseId: args.leaseId });
      await ctx.scheduler.runAfter(0, convexInternal.engine.runLoop, { leaseId: args.leaseId });
      return null;
    }

    if (!(await leaseStillValid(ctx, args.leaseId, expectedGeneration))) return null;

    await ctx.runMutation(convexInternal.engine.startAnswering, {
      expectedGeneration,
      roundId,
    });

    const currentRound = await ctx.runQuery(convexInternal.engine.getRoundForRunner, { roundId });
    if (!currentRound || !currentRound.prompt) {
      await ctx.scheduler.runAfter(0, convexInternal.engine.runLoop, { leaseId: args.leaseId });
      return null;
    }

    await Promise.all(
      contestants.map(async (contestant, answerIndex) => {
        try {
          const result = await callGenerateAnswer(contestant, currentRound.prompt as string);
          if (!(await leaseStillValid(ctx, args.leaseId, expectedGeneration))) return;
          await ctx.runMutation(convexInternal.engine.setAnswerResult, {
            expectedGeneration,
            roundId,
            answerIndex,
            result,
          });
        } catch {
          if (!(await leaseStillValid(ctx, args.leaseId, expectedGeneration))) return;
          await ctx.runMutation(convexInternal.engine.setAnswerResult, {
            expectedGeneration,
            roundId,
            answerIndex,
            result: "[no answer]",
            error: "Failed to answer",
          });
        }
      }),
    );

    if (!(await leaseStillValid(ctx, args.leaseId, expectedGeneration))) return null;

    await ctx.runMutation(convexInternal.engine.startVoting, {
      expectedGeneration,
      roundId,
      voters,
    });

    const roundForVotes = await ctx.runQuery(convexInternal.engine.getRoundForRunner, { roundId });
    if (!roundForVotes) {
      await ctx.scheduler.runAfter(0, convexInternal.engine.runLoop, { leaseId: args.leaseId });
      return null;
    }

    const answerA = roundForVotes.answerTasks[0]?.result ?? "[no answer]";
    const answerB = roundForVotes.answerTasks[1]?.result ?? "[no answer]";

    let modelVotesDone = false;
    const modelVotesPromise = Promise.all(
      voters.map(async (voter, voteIndex) => {
        try {
          const showAFirst = Math.random() > 0.5;
          const first = showAFirst ? { answer: answerA } : { answer: answerB };
          const second = showAFirst ? { answer: answerB } : { answer: answerA };
          const result = await callVote(voter, roundForVotes.prompt ?? "", first, second);
          if (!(await leaseStillValid(ctx, args.leaseId, expectedGeneration))) return;

          const votedForSide: "A" | "B" = showAFirst
            ? result === "A"
              ? "A"
              : "B"
            : result === "A"
              ? "B"
              : "A";

          await ctx.runMutation(convexInternal.engine.setModelVote, {
            expectedGeneration,
            roundId,
            voteIndex,
            side: votedForSide,
          });
        } catch {
          if (!(await leaseStillValid(ctx, args.leaseId, expectedGeneration))) return;
          await ctx.runMutation(convexInternal.engine.setModelVote, {
            expectedGeneration,
            roundId,
            voteIndex,
            error: true,
          });
        }
      }),
    ).finally(() => {
      modelVotesDone = true;
    });

    let windowClosed = false;
    let lastLeaseRenewAt = Date.now();
    while (!windowClosed || !modelVotesDone) {
      if (!(await leaseStillValid(ctx, args.leaseId, expectedGeneration))) return null;

      const latestRound = await ctx.runQuery(convexInternal.engine.getRoundForRunner, { roundId });
      if (!latestRound || latestRound.phase !== "voting" || !latestRound.viewerVotingEndsAt) {
        windowClosed = true;
        if (!modelVotesDone) {
          await sleep(300);
        }
      } else {
        const remaining = latestRound.viewerVotingEndsAt - Date.now();
        windowClosed = remaining <= 0;
        if (!windowClosed) {
          await sleep(Math.max(100, Math.min(1_000, remaining)));
        } else if (!modelVotesDone) {
          await sleep(300);
        }
      }

      const now = Date.now();
      if (now - lastLeaseRenewAt >= 20_000) {
        await ctx.runMutation(convexInternal.engine.renewLease, { leaseId: args.leaseId });
        lastLeaseRenewAt = now;
      }
    }

    await modelVotesPromise;

    if (!(await leaseStillValid(ctx, args.leaseId, expectedGeneration))) return null;

    await ctx.runMutation(convexInternal.engine.finalizeRound, {
      expectedGeneration,
      roundId,
    });

    await sleep(POST_ROUND_DELAY_MS);

    if (!(await leaseStillValid(ctx, args.leaseId, expectedGeneration))) return null;
    await ctx.runMutation(convexInternal.engine.renewLease, { leaseId: args.leaseId });
    await ctx.scheduler.runAfter(0, convexInternal.engine.runLoop, { leaseId: args.leaseId });

    return null;
  },
});

export const getRoundForRunner = internalQuery({
  args: {
    roundId: v.id("rounds"),
  },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.roundId);
  },
});

