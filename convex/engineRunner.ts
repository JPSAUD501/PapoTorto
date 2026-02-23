"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
const convexInternal = internal as any;
import { MODELS, type Model } from "../shared/models";
import { POST_ROUND_DELAY_MS, sleep, shuffle } from "./constants";
import { callGenerateAnswer, callGeneratePrompt, callVote } from "./ai";

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
      await ctx.scheduler.runAfter(1_000, convexInternal.engineRunner.runLoop, { leaseId: args.leaseId });
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
      await ctx.scheduler.runAfter(300, convexInternal.engineRunner.runLoop, { leaseId: args.leaseId });
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
      await ctx.scheduler.runAfter(0, convexInternal.engineRunner.runLoop, { leaseId: args.leaseId });
      return null;
    }

    if (!(await leaseStillValid(ctx, args.leaseId, expectedGeneration))) return null;

    await ctx.runMutation(convexInternal.engine.startAnswering, {
      expectedGeneration,
      roundId,
    });

    const currentRound = await ctx.runQuery(convexInternal.engine.getRoundForRunner, { roundId });
    if (!currentRound || !currentRound.prompt) {
      await ctx.scheduler.runAfter(0, convexInternal.engineRunner.runLoop, { leaseId: args.leaseId });
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
      await ctx.scheduler.runAfter(0, convexInternal.engineRunner.runLoop, { leaseId: args.leaseId });
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
    await ctx.scheduler.runAfter(0, convexInternal.engineRunner.runLoop, { leaseId: args.leaseId });

    return null;
  },
});
