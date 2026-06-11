import { describe, it, expect, beforeEach } from "vitest";
import { checkCaps, recordSpend, getDailySpend, getMonthlySpend, utcDate, utcYearMonth } from "../src/caps.js";
import { BulwarkKeyRecord } from "../src/types.js";
import { MockKV, makeEnv } from "./mock-kv.js";

function makeRecord(overrides: Partial<BulwarkKeyRecord> = {}): BulwarkKeyRecord {
  return {
    keyId: "testkey01",
    keyHash: "abc",
    ownerId: "owner1",
    tier: "indie",
    dailyCapUsd: 10.0,
    monthlyCapUsd: 100.0,
    bedtimeEnabled: false,
    wakeHour: 7,
    timezone: "UTC",
    createdAt: new Date().toISOString(),
    active: true,
    ...overrides,
  };
}

describe("caps — checkCaps", () => {
  let env: ReturnType<typeof makeEnv>;

  beforeEach(() => {
    env = makeEnv();
  });

  it("allows request when no spend recorded", async () => {
    const result = await checkCaps(makeRecord(), env as any);
    expect(result.allowed).toBe(true);
  });

  it("allows request when spend is below daily cap", async () => {
    const kv = env.BULWARK_KV as MockKV;
    await kv.put(`spend:daily:testkey01:${utcDate()}`, "5.0000");
    const result = await checkCaps(makeRecord(), env as any);
    expect(result.allowed).toBe(true);
  });

  it("blocks when daily spend equals the cap", async () => {
    const kv = env.BULWARK_KV as MockKV;
    await kv.put(`spend:daily:testkey01:${utcDate()}`, "10.00000000");
    const result = await checkCaps(makeRecord({ dailyCapUsd: 10.0 }), env as any);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.code).toBe("daily_cap_exceeded");
      expect(result.status).toBe(429);
      expect(result.capUsd).toBe(10.0);
      expect(result.spentUsd).toBeCloseTo(10.0, 4);
    }
  });

  it("blocks when daily spend exceeds the cap", async () => {
    const kv = env.BULWARK_KV as MockKV;
    await kv.put(`spend:daily:testkey01:${utcDate()}`, "12.50000000");
    const result = await checkCaps(makeRecord({ dailyCapUsd: 10.0 }), env as any);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe("daily_cap_exceeded");
  });

  it("blocks when monthly spend equals the cap", async () => {
    const kv = env.BULWARK_KV as MockKV;
    await kv.put(`spend:monthly:testkey01:${utcYearMonth()}`, "100.00000000");
    const result = await checkCaps(makeRecord({ dailyCapUsd: 0, monthlyCapUsd: 100.0 }), env as any);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.code).toBe("monthly_cap_exceeded");
      expect(result.status).toBe(429);
    }
  });

  it("daily cap checked before monthly cap", async () => {
    const kv = env.BULWARK_KV as MockKV;
    await kv.put(`spend:daily:testkey01:${utcDate()}`, "10.00000000");
    await kv.put(`spend:monthly:testkey01:${utcYearMonth()}`, "100.00000000");
    const result = await checkCaps(makeRecord(), env as any);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe("daily_cap_exceeded");
  });

  it("skips daily cap check when dailyCapUsd is 0", async () => {
    const kv = env.BULWARK_KV as MockKV;
    await kv.put(`spend:daily:testkey01:${utcDate()}`, "999.0");
    const result = await checkCaps(makeRecord({ dailyCapUsd: 0, monthlyCapUsd: 0 }), env as any);
    expect(result.allowed).toBe(true);
  });
});

describe("caps — recordSpend / getDailySpend / getMonthlySpend", () => {
  let env: ReturnType<typeof makeEnv>;

  beforeEach(() => {
    env = makeEnv();
  });

  it("records spend and can be read back", async () => {
    await recordSpend("testkey01", 1.5, env as any);
    const daily = await getDailySpend("testkey01", env as any);
    const monthly = await getMonthlySpend("testkey01", env as any);
    expect(daily).toBeCloseTo(1.5, 5);
    expect(monthly).toBeCloseTo(1.5, 5);
  });

  it("accumulates spend across multiple calls", async () => {
    await recordSpend("testkey01", 1.0, env as any);
    await recordSpend("testkey01", 2.5, env as any);
    await recordSpend("testkey01", 0.25, env as any);
    const daily = await getDailySpend("testkey01", env as any);
    expect(daily).toBeCloseTo(3.75, 5);
  });

  it("ignores zero-cost records", async () => {
    await recordSpend("testkey01", 0, env as any);
    const daily = await getDailySpend("testkey01", env as any);
    expect(daily).toBe(0);
  });

  it("returns 0 when no spend recorded", async () => {
    const daily = await getDailySpend("no-such-key", env as any);
    expect(daily).toBe(0);
  });
});
