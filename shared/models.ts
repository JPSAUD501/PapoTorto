export const MODELS = [
  { id: "google/gemini-3-flash-preview", name: "Gemini 3 Flash" },
  { id: "moonshotai/kimi-k2-0905", name: "Kimi K2" },
  { id: "deepseek/deepseek-v3.2", name: "DeepSeek 3.2" },
  { id: "minimax/minimax-m2.5", name: "MiniMax 2.5" },
  { id: "z-ai/glm-5", name: "GLM-5" },
  { id: "openai/gpt-5.2", name: "GPT-5.2" },
  { id: "anthropic/claude-sonnet-4.6", name: "Sonnet 4.6" },
  { id: "x-ai/grok-4.1-fast", name: "Grok 4.1" },
] as const;

export type Model = (typeof MODELS)[number];
export type ModelId = Model["id"];

const MODEL_BY_ID = new Map<string, Model>(MODELS.map((model) => [model.id, model]));

export const DEFAULT_ENABLED_MODEL_IDS = MODELS.map((model) => model.id) as ModelId[];

export function normalizeEnabledModelIds(input?: string[]): ModelId[] {
  if (!input) return [...DEFAULT_ENABLED_MODEL_IDS];

  const deduped: ModelId[] = [];
  const seen = new Set<string>();
  for (const candidate of input) {
    if (seen.has(candidate)) continue;
    const model = MODEL_BY_ID.get(candidate);
    if (!model) continue;
    deduped.push(model.id);
    seen.add(model.id);
  }

  if (deduped.length > 0) {
    return deduped;
  }
  return [...DEFAULT_ENABLED_MODEL_IDS];
}

export function getEnabledModels(enabledModelIds?: string[]): Model[] {
  const normalizedIds = normalizeEnabledModelIds(enabledModelIds);
  return normalizedIds
    .map((id) => MODEL_BY_ID.get(id))
    .filter((model): model is Model => Boolean(model));
}

export const MODEL_COLORS: Record<string, string> = {
  "Gemini 3 Flash": "#4285F4",
  "Kimi K2": "#00E599",
  "DeepSeek 3.2": "#4D6BFE",
  "GLM-5": "#1F63EC",
  "GPT-5.2": "#10A37F",
  "Sonnet 4.6": "#D97757",
  "Grok 4.1": "#FFFFFF",
  "MiniMax 2.5": "#FF3B30",
};
