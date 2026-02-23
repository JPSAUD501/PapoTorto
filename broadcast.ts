import { ConvexClient } from "convex/browser";
import { api } from "./convex/_generated/api";
import { createVotingCountdownTracker, type VotingCountdownView } from "./shared/countdown";

type Model = { id: string; name: string };
type TaskInfo = {
  model: Model;
  startedAt: number;
  finishedAt?: number;
  result?: string;
  error?: string;
};
type VoteInfo = {
  voter: Model;
  startedAt: number;
  finishedAt?: number;
  votedFor?: Model;
  error?: boolean;
};
type RoundState = {
  _id?: string;
  num: number;
  phase: "prompting" | "answering" | "voting" | "done";
  prompter: Model;
  promptTask: TaskInfo;
  prompt?: string;
  contestants: [Model, Model];
  answerTasks: [TaskInfo, TaskInfo];
  votes: VoteInfo[];
  scoreA?: number;
  scoreB?: number;
  viewerVotesA?: number;
  viewerVotesB?: number;
  viewerVotingEndsAt?: number;
};
type GameState = {
  lastCompleted: RoundState | null;
  active: RoundState | null;
  scores: Record<string, number>;
  humanScores: Record<string, number>;
  humanVoteTotals: Record<string, number>;
  done: boolean;
  isPaused: boolean;
  generation: number;
};
type StateMessage = {
  type: "state";
  data: GameState;
  totalRounds: number;
  viewerCount: number;
  version?: string;
};
type ViewerCountMessage = {
  type: "viewerCount";
  viewerCount: number;
};
type ServerMessage = StateMessage | ViewerCountMessage;

const MODEL_COLORS: Record<string, string> = {
  "Gemini 3 Flash": "#4285F4",
  "Kimi K2": "#00E599",
  "DeepSeek 3.2": "#4D6BFE",
  "Qwen 3.5 Plus": "#E67E22",
  "GLM-5": "#1F63EC",
  "GPT-5.2": "#10A37F",
  "Sonnet 4.6": "#D97757",
  "Grok 4.1": "#FFFFFF",
  "MiniMax 2.5": "#FF3B30",
};

const WIDTH = 1920;
const HEIGHT = 1080;

const canvas = document.getElementById("broadcast-canvas") as HTMLCanvasElement;
const statusEl = document.getElementById("broadcast-status") as HTMLDivElement;

function get2dContext(el: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = el.getContext("2d");
  if (!context) throw new Error("Contexto 2D do canvas indisponivel");
  return context;
}

const ctx = get2dContext(canvas);

let state: GameState | null = null;
let totalRounds: number | null = null;
let viewerCount = 0;
let connected = false;
const convex = new ConvexClient(getConvexUrl());
const convexApi = api as any;
const countdownTracker = createVotingCountdownTracker();
let liveUnsubscribe: { unsubscribe: () => void } | null = null;
let heartbeatTimer: number | null = null;

function getColor(name: string): string {
  return MODEL_COLORS[name] ?? "#aeb6d6";
}

function getLogoUrl(name: string): string | null {
  if (name.includes("Gemini")) return "/assets/logos/gemini.svg";
  if (name.includes("Kimi")) return "/assets/logos/kimi.svg";
  if (name.includes("DeepSeek")) return "/assets/logos/deepseek.svg";
  if (name.includes("Qwen")) return "/assets/logos/qwen.svg";
  if (name.includes("GLM")) return "/assets/logos/glm.svg";
  if (name.includes("GPT")) return "/assets/logos/openai.svg";
  if (name.includes("Opus") || name.includes("Sonnet")) return "/assets/logos/claude.svg";
  if (name.includes("Grok")) return "/assets/logos/grok.svg";
  if (name.includes("MiniMax")) return "/assets/logos/minimax.svg";
  return null;
}

const logoCache: Record<string, HTMLImageElement> = {};
const brandLogo = new Image();
brandLogo.src = "/assets/logo.svg";

function drawModelLogo(name: string, x: number, y: number, size: number): boolean {
  const url = getLogoUrl(name);
  if (!url) return false;
  if (!logoCache[url]) {
    const img = new Image();
    img.src = url;
    logoCache[url] = img;
  }
  const img = logoCache[url];
  if (img.complete && img.naturalHeight !== 0) {
    ctx.drawImage(img, x, y, size, size);
    return true;
  }
  return false;
}

function getConvexUrl(): string {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  const url = env?.VITE_CONVEX_URL;
  if (!url) throw new Error("VITE_CONVEX_URL is not configured");
  return url.replace(/\/$/, "");
}

function getOrCreateViewerId(): string {
  const key = "papotorto.viewerId";
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const generated = crypto.randomUUID();
  window.localStorage.setItem(key, generated);
  return generated;
}

function isGhostViewer(): boolean {
  const value = (new URLSearchParams(window.location.search).get("ghost") ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

type RankingEntry = {
  name: string;
  score: number;
  tieTotal: number;
};

function collectRankingNames(...records: Record<string, number>[]): string[] {
  const names = new Set<string>();
  for (const record of records) {
    for (const name of Object.keys(record)) {
      names.add(name);
    }
  }
  return [...names];
}

function rankByScore(
  scores: Record<string, number>,
  tieTotals: Record<string, number>,
  fallbackNames: string[],
): RankingEntry[] {
  const names = new Set<string>([
    ...fallbackNames,
    ...Object.keys(scores),
    ...Object.keys(tieTotals),
  ]);
  return [...names]
    .map((name) => ({
      name,
      score: scores[name] ?? 0,
      tieTotal: tieTotals[name] ?? 0,
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.tieTotal !== a.tieTotal) return b.tieTotal - a.tieTotal;
      return a.name.localeCompare(b.name);
    });
}

function setupRealtime() {
  const ghostViewer = isGhostViewer();
  const viewerId = getOrCreateViewerId();
  void convex.mutation(convexApi.live.ensureStarted, {});

  if (!ghostViewer) {
    void convex.mutation(convexApi.viewers.heartbeat, { viewerId, page: "broadcast" });
  }

  if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer);
  if (!ghostViewer) {
    heartbeatTimer = window.setInterval(() => {
      void convex.mutation(convexApi.viewers.heartbeat, { viewerId, page: "broadcast" });
    }, 10_000);
  } else {
    heartbeatTimer = null;
  }

  liveUnsubscribe?.unsubscribe();
  liveUnsubscribe = convex.onUpdate(
    convexApi.live.getState,
    {},
    (payload: { data: GameState; totalRounds: number | null; viewerCount: number }) => {
      connected = true;
      state = payload.data;
      totalRounds = payload.totalRounds;
      viewerCount = payload.viewerCount;
      setStatus("Convex conectado");
    },
    () => {
      connected = false;
      setStatus("Convex desconectado");
    },
  );
}

function setStatus(value: string) {
  statusEl.textContent = value;
}

function roundRect(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fillStyle: string,
) {
  const p = new Path2D();
  p.moveTo(x + r, y);
  p.lineTo(x + w - r, y);
  p.quadraticCurveTo(x + w, y, x + w, y + r);
  p.lineTo(x + w, y + h - r);
  p.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  p.lineTo(x + r, y + h);
  p.quadraticCurveTo(x, y + h, x, y + h - r);
  p.lineTo(x, y + r);
  p.quadraticCurveTo(x, y, x + r, y);
  ctx.fillStyle = fillStyle;
  ctx.fill(p);
}

function textLines(
  text: string,
  maxWidth: number,
  font: string,
  maxLines = 3,
): string[] {
  ctx.font = font;
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  const maxChunkLength = 1;

  const splitWordToFit = (word: string): string[] => {
    if (!word) return [];
    if (ctx.measureText(word).width <= maxWidth) return [word];

    const pieces: string[] = [];
    let remaining = word;
    while (remaining.length > 0) {
      let low = maxChunkLength;
      let high = remaining.length;
      let best = maxChunkLength;

      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const candidate = remaining.slice(0, mid);
        if (ctx.measureText(candidate).width <= maxWidth) {
          best = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }

      pieces.push(remaining.slice(0, best));
      remaining = remaining.slice(best);
    }

    return pieces;
  };

  for (const word of words) {
    const segments = splitWordToFit(word);
    let isFirstSegment = true;
    for (const segment of segments) {
      const prefix = isFirstSegment && current ? " " : "";
      const candidate = current ? `${current}${prefix}${segment}` : segment;
      if (ctx.measureText(candidate).width <= maxWidth) {
        current = candidate;
        isFirstSegment = false;
        continue;
      }
      if (current) lines.push(current);
      current = segment;
      isFirstSegment = false;
      if (lines.length >= maxLines - 1) break;
    }
    if (lines.length >= maxLines - 1) break;
  }

  if (current) {
    lines.push(current);
  }

  if (lines.length > maxLines) {
    lines.length = maxLines;
  }

  if (words.length > 0 && lines.length === maxLines) {
    const last = lines[maxLines - 1] ?? "";
    if (ctx.measureText(last).width > maxWidth) {
      let trimmed = last;
      while (trimmed.length > 3 && ctx.measureText(`${trimmed}...`).width > maxWidth) {
        trimmed = trimmed.slice(0, -1);
      }
      lines[maxLines - 1] = `${trimmed}...`;
    }
  }

  return lines;
}

function drawTextBlock(
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  font: string,
  color: string,
  maxLines: number,
) {
  const lines = textLines(text, maxWidth, font, maxLines);
  ctx.font = font;
  ctx.fillStyle = color;
  lines.forEach((line, idx) => {
    ctx.fillText(line, x, y + idx * lineHeight);
  });
}

function drawHeader() {
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  if (brandLogo.complete && brandLogo.naturalHeight !== 0) {
    const logoHeight = 34;
    const logoWidth = (brandLogo.naturalWidth / brandLogo.naturalHeight) * logoHeight;
    ctx.drawImage(brandLogo, 48, 44, logoWidth, logoHeight);
  } else {
    ctx.font = '700 40px "Inter", sans-serif';
    ctx.fillStyle = "#ededed";
    ctx.fillText("PapoTorto", 48, 76);
  }

}

function drawRankingSection(
  title: string,
  entries: RankingEntry[],
  maxScore: number,
  startY: number,
  iconForLeader: string,
) {
  ctx.font = '700 15px "JetBrains Mono", monospace';
  ctx.fillStyle = "#888";
  ctx.fillText(title, WIDTH - 348, startY);

  entries.slice(0, 7).forEach((entry, index) => {
    const y = startY + 30 + index * 56;
    const color = getColor(entry.name);
    const pct = maxScore > 0 ? entry.score / maxScore : 0;

    ctx.font = '600 18px "JetBrains Mono", monospace';
    ctx.fillStyle = "#888";
    const rank = index === 0 && entry.score > 0 ? iconForLeader : String(index + 1);
    ctx.fillText(rank, WIDTH - 348, y + 20);

    ctx.font = '600 18px "Inter", sans-serif';
    ctx.fillStyle = color;
    const nameText = entry.name.length > 17 ? `${entry.name.slice(0, 17)}...` : entry.name;

    const drewLogo = drawModelLogo(entry.name, WIDTH - 304, y + 2, 20);
    if (drewLogo) {
      ctx.fillText(nameText, WIDTH - 304 + 28, y + 20);
    } else {
      ctx.fillText(nameText, WIDTH - 304, y + 20);
    }

    roundRect(WIDTH - 304, y + 34, 208, 4, 2, "#1c1c1c");
    if (pct > 0) {
      roundRect(WIDTH - 304, y + 34, Math.max(8, 208 * pct), 4, 2, color);
    }

    ctx.font = '700 18px "JetBrains Mono", monospace';
    ctx.fillStyle = "#888";
    const scoreText = String(entry.score);
    const scoreWidth = ctx.measureText(scoreText).width;
    ctx.fillText(scoreText, WIDTH - 48 - scoreWidth, y + 20);
  });
}

function drawScoreboard(
  scores: Record<string, number>,
  humanScores: Record<string, number>,
  humanVoteTotals: Record<string, number>,
) {
  const names = collectRankingNames(scores, humanScores, humanVoteTotals);
  const humanEntries = rankByScore(humanScores, humanVoteTotals, names);
  const iaEntries = rankByScore(scores, {}, names);
  const maxHuman = humanEntries[0]?.score || 1;
  const maxIa = iaEntries[0]?.score || 1;

  roundRect(WIDTH - 380, 0, 380, HEIGHT, 0, "#111");
  ctx.fillStyle = "#1c1c1c";
  ctx.fillRect(WIDTH - 380, 0, 1, HEIGHT);

  drawRankingSection("RANKING PLATEIA", humanEntries, maxHuman, 70, "👥");
  drawRankingSection("RANKING IA", iaEntries, maxIa, 520, "👑");
}
function drawVotingCountdownWidget(countdown: VotingCountdownView, mainW: number) {
  const boxW = 332;
  const boxH = 66;
  const x = mainW - 64 - boxW;
  const y = 170;

  roundRect(x, y, boxW, boxH, 10, "rgba(255,255,255,0.03)");
  ctx.strokeStyle = "#1c1c1c";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, boxW - 1, boxH - 1);

  ctx.font = '600 14px "JetBrains Mono", monospace';
  ctx.fillStyle = "#888";
  ctx.fillText(countdown.label.toUpperCase(), x + 14, y + 25);

  ctx.font = '700 28px "JetBrains Mono", monospace';
  ctx.fillStyle = "#ededed";
  const timeWidth = ctx.measureText(countdown.display).width;
  ctx.fillText(countdown.display, x + boxW - 14 - timeWidth, y + 32);

  const barX = x + 14;
  const barY = y + boxH - 16;
  const barW = boxW - 28;
  const barH = 6;
  roundRect(barX, barY, barW, barH, 3, "#1c1c1c");
  roundRect(
    barX,
    barY,
    Math.round(barW * countdown.progress),
    barH,
    3,
    countdown.isZero ? "#555" : "#D97757",
  );
}

function drawRound(round: RoundState) {
  const mainW = WIDTH - 380;
  const countdown = countdownTracker.compute(round, Date.now());

  const phaseLabel =
    (round.phase === "prompting"
      ? "Escrevendo prompt"
      : round.phase === "answering"
        ? "Respondendo"
        : round.phase === "voting"
          ? "Jurados votando"
          : "Concluida"
    ).toUpperCase();

  ctx.font = '700 22px "JetBrains Mono", monospace';
  ctx.fillStyle = "#ededed";
  const totalText = totalRounds !== null ? `/${totalRounds}` : "";
  ctx.fillText(`Rodada ${round.num}${totalText}`, 64, 150);

  ctx.fillStyle = "#888";
  const labelWidth = ctx.measureText(phaseLabel).width;
  ctx.fillText(phaseLabel, mainW - 64 - labelWidth, 150);

  if (round.phase === "voting" && countdown) {
    drawVotingCountdownWidget(countdown, mainW);
  }

  ctx.font = '600 18px "JetBrains Mono", monospace';
  ctx.fillStyle = "#888";
  const promptedText = "PROMPT DE ";
  ctx.fillText(promptedText, 64, 210);

  const pTw = ctx.measureText(promptedText).width;
  ctx.fillStyle = getColor(round.prompter.name);
  const drewPLogo = drawModelLogo(round.prompter.name, 64 + pTw, 210 - 14, 20);

  if (drewPLogo) {
    ctx.fillText(round.prompter.name.toUpperCase(), 64 + pTw + 24, 210);
  } else {
    ctx.fillText(round.prompter.name.toUpperCase(), 64 + pTw, 210);
  }

  const promptText =
    round.prompt ??
    (round.phase === "prompting" ? "Gerando prompt..." : "Prompt indisponivel");

  const promptFont = '400 56px "DM Serif Display", serif';
  const promptLineHeight = 72;
  const promptMaxLines = 3;
  const promptMaxWidth = mainW - 120;
  const promptLines = textLines(promptText, promptMaxWidth, promptFont, promptMaxLines);
  const promptTextHeight = promptLines.length * promptLineHeight;
  const promptBaselineY = 262;
  const promptBarY = promptBaselineY - 44;

  ctx.fillStyle = getColor(round.prompter.name);
  ctx.fillRect(64, promptBarY, 4, promptTextHeight + 6);

  drawTextBlock(
    promptText,
    80,
    promptBaselineY,
    promptMaxWidth,
    promptLineHeight,
    promptFont,
    round.prompt ? "#ededed" : "#444",
    promptMaxLines,
  );

  if (round.phase !== "prompting") {
    const [taskA, taskB] = round.answerTasks;
    const cardW = (mainW - 160) / 2;
    const cardY = promptBarY + promptTextHeight + 6 + 32;
    const cardH = HEIGHT - cardY - 40;
    drawContestantCard(taskA, 64, cardY, cardW, cardH, round);
    drawContestantCard(taskB, 64 + cardW + 32, cardY, cardW, cardH, round);
  }
}

function drawContestantCard(
  task: TaskInfo,
  x: number,
  y: number,
  w: number,
  h: number,
  round: RoundState,
) {
  const [a, b] = round.contestants;
  let votesA = 0;
  let votesB = 0;
  const taskVoters: VoteInfo[] = [];
  for (const vote of round.votes) {
    if (vote.votedFor?.name === a.name) votesA += 1;
    if (vote.votedFor?.name === b.name) votesB += 1;
    if (vote.votedFor?.name === task.model.name) taskVoters.push(vote);
  }
  const isFirst = round.answerTasks[0].model.name === task.model.name;
  const voteCount = isFirst ? votesA : votesB;
  const isWinner = round.phase === "done" && voteCount > (isFirst ? votesB : votesA);
  
  const color = getColor(task.model.name);
  
  ctx.fillStyle = color;
  ctx.fillRect(x, y, isWinner ? 6 : 4, h);
  
  if (isWinner) {
    roundRect(x, y, w, h, 0, "rgba(255,255,255,0.03)");
  }

  ctx.font = '700 32px "Inter", sans-serif';
  ctx.fillStyle = color;
  const drewCLogo = drawModelLogo(task.model.name, x + 24, y + 16, 32);
  if (drewCLogo) {
    ctx.fillText(task.model.name, x + 64, y + 44);
  } else {
    ctx.fillText(task.model.name, x + 24, y + 44);
  }

  if (isWinner) {
    ctx.font = '700 18px "JetBrains Mono", monospace';
    ctx.fillStyle = "#0a0a0a";
    const winW = ctx.measureText("VENCEU").width;
    roundRect(x + w - 24 - winW - 24, y + 16, winW + 24, 36, 6, "#ededed");
    ctx.fillStyle = "#0a0a0a";
    ctx.fillText("VENCEU", x + w - 24 - winW - 12, y + 40);
  }

  const answer =
    !task.finishedAt && !task.result
      ? "Escrevendo resposta..."
      : task.error
        ? task.error
        : task.result ?? "Sem resposta";

  drawTextBlock(
    task.result ? `"${answer}"` : answer,
    x + 24,
    y + 120,
    w - 48,
    52,
    '400 40px "DM Serif Display", serif',
    isWinner ? "#ededed" : (!task.finishedAt && !task.result ? "#444" : "#888"),
    6,
  );

  const showVotes = round.phase === "voting" || round.phase === "done";
  if (showVotes) {
    const totalVotes = votesA + votesB;
    const pct = totalVotes > 0 ? Math.round((voteCount / totalVotes) * 100) : 0;

    const viewerVoteCount = isFirst ? (round.viewerVotesA ?? 0) : (round.viewerVotesB ?? 0);
    const totalViewerVotes = (round.viewerVotesA ?? 0) + (round.viewerVotesB ?? 0);
    const hasViewerVotes = totalViewerVotes > 0;

    // Shift model votes up when viewer votes are present
    const modelVoteBarY = hasViewerVotes ? y + h - 110 : y + h - 60;
    const modelVoteTextY = hasViewerVotes ? y + h - 74 : y + h - 24;

    roundRect(x + 24, modelVoteBarY, w - 48, 4, 2, "#1c1c1c");
    if (pct > 0) {
      roundRect(x + 24, modelVoteBarY, Math.max(8, ((w - 48) * pct) / 100), 4, 2, color);
    }

    ctx.font = '700 28px "JetBrains Mono", monospace';
    ctx.fillStyle = color;
    ctx.fillText(String(voteCount), x + 24, modelVoteTextY);

    ctx.font = '600 20px "JetBrains Mono", monospace';
    ctx.fillStyle = "#444";
    const vTxt = `voto${voteCount === 1 ? "" : "s"}`;
    const vCountW = ctx.measureText(String(voteCount)).width;
    const vTxtW = ctx.measureText(vTxt).width;
    ctx.fillText(vTxt, x + 24 + vCountW + 8, modelVoteTextY - 1);

    let avatarX = x + 24 + vCountW + 8 + vTxtW + 16;
    const avatarY = modelVoteBarY + 12;
    const avatarSize = 28;

    for (const v of taskVoters) {
      const vColor = getColor(v.voter.name);
      const drewLogo = drawModelLogo(v.voter.name, avatarX, avatarY, avatarSize);

      if (!drewLogo) {
        ctx.beginPath();
        ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
        ctx.fillStyle = vColor;
        ctx.fill();
        ctx.font = '700 12px "Inter", sans-serif';
        ctx.fillStyle = "#0a0a0a";
        const initial = v.voter.name[0] ?? "?";
        const tw = ctx.measureText(initial).width;
        ctx.fillText(initial, avatarX + avatarSize / 2 - tw / 2, avatarY + avatarSize / 2 + 4);
      }

      avatarX += avatarSize + 8;
    }

    // Viewer votes
    if (hasViewerVotes) {
      const viewerPct = Math.round((viewerVoteCount / totalViewerVotes) * 100);

      roundRect(x + 24, y + h - 56, w - 48, 4, 2, "#1c1c1c");
      if (viewerPct > 0) {
        roundRect(x + 24, y + h - 56, Math.max(8, ((w - 48) * viewerPct) / 100), 4, 2, "#666");
      }

      ctx.font = '700 22px "JetBrains Mono", monospace';
      ctx.fillStyle = "#999";
      ctx.fillText(String(viewerVoteCount), x + 24, y + h - 22);

      const vvCountW = ctx.measureText(String(viewerVoteCount)).width;
      ctx.font = '600 16px "JetBrains Mono", monospace';
      ctx.fillStyle = "#444";
      const vvTxt = `voto${viewerVoteCount === 1 ? "" : "s"} da plateia`;
      ctx.fillText(vvTxt, x + 24 + vvCountW + 8, y + h - 23);
    }
  }
}

function drawWaiting() {
  const mainW = WIDTH - 380;
  ctx.font = '400 48px "DM Serif Display", serif';
  ctx.fillStyle = "#888";
  const text = "Aguardando estado do jogo...";
  const tw = ctx.measureText(text).width;
  ctx.fillText(text, (mainW - tw) / 2, HEIGHT / 2);
}

function drawDone(
  scores: Record<string, number>,
  humanScores: Record<string, number>,
  humanVoteTotals: Record<string, number>,
) {
  const mainW = WIDTH - 380;
  const names = collectRankingNames(scores, humanScores, humanVoteTotals);
  const iaChampion = rankByScore(scores, {}, names)[0];
  const humanChampion = rankByScore(humanScores, humanVoteTotals, names).find((entry) => entry.score > 0);

  ctx.font = '700 20px "JetBrains Mono", monospace';
  ctx.fillStyle = "#444";
  const go = "FIM DE JOGO";
  const gow = ctx.measureText(go).width;
  ctx.fillText(go, (mainW - gow) / 2, HEIGHT / 2 - 150);

  if (iaChampion && iaChampion.score > 0) {
    ctx.font = '600 20px "JetBrains Mono", monospace';
    ctx.fillStyle = "#888";
    const iaLabel = "CAMPEAO IA";
    const iaLabelW = ctx.measureText(iaLabel).width;
    ctx.fillText(iaLabel, (mainW - iaLabelW) / 2, HEIGHT / 2 - 92);

    ctx.font = '400 62px "DM Serif Display", serif';
    ctx.fillStyle = getColor(iaChampion.name);
    const iaNameW = ctx.measureText(iaChampion.name).width;
    ctx.fillText(iaChampion.name, (mainW - iaNameW) / 2, HEIGHT / 2 - 24);
  }

  ctx.font = '600 20px "JetBrains Mono", monospace';
  ctx.fillStyle = "#888";
  const humanLabel = "CAMPEAO PLATEIA";
  const humanLabelW = ctx.measureText(humanLabel).width;
  ctx.fillText(humanLabel, (mainW - humanLabelW) / 2, HEIGHT / 2 + 52);

  if (humanChampion) {
    ctx.font = '400 58px "DM Serif Display", serif';
    ctx.fillStyle = getColor(humanChampion.name);
    const humanNameW = ctx.measureText(humanChampion.name).width;
    ctx.fillText(humanChampion.name, (mainW - humanNameW) / 2, HEIGHT / 2 + 122);
  } else {
    ctx.font = '600 28px "Inter", sans-serif';
    ctx.fillStyle = "#666";
    const none = "Sem campeao da plateia";
    const noneW = ctx.measureText(none).width;
    ctx.fillText(none, (mainW - noneW) / 2, HEIGHT / 2 + 112);
  }
}
function draw() {
  drawHeader();
  if (!state) {
    drawWaiting();
      return;
  }

  drawScoreboard(
    state.scores ?? {},
    state.humanScores ?? {},
    state.humanVoteTotals ?? {},
  );
  
  const isNextPrompting = state.active?.phase === "prompting" && !state.active.prompt;
  const displayRound = isNextPrompting && state.lastCompleted ? state.lastCompleted : (state.active ?? state.lastCompleted ?? null);

  if (state.done) {
    drawDone(
      state.scores ?? {},
      state.humanScores ?? {},
      state.humanVoteTotals ?? {},
    );
  } else if (displayRound) {
    drawRound(displayRound);
  } else {
    drawWaiting();
  }
}

function renderLoop() {
  draw();
  window.requestAnimationFrame(renderLoop);
}

function startCanvasCaptureSink() {
  const params = new URLSearchParams(window.location.search);
  const sink = params.get("sink");
  if (!sink) return;

  if (!("MediaRecorder" in window)) {
    setStatus("MediaRecorder indisponivel");
    return;
  }

  const fps = Number.parseInt(params.get("captureFps") ?? "30", 10);
  const bitRate = Number.parseInt(params.get("captureBitrate") ?? "12000000", 10);
  const stream = canvas.captureStream(Number.isFinite(fps) && fps > 0 ? fps : 30);
  const sinkUrl = sink;

  let recorder: MediaRecorder | null = null;
  let queuedBytes = 0;
  let pendingSend = Promise.resolve();
  const mimeCandidates = [
    "video/webm;codecs=vp8",
    "video/webm;codecs=vp9",
    "video/webm",
  ];
  const mimeType =
    mimeCandidates.find((value) => MediaRecorder.isTypeSupported(value)) ?? "";

  const options: MediaRecorderOptions = {
    videoBitsPerSecond: Number.isFinite(bitRate) && bitRate > 0 ? bitRate : 12_000_000,
  };
  if (mimeType) options.mimeType = mimeType;

  recorder = new MediaRecorder(stream, options);
  recorder.ondataavailable = async (event) => {
    if (event.data.size === 0) return;
    if (queuedBytes > 16_000_000) return;
    const chunk = await event.data.arrayBuffer();
    queuedBytes += chunk.byteLength;
    pendingSend = pendingSend
      .catch(() => {})
      .then(async () => {
        try {
          const response = await fetch(sinkUrl, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: chunk,
          });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
        } catch {
          setStatus("falha ao enviar chunk");
        } finally {
          queuedBytes -= chunk.byteLength;
        }
      });
  };
  recorder.onerror = () => {
    setStatus("Erro no gravador");
  };
  recorder.start(250);
  setStatus(`captura->http ${fps}fps`);
}

setupRealtime();
startCanvasCaptureSink();
renderLoop();

window.addEventListener("beforeunload", () => {
  liveUnsubscribe?.unsubscribe();
  if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer);
  void convex.close();
});


