import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { DEFAULT_SCORES } from "./constants";

type EngineReadCtx = Pick<QueryCtx, "db">;

export function normalizeScoreRecord(
  input?: Record<string, number>,
): Record<string, number> {
  const normalized: Record<string, number> = { ...DEFAULT_SCORES };
  if (!input) return normalized;
  for (const [name, score] of Object.entries(input)) {
    normalized[name] = Number.isFinite(score) ? score : 0;
  }
  return normalized;
}

export async function getEngineState(
  ctx: EngineReadCtx,
): Promise<Doc<"engineState"> | null> {
  return await ctx.db.query("engineState").withIndex("by_key", (q) => q.eq("key", "main")).first();
}

export async function getOrCreateEngineState(
  ctx: MutationCtx,
): Promise<Doc<"engineState">> {
  const existing = await getEngineState(ctx);
  if (existing) return existing;

  const now = Date.now();
  const id = await ctx.db.insert("engineState", {
    key: "main",
    generation: 1,
    isPaused: false,
    done: false,
    runsMode: "infinite",
    nextRoundNum: 1,
    scores: { ...DEFAULT_SCORES },
    humanScores: { ...DEFAULT_SCORES },
    humanVoteTotals: { ...DEFAULT_SCORES },
    enabledModelIds: [],
    completedRounds: 0,
    updatedAt: now,
  });

  const created = await ctx.db.get(id);
  if (!created) throw new Error("failed to initialize engine state");
  return created;
}

export function isFiniteRuns(state: { runsMode: "finite" | "infinite"; totalRounds?: number }): boolean {
  return state.runsMode === "finite" && typeof state.totalRounds === "number";
}
