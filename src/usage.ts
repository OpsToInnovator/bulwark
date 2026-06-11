// ─── Usage tracking ────────────────────────────────────────────────────────────
//
// Every proxied request generates a UsageRecord.
//
// Write path:
//   1. Sync: update KV hot counters (daily/monthly spend, request count, baseline)
//   2. Async (fire-and-forget): write full record to Postgres via Hyperdrive
//
// If HYPERDRIVE binding is absent (local dev, or not yet configured) the Postgres
// write is silently skipped — KV counters still work.
//
// Anomaly flag: raised when today's spend > 3× rolling baseline.
//
// KV layout mirrors caps.ts — this module calls caps.recordSpend.

import { Env, Provider, UsageRecord } from "./types.js";
import { recordSpend, getDailySpend } from "./caps.js";
import { getRollingBaseline } from "./bedtime.js";
import { incrementRequestCounter } from "./auth.js";

export interface RecordUsageInput {
  requestId: string;
  keyId: string;
  provider: Provider;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  cacheHit: boolean;
  latencyMs: number;
  httpStatus: number;
}

/**
 * Record usage for a completed request.
 * This is intentionally fire-and-forget from the hot path — use ctx.waitUntil.
 */
export async function recordUsage(input: RecordUsageInput, env: Env): Promise<void> {
  const baseline = await getRollingBaseline(input.keyId, env);
  const todaySpend = await getDailySpend(input.keyId, env);
  const projectedDailySpend = todaySpend + input.costUsd;
  const anomalyFlag = baseline > 0 && projectedDailySpend > baseline * 3;

  const record: UsageRecord = {
    requestId: input.requestId,
    keyId: input.keyId,
    provider: input.provider,
    model: input.model,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    costUsd: input.costUsd,
    cacheHit: input.cacheHit,
    anomalyFlag,
    latencyMs: input.latencyMs,
    timestamp: new Date().toISOString(),
    httpStatus: input.httpStatus,
  };

  // KV hot counter updates (parallel)
  await Promise.all([
    recordSpend(input.keyId, input.costUsd, env),
    incrementRequestCounter(input.keyId, env),
    storeRecentUsage(record, env),
  ]);

  // Postgres write (non-blocking)
  writeToPostgres(record, env).catch((err) => {
    console.error("[bulwark/usage] Postgres write failed:", err);
  });
}

// ─── Recent usage in KV (for hot reads / dashboard) ──────────────────────────

const MAX_RECENT_RECORDS = 50;

async function storeRecentUsage(record: UsageRecord, env: Env): Promise<void> {
  const key = `usage:recent:${record.keyId}`;
  const existing = await env.BULWARK_KV.get(key, { type: "json" }) as UsageRecord[] | null;
  const records = existing ?? [];
  records.unshift(record);
  const trimmed = records.slice(0, MAX_RECENT_RECORDS);
  await env.BULWARK_KV.put(key, JSON.stringify(trimmed), {
    expirationTtl: 7 * 24 * 3600,
  });
}

// ─── Postgres via Hyperdrive ──────────────────────────────────────────────────
//
// SQL schema (run once on your Neon DB):
//
//   CREATE TABLE IF NOT EXISTS usage_records (
//     request_id     TEXT PRIMARY KEY,
//     key_id         TEXT NOT NULL,
//     provider       TEXT NOT NULL,
//     model          TEXT NOT NULL,
//     prompt_tokens  INT  NOT NULL,
//     completion_tokens INT NOT NULL,
//     cost_usd       NUMERIC(12,8) NOT NULL,
//     cache_hit      BOOLEAN NOT NULL,
//     anomaly_flag   BOOLEAN NOT NULL,
//     latency_ms     INT NOT NULL,
//     timestamp      TIMESTAMPTZ NOT NULL,
//     http_status    INT NOT NULL
//   );
//   CREATE INDEX ON usage_records(key_id, timestamp DESC);

async function writeToPostgres(record: UsageRecord, env: Env): Promise<void> {
  if (!env.HYPERDRIVE) return; // Graceful no-op

  // Hyperdrive exposes a connectionString; use fetch to the Hyperdrive endpoint
  // In practice you'd use a Postgres client. Here we use a raw SQL query via
  // the Hyperdrive REST-like interface using the Workers Postgres driver pattern.
  // NOTE: @neondatabase/serverless or postgres.js can be used with Hyperdrive.
  // This stub uses dynamic import for the optional dependency.
  try {
    // Dynamic import allows tree-shaking when not deployed with Hyperdrive
    const { Client } = await import("@neondatabase/serverless" as string) as {
      Client: new (config: { connectionString: string }) => {
        connect(): Promise<void>;
        query(sql: string, params: unknown[]): Promise<unknown>;
        end(): Promise<void>;
      };
    };
    const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
    await client.connect();
    await client.query(
      `INSERT INTO usage_records
         (request_id,key_id,provider,model,prompt_tokens,completion_tokens,
          cost_usd,cache_hit,anomaly_flag,latency_ms,timestamp,http_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (request_id) DO NOTHING`,
      [
        record.requestId,
        record.keyId,
        record.provider,
        record.model,
        record.promptTokens,
        record.completionTokens,
        record.costUsd,
        record.cacheHit,
        record.anomalyFlag,
        record.latencyMs,
        record.timestamp,
        record.httpStatus,
      ],
    );
    await client.end();
  } catch (err) {
    // Don't let DB errors surface to the user
    console.error("[bulwark/usage] Hyperdrive insert error:", err);
  }
}

/** Generate a request ID. */
export function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
