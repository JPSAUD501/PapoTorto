export const MODELS = [
  { id: "google/gemini-3-flash", name: "Gemini 3 Flash" },
  { id: "moonshotai/kimi-k2", name: "Kimi K2" },
  { id: "deepseek/deepseek-v3.2", name: "DeepSeek 3.2" },
  { id: "qwen/qwen3.5-plus-02-15", name: "Qwen 3.5 Plus" },
  { id: "z-ai/glm-5", name: "GLM-5" },
  { id: "openai/gpt-5.2", name: "GPT-5.2" },
  { id: "anthropic/claude-sonnet-4.6", name: "Sonnet 4.6" },
  { id: "x-ai/grok-4.1-fast", name: "Grok 4.1" },
] as const;

export type Model = (typeof MODELS)[number];

export const MODEL_COLORS: Record<string, string> = {
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
