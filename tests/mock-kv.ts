// ─── Mock KVNamespace for unit tests ─────────────────────────────────────────

export class MockKV implements KVNamespace {
  private store = new Map<string, { value: string; expiration?: number }>();

  async get(
    key: string,
    options?: { type?: "text" | "json" | "arrayBuffer" | "stream" } | "text" | "json" | "arrayBuffer" | "stream",
  ): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiration && entry.expiration < Date.now() / 1000) {
      this.store.delete(key);
      return null;
    }
    const type = typeof options === "object" ? options?.type : options;
    if (type === "json") {
      return JSON.parse(entry.value) as string;
    }
    return entry.value;
  }

  async put(
    key: string,
    value: string | ReadableStream | ArrayBuffer,
    options?: { expiration?: number; expirationTtl?: number },
  ): Promise<void> {
    let expiration: number | undefined;
    if (options?.expiration) expiration = options.expiration;
    if (options?.expirationTtl) expiration = Math.floor(Date.now() / 1000) + options.expirationTtl;
    this.store.set(key, { value: String(value), expiration });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<KVNamespaceListResult<unknown, string>> {
    const prefix = options?.prefix ?? "";
    const keys = Array.from(this.store.keys())
      .filter((k) => k.startsWith(prefix))
      .map((name) => ({ name, expiration: undefined, metadata: undefined }));
    return { keys, list_complete: true, cacheStatus: null };
  }

  async getWithMetadata<M>(
    key: string,
    _options?: unknown,
  ): Promise<KVNamespaceGetWithMetadataResult<string | null, M>> {
    const value = await this.get(key);
    return { value, metadata: null as M, cacheStatus: null };
  }

  // Test helper
  _raw(): Map<string, { value: string; expiration?: number }> {
    return this.store;
  }
}

export function makeEnv(overrides: Partial<{
  CACHE_TTL_SECONDS: string;
  BEDTIME_WAKE_HOUR: string;
  STRIPE_WEBHOOK_SECRET: string;
  ENVIRONMENT: string;
}> = {}): { BULWARK_KV: MockKV } & Record<string, string> {
  return {
    BULWARK_KV: new MockKV(),
    CACHE_TTL_SECONDS: "3600",
    BEDTIME_WAKE_HOUR: "7",
    STRIPE_WEBHOOK_SECRET: "",
    ENVIRONMENT: "test",
    ...overrides,
  } as unknown as { BULWARK_KV: MockKV } & Record<string, string>;
}
