// ─── Hard spend caps ──────────────────────────────────────────────────────────
//
// KV layout:
//   spend:daily:{keyId}:{yyyymmdd}   → USD spend as string (e.g. "1.2345")
//   spend:monthly:{keyId}:{yyyymm}   → USD spend as string
//
// Reads happen BEFORE forwarding; writes happen AFTER cost is known (usage.ts).
// Both daily and monthly caps must pass before a request is forwarded.

import { BulwarkKeyRecord, Env } from "./types.js";

export interface CapsCheckResult {
  allowed: true;
}
export interface CapsBlocked {
  allowed: false;
  status: 429;
  code: "daily_cap_exceeded" | "monthly_cap_exceeded";
  message: string;
  capUsd: number;
  spentUsd: number;
  resetAt: string; // ISO-8601 of next reset window
}
export type CapsOutcome = CapsCheckResult | CapsBlocked;

/** Read current daily spend for a key (USD). */
export async function getDailySpend(keyId: string, env: Env): Promise<number> {
  const val = await env.BULWARK_KV.get(`spend:daily:${keyId}:${utcDate()}`);
  return val ? parseFloat(val) : 0;
}

/** Read current monthly spend for a key (USD). */
export async function getMonthlySpend(keyId: string, env: Env): Promise<number> {
  const val = await env.BULWARK_KV.get(`spend:monthly:${keyId}:${utcYearMonth()}`);
  return val ? parseFloat(val) : 0;
}

/**
 * Check both daily and monthly caps BEFORE forwarding a request.
 * We don't know the cost yet, so we check current spend against the cap
 * conservatively. The actual cost is added after the request completes.
 */
export async function checkCaps(record: BulwarkKeyRecord, env: Env): Promise<CapsOutcome> {
  const { keyId, dailyCapUsd, monthlyCapUsd } = record;

  if (dailyCapUsd > 0) {
    const spent = await getDailySpend(keyId, env);
    if (spent >= dailyCapUsd) {
      return {
        allowed: false,
        status: 429,
        code: "daily_cap_exceeded",
        message: `Daily spend cap of $${dailyCapUsd.toFixed(2)} reached ($${spent.toFixed(4)} spent). Resets at UTC midnight.`,
        capUsd: dailyCapUsd,
        spentUsd: spent,
        resetAt: nextUtcMidnight(),
      };
    }
  }

  if (monthlyCapUsd > 0) {
    const spent = await getMonthlySpend(keyId, env);
    if (spent >= monthlyCapUsd) {
      return {
        allowed: false,
        status: 429,
        code: "monthly_cap_exceeded",
        message: `Monthly spend cap of $${monthlyCapUsd.toFixed(2)} reached ($${spent.toFixed(4)} spent). Resets on the 1st of next month.`,
        capUsd: monthlyCapUsd,
        spentUsd: spent,
        resetAt: nextMonthStart(),
      };
    }
  }

  return { allowed: true };
}

/**
 * Add cost to daily and monthly spend counters. Fire-and-forget is acceptable
 * (minor over-spend on race condition is better than blocking the hot path).
 */
export async function recordSpend(keyId: string, costUsd: number, env: Env): Promise<void> {
  if (costUsd <= 0) return;

  const today = utcDate();
  const yearMonth = utcYearMonth();

  await Promise.all([
    incrementFloat(`spend:daily:${keyId}:${today}`, costUsd, 26 * 3600, env),
    incrementFloat(`spend:monthly:${keyId}:${yearMonth}`, costUsd, 35 * 24 * 3600, env),
  ]);
}

// ─── KV float helpers ────────────────────────────────────────────────────────

async function incrementFloat(
  key: string,
  delta: number,
  ttlSeconds: number,
  env: Env,
): Promise<void> {
  const current = await env.BULWARK_KV.get(key);
  const next = current ? parseFloat(current) + delta : delta;
  await env.BULWARK_KV.put(key, next.toFixed(8), { expirationTtl: ttlSeconds });
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

export function utcDate(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function utcYearMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function nextUtcMidnight(): string {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}

function nextMonthStart(): string {
  const d = new Date();
  const year = d.getUTCMonth() === 11 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
  const month = d.getUTCMonth() === 11 ? 0 : d.getUTCMonth() + 1;
  return new Date(Date.UTC(year, month, 1)).toISOString();
}
