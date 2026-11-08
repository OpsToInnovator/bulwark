import { describe, it, expect, beforeEach, vi } from "vitest";
import { MockKV, makeEnv } from "./mock-kv.js";

// Captures every pg Client the code under test constructs, so the tests can
// assert on connect/query/end without a database.
const pg = vi.hoisted(() => {
  const clients: {
    connectionString: string;
    connected: boolean;
    ended: boolean;
    queries: { sql: string; params: unknown[] }[];
  }[] = [];

  const hooks: { query: (sql: string, params: unknown[]) => Promise<unknown> } = {
    query: async () => ({ rows: [] }),
  };

  return { clients, hooks };
});

vi.mock("pg", () => {
  class Client {
    connectionString: string;
    connected = false;
    ended = false;
    queries: { sql: string; params: unknown[] }[] = [];

    constructor(config: { connectionString: string }) {
      this.connectionString = config.connectionString;
      pg.clients.push(this);
    }

    async connect(): Promise<void> {
      this.connected = true;
    }

    async query(sql: string, params: unknown[]): Promise<unknown> {
      this.queries.push({ sql, params });
      return pg.hooks.query(sql, params);
    }

    async end(): Promise<void> {
      this.ended = true;
    }
  }

  return { Client, default: { Client } };
});

const { recordUsage } = await import("../src/usage.js");

function makeInput(overrides = {}) {
  return {
    requestId: "req_test_1",
    keyId: "testkey01",
    provider: "openai" as const,
    model: "gpt-4o",
    promptTokens: 100,
    completionTokens: 50,
    costUsd: 0.00125,
    cacheHit: false,
    latencyMs: 420,
    httpStatus: 200,
    ...overrides,
  };
}

function withHyperdrive(env: ReturnType<typeof makeEnv>) {
  return { ...env, HYPERDRIVE: { connectionString: "postgres://localhost:5432/bulwark" } };
}

/** Let pending microtasks and timers drain. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("usage — Postgres write path", () => {
  let env: ReturnType<typeof makeEnv>;

  beforeEach(() => {
    env = makeEnv();
    pg.clients.length = 0;
    pg.hooks.query = async () => ({ rows: [] });
  });

  it("inserts the record when HYPERDRIVE is bound", async () => {
    await recordUsage(makeInput(), withHyperdrive(env) as any);

    expect(pg.clients).toHaveLength(1);
    const client = pg.clients[0]!;
    expect(client.connectionString).toBe("postgres://localhost:5432/bulwark");
    expect(client.connected).toBe(true);
    expect(client.ended).toBe(true);
    expect(client.queries).toHaveLength(1);
    expect(client.queries[0]!.sql).toContain("INSERT INTO usage_records");
  });

  it("binds every column of the record in order", async () => {
    await recordUsage(makeInput(), withHyperdrive(env) as any);

    const params = pg.clients[0]!.queries[0]!.params;
    // 12 columns in the INSERT; a mismatch here means values land in the wrong
    // columns, which Postgres will happily accept for same-typed neighbours.
    expect(params).toHaveLength(12);
    expect(params.slice(0, 9)).toEqual([
      "req_test_1",
      "testkey01",
      "openai",
      "gpt-4o",
      100,
      50,
      0.00125,
      false,
      false,
    ]);
    expect(params[9]).toBe(420);
    expect(typeof params[10]).toBe("string"); // ISO timestamp
    expect(params[11]).toBe(200);
  });

  // Regression: writeToPostgres used to be started without being awaited, so the
  // promise escaped the caller's ctx.waitUntil and the isolate was torn down
  // before the insert settled. Nothing was written and nothing was logged.
  it("does not resolve until the insert has settled", async () => {
    let releaseQuery!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    pg.hooks.query = async () => {
      await gate;
      return { rows: [] };
    };

    let settled = false;
    const pending = recordUsage(makeInput(), withHyperdrive(env) as any).then(() => {
      settled = true;
    });

    await flush();
    expect(settled).toBe(false);

    releaseQuery();
    await pending;
    expect(settled).toBe(true);
  });

  it("skips the driver entirely when HYPERDRIVE is unbound", async () => {
    await recordUsage(makeInput(), env as any);
    expect(pg.clients).toHaveLength(0);
  });

  it("still updates KV counters when the database write fails", async () => {
    pg.hooks.query = async () => {
      throw new Error("connection refused");
    };

    await expect(
      recordUsage(makeInput(), withHyperdrive(env) as any),
    ).resolves.toBeUndefined();

    const kv = env.BULWARK_KV as MockKV;
    const recent = (await kv.get("usage:recent:testkey01", { type: "json" })) as unknown as
      | { requestId: string }[]
      | null;
    expect(recent?.[0]?.requestId).toBe("req_test_1");
  });

  it("writes the record to the KV recent list", async () => {
    await recordUsage(makeInput(), withHyperdrive(env) as any);

    const kv = env.BULWARK_KV as MockKV;
    const recent = (await kv.get("usage:recent:testkey01", { type: "json" })) as unknown as
      | { requestId: string; costUsd: number }[]
      | null;
    expect(recent).toHaveLength(1);
    expect(recent?.[0]?.costUsd).toBe(0.00125);
  });
});
