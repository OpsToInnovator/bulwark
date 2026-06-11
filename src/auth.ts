// ─── Auth: Bulwark API key validation + tier quota enforcement ───────────────
//
// Keys are passed via:  Authorization: Bearer bwk_<base64url>
// KV layout:
//   apikey:{keyId}          → JSON<BulwarkKeyRecord>
//   usage:req:{keyId}:{yyyymm} → monthly request count (string)

import { BulwarkKeyRecord, Env, TIER_CONFIGS } from "./types.js";

const KEY_PREFIX = "bwk_";

/** Constant-time hex comparison to resist timing attacks. */
async function sha256Hex(value: string): Promise<string> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(value));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface AuthResult {
  ok: true;
  record: BulwarkKeyRecord;
}
export interface AuthFailure {
  ok: false;
  status: 401 | 403 | 429;
  code: string;
  message: string;
}
export type AuthOutcome = AuthResult | AuthFailure;

/**
 * Validate the incoming Bulwark key and enforce tier request quotas.
 * Does NOT enforce USD caps (handled by caps.ts).
 */
export async function authenticate(
  request: Request,
  env: Env,
): Promise<AuthOutcome> {
  const authHeader = request.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return { ok: false, status: 401, code: "missing_key", message: "Authorization header with Bearer token required." };
  }

  const rawKey = authHeader.slice(7).trim();
  if (!rawKey.startsWith(KEY_PREFIX)) {
    return { ok: false, status: 401, code: "invalid_key_format", message: "Bulwark keys must start with bwk_." };
  }

  // Extract keyId from the raw key (first 16 chars after prefix act as id)
  // Key format: bwk_{keyId16}_{secret}
  const withoutPrefix = rawKey.slice(KEY_PREFIX.length);
  const separatorIdx = withoutPrefix.indexOf("_");
  if (separatorIdx === -1) {
    return { ok: false, status: 401, code: "invalid_key_format", message: "Malformed Bulwark key." };
  }
  const keyId = withoutPrefix.slice(0, separatorIdx);

  const recordJson = await env.BULWARK_KV.get(`apikey:${keyId}`);
  if (recordJson === null) {
    return { ok: false, status: 401, code: "unknown_key", message: "API key not found." };
  }

  const record: BulwarkKeyRecord = JSON.parse(recordJson);

  if (!record.active) {
    return { ok: false, status: 403, code: "key_disabled", message: "This API key has been disabled." };
  }

  // Verify key hash
  const hash = await sha256Hex(rawKey);
  if (hash !== record.keyHash) {
    return { ok: false, status: 401, code: "invalid_key", message: "API key is invalid." };
  }

  // Enforce monthly request quota
  const tierConfig = TIER_CONFIGS[record.tier];
  if (tierConfig.monthlyRequestLimit > 0) {
    const yearMonth = utcYearMonth();
    const reqCountStr = await env.BULWARK_KV.get(`usage:req:${keyId}:${yearMonth}`);
    const reqCount = reqCountStr ? parseInt(reqCountStr, 10) : 0;
    if (reqCount >= tierConfig.monthlyRequestLimit) {
      return {
        ok: false,
        status: 429,
        code: "monthly_request_quota_exceeded",
        message: `Your ${record.tier} plan allows ${tierConfig.monthlyRequestLimit.toLocaleString()} requests/month. Upgrade to continue.`,
      };
    }
  }

  return { ok: true, record };
}

/** Increment the monthly request counter. Fire-and-forget. */
export async function incrementRequestCounter(keyId: string, env: Env): Promise<void> {
  const yearMonth = utcYearMonth();
  const kvKey = `usage:req:${keyId}:${yearMonth}`;
  const current = await env.BULWARK_KV.get(kvKey);
  const next = current ? parseInt(current, 10) + 1 : 1;
  // Expire 35 days after start-of-month to allow for month overlap
  await env.BULWARK_KV.put(kvKey, String(next), { expirationTtl: 35 * 24 * 3600 });
}

function utcYearMonth(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}${m}`;
}

/** Generate a new Bulwark API key (for use during key provisioning, not in hot path). */
export async function generateKey(keyId: string): Promise<{ rawKey: string; hash: string }> {
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const rawKey = `${KEY_PREFIX}${keyId}_${secret}`;
  const hash = await sha256Hex(rawKey);
  return { rawKey, hash };
}
