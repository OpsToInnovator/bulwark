// ─── Attribution layer: cost per task, agent, workflow and tag ───────────────
//
// Caps answer "how much can this key spend?". Attribution answers "what did
// each unit of work cost, and was it worth it?". Agent spend is decisions,
// not seats, so the unit of account is the task, not the API key.
//
// Inputs (all optional, headers win over body metadata):
//   x-bulwark-task-id       → unit of work (an agent run, a job, a trace)
//   x-bulwark-agent         → agent / role name making the call
//   x-bulwark-workflow      → workflow / pipeline the task belongs to
//   x-bulwark-tags          → comma-separated k=v pairs, e.g. team=growth,env=prod
//   x-bulwark-task-cap-usd  → hard USD cap for this task (429 task_cap_exceeded)
//
// Body fallbacks (so most agent frameworks need no header plumbing):
//   OpenAI    body.metadata.{task_id|bulwark_task_id, agent, workflow}, body.user → tag user
//   Anthropic body.metadata.user_id → tag user
//
// KV layout:
//   attr:task:{keyId}:{taskId}                     → JSON<TaskLedger>        (30d TTL)
//   attr:tasks:recent:{keyId}                      → JSON<string[]> taskIds  (30d TTL)
//   attr:agg:{keyId}:{dimension}:{value}:{yyyymmdd} → JSON<DailyAggregate>   (35d TTL)
//     dimension ∈ agent | workflow | model | tag:{k}
//
// Accounting is read-before/write-after, identical to caps.ts. Bounded
// overshoot under concurrency is accepted on purpose; see DESIGN.md.

import { Env, Provider } from "./types.js";
import { utcDate } from "./caps.js";

export const TASK_HEADER = "x-bulwark-task-id";
export const AGENT_HEADER = "x-bulwark-agent";
export const WORKFLOW_HEADER = "x-bulwark-workflow";
export const TAGS_HEADER = "x-bulwark-tags";
export const TASK_CAP_HEADER = "x-bulwark-task-cap-usd";

export const TASK_SPEND_HEADER = "x-bulwark-task-spend-usd";
export const REQUEST_COST_HEADER = "x-bulwark-cost-usd";

const MAX_VALUE_LEN = 64;
const MAX_TAGS = 8;
const VALUE_PATTERN = /^[A-Za-z0-9._:/@-]+$/;
const TAG_KEY_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

const TASK_TTL = 30 * 24 * 3600;
const AGG_TTL = 35 * 24 * 3600;
const MAX_RECENT_TASKS = 200;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Attribution {
  taskId?: string | undefined;
  agent?: string | undefined;
  workflow?: string | undefined;
  tags: Record<string, string>;
  taskCapUsd?: number | undefined;
}

export type TaskOutcome = "success" | "failure" | "abandoned";

export interface Bucket {
  requests: number;
  costUsd: number;
}

export interface TaskLedger {
  taskId: string;
  keyId: string;
  agent?: string | undefined;
  workflow?: string | undefined;
  tags: Record<string, string>;
  requests: number;
  cacheHits: number;
  upstreamErrors: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  byModel: Record<string, Bucket>;
  byAgent: Record<string, Bucket>;
  capUsd?: number | undefined;
  firstSeenAt: string;
  lastSeenAt: string;
  outcome?: TaskOutcome | undefined;
  outcomeAt?: string | undefined;
  valueUsd?: number | undefined;
  outcomeNote?: string | undefined;
}

export interface DailyAggregate {
  requests: number;
  cacheHits: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface AttributionUsage {
  keyId: string;
  provider: Provider;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  cacheHit: boolean;
  httpStatus: number;
  attribution: Attribution;
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

export interface ParseOk {
  ok: true;
  attribution: Attribution;
}
export interface ParseFail {
  ok: false;
  message: string;
}

/** Extract attribution from headers, falling back to provider body metadata. */
export function parseAttribution(
  headers: Headers,
  body: Record<string, unknown>,
  provider: Provider,
): ParseOk | ParseFail {
  const fromBody = bodyAttribution(body, provider);

  const taskId = pick(headers.get(TASK_HEADER), fromBody.taskId);
  const agent = pick(headers.get(AGENT_HEADER), fromBody.agent);
  const workflow = pick(headers.get(WORKFLOW_HEADER), fromBody.workflow);

  for (const [name, value] of [
    [TASK_HEADER, taskId],
    [AGENT_HEADER, agent],
    [WORKFLOW_HEADER, workflow],
  ] as const) {
    if (value !== undefined && !isValidValue(value)) {
      return {
        ok: false,
        message: `${name} must be 1-${MAX_VALUE_LEN} chars of letters, digits, . _ : / @ -`,
      };
    }
  }

  const tags: Record<string, string> = { ...fromBody.tags };
  const rawTags = headers.get(TAGS_HEADER);
  if (rawTags) {
    for (const part of rawTags.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) return { ok: false, message: `${TAGS_HEADER} entries must be key=value.` };
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim();
      if (!TAG_KEY_PATTERN.test(k) || !isValidValue(v)) {
        return { ok: false, message: `${TAGS_HEADER} entry "${trimmed}" has an invalid key or value.` };
      }
      tags[k] = v;
    }
  }
  if (Object.keys(tags).length > MAX_TAGS) {
    return { ok: false, message: `At most ${MAX_TAGS} tags per request.` };
  }

  let taskCapUsd: number | undefined;
  const rawCap = headers.get(TASK_CAP_HEADER);
  if (rawCap !== null && rawCap.trim() !== "") {
    const n = Number(rawCap);
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, message: `${TASK_CAP_HEADER} must be a positive number.` };
    }
    if (!taskId) {
      return { ok: false, message: `${TASK_CAP_HEADER} requires ${TASK_HEADER}.` };
    }
    taskCapUsd = n;
  }

  return { ok: true, attribution: { taskId, agent, workflow, tags, taskCapUsd } };
}

function bodyAttribution(body: Record<string, unknown>, provider: Provider): Attribution {
  const out: Attribution = { tags: {} };
  const meta = body["metadata"];
  if (meta && typeof meta === "object") {
    const m = meta as Record<string, unknown>;
    out.taskId = str(m["bulwark_task_id"]) ?? str(m["task_id"]);
    out.agent = str(m["agent"]);
    out.workflow = str(m["workflow"]);
    if (provider === "anthropic") {
      const user = str(m["user_id"]);
      if (user && isValidValue(user)) out.tags["user"] = user;
    }
  }
  if (provider === "openai") {
    const user = str(body["user"]);
    if (user && isValidValue(user)) out.tags["user"] = user;
  }
  return out;
}

/** True when the request carries anything worth attributing. */
export function hasAttribution(a: Attribution): boolean {
  return Boolean(a.taskId || a.agent || a.workflow || Object.keys(a.tags).length > 0);
}

// ─── Task ledger ──────────────────────────────────────────────────────────────

function taskKey(keyId: string, taskId: string): string {
  return `attr:task:${keyId}:${taskId}`;
}

export async function getTaskLedger(keyId: string, taskId: string, env: Env): Promise<TaskLedger | null> {
  return (await env.BULWARK_KV.get(taskKey(keyId, taskId), { type: "json" })) as TaskLedger | null;
}

async function putTaskLedger(ledger: TaskLedger, env: Env): Promise<void> {
  await env.BULWARK_KV.put(taskKey(ledger.keyId, ledger.taskId), JSON.stringify(ledger), {
    expirationTtl: TASK_TTL,
  });
}

function newLedger(keyId: string, a: Attribution, now: string): TaskLedger {
  return {
    taskId: a.taskId!,
    keyId,
    agent: a.agent,
    workflow: a.workflow,
    tags: { ...a.tags },
    requests: 0,
    cacheHits: 0,
    upstreamErrors: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    byModel: {},
    byAgent: {},
    capUsd: a.taskCapUsd,
    firstSeenAt: now,
    lastSeenAt: now,
  };
}

// ─── Per-task and per-agent caps ──────────────────────────────────────────────

export interface AttributionAllowed {
  allowed: true;
  ledger: TaskLedger | null;
}
export interface AttributionBlocked {
  allowed: false;
  status: 429;
  code: "task_cap_exceeded" | "agent_cap_exceeded";
  message: string;
  capUsd: number;
  spentUsd: number;
  taskId?: string | undefined;
  agent?: string | undefined;
}
export type AttributionOutcome = AttributionAllowed | AttributionBlocked;

/**
 * Enforce per-task and per-agent caps BEFORE forwarding.
 * Effective task cap: header cap → cap stored on ledger → key default.
 */
export async function checkAttributionCaps(
  keyId: string,
  a: Attribution,
  defaults: { defaultTaskCapUsd?: number | undefined; agentDailyCapsUsd?: Record<string, number> | undefined },
  env: Env,
): Promise<AttributionOutcome> {
  let ledger: TaskLedger | null = null;

  if (a.taskId) {
    ledger = await getTaskLedger(keyId, a.taskId, env);
    const capUsd = a.taskCapUsd ?? ledger?.capUsd ?? defaults.defaultTaskCapUsd ?? 0;
    const spent = ledger?.costUsd ?? 0;
    if (capUsd > 0 && spent >= capUsd) {
      return {
        allowed: false,
        status: 429,
        code: "task_cap_exceeded",
        message: `Task "${a.taskId}" reached its cap of $${capUsd.toFixed(2)} ($${spent.toFixed(4)} spent). Start a new task or raise the cap.`,
        capUsd,
        spentUsd: spent,
        taskId: a.taskId,
      };
    }
  }

  if (a.agent && defaults.agentDailyCapsUsd) {
    const capUsd = defaults.agentDailyCapsUsd[a.agent] ?? 0;
    if (capUsd > 0) {
      const agg = await getAggregate(keyId, "agent", a.agent, utcDate(), env);
      const spent = agg?.costUsd ?? 0;
      if (spent >= capUsd) {
        return {
          allowed: false,
          status: 429,
          code: "agent_cap_exceeded",
          message: `Agent "${a.agent}" reached its daily cap of $${capUsd.toFixed(2)} ($${spent.toFixed(4)} spent). Resets at UTC midnight.`,
          capUsd,
          spentUsd: spent,
          agent: a.agent,
        };
      }
    }
  }

  return { allowed: true, ledger };
}

// ─── Recording ────────────────────────────────────────────────────────────────

/** Fold a completed request into the task ledger and daily aggregates. */
export async function recordAttribution(u: AttributionUsage, env: Env): Promise<void> {
  const a = u.attribution;
  if (!hasAttribution(a)) return;

  const now = new Date().toISOString();
  const day = utcDate();
  const writes: Promise<void>[] = [];

  if (a.taskId) {
    const ledger = (await getTaskLedger(u.keyId, a.taskId, env)) ?? newLedger(u.keyId, a, now);
    ledger.requests += 1;
    if (u.cacheHit) ledger.cacheHits += 1;
    if (u.httpStatus >= 400) ledger.upstreamErrors += 1;
    ledger.promptTokens += u.promptTokens;
    ledger.completionTokens += u.completionTokens;
    ledger.costUsd = round8(ledger.costUsd + u.costUsd);
    ledger.lastSeenAt = now;
    if (a.taskCapUsd !== undefined) ledger.capUsd = a.taskCapUsd;
    if (!ledger.agent && a.agent) ledger.agent = a.agent;
    if (!ledger.workflow && a.workflow) ledger.workflow = a.workflow;
    ledger.tags = { ...a.tags, ...ledger.tags };
    bump(ledger.byModel, u.model, u.costUsd);
    if (a.agent) bump(ledger.byAgent, a.agent, u.costUsd);

    writes.push(putTaskLedger(ledger, env));
    if (ledger.requests === 1) writes.push(pushRecentTask(u.keyId, a.taskId, env));
  }

  const dims: Array<[string, string]> = [["model", u.model]];
  if (a.agent) dims.push(["agent", a.agent]);
  if (a.workflow) dims.push(["workflow", a.workflow]);
  for (const [k, v] of Object.entries(a.tags)) dims.push([`tag:${k}`, v]);

  for (const [dimension, value] of dims) {
    writes.push(incrementAggregate(u.keyId, dimension, value, day, u, env));
  }

  await Promise.all(writes);
}

async function pushRecentTask(keyId: string, taskId: string, env: Env): Promise<void> {
  const key = `attr:tasks:recent:${keyId}`;
  const existing = ((await env.BULWARK_KV.get(key, { type: "json" })) as string[] | null) ?? [];
  const next = [taskId, ...existing.filter((t) => t !== taskId)].slice(0, MAX_RECENT_TASKS);
  await env.BULWARK_KV.put(key, JSON.stringify(next), { expirationTtl: TASK_TTL });
}

export async function listRecentTaskIds(keyId: string, env: Env): Promise<string[]> {
  return ((await env.BULWARK_KV.get(`attr:tasks:recent:${keyId}`, { type: "json" })) as string[] | null) ?? [];
}

// ─── Daily aggregates ─────────────────────────────────────────────────────────

function aggKey(keyId: string, dimension: string, value: string, day: string): string {
  return `attr:agg:${keyId}:${dimension}:${value}:${day}`;
}

export async function getAggregate(
  keyId: string,
  dimension: string,
  value: string,
  day: string,
  env: Env,
): Promise<DailyAggregate | null> {
  return (await env.BULWARK_KV.get(aggKey(keyId, dimension, value, day), { type: "json" })) as DailyAggregate | null;
}

async function incrementAggregate(
  keyId: string,
  dimension: string,
  value: string,
  day: string,
  u: AttributionUsage,
  env: Env,
): Promise<void> {
  const key = aggKey(keyId, dimension, value, day);
  const cur = ((await env.BULWARK_KV.get(key, { type: "json" })) as DailyAggregate | null) ?? emptyAggregate();
  cur.requests += 1;
  if (u.cacheHit) cur.cacheHits += 1;
  cur.promptTokens += u.promptTokens;
  cur.completionTokens += u.completionTokens;
  cur.costUsd = round8(cur.costUsd + u.costUsd);
  await env.BULWARK_KV.put(key, JSON.stringify(cur), { expirationTtl: AGG_TTL });
}

export interface SummaryRow extends DailyAggregate {
  value: string;
  shareOfCost: number; // 0..1
  cacheHitRate: number; // 0..1
}

/** Cost breakdown for one dimension on one UTC day, sorted by cost desc. */
export async function summarizeDimension(
  keyId: string,
  dimension: string,
  day: string,
  env: Env,
): Promise<{ dimension: string; date: string; totalCostUsd: number; rows: SummaryRow[] }> {
  const prefix = `attr:agg:${keyId}:${dimension}:`;
  const suffix = `:${day}`;
  const names: string[] = [];
  let cursor: string | null = null;
  do {
    const page: KVNamespaceListResult<unknown, string> = await env.BULWARK_KV.list(
      cursor ? { prefix, cursor } : { prefix },
    );
    for (const k of page.keys) if (k.name.endsWith(suffix)) names.push(k.name);
    cursor = page.list_complete ? null : ((page as { cursor?: string }).cursor ?? null);
  } while (cursor);

  const aggs = await Promise.all(
    names.map(async (name) => {
      const value = name.slice(prefix.length, name.length - suffix.length);
      const agg = ((await env.BULWARK_KV.get(name, { type: "json" })) as DailyAggregate | null) ?? emptyAggregate();
      return { value, ...agg };
    }),
  );

  const total = round8(aggs.reduce((s, r) => s + r.costUsd, 0));
  const rows: SummaryRow[] = aggs
    .map((r) => ({
      ...r,
      shareOfCost: total > 0 ? r.costUsd / total : 0,
      cacheHitRate: r.requests > 0 ? r.cacheHits / r.requests : 0,
    }))
    .sort((x, y) => y.costUsd - x.costUsd);

  return { dimension, date: day, totalCostUsd: total, rows };
}

// ─── Outcomes and ROI roll-up ─────────────────────────────────────────────────

export interface OutcomeInput {
  outcome: TaskOutcome;
  valueUsd?: number | undefined;
  note?: string | undefined;
}

export function isTaskOutcome(v: unknown): v is TaskOutcome {
  return v === "success" || v === "failure" || v === "abandoned";
}

/** Attach an outcome (and optional business value) to a task. */
export async function recordTaskOutcome(
  keyId: string,
  taskId: string,
  input: OutcomeInput,
  env: Env,
): Promise<TaskLedger | null> {
  const ledger = await getTaskLedger(keyId, taskId, env);
  if (!ledger) return null;
  ledger.outcome = input.outcome;
  ledger.outcomeAt = new Date().toISOString();
  if (input.valueUsd !== undefined) ledger.valueUsd = input.valueUsd;
  if (input.note !== undefined) ledger.outcomeNote = input.note.slice(0, 280);
  await putTaskLedger(ledger, env);
  return ledger;
}

export interface TasksRollup {
  tasks: number;
  withOutcome: number;
  succeeded: number;
  failed: number;
  abandoned: number;
  successRate: number | null; // among tasks with an outcome
  totalCostUsd: number;
  costPerTaskUsd: number | null;
  costPerSuccessUsd: number | null;
  avgRequestsPerTask: number | null;
  cacheHitRate: number | null;
  totalValueUsd: number | null; // only tasks with valueUsd
  valueToCostRatio: number | null; // value / cost, over tasks with valueUsd
}

/** Roll a set of ledgers up into the numbers a finance team actually asks for. */
export function rollupTasks(ledgers: TaskLedger[]): TasksRollup {
  const tasks = ledgers.length;
  const withOutcome = ledgers.filter((l) => l.outcome).length;
  const succeeded = ledgers.filter((l) => l.outcome === "success").length;
  const failed = ledgers.filter((l) => l.outcome === "failure").length;
  const abandoned = ledgers.filter((l) => l.outcome === "abandoned").length;
  const totalCost = round8(ledgers.reduce((s, l) => s + l.costUsd, 0));
  const totalReq = ledgers.reduce((s, l) => s + l.requests, 0);
  const totalHits = ledgers.reduce((s, l) => s + l.cacheHits, 0);
  const valued = ledgers.filter((l) => typeof l.valueUsd === "number");
  const totalValue = valued.length ? round8(valued.reduce((s, l) => s + (l.valueUsd ?? 0), 0)) : null;
  const valuedCost = valued.reduce((s, l) => s + l.costUsd, 0);

  return {
    tasks,
    withOutcome,
    succeeded,
    failed,
    abandoned,
    successRate: withOutcome > 0 ? succeeded / withOutcome : null,
    totalCostUsd: totalCost,
    costPerTaskUsd: tasks > 0 ? round8(totalCost / tasks) : null,
    costPerSuccessUsd: succeeded > 0 ? round8(totalCost / succeeded) : null,
    avgRequestsPerTask: tasks > 0 ? totalReq / tasks : null,
    cacheHitRate: totalReq > 0 ? totalHits / totalReq : null,
    totalValueUsd: totalValue,
    valueToCostRatio: totalValue !== null && valuedCost > 0 ? round8(totalValue / valuedCost) : null,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pick(header: string | null, fallback: string | undefined): string | undefined {
  const h = header?.trim();
  if (h) return h;
  return fallback?.trim() || undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function isValidValue(v: string): boolean {
  return v.length > 0 && v.length <= MAX_VALUE_LEN && VALUE_PATTERN.test(v);
}

function bump(map: Record<string, Bucket>, key: string, costUsd: number): void {
  const b = map[key] ?? { requests: 0, costUsd: 0 };
  b.requests += 1;
  b.costUsd = round8(b.costUsd + costUsd);
  map[key] = b;
}

function emptyAggregate(): DailyAggregate {
  return { requests: 0, cacheHits: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };
}

export function round8(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}
