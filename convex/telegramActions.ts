"use node";

import { v } from "convex/values";
import { Bot } from "grammy";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

const convexInternal = internal as any;

const TELEGRAM_ALLOWED_UPDATES = [
  "poll",
  "poll_answer",
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
] as const;
const TELEGRAM_MAX_UPDATES_PER_POLL = 100;
const TELEGRAM_POLL_QUESTION_MAX_LENGTH = 300;
const TELEGRAM_POLL_OPTION_MAX_LENGTH = 100;

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

function normalizePollText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

function truncatePollText(value: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 3)}...`;
}

function buildPollQuestion(roundNum: number, prompt: unknown): string {
  const normalizedPrompt = normalizePollText(prompt);
  if (!normalizedPrompt) {
    return truncatePollText(`Rodada ${roundNum} - Vote no melhor`, TELEGRAM_POLL_QUESTION_MAX_LENGTH);
  }
  return truncatePollText(
    `Rodada ${roundNum} - Prompt: ${normalizedPrompt}`,
    TELEGRAM_POLL_QUESTION_MAX_LENGTH,
  );
}

function buildPollOption(indexLabel: string, contestantName: unknown, answerText: unknown): string {
  const normalizedName = normalizePollText(contestantName) || "Modelo";
  const normalizedAnswer = normalizePollText(answerText) || "[sem resposta]";
  const prefix = `${indexLabel} - ${normalizedName}: `;
  const available = TELEGRAM_POLL_OPTION_MAX_LENGTH - prefix.length;
  if (available <= 0) {
    return truncatePollText(prefix, TELEGRAM_POLL_OPTION_MAX_LENGTH);
  }
  return `${prefix}${truncatePollText(normalizedAnswer, available)}`;
}

function isTelegramConfigured(state: {
  telegramEnabled?: unknown;
  telegramBotToken?: unknown;
  telegramChannelId?: unknown;
} | null): boolean {
  if (!state || state.telegramEnabled !== true) return false;
  return Boolean(normalizeTelegramToken(state.telegramBotToken) && normalizeTelegramChannelId(state.telegramChannelId));
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractPollsFromUpdate(update: any): any[] {
  const polls: any[] = [];
  if (update?.poll) polls.push(update.poll);
  if (update?.message?.poll) polls.push(update.message.poll);
  if (update?.edited_message?.poll) polls.push(update.edited_message.poll);
  if (update?.channel_post?.poll) polls.push(update.channel_post.poll);
  if (update?.edited_channel_post?.poll) polls.push(update.edited_channel_post.poll);
  return polls;
}

function isAlreadyClosedPollError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("poll has already been closed");
}

function isAlreadyDeletedMessageError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("message to delete not found") ||
    lower.includes("message can't be deleted") ||
    lower.includes("message is not modified")
  );
}

function isWebhookActiveGetUpdatesError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("can't use getupdates method while webhook is active") ||
    lower.includes("webhook is active") ||
    lower.includes("terminated by other getupdates request")
  );
}

export const pollUpdates = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    let shouldSchedule = true;
    try {
      const state = await ctx.runQuery(convexInternal.engine.getRunnerState, {});
      if (!isTelegramConfigured(state)) {
        shouldSchedule = false;
        await ctx.runMutation(convexInternal.telegram.clearPollingError, {});
        return null;
      }
      const pollingState = await ctx.runQuery(convexInternal.telegram.getPollingState, {});

      const token = normalizeTelegramToken(state.telegramBotToken);
      const bot = new Bot(token);

      const currentOffset =
        typeof pollingState?.lastUpdateId === "number" && Number.isFinite(pollingState.lastUpdateId)
          ? Math.floor(pollingState.lastUpdateId) + 1
          : undefined;

      let updates: any[] = [];
      try {
        updates = await bot.api.getUpdates({
          offset: currentOffset,
          limit: TELEGRAM_MAX_UPDATES_PER_POLL,
          allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
        });
      } catch (error) {
        const message = toErrorMessage(error);
        if (!isWebhookActiveGetUpdatesError(message)) {
          throw error;
        }
        await bot.api.deleteWebhook({
          drop_pending_updates: false,
        });
        updates = await bot.api.getUpdates({
          offset: currentOffset,
          limit: TELEGRAM_MAX_UPDATES_PER_POLL,
          allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
        });
      }

      let maxUpdateId: number | undefined;
      for (const update of updates) {
        const polls = extractPollsFromUpdate(update as any);
        for (const poll of polls) {
          if (!poll?.id) continue;
          const votesA = normalizeNumber(poll.options?.[0]?.voter_count ?? 0);
          const votesB = normalizeNumber(poll.options?.[1]?.voter_count ?? 0);
          await ctx.runMutation(convexInternal.telegram.syncPollCounts, {
            pollId: poll.id,
            votesA,
            votesB,
          });
        }
        if (typeof update.update_id === "number" && Number.isFinite(update.update_id)) {
          maxUpdateId =
            typeof maxUpdateId === "number"
              ? Math.max(maxUpdateId, Math.floor(update.update_id))
              : Math.floor(update.update_id);
        }
      }

      await ctx.runMutation(convexInternal.telegram.recordPollingSuccess, {
        lastUpdateId: maxUpdateId,
      });
    } catch (error) {
      await ctx.runMutation(convexInternal.telegram.setPollingError, {
        message: toErrorMessage(error),
      });
    } finally {
      await ctx.runMutation(convexInternal.telegram.scheduleNextPoll, { shouldSchedule });
    }

    return null;
  },
});

export const openRoundPoll = internalAction({
  args: {
    roundId: v.id("rounds"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      const [state, round, existingRoundPoll] = await Promise.all([
        ctx.runQuery(convexInternal.engine.getRunnerState, {}),
        ctx.runQuery(convexInternal.engine.getRoundForRunner, { roundId: args.roundId }),
        ctx.runQuery(convexInternal.telegram.getRoundPollByRoundId, { roundId: args.roundId }),
      ]);

      if (!isTelegramConfigured(state)) return null;
      if (!round || round.phase !== "voting") return null;
      if (existingRoundPoll) return null;
      const contestantA = round.contestants?.[0];
      const contestantB = round.contestants?.[1];
      if (!contestantA?.name || !contestantB?.name) return null;

      const token = normalizeTelegramToken(state.telegramBotToken);
      const channelId = normalizeTelegramChannelId(state.telegramChannelId);
      const bot = new Bot(token);
      const optionA = buildPollOption("1", contestantA.name, round.answerTasks?.[0]?.result);
      const optionB = buildPollOption("2", contestantB.name, round.answerTasks?.[1]?.result);

      const pollMessage = await bot.api.sendPoll(
        channelId,
        buildPollQuestion(round.num, round.prompt),
        [optionA, optionB],
        {
          is_anonymous: true,
          allows_multiple_answers: false,
        },
      );

      const pollId = pollMessage.poll?.id;
      if (!pollId) {
        throw new Error("Telegram sendPoll returned no poll id");
      }

      await ctx.runMutation(convexInternal.telegram.upsertRoundPoll, {
        generation: round.generation,
        roundId: args.roundId,
        pollId,
        chatId: String(pollMessage.chat.id),
        messageId: pollMessage.message_id,
      });

      await ctx.runMutation(convexInternal.telegram.clearPollingError, {});
    } catch (error) {
      await ctx.runMutation(convexInternal.telegram.setPollingError, {
        message: toErrorMessage(error),
      });
    }

    return null;
  },
});

export const closeRoundPoll = internalAction({
  args: {
    roundId: v.id("rounds"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const pollRow = await ctx.runQuery(convexInternal.telegram.getRoundPollByRoundId, { roundId: args.roundId });
    if (!pollRow) return null;
    if (pollRow.status === "deleted") return null;

    const state = await ctx.runQuery(convexInternal.engine.getRunnerState, {});
    const token = normalizeTelegramToken(state?.telegramBotToken);
    if (!token) {
      await ctx.runMutation(convexInternal.telegram.setRoundPollStatus, {
        roundId: args.roundId,
        status: "error",
        lastError: "Telegram bot token missing while closing poll",
      });
      await ctx.runMutation(convexInternal.telegram.setPollingError, {
        message: "Telegram bot token missing while closing poll",
      });
      return null;
    }

    const bot = new Bot(token);
    let stopSucceeded = false;

    try {
      const poll = await bot.api.stopPoll(pollRow.chatId, pollRow.messageId);
      const votesA = normalizeNumber(poll.options?.[0]?.voter_count ?? 0);
      const votesB = normalizeNumber(poll.options?.[1]?.voter_count ?? 0);
      await ctx.runMutation(convexInternal.telegram.syncPollCounts, {
        pollId: pollRow.pollId,
        votesA,
        votesB,
      });
      stopSucceeded = true;
    } catch (error) {
      const message = toErrorMessage(error);
      if (isAlreadyClosedPollError(message)) {
        stopSucceeded = true;
      } else {
        await ctx.runMutation(convexInternal.telegram.setRoundPollStatus, {
          roundId: args.roundId,
          status: "error",
          lastError: message,
        });
        await ctx.runMutation(convexInternal.telegram.setPollingError, {
          message,
        });
      }
    }

    if (!stopSucceeded) {
      return null;
    }

    await ctx.runMutation(convexInternal.telegram.setRoundPollStatus, {
      roundId: args.roundId,
      status: "closed",
    });

    try {
      await bot.api.deleteMessage(pollRow.chatId, pollRow.messageId);
      await ctx.runMutation(convexInternal.telegram.setRoundPollStatus, {
        roundId: args.roundId,
        status: "deleted",
      });
    } catch (error) {
      const message = toErrorMessage(error);
      if (isAlreadyDeletedMessageError(message)) {
        await ctx.runMutation(convexInternal.telegram.setRoundPollStatus, {
          roundId: args.roundId,
          status: "deleted",
        });
        return null;
      }
      await ctx.runMutation(convexInternal.telegram.setRoundPollStatus, {
        roundId: args.roundId,
        status: "error",
        lastError: message,
      });
      await ctx.runMutation(convexInternal.telegram.setPollingError, {
        message,
      });
    }

    return null;
  },
});
