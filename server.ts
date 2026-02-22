import type { ServerWebSocket } from "bun";
import { timingSafeEqual } from "node:crypto";
import indexHtml from "./index.html";
import historyHtml from "./history.html";
import { getRounds, getAllRounds } from "./db.ts";
import {
  MODELS,
  LOG_FILE,
  log,
  runGame,
  type GameState,
  type RoundState,
} from "./game.ts";

// ── Game state ──────────────────────────────────────────────────────────────

const runsArg = process.argv.find((a) => a.startsWith("runs="));
const runsStr = runsArg ? runsArg.split("=")[1] : "infinite";
const runs =
  runsStr === "infinite" ? Infinity : parseInt(runsStr || "infinite", 10);

if (!process.env.OPENROUTER_API_KEY) {
  console.error("Error: Set OPENROUTER_API_KEY environment variable");
  process.exit(1);
}

const allRounds = getAllRounds();
const initialScores = Object.fromEntries(MODELS.map((m) => [m.name, 0]));

let initialCompleted: RoundState[] = [];
if (allRounds.length > 0) {
  for (const round of allRounds) {
    if (round.scoreA !== undefined && round.scoreB !== undefined) {
      if (round.scoreA > round.scoreB) {
        initialScores[round.contestants[0].name] =
          (initialScores[round.contestants[0].name] || 0) + 1;
      } else if (round.scoreB > round.scoreA) {
        initialScores[round.contestants[1].name] =
          (initialScores[round.contestants[1].name] || 0) + 1;
      }
    }
  }
  const lastRound = allRounds[allRounds.length - 1];
  if (lastRound) {
    initialCompleted = [lastRound];
  }
}

const gameState: GameState = {
  completed: initialCompleted,
  active: null,
  scores: initialScores,
  done: false,
  isPaused: false,
};

// ── Guardrails ──────────────────────────────────────────────────────────────

type WsData = { ip: string };

const WINDOW_MS = 60_000;
const WS_UPGRADE_LIMIT_PER_MIN = parsePositiveInt(
  process.env.WS_UPGRADE_LIMIT_PER_MIN,
  20,
);
const HISTORY_LIMIT_PER_MIN = parsePositiveInt(
  process.env.HISTORY_LIMIT_PER_MIN,
  120,
);
const ADMIN_LIMIT_PER_MIN = parsePositiveInt(
  process.env.ADMIN_LIMIT_PER_MIN,
  10,
);
const MAX_WS_GLOBAL = parsePositiveInt(process.env.MAX_WS_GLOBAL, 2_000);
const MAX_WS_PER_IP = parsePositiveInt(process.env.MAX_WS_PER_IP, 8);
const MAX_HISTORY_PAGE = parsePositiveInt(
  process.env.MAX_HISTORY_PAGE,
  100_000,
);
const MAX_HISTORY_LIMIT = parsePositiveInt(process.env.MAX_HISTORY_LIMIT, 50);
const HISTORY_CACHE_TTL_MS = parsePositiveInt(
  process.env.HISTORY_CACHE_TTL_MS,
  5_000,
);
const MAX_HISTORY_CACHE_KEYS = parsePositiveInt(
  process.env.MAX_HISTORY_CACHE_KEYS,
  500,
);

const requestWindows = new Map<string, number[]>();
const wsByIp = new Map<string, number>();
const historyCache = new Map<string, { body: string; expiresAt: number }>();
let lastRateWindowSweep = 0;
let lastHistoryCacheSweep = 0;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getClientIp(req: Request, server: Bun.Server<WsData>): string {
  return server.requestIP(req)?.address ?? "unknown";
}

function isRateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  if (now - lastRateWindowSweep >= windowMs) {
    for (const [bucketKey, timestamps] of requestWindows) {
      const recent = timestamps.filter(
        (timestamp) => now - timestamp <= windowMs,
      );
      if (recent.length === 0) {
        requestWindows.delete(bucketKey);
      } else {
        requestWindows.set(bucketKey, recent);
      }
    }
    lastRateWindowSweep = now;
  }

  const existing = requestWindows.get(key) ?? [];
  const recent = existing.filter((timestamp) => now - timestamp <= windowMs);
  if (recent.length >= limit) {
    requestWindows.set(key, recent);
    return true;
  }
  recent.push(now);
  requestWindows.set(key, recent);
  return false;
}

function secureCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function isAdminAuthorized(req: Request, url: URL): boolean {
  const expected = process.env.ADMIN_SECRET;
  if (!expected) return false;
  const provided =
    req.headers.get("x-admin-secret") ?? url.searchParams.get("secret") ?? "";
  if (!provided) return false;
  return secureCompare(provided, expected);
}

function decrementIpConnection(ip: string) {
  const current = wsByIp.get(ip) ?? 0;
  if (current <= 1) {
    wsByIp.delete(ip);
    return;
  }
  wsByIp.set(ip, current - 1);
}

function setHistoryCache(key: string, body: string, expiresAt: number) {
  if (historyCache.size >= MAX_HISTORY_CACHE_KEYS) {
    const firstKey = historyCache.keys().next().value;
    if (firstKey) historyCache.delete(firstKey);
  }
  historyCache.set(key, { body, expiresAt });
}

// ── WebSocket clients ───────────────────────────────────────────────────────

const clients = new Set<ServerWebSocket<WsData>>();

function broadcast() {
  const msg = JSON.stringify({
    type: "state",
    data: gameState,
    totalRounds: runs,
    viewerCount: clients.size,
  });
  for (const ws of clients) {
    ws.send(msg);
  }
}

// ── Server ──────────────────────────────────────────────────────────────────

const port = parseInt(process.env.PORT ?? "5109", 10); // 5109 = SLOP

const server = Bun.serve<WsData>({
  port,
  routes: {
    "/": indexHtml,
    "/history": historyHtml,
  },
  fetch(req, server) {
    const url = new URL(req.url);
    const ip = getClientIp(req, server);

    if (url.pathname.startsWith("/assets/")) {
      const path = `./public${url.pathname}`;
      const file = Bun.file(path);
      return new Response(file, {
        headers: {
          "Cache-Control": "public, max-age=604800, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }

    if (url.pathname === "/api/pause" || url.pathname === "/api/resume") {
      if (req.method !== "POST") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "POST" },
        });
      }
      if (isRateLimited(`admin:${ip}`, ADMIN_LIMIT_PER_MIN, WINDOW_MS)) {
        return new Response("Too Many Requests", { status: 429 });
      }
      if (!isAdminAuthorized(req, url)) {
        return new Response("Unauthorized", { status: 401 });
      }

      if (url.pathname === "/api/pause") {
        gameState.isPaused = true;
      } else {
        gameState.isPaused = false;
      }
      broadcast();
      return new Response(
        url.pathname === "/api/pause" ? "Paused" : "Resumed",
        {
          status: 200,
        },
      );
    }

    if (url.pathname === "/api/history") {
      if (isRateLimited(`history:${ip}`, HISTORY_LIMIT_PER_MIN, WINDOW_MS)) {
        return new Response("Too Many Requests", { status: 429 });
      }
      const rawPage = parseInt(url.searchParams.get("page") || "1", 10);
      const rawLimit = parseInt(url.searchParams.get("limit") || "10", 10);
      const page = Number.isFinite(rawPage)
        ? Math.min(Math.max(rawPage, 1), MAX_HISTORY_PAGE)
        : 1;
      const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(rawLimit, 1), MAX_HISTORY_LIMIT)
        : 10;
      const cacheKey = `${page}:${limit}`;
      const now = Date.now();
      if (now - lastHistoryCacheSweep >= HISTORY_CACHE_TTL_MS) {
        for (const [key, value] of historyCache) {
          if (value.expiresAt <= now) historyCache.delete(key);
        }
        lastHistoryCacheSweep = now;
      }
      const cached = historyCache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        return new Response(cached.body, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=5, stale-while-revalidate=30",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      const body = JSON.stringify(getRounds(page, limit));
      setHistoryCache(cacheKey, body, now + HISTORY_CACHE_TTL_MS);
      return new Response(body, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=5, stale-while-revalidate=30",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    if (url.pathname === "/ws") {
      if (req.method !== "GET") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "GET" },
        });
      }
      if (
        isRateLimited(`ws-upgrade:${ip}`, WS_UPGRADE_LIMIT_PER_MIN, WINDOW_MS)
      ) {
        return new Response("Too Many Requests", { status: 429 });
      }
      if (clients.size >= MAX_WS_GLOBAL) {
        return new Response("Service Unavailable", { status: 503 });
      }
      const existingForIp = wsByIp.get(ip) ?? 0;
      if (existingForIp >= MAX_WS_PER_IP) {
        return new Response("Too Many Requests", { status: 429 });
      }

      const upgraded = server.upgrade(req, { data: { ip } });
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return undefined;
    }

    return new Response("Not found", { status: 404 });
  },
  websocket: {
    data: {} as WsData,
    open(ws) {
      clients.add(ws);
      wsByIp.set(ws.data.ip, (wsByIp.get(ws.data.ip) ?? 0) + 1);
      broadcast();
    },
    message(_ws, _message) {
      // Spectator-only, no client messages handled
    },
    close(ws) {
      clients.delete(ws);
      decrementIpConnection(ws.data.ip);
      broadcast();
    },
  },
  development:
    process.env.NODE_ENV === "production"
      ? false
      : {
          hmr: true,
          console: true,
        },
  error(error) {
    log("ERROR", "server", "Unhandled fetch/websocket error", {
      message: error.message,
      stack: error.stack,
    });
    return new Response("Internal Server Error", { status: 500 });
  },
});

console.log(`\n🎮 quipslop Web — http://localhost:${server.port}`);
console.log(`📡 WebSocket — ws://localhost:${server.port}/ws`);
console.log(`🎯 ${runs} rounds with ${MODELS.length} models\n`);

log("INFO", "server", `Web server started on port ${server.port}`, {
  runs,
  models: MODELS.map((m) => m.id),
});

// ── Start game ──────────────────────────────────────────────────────────────

runGame(runs, gameState, broadcast).then(() => {
  console.log(`\n✅ Game complete! Log: ${LOG_FILE}`);
});
