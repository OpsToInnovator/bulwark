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
import { Attribution, hasAttribution, recordAttribution } from "./attribution.js";

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
  attribution?: Attribution | undefined;
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

  const attribution = input.attribution;
  if (attribution && hasAttribution(attribution)) {
    record.taskId = attribution.taskId;
    record.agent = attribution.agent;
    record.workflow = attribution.workflow;
    record.tags = Object.keys(attribution.tags).length ? attribution.tags : undefined;
  }

  // KV hot counter updates (parallel)
  const writes: Promise<void>[] = [
    recordSpend(input.keyId, input.costUsd, env),
    incrementRequestCounter(input.keyId, env),
    storeRecentUsage(record, env),
  ];
  if (attribution && hasAttribution(attribution)) {
    writes.push(
      recordAttribution(
        {
          keyId: input.keyId,
          provider: input.provider,
          model: input.model,
          promptTokens: input.promptTokens,
          completionTokens: input.completionTokens,
          costUsd: input.costUsd,
          cacheHit: input.cacheHit,
          httpStatus: input.httpStatus,
          attribution,
        },
        env,
      ),
    );
  }
  await Promise.all(writes);

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
//     http_status    INT NOT NULL,
//     task_id        TEXT,
//     agent          TEXT,
//     workflow       TEXT,
//     tags           JSONB
//   );
//   CREATE INDEX ON usage_records(key_id, timestamp DESC);
//   CREATE INDEX ON usage_records(key_id, task_id) WHERE task_id IS NOT NULL;
//   CREATE INDEX ON usage_records(key_id, agent, timestamp DESC) WHERE agent IS NOT NULL;
//
// Migration for databases created before the attribution layer:
//
//   ALTER TABLE usage_records
//     ADD COLUMN IF NOT EXISTS task_id  TEXT,
//     ADD COLUMN IF NOT EXISTS agent    TEXT,
//     ADD COLUMN IF NOT EXISTS workflow TEXT,
//     ADD COLUMN IF NOT EXISTS tags     JSONB;
//
//   CREATE TABLE IF NOT EXISTS task_outcomes (
//     key_id      TEXT NOT NULL,
//     task_id     TEXT NOT NULL,
//     outcome     TEXT NOT NULL,          -- success | failure | abandoned
//     value_usd   NUMERIC(12,4),
//     note        TEXT,
//     cost_usd    NUMERIC(12,8) NOT NULL, -- ledger cost at time of outcome
//     requests    INT NOT NULL,
//     recorded_at TIMESTAMPTZ NOT NULL,
//     PRIMARY KEY (key_id, task_id)
//   );

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
          cost_usd,cache_hit,anomaly_flag,latency_ms,timestamp,http_status,
          task_id,agent,workflow,tags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
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
        record.taskId ?? null,
        record.agent ?? null,
        record.workflow ?? null,
        record.tags ? JSON.stringify(record.tags) : null,
      ],
    );
    await client.end();
  } catch (err) {
    // Don't let DB errors surface to the user
    console.error("[bulwark/usage] Hyperdrive insert error:", err);
  }
}

/** Persist a task outcome to Postgres (no-op without Hyperdrive). */
export async function writeTaskOutcomeToPostgres(
  row: {
    keyId: string;
    taskId: string;
    outcome: string;
    valueUsd?: number | undefined;
    note?: string | undefined;
    costUsd: number;
    requests: number;
    recordedAt: string;
  },
  env: Env,
): Promise<void> {
  if (!env.HYPERDRIVE) return;
  try {
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
      `INSERT INTO task_outcomes
         (key_id,task_id,outcome,value_usd,note,cost_usd,requests,recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (key_id, task_id) DO UPDATE SET
         outcome = EXCLUDED.outcome, value_usd = EXCLUDED.value_usd, note = EXCLUDED.note,
         cost_usd = EXCLUDED.cost_usd, requests = EXCLUDED.requests, recorded_at = EXCLUDED.recorded_at`,
      [
        row.keyId,
        row.taskId,
        row.outcome,
        row.valueUsd ?? null,
        row.note ?? null,
        row.costUsd,
        row.requests,
        row.recordedAt,
      ],
    );
    await client.end();
  } catch (err) {
    console.error("[bulwark/usage] task_outcomes upsert error:", err);
  }
}

/** Generate a request ID. */
export function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
