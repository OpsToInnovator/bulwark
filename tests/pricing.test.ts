import { describe, it, expect } from "vitest";
import { calculateCost, getModelPricing } from "../src/pricing.js";

describe("pricing — getModelPricing", () => {
  it("returns exact match for known OpenAI model", () => {
    const p = getModelPricing("openai", "gpt-4o");
    expect(p).not.toBeNull();
    expect(p!.inputPerMillion).toBe(2.5);
    expect(p!.outputPerMillion).toBe(10.0);
  });

  it("returns prefix match for versioned model ID", () => {
    // e.g. "gpt-4o-mini-2024-07-18" should match "gpt-4o-mini"
    const p = getModelPricing("openai", "gpt-4o-mini-2024-07-18");
    expect(p).not.toBeNull();
    expect(p!.inputPerMillion).toBe(0.15);
  });

  it("returns null for unknown model", () => {
    expect(getModelPricing("openai", "gpt-99-super-unknown")).toBeNull();
  });

  it("returns Anthropic Claude pricing", () => {
    const p = getModelPricing("anthropic", "claude-3-5-sonnet-20241022");
    expect(p).not.toBeNull();
    expect(p!.inputPerMillion).toBe(3.0);
    expect(p!.outputPerMillion).toBe(15.0);
  });

  it("returns Gemini pricing", () => {
    const p = getModelPricing("gemini", "gemini-2.0-flash");
    expect(p).not.toBeNull();
    expect(p!.inputPerMillion).toBe(0.1);
  });
});

describe("pricing — calculateCost", () => {
  it("computes correct cost for gpt-4o", () => {
    // 1000 prompt tokens + 500 completion tokens
    // cost = (1000 * 2.5 + 500 * 10.0) / 1_000_000 = (2500 + 5000) / 1_000_000 = 0.0075
    const { costUsd, unknownModel } = calculateCost("openai", "gpt-4o", 1000, 500);
    expect(unknownModel).toBe(false);
    expect(costUsd).toBeCloseTo(0.0075, 8);
  });

  it("computes correct cost for gpt-4o-mini", () => {
    // 100_000 prompt + 50_000 completion
    // (100_000 * 0.15 + 50_000 * 0.60) / 1_000_000 = (15_000 + 30_000) / 1_000_000 = 0.045
    const { costUsd } = calculateCost("openai", "gpt-4o-mini", 100_000, 50_000);
    expect(costUsd).toBeCloseTo(0.045, 8);
  });

  it("computes $0 and sets unknownModel for unknown model", () => {
    const { costUsd, unknownModel } = calculateCost("openai", "gpt-∞", 1000, 1000);
    expect(costUsd).toBe(0);
    expect(unknownModel).toBe(true);
  });

  it("computes zero cost when no tokens used", () => {
    const { costUsd } = calculateCost("anthropic", "claude-3-opus-20240229", 0, 0);
    expect(costUsd).toBe(0);
  });

  it("computes correct cost for Anthropic Opus", () => {
    // 2000 prompt + 1000 completion
    // (2000 * 15.0 + 1000 * 75.0) / 1_000_000 = (30_000 + 75_000) / 1_000_000 = 0.105
    const { costUsd } = calculateCost("anthropic", "claude-3-opus-20240229", 2000, 1000);
    expect(costUsd).toBeCloseTo(0.105, 8);
  });

  it("handles prefix match in cost calculation", () => {
    // claude-3-5-sonnet-20241022 prefix matches itself; test a versioned ID
    const p1 = calculateCost("anthropic", "claude-3-5-sonnet-20241022", 1000, 1000);
    const p2 = calculateCost("anthropic", "claude-3-5-sonnet-20240620", 1000, 1000);
    expect(p1.costUsd).toBeCloseTo(p2.costUsd, 8);
  });
});
