// ─── Bulwark proxy — main entry point ─────────────────────────────────────────
//
// Route map:
//   POST /v1/chat/completions   → OpenAI chat completions proxy
//   POST /v1/messages           → Anthropic messages proxy
//   POST /v1beta/models/:model/generateContent → Gemini passthrough
//   POST /v1/bedtime            → Toggle Bedtime Mode for authenticated key
//   GET  /health                → Health check (no auth)
//
// All proxy routes require Authorization: Bearer bwk_<keyId>_<secret>
// Provider key passed via x-provider-key header (never stored).

import { Router, IRequest, error, json } from "itty-router";
import { authenticate, incrementRequestCounter } from "./auth.js";
import { checkCaps } from "./caps.js";
import { checkBedtime, setBedtimeEnabled } from "./bedtime.js";
import { computeCacheKey, cacheGet, cachePut, isCacheable, CACHE_HEADER } from "./cache.js";
import { calculateCost } from "./pricing.js";
import { recordUsage, generateRequestId } from "./usage.js";
import { Env, Provider } from "./types.js";
import { getDailySpend } from "./caps.js";

const router = Router<IRequest, [Env, ExecutionContext]>();

// ─── Health ──────────────────────────────────────────────────────────────────

router.get("/health", () =>
  json({ status: "ok", service: "bulwark", version: "1.0.0", ts: new Date().toISOString() }),
);

// ─── Bedtime toggle ──────────────────────────────────────────────────────────

router.post("/v1/bedtime", async (req, env: Env) => {
  const auth = await authenticate(req, env);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message);

  let body: { enabled: boolean };
  try {
    body = await req.json() as { enabled: boolean };
  } catch {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON with { enabled: boolean }.");
  }
  if (typeof body.enabled !== "boolean") {
    return errorResponse(400, "invalid_body", '`enabled` must be a boolean.');
  }

  await setBedtimeEnabled(auth.record.keyId, body.enabled, env);
  return json({ ok: true, bedtime_enabled: body.enabled });
});

// ─── OpenAI proxy ─────────────────────────────────────────────────────────────

router.post("/v1/chat/completions", async (req, env: Env, ctx: ExecutionContext) => {
  return proxyRequest(req, env, ctx, "openai", "https://api.openai.com/v1/chat/completions");
});

// ─── Anthropic proxy ──────────────────────────────────────────────────────────

router.post("/v1/messages", async (req, env: Env, ctx: ExecutionContext) => {
  return proxyRequest(req, env, ctx, "anthropic", "https://api.anthropic.com/v1/messages");
});

// ─── Gemini passthrough ───────────────────────────────────────────────────────
// Matches /v1beta/models/:model/generateContent (and similar paths)

router.post("/v1beta/*", async (req, env: Env, ctx: ExecutionContext) => {
  const url = new URL(req.url);
  const upstreamUrl = `https://generativelanguage.googleapis.com${url.pathname}${url.search}`;
  return proxyRequest(req, env, ctx, "gemini", upstreamUrl);
});

// ─── 404 catch-all ────────────────────────────────────────────────────────────

router.all("*", () => errorResponse(404, "not_found", "Route not found."));

// ─── Core proxy logic ─────────────────────────────────────────────────────────

async function proxyRequest(
  req: IRequest,
  env: Env,
  ctx: ExecutionContext,
  provider: Provider,
  upstreamUrl: string,
): Promise<Response> {
  const requestId = generateRequestId();
  const startMs = Date.now();

  // 1. Authenticate
  const auth = await authenticate(req, env);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message);
  const { record } = auth;

  // 2. Parse body
  let bodyObj: Record<string, unknown>;
  const rawBody = await req.text();
  try {
    bodyObj = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON.");
  }

  const model = extractModel(provider, bodyObj);

  // 3. Check spend caps
  const capsResult = await checkCaps(record, env);
  if (!capsResult.allowed) {
    return errorResponse(capsResult.status, capsResult.code, capsResult.message, {
      cap_usd: capsResult.capUsd,
      spent_usd: capsResult.spentUsd,
      resets_at: capsResult.resetAt,
    });
  }

  // 4. Check Bedtime Mode
  const dailySpend = await getDailySpend(record.keyId, env);
  const bedtimeResult = await checkBedtime(record, dailySpend, env);
  if (bedtimeResult.blocked) {
    return errorResponse(bedtimeResult.status, bedtimeResult.code, bedtimeResult.message, {
      wake_hour: bedtimeResult.wakeHour,
      baseline_usd: bedtimeResult.baselineUsd,
      projected_spend_usd: bedtimeResult.projectedSpendUsd,
    });
  }

  // 5. Cache lookup (skip for streaming)
  const cacheable = isCacheable(bodyObj);
  let cacheKey = "";
  if (cacheable) {
    cacheKey = await computeCacheKey(provider, model, bodyObj);
    const cached = await cacheGet(cacheKey, env);
    if (cached) {
      // Fire usage record for cache hit (cost = 0)
      ctx.waitUntil(
        recordUsage(
          {
            requestId,
            keyId: record.keyId,
            provider,
            model,
            promptTokens: 0,
            completionTokens: 0,
            costUsd: 0,
            cacheHit: true,
            latencyMs: Date.now() - startMs,
            httpStatus: 200,
          },
          env,
        ),
      );
      return cached;
    }
  }

  // 6. Build upstream request
  const providerKey = req.headers.get("x-provider-key");
  if (!providerKey) {
    return errorResponse(400, "missing_provider_key", "Provide your provider API key via x-provider-key header.");
  }

  const upstreamHeaders = buildUpstreamHeaders(provider, providerKey, req);
  const upstreamReq = new Request(upstreamUrl, {
    method: "POST",
    headers: upstreamHeaders,
    body: rawBody,
  });

  // 7. Forward request
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamReq);
  } catch (fetchErr) {
    return errorResponse(502, "upstream_error", `Failed to reach ${provider}: ${fetchErr}`);
  }

  const latencyMs = Date.now() - startMs;

  // 8. Parse response for token usage
  let responseBody: Record<string, unknown> | null = null;
  let promptTokens = 0;
  let completionTokens = 0;

  if (upstreamResponse.ok) {
    const responseText = await upstreamResponse.text();
    try {
      responseBody = JSON.parse(responseText) as Record<string, unknown>;
      const usage = extractUsage(provider, responseBody);
      promptTokens = usage.promptTokens;
      completionTokens = usage.completionTokens;
    } catch {
      // Non-JSON response (shouldn't happen for non-streaming)
    }

    // 9. Cache the response
    if (cacheable && responseBody && cacheKey) {
      ctx.waitUntil(cachePut(cacheKey, responseBody, env));
    }

    // 10. Record usage (fire-and-forget)
    const { costUsd } = calculateCost(provider, model, promptTokens, completionTokens);
    ctx.waitUntil(
      recordUsage(
        {
          requestId,
          keyId: record.keyId,
          provider,
          model,
          promptTokens,
          completionTokens,
          costUsd,
          cacheHit: false,
          latencyMs,
          httpStatus: upstreamResponse.status,
        },
        env,
      ),
    );

    const responseHeaders = new Headers(upstreamResponse.headers);
    responseHeaders.set(CACHE_HEADER, "miss");
    responseHeaders.set("x-bulwark-request-id", requestId);

    return new Response(responseBody ? JSON.stringify(responseBody) : null, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  }

  // Upstream error — pass through faithfully
  const errText = await upstreamResponse.text();
  ctx.waitUntil(
    recordUsage(
      {
        requestId,
        keyId: record.keyId,
        provider,
        model,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        cacheHit: false,
        latencyMs,
        httpStatus: upstreamResponse.status,
      },
      env,
    ),
  );

  return new Response(errText, {
    status: upstreamResponse.status,
    headers: {
      "Content-Type": upstreamResponse.headers.get("Content-Type") ?? "application/json",
      "x-bulwark-request-id": requestId,
    },
  });
}

// ─── Provider-specific helpers ────────────────────────────────────────────────

function buildUpstreamHeaders(
  provider: Provider,
  providerKey: string,
  originalReq: IRequest,
): Headers {
  const headers = new Headers();
  headers.set("Content-Type", "application/json");

  switch (provider) {
    case "openai":
      headers.set("Authorization", `Bearer ${providerKey}`);
      // Forward OpenAI-Organization if set
      const orgId = originalReq.headers.get("openai-organization");
      if (orgId) headers.set("OpenAI-Organization", orgId);
      break;
    case "anthropic":
      headers.set("x-api-key", providerKey);
      headers.set("anthropic-version", originalReq.headers.get("anthropic-version") ?? "2023-06-01");
      break;
    case "gemini":
      // Gemini uses ?key= query param; we set it in the URL via the caller.
      // Also support Bearer for Vertex AI
      if (providerKey.startsWith("ya29.") || providerKey.startsWith("Bearer ")) {
        headers.set("Authorization", providerKey.startsWith("Bearer ") ? providerKey : `Bearer ${providerKey}`);
      }
      // For API key auth, the key is already in the URL (?key=...) if the user
      // passes it in x-provider-key and the original request includes ?key= in the path.
      // If not, we append it here.
      break;
  }

  return headers;
}

function extractModel(provider: Provider, body: Record<string, unknown>): string {
  switch (provider) {
    case "openai":
      return (body["model"] as string | undefined) ?? "gpt-4o";
    case "anthropic":
      return (body["model"] as string | undefined) ?? "claude-3-5-sonnet-20241022";
    case "gemini": {
      // Model is in the URL path for Gemini; fall back to body if present
      return (body["model"] as string | undefined) ?? "gemini-2.0-flash";
    }
  }
}

function extractUsage(
  provider: Provider,
  body: Record<string, unknown>,
): { promptTokens: number; completionTokens: number } {
  try {
    switch (provider) {
      case "openai": {
        const usage = body["usage"] as { prompt_tokens?: number; completion_tokens?: number } | undefined;
        return {
          promptTokens: usage?.prompt_tokens ?? 0,
          completionTokens: usage?.completion_tokens ?? 0,
        };
      }
      case "anthropic": {
        const usage = body["usage"] as { input_tokens?: number; output_tokens?: number } | undefined;
        return {
          promptTokens: usage?.input_tokens ?? 0,
          completionTokens: usage?.output_tokens ?? 0,
        };
      }
      case "gemini": {
        const meta = body["usageMetadata"] as {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
        } | undefined;
        return {
          promptTokens: meta?.promptTokenCount ?? 0,
          completionTokens: meta?.candidatesTokenCount ?? 0,
        };
      }
    }
  } catch {
    return { promptTokens: 0, completionTokens: 0 };
  }
}

// ─── Error helpers ────────────────────────────────────────────────────────────

function errorResponse(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({ error: { code, message, ...extra } }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    },
  );
}

// ─── Worker export ────────────────────────────────────────────────────────────

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return router
      .fetch(request, env, ctx)
      .catch((err: unknown) => error(500, String(err)));
  },
} satisfies ExportedHandler<Env>;
