"use node";

import { generateText } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { ALL_PROMPTS } from "../prompts";
import type { Model } from "../shared/models";
import { shuffle } from "./constants";

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
  extraBody: {
    reasoning: { effort: "medium" },
  },
});

function cleanResponse(text: string): string {
  const trimmed = text.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isRealString(s: string, minLength = 5): boolean {
  return s.length >= minLength;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  validate: (result: T) => boolean,
  retries = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await fn();
      if (validate(result)) return result;
      lastErr = new Error("validation failed");
    } catch (err) {
      lastErr = err;
    }
    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  throw lastErr;
}

function buildPromptSystem(): string {
  const examples = shuffle([...ALL_PROMPTS]).slice(0, 80);
  return `You are a comedy writer for the game Quiplash. Generate a single funny fill-in-the-blank prompt that players will try to answer. The prompt should be surprising and designed to elicit hilarious responses. Return ONLY the prompt text, nothing else. Keep it short (under 15 words).\n\nUse a wide VARIETY of prompt formats. Do NOT always use "The worst thing to..." - mix it up! Here are examples of the range of styles:\n\n${examples
    .map((p) => `- ${p}`)
    .join("\n")}\n\nCome up with something ORIGINAL - don't copy these examples.`;
}

export async function callGeneratePrompt(model: Model): Promise<string> {
  return withRetry(
    async () => {
      const { text } = await generateText({
        model: openrouter.chat(model.id),
        system: buildPromptSystem(),
        prompt:
          "Generate a single original Quiplash prompt. Be creative and don't repeat common patterns.",
      });
      return cleanResponse(text);
    },
    (s) => isRealString(s, 10),
    3,
  );
}

export async function callGenerateAnswer(model: Model, prompt: string): Promise<string> {
  return withRetry(
    async () => {
      const { text } = await generateText({
        model: openrouter.chat(model.id),
        system:
          "You are playing Quiplash! You'll be given a fill-in-the-blank prompt. Give the FUNNIEST possible answer. Be creative, edgy, unexpected, and concise. Reply with ONLY your answer - no quotes, no explanation, no preamble. Keep it short (under 12 words).",
        prompt: `Fill in the blank: ${prompt}`,
      });
      return cleanResponse(text);
    },
    (s) => isRealString(s, 3),
    3,
  );
}

export async function callVote(
  voter: Model,
  prompt: string,
  a: { answer: string },
  b: { answer: string },
): Promise<"A" | "B"> {
  return withRetry(
    async () => {
      const { text } = await generateText({
        model: openrouter.chat(voter.id),
        system:
          "You are a judge in a comedy game. You'll see a fill-in-the-blank prompt and two answers. Pick which answer is FUNNIER. You MUST respond with exactly \"A\" or \"B\".",
        prompt: `Prompt: \"${prompt}\"\n\nAnswer A: \"${a.answer}\"\nAnswer B: \"${b.answer}\"\n\nWhich is funnier? Reply with just A or B.`,
      });

      const cleaned = text.trim().toUpperCase();
      if (!cleaned.startsWith("A") && !cleaned.startsWith("B")) {
        throw new Error(`Invalid vote: ${text.trim()}`);
      }
      return cleaned.startsWith("A") ? "A" : "B";
    },
    (v) => v === "A" || v === "B",
    3,
  );
}
