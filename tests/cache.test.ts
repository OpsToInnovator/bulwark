import { describe, it, expect, beforeEach } from "vitest";
import { computeCacheKey, cacheGet, cachePut, isCacheable } from "../src/cache.js";
import { makeEnv } from "./mock-kv.js";

describe("cache — computeCacheKey", () => {
  it("produces a 64-char hex SHA-256 string", async () => {
    const key = await computeCacheKey("openai", "gpt-4o", { messages: [{ role: "user", content: "hi" }] });
    expect(key).toHaveLength(64);
    expect(key).toMatch(/^[0-9a-f]+$/);
  });

  it("same inputs produce same key", async () => {
    const body = { messages: [{ role: "user", content: "hello" }], temperature: 0 };
    const k1 = await computeCacheKey("openai", "gpt-4o", body);
    const k2 = await computeCacheKey("openai", "gpt-4o", body);
    expect(k1).toBe(k2);
  });

  it("different providers produce different keys", async () => {
    const body = { messages: [] };
    const k1 = await computeCacheKey("openai", "gpt-4o", body);
    const k2 = await computeCacheKey("anthropic", "gpt-4o", body);
    expect(k1).not.toBe(k2);
  });

  it("different models produce different keys", async () => {
    const body = { messages: [] };
    const k1 = await computeCacheKey("openai", "gpt-4o", body);
    const k2 = await computeCacheKey("openai", "gpt-4o-mini", body);
    expect(k1).not.toBe(k2);
  });

  it("different body content produces different keys", async () => {
    const k1 = await computeCacheKey("openai", "gpt-4o", { messages: [{ role: "user", content: "hello" }] });
    const k2 = await computeCacheKey("openai", "gpt-4o", { messages: [{ role: "user", content: "world" }] });
    expect(k1).not.toBe(k2);
  });

  it("key is stable regardless of object key order", async () => {
    const body1 = { model: "gpt-4o", temperature: 0, messages: [] };
    const body2 = { messages: [], temperature: 0, model: "gpt-4o" };
    const k1 = await computeCacheKey("openai", "gpt-4o", body1);
    const k2 = await computeCacheKey("openai", "gpt-4o", body2);
    expect(k1).toBe(k2);
  });
});

describe("cache — cacheGet / cachePut", () => {
  let env: ReturnType<typeof makeEnv>;

  beforeEach(() => {
    env = makeEnv();
  });

  it("returns null on cache miss", async () => {
    const result = await cacheGet("nonexistentkey", env as any);
    expect(result).toBeNull();
  });

  it("stores and retrieves a cached response", async () => {
    const body = { id: "chatcmpl-123", choices: [{ message: { content: "Hello" } }] };
    const key = await computeCacheKey("openai", "gpt-4o", { messages: [] });

    await cachePut(key, body, env as any);
    const response = await cacheGet(key, env as any);

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(response!.headers.get("x-bulwark-cache")).toBe("hit");
    expect(response!.headers.get("Content-Type")).toBe("application/json");

    const parsed = await response!.json() as typeof body;
    expect(parsed.id).toBe("chatcmpl-123");
  });

  it("includes x-bulwark-cached-at header", async () => {
    const key = await computeCacheKey("openai", "gpt-4o", { messages: [] });
    await cachePut(key, { ok: true }, env as any);
    const response = await cacheGet(key, env as any);
    expect(response!.headers.get("x-bulwark-cached-at")).toBeTruthy();
  });

  it("different keys don't collide", async () => {
    const k1 = await computeCacheKey("openai", "gpt-4o", { messages: [{ content: "foo" }] });
    const k2 = await computeCacheKey("openai", "gpt-4o", { messages: [{ content: "bar" }] });

    await cachePut(k1, { answer: "foo" }, env as any);
    await cachePut(k2, { answer: "bar" }, env as any);

    const r1 = await cacheGet(k1, env as any);
    const r2 = await cacheGet(k2, env as any);

    expect(await r1!.json()).toEqual({ answer: "foo" });
    expect(await r2!.json()).toEqual({ answer: "bar" });
  });
});

describe("cache — isCacheable", () => {
  it("allows non-streaming requests", () => {
    expect(isCacheable({ messages: [] })).toBe(true);
  });

  it("rejects streaming requests", () => {
    expect(isCacheable({ messages: [], stream: true })).toBe(false);
  });

  it("allows non-streaming with stream: false", () => {
    expect(isCacheable({ messages: [], stream: false })).toBe(true);
  });

  it("allows requests with temperature > 0 (variable but still cached)", () => {
    expect(isCacheable({ messages: [], temperature: 0.7 })).toBe(true);
  });
});
