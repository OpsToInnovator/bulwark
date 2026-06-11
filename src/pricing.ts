// ─── Pricing table ────────────────────────────────────────────────────────────
//
// *** UPDATE ME when providers change prices ***
// Last verified: 2025-06 (approximate public list prices)
// Sources: platform.openai.com/docs/pricing, anthropic.com/pricing, ai.google.dev/pricing
//
// Prices in USD per 1,000,000 tokens (per-million).
// Cost = (promptTokens * inputRate + completionTokens * outputRate) / 1_000_000

export interface ModelPricing {
  /** USD per 1M input/prompt tokens */
  inputPerMillion: number;
  /** USD per 1M output/completion tokens */
  outputPerMillion: number;
  /** Human-readable note, e.g. context window */
  note?: string;
}

// ─── OpenAI ──────────────────────────────────────────────────────────────────
// *** UPDATE ME: Check https://platform.openai.com/docs/pricing for current rates ***
const OPENAI_PRICING: Record<string, ModelPricing> = {
  // GPT-5 family
  "gpt-5":                      { inputPerMillion: 15.00, outputPerMillion: 60.00, note: "GPT-5, 128K ctx" },
  "gpt-5-mini":                 { inputPerMillion:  2.50, outputPerMillion: 10.00, note: "GPT-5 Mini, 128K ctx" },

  // GPT-4.x family (still widely used)
  "gpt-4o":                     { inputPerMillion:  2.50, outputPerMillion: 10.00, note: "GPT-4o, 128K ctx" },
  "gpt-4o-mini":                { inputPerMillion:  0.15, outputPerMillion:  0.60, note: "GPT-4o Mini, 128K ctx" },
  "gpt-4-turbo":                { inputPerMillion: 10.00, outputPerMillion: 30.00, note: "GPT-4 Turbo, 128K ctx" },
  "gpt-4-turbo-preview":        { inputPerMillion: 10.00, outputPerMillion: 30.00, note: "GPT-4 Turbo Preview" },
  "gpt-4":                      { inputPerMillion: 30.00, outputPerMillion: 60.00, note: "GPT-4, 8K ctx" },

  // GPT-3.5
  "gpt-3.5-turbo":              { inputPerMillion:  0.50, outputPerMillion:  1.50, note: "GPT-3.5 Turbo, 16K ctx" },
  "gpt-3.5-turbo-instruct":     { inputPerMillion:  1.50, outputPerMillion:  2.00, note: "Instruct" },

  // o-series reasoning
  "o1":                         { inputPerMillion: 15.00, outputPerMillion: 60.00, note: "o1 reasoning" },
  "o1-mini":                    { inputPerMillion:  3.00, outputPerMillion: 12.00, note: "o1-mini" },
  "o3":                         { inputPerMillion: 10.00, outputPerMillion: 40.00, note: "o3 (*** UPDATE ME when GA ***)" },
  "o3-mini":                    { inputPerMillion:  1.10, outputPerMillion:  4.40, note: "o3-mini" },
  "o4-mini":                    { inputPerMillion:  1.10, outputPerMillion:  4.40, note: "o4-mini (*** UPDATE ME ***)" },
};

// ─── Anthropic ───────────────────────────────────────────────────────────────
// *** UPDATE ME: Check https://www.anthropic.com/pricing for current rates ***
const ANTHROPIC_PRICING: Record<string, ModelPricing> = {
  // Claude 4 family
  "claude-opus-4-5":            { inputPerMillion: 15.00, outputPerMillion: 75.00, note: "Claude Opus 4.5, 200K ctx (*** UPDATE ME ***)" },
  "claude-opus-4-0":            { inputPerMillion: 15.00, outputPerMillion: 75.00, note: "Claude Opus 4, 200K ctx" },
  "claude-sonnet-4-5":          { inputPerMillion:  3.00, outputPerMillion: 15.00, note: "Claude Sonnet 4.5 (*** UPDATE ME ***)" },
  "claude-sonnet-4-0":          { inputPerMillion:  3.00, outputPerMillion: 15.00, note: "Claude Sonnet 4" },
  "claude-haiku-4-0":           { inputPerMillion:  0.80, outputPerMillion:  4.00, note: "Claude Haiku 4 (*** UPDATE ME ***)" },

  // Claude 3.x family (still active)
  "claude-3-5-sonnet-20241022": { inputPerMillion:  3.00, outputPerMillion: 15.00, note: "Claude 3.5 Sonnet, 200K ctx" },
  "claude-3-5-sonnet-20240620": { inputPerMillion:  3.00, outputPerMillion: 15.00 },
  "claude-3-5-haiku-20241022":  { inputPerMillion:  0.80, outputPerMillion:  4.00, note: "Claude 3.5 Haiku, 200K ctx" },
  "claude-3-opus-20240229":     { inputPerMillion: 15.00, outputPerMillion: 75.00, note: "Claude 3 Opus, 200K ctx" },
  "claude-3-sonnet-20240229":   { inputPerMillion:  3.00, outputPerMillion: 15.00 },
  "claude-3-haiku-20240307":    { inputPerMillion:  0.25, outputPerMillion:  1.25 },
};

// ─── Google Gemini ───────────────────────────────────────────────────────────
// *** UPDATE ME: Check https://ai.google.dev/pricing for current rates ***
const GEMINI_PRICING: Record<string, ModelPricing> = {
  // Gemini 3.x family
  "gemini-3.0-ultra":           { inputPerMillion: 10.00, outputPerMillion: 30.00, note: "Gemini 3.0 Ultra (*** UPDATE ME when released ***)" },
  "gemini-3.0-pro":             { inputPerMillion:  3.50, outputPerMillion: 10.50, note: "Gemini 3.0 Pro (*** UPDATE ME when released ***)" },
  "gemini-3.0-flash":           { inputPerMillion:  0.30, outputPerMillion:  2.50, note: "Gemini 3.0 Flash (*** UPDATE ME when released ***)" },

  // Gemini 2.x family (current GA)
  "gemini-2.5-pro":             { inputPerMillion:  1.25, outputPerMillion: 10.00, note: "Gemini 2.5 Pro, 1M ctx (<=200K tokens input rate)" },
  "gemini-2.5-flash":           { inputPerMillion:  0.15, outputPerMillion:  0.60, note: "Gemini 2.5 Flash" },
  "gemini-2.0-flash":           { inputPerMillion:  0.10, outputPerMillion:  0.40, note: "Gemini 2.0 Flash" },
  "gemini-2.0-flash-lite":      { inputPerMillion:  0.075,outputPerMillion:  0.30, note: "Gemini 2.0 Flash-Lite" },

  // Gemini 1.5 (legacy)
  "gemini-1.5-pro":             { inputPerMillion:  1.25, outputPerMillion:  5.00, note: "Gemini 1.5 Pro, 2M ctx" },
  "gemini-1.5-flash":           { inputPerMillion:  0.075,outputPerMillion:  0.30, note: "Gemini 1.5 Flash" },
};

// ─── Unified lookup ──────────────────────────────────────────────────────────

export type Provider = "openai" | "anthropic" | "gemini";

const PRICING_TABLES: Record<Provider, Record<string, ModelPricing>> = {
  openai:    OPENAI_PRICING,
  anthropic: ANTHROPIC_PRICING,
  gemini:    GEMINI_PRICING,
};

/**
 * Look up pricing for a model. Returns null if unknown (caller should log and
 * default to $0 rather than crashing, but flag the record for manual review).
 */
export function getModelPricing(provider: Provider, model: string): ModelPricing | null {
  const table = PRICING_TABLES[provider];
  // Exact match first
  if (model in table) return table[model] ?? null;
  // Prefix match: "gpt-4o-mini-2024-07-18" → "gpt-4o-mini"
  // Use longest matching prefix to avoid gpt-4o matching before gpt-4o-mini.
  let bestKey = "";
  let bestPricing: ModelPricing | null = null;
  for (const key of Object.keys(table)) {
    if (model.startsWith(key) && key.length > bestKey.length) {
      bestKey = key;
      bestPricing = table[key] ?? null;
    }
  }
  return bestPricing;
}

/**
 * Calculate cost in USD for a request.
 * Returns 0 and logs a warning if model is unknown rather than throwing.
 */
export function calculateCost(
  provider: Provider,
  model: string,
  promptTokens: number,
  completionTokens: number,
): { costUsd: number; unknownModel: boolean } {
  const pricing = getModelPricing(provider, model);
  if (!pricing) {
    console.warn(`[bulwark/pricing] Unknown model ${provider}/${model} — cost recorded as $0. Add to pricing.ts.`);
    return { costUsd: 0, unknownModel: true };
  }
  const costUsd =
    (promptTokens * pricing.inputPerMillion + completionTokens * pricing.outputPerMillion) /
    1_000_000;
  return { costUsd, unknownModel: false };
}
