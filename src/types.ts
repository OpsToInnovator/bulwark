// ─── Shared types ────────────────────────────────────────────────────────────

export type Tier = "free" | "indie" | "team" | "pro";

export interface TierConfig {
  monthlyRequestLimit: number; // 0 = unlimited
  logRetentionDays: number;
  semanticCache: boolean;
  multiProject: boolean;
  byoPostgres: boolean;
  sso: boolean;
}

export const TIER_CONFIGS: Record<Tier, TierConfig> = {
  free:  { monthlyRequestLimit: 10_000,   logRetentionDays: 7,   semanticCache: false, multiProject: false, byoPostgres: false, sso: false },
  indie: { monthlyRequestLimit: 250_000,  logRetentionDays: 30,  semanticCache: true,  multiProject: false, byoPostgres: false, sso: false },
  team:  { monthlyRequestLimit: 2_000_000, logRetentionDays: 90, semanticCache: true,  multiProject: true,  byoPostgres: false, sso: false },
  pro:   { monthlyRequestLimit: 0,         logRetentionDays: 90, semanticCache: true,  multiProject: true,  byoPostgres: true,  sso: true  },
};

/** Stored in KV under key `apikey:{keyId}` */
export interface BulwarkKeyRecord {
  keyId: string;
  keyHash: string;         // SHA-256 hex of the raw key
  ownerId: string;
  tier: Tier;
  dailyCapUsd: number;     // hard daily cap in USD; 0 = disabled
  monthlyCapUsd: number;   // hard monthly cap in USD; 0 = disabled
  bedtimeEnabled: boolean;
  wakeHour: number;        // 0-23, local to timezone
  timezone: string;        // IANA, e.g. "America/New_York"
  createdAt: string;       // ISO-8601
  active: boolean;
}

export interface UsageRecord {
  requestId: string;
  keyId: string;
  provider: "openai" | "anthropic" | "gemini";
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  cacheHit: boolean;
  anomalyFlag: boolean;
  latencyMs: number;
  timestamp: string;       // ISO-8601
  httpStatus: number;
}

export interface Env {
  BULWARK_KV: KVNamespace;
  HYPERDRIVE?: Hyperdrive;
  CACHE_TTL_SECONDS: string;
  BEDTIME_WAKE_HOUR: string;
  STRIPE_WEBHOOK_SECRET: string;
  ENVIRONMENT: string;
}
