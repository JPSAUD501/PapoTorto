export const AVAILABLE_MODEL_LOGO_IDS = [
  "claude",
  "deepseek",
  "gemini",
  "glm",
  "grok",
  "kimi",
  "minimax",
  "openai",
  "qwen",
] as const;

export const AVAILABLE_MODEL_COLORS = [
  "#10A37F",
  "#14B8A6",
  "#06B6D4",
  "#0EA5E9",
  "#3B82F6",
  "#6366F1",
  "#8B5CF6",
  "#A855F7",
  "#D946EF",
  "#EC4899",
  "#F43F5E",
  "#EF4444",
  "#F97316",
  "#F59E0B",
  "#EAB308",
  "#84CC16",
  "#22C55E",
  "#16A34A",
  "#10B981",
  "#2DD4BF",
  "#38BDF8",
  "#60A5FA",
  "#F87171",
  "#FB7185",
] as const;

export type ModelLogoId = (typeof AVAILABLE_MODEL_LOGO_IDS)[number];

export type Model = {
  id: string;
  name: string;
  color?: string;
  logoId?: ModelLogoId;
};

export type ModelCatalogEntry = {
  _id?: string;
  modelId: string;
  name: string;
  color: string;
  logoId: ModelLogoId;
  enabled: boolean;
  archivedAt?: number;
  createdAt?: number;
  updatedAt?: number;
};

export const DEFAULT_MODEL_COLOR = "#A1A1A1";

const LOGO_ID_SET = new Set<string>(AVAILABLE_MODEL_LOGO_IDS);

export function isValidModelLogoId(value: string): value is ModelLogoId {
  return LOGO_ID_SET.has(value);
}

export function getLogoUrlById(logoId?: string | null): string | null {
  if (!logoId || !isValidModelLogoId(logoId)) return null;
  return `/assets/logos/${logoId}.svg`;
}

export function normalizeHexColor(input?: string | null): string {
  const value = (input ?? "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(value)) {
    return value.toUpperCase();
  }
  return DEFAULT_MODEL_COLOR;
}

export function toRuntimeModel(entry: Pick<ModelCatalogEntry, "modelId" | "name" | "color" | "logoId">): Model {
  return {
    id: entry.modelId,
    name: entry.name,
    color: normalizeHexColor(entry.color),
    logoId: entry.logoId,
  };
}
