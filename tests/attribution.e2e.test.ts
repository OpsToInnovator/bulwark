import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index.js";
import { generateKey } from "../src/auth.js";
import { BulwarkKeyRecord } from "../src/types.js";
import { makeEnv } from "./mock-kv.js";

// End-to-end through the router: real auth + caps + attribution, mocked upstream.

const KEY_ID = "e2ekey0000000001";

function ctx() {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => {},
    flush: () => Promise.all(pending),
  };
}

function openaiResponse(prompt = 1000, completion = 1000) {
  // gpt-4o: $2.50 in / $10 out per million → 1000/1000 tokens = $0.0125
  return new Response(
    JSON.stringify({
      id: "chatcmpl-x",
      model: "gpt-4o",
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: prompt, completion_tokens: completion },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

async function seedKey(env: ReturnType<typeof makeEnv>, overrides: Partial<BulwarkKeyRecord> = {}) {
  const { rawKey, hash } = await generateKey(KEY_ID);
  const record: BulwarkKeyRecord = {
    keyId: KEY_ID,
    keyHash: hash,
    ownerId: "owner",
    tier: "pro",
    dailyCapUsd: 100,
    monthlyCapUsd: 1000,
    bedtimeEnabled: false,
    wakeHour: 7,
    timezone: "UTC",
    createdAt: new Date().toISOString(),
    active: true,
    ...overrides,
  };
  await env.BULWARK_KV.put(`apikey:${KEY_ID}`, JSON.stringify(record));
  return rawKey;
}

function call(
  rawKey: string,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${rawKey}`,
    "x-provider-key": "sk-test",
    "Content-Type": "application/json",
    ...(init.headers ?? {}),
  };
  return new Request(`https://bulwark.test${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
}

describe("attribution — end to end", () => {
  let env: ReturnType<typeof makeEnv>;
  let rawKey: string;
  const fetchMock = vi.fn();

  beforeEach(async () => {
    env = makeEnv();
    rawKey = await seedKey(env);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => openaiResponse());
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("echoes task id, request cost and running task spend, then trips the task cap", async () => {
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], temperature: 0.9 };
    const headers = {
      "x-bulwark-task-id": "run_1",
      "x-bulwark-agent": "researcher",
      "x-bulwark-workflow": "enrich",
      "x-bulwark-tags": "team=growth",
      "x-bulwark-task-cap-usd": "0.02",
    };

    const c1 = ctx();
    const r1 = await worker.fetch(call(rawKey, "/v1/chat/completions", { body, headers }), env as any, c1 as any);
    await c1.flush();
    expect(r1.status).toBe(200);
    expect(r1.headers.get("x-bulwark-task-id")).toBe("run_1");
    expect(parseFloat(r1.headers.get("x-bulwark-cost-usd")!)).toBeCloseTo(0.0125, 6);
    expect(parseFloat(r1.headers.get("x-bulwark-task-spend-usd")!)).toBeCloseTo(0.0125, 6);

    // Second call: different prompt so the cache is bypassed; spend 0.0125 < cap 0.02 → allowed
    const c2 = ctx();
    const r2 = await worker.fetch(
      call(rawKey, "/v1/chat/completions", { body: { ...body, messages: [{ role: "user", content: "again" }] }, headers }),
      env as any,
      c2 as any,
    );
    await c2.flush();
    expect(r2.status).toBe(200);
    expect(parseFloat(r2.headers.get("x-bulwark-task-spend-usd")!)).toBeCloseTo(0.025, 6);

    // Third call: ledger 0.025 ≥ cap 0.02 → 429 task_cap_exceeded, upstream never called
    const callsBefore = fetchMock.mock.calls.length;
    const r3 = await worker.fetch(
      call(rawKey, "/v1/chat/completions", { body: { ...body, messages: [{ role: "user", content: "third" }] }, headers }),
      env as any,
      ctx() as any,
    );
    expect(r3.status).toBe(429);
    const err = (await r3.json()) as { error: Record<string, unknown> };
    expect(err.error.code).toBe("task_cap_exceeded");
    expect(err.error.task_id).toBe("run_1");
    expect(err.error.cap_usd).toBe(0.02);
    expect(fetchMock.mock.calls.length).toBe(callsBefore);

    // A fresh task is unaffected
    const r4 = await worker.fetch(
      call(rawKey, "/v1/chat/completions", { body, headers: { ...headers, "x-bulwark-task-id": "run_2" } }),
      env as any,
      ctx() as any,
    );
    expect(r4.status).toBe(200);
  });

  it("task ledger, outcome and summary endpoints reflect proxied usage", async () => {
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "x" }] };
    const headers = { "x-bulwark-task-id": "job_9", "x-bulwark-agent": "writer", "x-bulwark-tags": "env=prod" };
    const c = ctx();
    await worker.fetch(call(rawKey, "/v1/chat/completions", { body, headers }), env as any, c as any);
    await c.flush();

    const ledgerRes = await worker.fetch(call(rawKey, "/v1/attribution/tasks/job_9"), env as any, ctx() as any);
    expect(ledgerRes.status).toBe(200);
    const ledger = (await ledgerRes.json()) as Record<string, unknown>;
    expect(ledger.requests).toBe(1);
    expect(ledger.agent).toBe("writer");
    expect(ledger.costUsd).toBeCloseTo(0.0125, 6);

    const outcomeRes = await worker.fetch(
      call(rawKey, "/v1/attribution/tasks/job_9/outcome", { body: { outcome: "success", value_usd: 1.25, note: "shipped" } }),
      env as any,
      ctx() as any,
    );
    expect(outcomeRes.status).toBe(200);
    const outcome = (await outcomeRes.json()) as Record<string, unknown>;
    expect(outcome.outcome).toBe("success");
    expect(outcome.value_to_cost_ratio).toBeCloseTo(100, 4);

    const listRes = await worker.fetch(call(rawKey, "/v1/attribution/tasks?limit=10"), env as any, ctx() as any);
    const list = (await listRes.json()) as { rollup: Record<string, unknown>; tasks: unknown[] };
    expect(list.tasks.length).toBe(1);
    expect(list.rollup.succeeded).toBe(1);
    expect(list.rollup.costPerSuccessUsd).toBeCloseTo(0.0125, 6);

    const sumRes = await worker.fetch(call(rawKey, "/v1/attribution/summary?dimension=agent"), env as any, ctx() as any);
    const summary = (await sumRes.json()) as { rows: Array<{ value: string; costUsd: number }> };
    expect(summary.rows[0].value).toBe("writer");
    expect(summary.rows[0].costUsd).toBeCloseTo(0.0125, 6);

    const tagRes = await worker.fetch(call(rawKey, "/v1/attribution/summary?dimension=tag:env"), env as any, ctx() as any);
    expect(((await tagRes.json()) as { rows: Array<{ value: string }> }).rows[0].value).toBe("prod");
  });

  it("enforces a per-agent daily cap configured on the key record", async () => {
    rawKey = await seedKey(env, { agentDailyCapsUsd: { scraper: 0.01 } });
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "a" }] };
    const c = ctx();
    const r1 = await worker.fetch(call(rawKey, "/v1/chat/completions", { body, headers: { "x-bulwark-agent": "scraper" } }), env as any, c as any);
    await c.flush();
    expect(r1.status).toBe(200);

    const r2 = await worker.fetch(
      call(rawKey, "/v1/chat/completions", { body: { ...body, messages: [{ role: "user", content: "b" }] }, headers: { "x-bulwark-agent": "scraper" } }),
      env as any,
      ctx() as any,
    );
    expect(r2.status).toBe(429);
    expect(((await r2.json()) as { error: { code: string } }).error.code).toBe("agent_cap_exceeded");

    const r3 = await worker.fetch(
      call(rawKey, "/v1/chat/completions", { body: { ...body, messages: [{ role: "user", content: "c" }] }, headers: { "x-bulwark-agent": "planner" } }),
      env as any,
      ctx() as any,
    );
    expect(r3.status).toBe(200);
  });

  it("rejects invalid attribution and outcome input with 400s, unknown tasks with 404", async () => {
    const body = { model: "gpt-4o", messages: [] };
    const bad = await worker.fetch(call(rawKey, "/v1/chat/completions", { body, headers: { "x-bulwark-task-id": "no spaces" } }), env as any, ctx() as any);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("invalid_attribution");

    const badOutcome = await worker.fetch(call(rawKey, "/v1/attribution/tasks/t/outcome", { body: { outcome: "meh" } }), env as any, ctx() as any);
    expect(badOutcome.status).toBe(400);

    const missing = await worker.fetch(call(rawKey, "/v1/attribution/tasks/never"), env as any, ctx() as any);
    expect(missing.status).toBe(404);

    const badDim = await worker.fetch(call(rawKey, "/v1/attribution/summary?dimension=secret"), env as any, ctx() as any);
    expect(badDim.status).toBe(400);
  });

  it("requires auth on attribution endpoints", async () => {
    const r = await worker.fetch(new Request("https://bulwark.test/v1/attribution/tasks"), env as any, ctx() as any);
    expect(r.status).toBe(401);
  });

  it("requests without attribution still proxy normally and expose request cost", async () => {
    const c = ctx();
    const r = await worker.fetch(call(rawKey, "/v1/chat/completions", { body: { model: "gpt-4o", messages: [] } }), env as any, c as any);
    await c.flush();
    expect(r.status).toBe(200);
    expect(r.headers.get("x-bulwark-task-id")).toBeNull();
    expect(parseFloat(r.headers.get("x-bulwark-cost-usd")!)).toBeCloseTo(0.0125, 6);
    const list = (await (await worker.fetch(call(rawKey, "/v1/attribution/tasks"), env as any, ctx() as any)).json()) as { tasks: unknown[] };
    expect(list.tasks).toEqual([]);
  });
});
