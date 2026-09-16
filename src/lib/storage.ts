/**
 * Storage Abstraction Layer for CodeWhip Proxy
 * 
 * Provides unified storage interface that works across:
 * - Cloudflare Workers KV
 * - Node.js filesystem
 * - In-memory (for testing/serverless)
 */

import type { ProviderConfig, ProviderId, Storage, KeySource } from "./types.js";

// ============================================================================
// Node.js Storage (filesystem + env)
// ============================================================================

export class NodeStorage implements Storage {
  constructor(private envVars: Record<string, string> = {}) {}

  async resolveKey(provider: ProviderId): Promise<{ key: string; source: KeySource }> {
    // Import provider config to get env var name
    const { PROVIDERS } = await import("./providers.js");
    const cfg = PROVIDERS[provider];
    if (!cfg) return { key: "", source: "none" };
    
    const key = this.envVars[cfg.envVar] ?? process.env[cfg.envVar] ?? "";
    if (key.length > 0) return { key, source: "env" };
    
    // Check for anonymous key
    if (cfg.anonymousKey) {
      return { key: cfg.anonymousKey, source: "anonymous" };
    }
    
    return { key: "", source: "none" };
  }

  async getProviderConfig(provider: ProviderId): Promise<ProviderConfig | null> {
    const { PROVIDERS } = await import("./providers.js");
    return PROVIDERS[provider] ?? null;
  }

  async listAllProviderConfigs(): Promise<ProviderConfig[]> {
    const { PROVIDERS } = await import("./providers.js");
    return Object.values(PROVIDERS);
  }
}

// ============================================================================
// Cloudflare KV Storage
// ============================================================================

export class KVStorage implements Storage {
  constructor(private kv: any) {}

  async resolveKey(provider: ProviderId): Promise<{ key: string; source: KeySource }> {
    const { PROVIDERS } = await import("./providers.js");
    const cfg = PROVIDERS[provider];
    if (!cfg) return { key: "", source: "none" };
    
    // Check environment variable first
    const envKey = process.env[cfg.envVar] ?? "";
    if (envKey.length > 0) return { key: envKey, source: "env" };
    
    // Check KV for stored key
    const storedKey = await this.kv.get(`${provider}-key`, { type: "text" });
    if (storedKey && storedKey.length > 0) {
      return { key: storedKey, source: "file" };
    }
    
    // Check for anonymous key
    if (cfg.anonymousKey) {
      return { key: cfg.anonymousKey, source: "anonymous" };
    }
    
    return { key: "", source: "none" };
  }

  async getProviderConfig(provider: ProviderId): Promise<ProviderConfig | null> {
    // Try KV first for custom providers
    const customConfig = await this.kv.get(`provider:${provider}`, { type: "json" });
    if (customConfig) return customConfig;
    
    // Fall back to builtin
    const { PROVIDERS } = await import("./providers.js");
    return PROVIDERS[provider] ?? null;
  }

  async listAllProviderConfigs(): Promise<ProviderConfig[]> {
    const { PROVIDERS } = await import("./providers.js");
    const builtin = Object.values(PROVIDERS);
    
    // Also get custom providers from KV
    try {
      const keys = await this.kv.list({ prefix: "provider:" });
      for (const key of keys.keys) {
        const config = await this.kv.get(key.name, { type: "json" });
        if (config && !builtin.find(p => p.id === config.id)) {
          builtin.push(config);
        }
      }
    } catch {
      // Ignore errors
    }
    
    return builtin;
  }

  // Additional KV-specific methods
  async saveKey(provider: ProviderId, key: string): Promise<void> {
    await this.kv.put(`${provider}-key`, key, { expirationTtl: 3600 * 24 * 365 }); // 1 year
  }

  async deleteKey(provider: ProviderId): Promise<void> {
    await this.kv.delete(`${provider}-key`);
  }

  async saveProvider(config: ProviderConfig): Promise<void> {
    await this.kv.put(`provider:${config.id}`, JSON.stringify(config), { expirationTtl: 3600 * 24 * 365 });
  }

  async deleteProvider(provider: ProviderId): Promise<void> {
    await this.kv.delete(`provider:${provider}`);
  }
}

// ============================================================================
// In-Memory Storage (for testing / ephemeral)
// ============================================================================

export class MemoryStorage implements Storage {
  private keys = new Map<string, string>();
  private providers = new Map<string, ProviderConfig>();
  private initialized = false;

  private async ensureInit(): Promise<void> {
    if (!this.initialized) {
      const { PROVIDERS } = await import("./providers.js");
      for (const [id, cfg] of Object.entries(PROVIDERS)) {
        this.providers.set(id, cfg as ProviderConfig);
      }
      this.initialized = true;
    }
  }

  async resolveKey(provider: ProviderId): Promise<{ key: string; source: KeySource }> {
    await this.ensureInit();
    const cfg = this.providers.get(provider);
    if (!cfg) return { key: "", source: "none" };
    
    // Check env var
    const envKey = process.env[cfg.envVar] ?? "";
    if (envKey.length > 0) return { key: envKey, source: "env" };
    
    // Check memory store
    const storedKey = this.keys.get(provider);
    if (storedKey) return { key: storedKey, source: "file" };
    
    // Check anonymous
    if (cfg.anonymousKey) {
      return { key: cfg.anonymousKey, source: "anonymous" };
    }
    
    return { key: "", source: "none" };
  }

  async getProviderConfig(provider: ProviderId): Promise<ProviderConfig | null> {
    await this.ensureInit();
    return this.providers.get(provider) ?? null;
  }

  async listAllProviderConfigs(): Promise<ProviderConfig[]> {
    await this.ensureInit();
    return [...this.providers.values()];
  }

  // Memory-specific methods
  setKey(provider: ProviderId, key: string): void {
    this.keys.set(provider, key);
  }

  deleteKey(provider: ProviderId): void {
    this.keys.delete(provider);
  }

  setProvider(config: ProviderConfig): void {
    this.providers.set(config.id, config);
  }

  deleteProvider(provider: ProviderId): void {
    this.providers.delete(provider);
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export interface StorageConfig {
  backend: "kv" | "node" | "memory";
  kv?: any;
  envVars?: Record<string, string>;
}

export function createStorage(config: StorageConfig): Storage {
  switch (config.backend) {
    case "kv":
      return new KVStorage(config.kv);
    case "memory":
      return new MemoryStorage();
    case "node":
    default:
      return new NodeStorage(config.envVars);
  }
}

export function createStorageForBackend(
  backend: "kv" | "node" | "memory",
  kv?: any,
  envVars?: Record<string, string>
): Storage {
  return createStorage({ backend, kv, envVars });
}

// Re-export for convenience
export type { Storage } from "./types.js";