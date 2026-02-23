export async function readWebViewerCount(ctx: any): Promise<number> {
  const rows = await ctx.db.query("viewerCountShards").collect();
  return rows.reduce((sum: number, row: any) => sum + row.count, 0);
}

export async function readPlatformViewerCount(ctx: any): Promise<number> {
  const rows = await ctx.db
    .query("viewerTargets")
    .withIndex("by_enabled", (q: any) => q.eq("enabled", true))
    .collect();
  return rows.reduce((sum: number, row: any) => sum + (row.isLive ? row.viewerCount : 0), 0);
}

export async function readTotalViewerCount(ctx: any): Promise<number> {
  const [web, platforms] = await Promise.all([readWebViewerCount(ctx), readPlatformViewerCount(ctx)]);
  return web + platforms;
}
