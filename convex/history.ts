import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { query } from "./_generated/server";
import { toClientRound } from "./rounds";
import { getEngineState } from "./state";

export const listPaginated = query({
  args: {
    paginationOpts: paginationOptsValidator,
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const engine = await getEngineState(ctx as any);
    if (!engine) {
      return {
        page: [],
        isDone: true,
        continueCursor: "",
        pageStatus: "Exhausted",
      };
    }

    const result = await ctx.db
      .query("rounds")
      .withIndex("by_generation_and_completedAt", (q: any) =>
        q.eq("generation", engine.generation),
      )
      .order("desc")
      .paginate(args.paginationOpts);

    return {
      ...result,
      page: result.page.map((round: any) => toClientRound(round)).filter(Boolean),
    };
  },
});
