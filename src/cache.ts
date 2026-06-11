// ─── Exact-match KV cache ─────────────────────────────────────────────────────
//
// Cache key: SHA-256 of (provider + model + canonical-sorted request body)
// KV key:    cache:{hex}
// Response header: x-bulwark-cache: hit | miss
// Default TTL: 3600s (configurable via CACHE_TTL_SECONDS env var)
//
// Only deterministic (non-streaming) requests are cached.
// Streaming requests pass through with cache: miss and are never stored.

import { Env, Provider } from "./types.js";

export const CACHE_HEADER = "x-bulwark-cache";

/**
 * Compute a stable cache key from the provider, model, and request body.
 * Body is JSON-parsed and keys sorted for stability across equivalent requests.
 */
export async function computeCacheKey(
  provider: Provider,
  model: string,
  body: unknown,
): Promise<string> {
  const canonical = JSON.stringify({ provider, model, body: sortedKeys(body) });
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(canonical));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Attempt to return a cached response. Returns null on miss. */
export async function cacheGet(
  cacheKey: string,
  env: Env,
): Promise<Response | null> {
  const stored = await env.BULWARK_KV.get(`cache:${cacheKey}`, { type: "json" }) as StoredCacheEntry | null;
  if (!stored) return null;

  const body = JSON.stringify(stored.body);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      [CACHE_HEADER]: "hit",
      "x-bulwark-cached-at": stored.cachedAt,
    },
  });
}

/** Store a response body in KV cache. */
export async function cachePut(
  cacheKey: string,
  responseBody: unknown,
  env: Env,
): Promise<void> {
  const ttl = parseInt(env.CACHE_TTL_SECONDS ?? "3600", 10);
  const entry: StoredCacheEntry = {
    body: responseBody,
    cachedAt: new Date().toISOString(),
  };
  await env.BULWARK_KV.put(`cache:${cacheKey}`, JSON.stringify(entry), {
    expirationTtl: ttl,
  });
}

/** Returns true if the request should be eligible for caching. */
export function isCacheable(body: Record<string, unknown>): boolean {
  // Streaming requests are not cached — response is a token stream, not a JSON blob
  if (body["stream"] === true) return false;
  // Temperature = 0 or absent → deterministic → cache-worthy
  // Non-zero temperature produces variable results; still cache (caller's choice)
  return true;
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface StoredCacheEntry {
  body: unknown;
  cachedAt: string;
}

// ─── Key canonicalization helper ──────────────────────────────────────────────

function sortedKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sortedKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = sortedKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}
