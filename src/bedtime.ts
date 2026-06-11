// ─── Bedtime Mode ─────────────────────────────────────────────────────────────
//
// Hero feature: block requests that would push spend above 2× the key's rolling
// daily baseline during sleeping hours.
//
// KV layout:
//   bedtime:baseline:{keyId}    → rolling 7-day average daily spend (float string)
//   bedtime:days:{keyId}        → JSON array of last 7 daily spend values
//   bedtime:enabled:{keyId}     → "1" | "0"  (overrides record.bedtimeEnabled)
//
// Baseline logic:
//   - Maintain a JSON array of last 7 daily spend totals for the key.
//   - Rolling average = sum / count (excluding days with no data).
//   - On the very first day, baseline = 0 → any spend unblocks once >0 baseline exists.
//
// "During sleeping hours" = outside [wakeHour, wakeHour + 16) in the key's timezone.
//   Default: blocked 23:00 → 07:00.  Wake hour default = 7.

import { BulwarkKeyRecord, Env } from "./types.js";

export const BEDTIME_MULTIPLIER = 2.0;
const BASELINE_WINDOW_DAYS = 7;

export interface BedtimeCheckResult {
  blocked: false;
}
export interface BedtimeBlocked {
  blocked: true;
  status: 429;
  code: "bedtime_mode_active";
  message: string;
  wakeHour: number;
  baselineUsd: number;
  projectedSpendUsd: number;
}
export type BedtimeOutcome = BedtimeCheckResult | BedtimeBlocked;

/**
 * Check Bedtime Mode. Called after caps check but before forwarding the request.
 * estimatedCost: use 0 (unknown) — the check is conservative: if today's spend
 * already exceeds 2× baseline we block even without a cost estimate.
 */
export async function checkBedtime(
  record: BulwarkKeyRecord,
  todaySpendUsd: number,
  env: Env,
): Promise<BedtimeOutcome> {
  if (!record.bedtimeEnabled) return { blocked: false };

  // Allow an override stored in KV (for the POST /v1/bedtime toggle endpoint)
  const kvToggle = await env.BULWARK_KV.get(`bedtime:enabled:${record.keyId}`);
  if (kvToggle === "0") return { blocked: false };

  // Check if currently in sleeping hours
  if (!isInBedtimeWindow(record.wakeHour, record.timezone)) {
    return { blocked: false };
  }

  const baseline = await getRollingBaseline(record.keyId, env);
  // No baseline yet (new key) — let the first day through to build baseline
  if (baseline === 0) return { blocked: false };

  const threshold = baseline * BEDTIME_MULTIPLIER;
  if (todaySpendUsd >= threshold) {
    return {
      blocked: true,
      status: 429,
      code: "bedtime_mode_active",
      message:
        `Bedtime Mode is active. Today's spend ($${todaySpendUsd.toFixed(4)}) has reached ` +
        `${BEDTIME_MULTIPLIER}× your daily baseline ($${baseline.toFixed(4)}). ` +
        `Requests are blocked until ${record.wakeHour}:00 ${record.timezone}. ` +
        `Disable Bedtime Mode via POST /v1/bedtime or wait until morning.`,
      wakeHour: record.wakeHour,
      baselineUsd: baseline,
      projectedSpendUsd: todaySpendUsd,
    };
  }

  return { blocked: false };
}

/**
 * Update the rolling daily baseline at end-of-day (or called periodically).
 * Appends today's total spend to the history window and recomputes the average.
 */
export async function updateDailyBaseline(
  keyId: string,
  todaySpendUsd: number,
  env: Env,
): Promise<void> {
  const historyJson = await env.BULWARK_KV.get(`bedtime:days:${keyId}`);
  const history: number[] = historyJson ? JSON.parse(historyJson) : [];

  history.push(todaySpendUsd);
  // Keep only the last N days
  const window = history.slice(-BASELINE_WINDOW_DAYS);

  const avg = window.reduce((sum, v) => sum + v, 0) / window.length;

  await Promise.all([
    env.BULWARK_KV.put(`bedtime:days:${keyId}`, JSON.stringify(window), {
      expirationTtl: 90 * 24 * 3600,
    }),
    env.BULWARK_KV.put(`bedtime:baseline:${keyId}`, avg.toFixed(8), {
      expirationTtl: 90 * 24 * 3600,
    }),
  ]);
}

/** Fetch the current rolling baseline (USD). Returns 0 if none recorded yet. */
export async function getRollingBaseline(keyId: string, env: Env): Promise<number> {
  const val = await env.BULWARK_KV.get(`bedtime:baseline:${keyId}`);
  return val ? parseFloat(val) : 0;
}

/**
 * Toggle Bedtime Mode on/off for a key via KV override.
 * POST /v1/bedtime body: { "enabled": boolean }
 */
export async function setBedtimeEnabled(
  keyId: string,
  enabled: boolean,
  env: Env,
): Promise<void> {
  await env.BULWARK_KV.put(`bedtime:enabled:${keyId}`, enabled ? "1" : "0", {
    expirationTtl: 365 * 24 * 3600,
  });
}

// ─── Time helpers ─────────────────────────────────────────────────────────────

/**
 * Returns true if the current time is within the "sleeping" window
 * (i.e. outside [wakeHour, wakeHour + 16) in the given timezone).
 *
 * Sleeping window: from (wakeHour - 8) to wakeHour of the next day, i.e.
 * if wake = 7am → sleeping between 11pm and 7am.
 * We define "bedtime window" as any hour < wakeHour OR hour >= (wakeHour + 16).
 */
export function isInBedtimeWindow(wakeHour: number, timezone: string): boolean {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    });
    const parts = formatter.formatToParts(new Date());
    const hourPart = parts.find((p) => p.type === "hour");
    const localHour = hourPart ? parseInt(hourPart.value, 10) : new Date().getUTCHours();
    // Active hours: [wakeHour, wakeHour+16)
    // Sleeping hours: everything else
    const activeEnd = (wakeHour + 16) % 24;
    if (activeEnd > wakeHour) {
      return localHour < wakeHour || localHour >= activeEnd;
    } else {
      // Wraps midnight
      return localHour >= activeEnd && localHour < wakeHour;
    }
  } catch {
    // Unknown timezone — fall back to UTC
    const utcHour = new Date().getUTCHours();
    return utcHour < wakeHour || utcHour >= wakeHour + 16;
  }
}
