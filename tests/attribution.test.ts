import { describe, it, expect, beforeEach } from "vitest";
import {
  parseAttribution,
  hasAttribution,
  checkAttributionCaps,
  recordAttribution,
  getTaskLedger,
  getAggregate,
  listRecentTaskIds,
  summarizeDimension,
  recordTaskOutcome,
  rollupTasks,
  TaskLedger,
  Attribution,
  AttributionUsage,
} from "../src/attribution.js";
import { utcDate } from "../src/caps.js";
import { makeEnv } from "./mock-kv.js";

const KEY = "key01";

function headers(h: Record<string, string> = {}): Headers {
  return new Headers(h);
}

function usage(overrides: Partial<AttributionUsage> & { attribution: Attribution }): AttributionUsage {
  return {
    keyId: KEY,
    provider: "openai",
    model: "gpt-4o",
    promptTokens: 100,
    completionTokens: 50,
    costUsd: 0.01,
    cacheHit: false,
    httpStatus: 200,
    ...overrides,
  };
}

// ─── parseAttribution ─────────────────────────────────────────────────────────

describe("attribution — parseAttribution", () => {
  it("returns empty attribution when nothing is supplied", () => {
    const r = parseAttribution(headers(), {}, "openai");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(hasAttribution(r.attribution)).toBe(false);
      expect(r.attribution.tags).toEqual({});
    }
  });

  it("reads task, agent, workflow, tags and task cap from headers", () => {
    const r = parseAttribution(
      headers({
        "x-bulwark-task-id": "run_123",
        "x-bulwark-agent": "researcher",
        "x-bulwark-workflow": "lead-enrichment",
        "x-bulwark-tags": "team=growth, env=prod",
        "x-bulwark-task-cap-usd": "2.50",
      }),
      {},
      "openai",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.attribution).toEqual({
        taskId: "run_123",
        agent: "researcher",
        workflow: "lead-enrichment",
        tags: { team: "growth", env: "prod" },
        taskCapUsd: 2.5,
      });
    }
  });

  it("falls back to OpenAI body metadata and user field", () => {
    const r = parseAttribution(
      headers(),
      { metadata: { task_id: "t1", agent: "planner", workflow: "wf" }, user: "cust_42" },
      "openai",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.attribution.taskId).toBe("t1");
      expect(r.attribution.agent).toBe("planner");
      expect(r.attribution.workflow).toBe("wf");
      expect(r.attribution.tags).toEqual({ user: "cust_42" });
    }
  });

  it("prefers bulwark_task_id over task_id in metadata and headers over body", () => {
    const r = parseAttribution(
      headers({ "x-bulwark-agent": "header-agent" }),
      { metadata: { bulwark_task_id: "bw", task_id: "plain", agent: "body-agent" } },
      "openai",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.attribution.taskId).toBe("bw");
      expect(r.attribution.agent).toBe("header-agent");
    }
  });

  it("maps Anthropic metadata.user_id to the user tag", () => {
    const r = parseAttribution(headers(), { metadata: { user_id: "u9" } }, "anthropic");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.attribution.tags).toEqual({ user: "u9" });
  });

  it("rejects values with disallowed characters or excessive length", () => {
    expect(parseAttribution(headers({ "x-bulwark-task-id": "has space" }), {}, "openai").ok).toBe(false);
    expect(parseAttribution(headers({ "x-bulwark-agent": "a".repeat(65) }), {}, "openai").ok).toBe(false);
    expect(parseAttribution(headers({ "x-bulwark-task-id": "ok.id:1/2@x-y_z" }), {}, "openai").ok).toBe(true);
  });

  it("rejects malformed tags and more than 8 tags", () => {
    expect(parseAttribution(headers({ "x-bulwark-tags": "novalue" }), {}, "openai").ok).toBe(false);
    expect(parseAttribution(headers({ "x-bulwark-tags": "=v" }), {}, "openai").ok).toBe(false);
    const many = Array.from({ length: 9 }, (_, i) => `k${i}=v`).join(",");
    expect(parseAttribution(headers({ "x-bulwark-tags": many }), {}, "openai").ok).toBe(false);
  });

  it("rejects a task cap that is non-numeric, non-positive, or has no task id", () => {
    expect(parseAttribution(headers({ "x-bulwark-task-id": "t", "x-bulwark-task-cap-usd": "abc" }), {}, "openai").ok).toBe(false);
    expect(parseAttribution(headers({ "x-bulwark-task-id": "t", "x-bulwark-task-cap-usd": "0" }), {}, "openai").ok).toBe(false);
    expect(parseAttribution(headers({ "x-bulwark-task-cap-usd": "1" }), {}, "openai").ok).toBe(false);
  });

  it("ignores non-string metadata values", () => {
    const r = parseAttribution(headers(), { metadata: { task_id: 123, agent: null } }, "openai");
    expect(r.ok).toBe(true);
    if (r.ok) expect(hasAttribution(r.attribution)).toBe(false);
  });
});

// ─── recordAttribution ────────────────────────────────────────────────────────

describe("attribution — recordAttribution", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => {
    env = makeEnv();
  });

  it("does nothing when the request carries no attribution", async () => {
    await recordAttribution(usage({ attribution: { tags: {} } }), env as any);
    expect((env.BULWARK_KV as any)._raw().size).toBe(0);
  });

  it("creates and accumulates a task ledger across requests", async () => {
    const a: Attribution = { taskId: "t1", agent: "researcher", workflow: "wf", tags: { team: "growth" } };
    await recordAttribution(usage({ attribution: a, costUsd: 0.01 }), env as any);
    await recordAttribution(usage({ attribution: a, costUsd: 0.02, model: "gpt-4o-mini", cacheHit: true }), env as any);
    await recordAttribution(usage({ attribution: { ...a, agent: "writer" }, costUsd: 0.03, httpStatus: 500 }), env as any);

    const ledger = await getTaskLedger(KEY, "t1", env as any);
    expect(ledger).not.toBeNull();
    expect(ledger!.requests).toBe(3);
    expect(ledger!.cacheHits).toBe(1);
    expect(ledger!.upstreamErrors).toBe(1);
    expect(ledger!.costUsd).toBeCloseTo(0.06, 8);
    expect(ledger!.promptTokens).toBe(300);
    expect(ledger!.completionTokens).toBe(150);
    expect(ledger!.agent).toBe("researcher"); // first agent seen is the task owner
    expect(ledger!.byAgent["researcher"]).toEqual({ requests: 2, costUsd: 0.03 });
    expect(ledger!.byAgent["writer"]).toEqual({ requests: 1, costUsd: 0.03 });
    expect(ledger!.byModel["gpt-4o"].requests).toBe(2);
    expect(ledger!.byModel["gpt-4o-mini"].requests).toBe(1);
    expect(ledger!.tags).toEqual({ team: "growth" });
    expect(ledger!.firstSeenAt <= ledger!.lastSeenAt).toBe(true);
  });

  it("tracks recent task ids, newest first, without duplicates", async () => {
    await recordAttribution(usage({ attribution: { taskId: "a", tags: {} } }), env as any);
    await recordAttribution(usage({ attribution: { taskId: "b", tags: {} } }), env as any);
    await recordAttribution(usage({ attribution: { taskId: "a", tags: {} } }), env as any);
    expect(await listRecentTaskIds(KEY, env as any)).toEqual(["b", "a"]);
  });

  it("writes daily aggregates per agent, workflow, model and tag", async () => {
    const a: Attribution = { agent: "researcher", workflow: "wf", tags: { team: "growth", env: "prod" } };
    await recordAttribution(usage({ attribution: a, costUsd: 0.05 }), env as any);
    await recordAttribution(usage({ attribution: a, costUsd: 0.05, cacheHit: true }), env as any);

    const day = utcDate();
    const agent = await getAggregate(KEY, "agent", "researcher", day, env as any);
    expect(agent).toEqual({ requests: 2, cacheHits: 1, promptTokens: 200, completionTokens: 100, costUsd: 0.1 });
    expect((await getAggregate(KEY, "workflow", "wf", day, env as any))!.costUsd).toBeCloseTo(0.1, 8);
    expect((await getAggregate(KEY, "model", "gpt-4o", day, env as any))!.requests).toBe(2);
    expect((await getAggregate(KEY, "tag:team", "growth", day, env as any))!.requests).toBe(2);
    expect((await getAggregate(KEY, "tag:env", "prod", day, env as any))!.requests).toBe(2);
  });

  it("stores the task cap on the ledger when supplied via header", async () => {
    await recordAttribution(usage({ attribution: { taskId: "capped", tags: {}, taskCapUsd: 1.5 } }), env as any);
    expect((await getTaskLedger(KEY, "capped", env as any))!.capUsd).toBe(1.5);
  });
});

// ─── checkAttributionCaps ─────────────────────────────────────────────────────

describe("attribution — checkAttributionCaps", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => {
    env = makeEnv();
  });

  it("allows when there is no task and no agent cap", async () => {
    const r = await checkAttributionCaps(KEY, { tags: {} }, {}, env as any);
    expect(r.allowed).toBe(true);
  });

  it("allows a new task under its header cap and returns no ledger yet", async () => {
    const r = await checkAttributionCaps(KEY, { taskId: "t", tags: {}, taskCapUsd: 1 }, {}, env as any);
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.ledger).toBeNull();
  });

  it("blocks with task_cap_exceeded once the ledger reaches the header cap", async () => {
    const a: Attribution = { taskId: "t", tags: {}, taskCapUsd: 0.05 };
    await recordAttribution(usage({ attribution: a, costUsd: 0.05 }), env as any);
    const r = await checkAttributionCaps(KEY, a, {}, env as any);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.status).toBe(429);
      expect(r.code).toBe("task_cap_exceeded");
      expect(r.capUsd).toBe(0.05);
      expect(r.spentUsd).toBeCloseTo(0.05, 8);
      expect(r.taskId).toBe("t");
    }
  });

  it("uses the cap persisted on the ledger when later requests omit the header", async () => {
    await recordAttribution(usage({ attribution: { taskId: "t", tags: {}, taskCapUsd: 0.01 }, costUsd: 0.01 }), env as any);
    const r = await checkAttributionCaps(KEY, { taskId: "t", tags: {} }, {}, env as any);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.code).toBe("task_cap_exceeded");
  });

  it("falls back to the key's default task cap", async () => {
    await recordAttribution(usage({ attribution: { taskId: "t", tags: {} }, costUsd: 0.2 }), env as any);
    const blocked = await checkAttributionCaps(KEY, { taskId: "t", tags: {} }, { defaultTaskCapUsd: 0.2 }, env as any);
    expect(blocked.allowed).toBe(false);
    const allowed = await checkAttributionCaps(KEY, { taskId: "t", tags: {} }, { defaultTaskCapUsd: 0.5 }, env as any);
    expect(allowed.allowed).toBe(true);
  });

  it("a header cap overrides the key default", async () => {
    await recordAttribution(usage({ attribution: { taskId: "t", tags: {} }, costUsd: 0.2 }), env as any);
    const r = await checkAttributionCaps(KEY, { taskId: "t", tags: {}, taskCapUsd: 5 }, { defaultTaskCapUsd: 0.1 }, env as any);
    expect(r.allowed).toBe(true);
  });

  it("blocks with agent_cap_exceeded when the agent's daily spend reaches its cap", async () => {
    const a: Attribution = { agent: "scraper", tags: {} };
    await recordAttribution(usage({ attribution: a, costUsd: 0.3 }), env as any);
    const r = await checkAttributionCaps(KEY, a, { agentDailyCapsUsd: { scraper: 0.3, other: 100 } }, env as any);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.code).toBe("agent_cap_exceeded");
      expect(r.agent).toBe("scraper");
      expect(r.capUsd).toBe(0.3);
    }
    const other = await checkAttributionCaps(KEY, { agent: "other", tags: {} }, { agentDailyCapsUsd: { scraper: 0.3, other: 100 } }, env as any);
    expect(other.allowed).toBe(true);
  });

  it("ignores agent caps set to zero", async () => {
    await recordAttribution(usage({ attribution: { agent: "a", tags: {} }, costUsd: 1 }), env as any);
    const r = await checkAttributionCaps(KEY, { agent: "a", tags: {} }, { agentDailyCapsUsd: { a: 0 } }, env as any);
    expect(r.allowed).toBe(true);
  });
});

// ─── summarizeDimension ───────────────────────────────────────────────────────

describe("attribution — summarizeDimension", () => {
  it("ranks values by cost with share and cache hit rate", async () => {
    const env = makeEnv();
    await recordAttribution(usage({ attribution: { agent: "a", tags: {} }, costUsd: 0.75 }), env as any);
    await recordAttribution(usage({ attribution: { agent: "b", tags: {} }, costUsd: 0.25 }), env as any);
    await recordAttribution(usage({ attribution: { agent: "b", tags: {} }, costUsd: 0, cacheHit: true }), env as any);

    const s = await summarizeDimension(KEY, "agent", utcDate(), env as any);
    expect(s.totalCostUsd).toBeCloseTo(1.0, 8);
    expect(s.rows.map((r) => r.value)).toEqual(["a", "b"]);
    expect(s.rows[0].shareOfCost).toBeCloseTo(0.75, 8);
    expect(s.rows[1].requests).toBe(2);
    expect(s.rows[1].cacheHitRate).toBeCloseTo(0.5, 8);
  });

  it("isolates by key, dimension and day", async () => {
    const env = makeEnv();
    await recordAttribution(usage({ attribution: { agent: "a", workflow: "w", tags: { team: "x" } }, costUsd: 1 }), env as any);
    await recordAttribution(usage({ keyId: "otherkey", attribution: { agent: "a", tags: {} }, costUsd: 9 }), env as any);

    expect((await summarizeDimension(KEY, "agent", utcDate(), env as any)).totalCostUsd).toBe(1);
    expect((await summarizeDimension(KEY, "workflow", utcDate(), env as any)).rows[0].value).toBe("w");
    expect((await summarizeDimension(KEY, "tag:team", utcDate(), env as any)).rows[0].value).toBe("x");
    expect((await summarizeDimension(KEY, "agent", "20000101", env as any)).rows).toEqual([]);
  });
});

// ─── outcomes + rollup ────────────────────────────────────────────────────────

describe("attribution — outcomes and rollup", () => {
  it("returns null for an unknown task", async () => {
    const env = makeEnv();
    expect(await recordTaskOutcome(KEY, "nope", { outcome: "success" }, env as any)).toBeNull();
  });

  it("records outcome, value and a truncated note", async () => {
    const env = makeEnv();
    await recordAttribution(usage({ attribution: { taskId: "t", tags: {} }, costUsd: 0.5 }), env as any);
    const l = await recordTaskOutcome(KEY, "t", { outcome: "success", valueUsd: 25, note: "x".repeat(400) }, env as any);
    expect(l!.outcome).toBe("success");
    expect(l!.valueUsd).toBe(25);
    expect(l!.outcomeNote!.length).toBe(280);
    expect(l!.outcomeAt).toBeTruthy();
  });

  it("rolls ledgers up into cost per task, cost per success and value ratio", () => {
    const mk = (o: Partial<TaskLedger>): TaskLedger => ({
      taskId: "x",
      keyId: KEY,
      tags: {},
      requests: 4,
      cacheHits: 1,
      upstreamErrors: 0,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 1,
      byModel: {},
      byAgent: {},
      firstSeenAt: "",
      lastSeenAt: "",
      ...o,
    });
    const r = rollupTasks([
      mk({ outcome: "success", valueUsd: 10, costUsd: 1 }),
      mk({ outcome: "success", valueUsd: 5, costUsd: 1 }),
      mk({ outcome: "failure", costUsd: 2 }),
      mk({ costUsd: 0.5 }), // no outcome yet
    ]);
    expect(r.tasks).toBe(4);
    expect(r.withOutcome).toBe(3);
    expect(r.succeeded).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.successRate).toBeCloseTo(2 / 3, 8);
    expect(r.totalCostUsd).toBeCloseTo(4.5, 8);
    expect(r.costPerTaskUsd).toBeCloseTo(1.125, 8);
    expect(r.costPerSuccessUsd).toBeCloseTo(2.25, 8);
    expect(r.avgRequestsPerTask).toBe(4);
    expect(r.cacheHitRate).toBeCloseTo(0.25, 8);
    expect(r.totalValueUsd).toBe(15);
    expect(r.valueToCostRatio).toBeCloseTo(7.5, 8); // 15 value / 2 cost on valued tasks
  });

  it("returns nulls for an empty set rather than dividing by zero", () => {
    const r = rollupTasks([]);
    expect(r.tasks).toBe(0);
    expect(r.successRate).toBeNull();
    expect(r.costPerTaskUsd).toBeNull();
    expect(r.valueToCostRatio).toBeNull();
  });
});
