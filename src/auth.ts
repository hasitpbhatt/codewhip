import * as fs from "node:fs";
import * as path from "node:path";
import { configDir } from "./config-dir.js";
import { getProviderConfig } from "./custom-providers.js";
import type { BuiltinProviderId } from "./provider.js";

export type { ProviderId } from "./provider.js";
export { configDir, CONFIG_DIR_ENV } from "./config-dir.js";

type StoredCreds = {
  nvidiaApiKey?: unknown;
  mistralApiKey?: unknown;
  sensenovaApiKey?: unknown;
  alibabaApiKey?: unknown;
  llm7ApiKey?: unknown;
  tokenharborApiKey?: unknown;
  baiApiKey?: unknown;
  fabrykaApiKey?: unknown;
  opencodeApiKey?: unknown;
  kiloApiKey?: unknown;
  openrouterApiKey?: unknown;
  geminiApiKey?: unknown;
  groqApiKey?: unknown;
  cerebrasApiKey?: unknown;
  zaiApiKey?: unknown;
  emperoApiKey?: unknown;
  // Onboarded free OpenAI-compatible providers (2026-09-11 addendum).
  pollinationsApiKey?: unknown;
  sambanovaApiKey?: unknown;
  chutesApiKey?: unknown;
  hyperbolicApiKey?: unknown;
  // lepton removed 2026-09-13: Lepton AI ceased operations 2025-05-20 after
  // the NVIDIA acquisition and api.lepton.ai no longer resolves. A leftover
  // leptonApiKey in an existing credentials.json is simply ignored.
  xaiApiKey?: unknown;
  huggingfaceApiKey?: unknown;
  upstageApiKey?: unknown;
  novitaApiKey?: unknown;
  parasailApiKey?: unknown;
  volcengineApiKey?: unknown;
  qianfanApiKey?: unknown;
  hunyuanApiKey?: unknown;
  moonshotApiKey?: unknown;
  deepseekApiKey?: unknown;
  minimaxApiKey?: unknown;
  stepfunApiKey?: unknown;
  ppioApiKey?: unknown;
  // Free-tier candidates harvested 2026-09-13.
  cloudflareApiKey?: unknown;
  modelscopeApiKey?: unknown;
  ovhcloudApiKey?: unknown;
  ollamaApiKey?: unknown;
  cohereApiKey?: unknown;
  siliconflowApiKey?: unknown;
  aionlabsApiKey?: unknown;
  agnesApiKey?: unknown;
  requestyApiKey?: unknown;
  inferenceApiKey?: unknown;
  hetznerApiKey?: unknown;
  veniceApiKey?: unknown;
  scalewayApiKey?: unknown;
  friendliApiKey?: unknown;
  nscaleApiKey?: unknown;
  nebiusApiKey?: unknown;
  ai21ApiKey?: unknown;
  cozeApiKey?: unknown;
  /** Custom providers: `custom_<sanitized-id>_ApiKey` (see customFieldFor). */
  [key: string]: unknown;
};

const FIELD_BY_PROVIDER: Record<BuiltinProviderId, string> = {
  nvidia: "nvidiaApiKey",
  mistral: "mistralApiKey",
  sensenova: "sensenovaApiKey",
  alibaba: "alibabaApiKey",
  llm7: "llm7ApiKey",
  tokenharbor: "tokenharborApiKey",
  bai: "baiApiKey",
  fabryka: "fabrykaApiKey",
  opencode: "opencodeApiKey",
  kilo: "kiloApiKey",
  openrouter: "openrouterApiKey",
  gemini: "geminiApiKey",
  groq: "groqApiKey",
  cerebras: "cerebrasApiKey",
  zai: "zaiApiKey",
  empero: "emperoApiKey",
  // Onboarded free OpenAI-compatible providers (2026-09-11 addendum).
  pollinations: "pollinationsApiKey",
  sambanova: "sambanovaApiKey",
  chutes: "chutesApiKey",
  hyperbolic: "hyperbolicApiKey",
  xai: "xaiApiKey",
  huggingface: "huggingfaceApiKey",
  upstage: "upstageApiKey",
  novita: "novitaApiKey",
  parasail: "parasailApiKey",
  volcengine: "volcengineApiKey",
  qianfan: "qianfanApiKey",
  hunyuan: "hunyuanApiKey",
  moonshot: "moonshotApiKey",
  deepseek: "deepseekApiKey",
  minimax: "minimaxApiKey",
  stepfun: "stepfunApiKey",
  ppio: "ppioApiKey",
  // Free-tier candidates harvested 2026-09-13.
  cloudflare: "cloudflareApiKey",
  modelscope: "modelscopeApiKey",
  ovhcloud: "ovhcloudApiKey",
  ollama: "ollamaApiKey",
  cohere: "cohereApiKey",
  siliconflow: "siliconflowApiKey",
  aionlabs: "aionlabsApiKey",
  agnes: "agnesApiKey",
  requesty: "requestyApiKey",
  inference: "inferenceApiKey",
  hetzner: "hetznerApiKey",
  venice: "veniceApiKey",
  scaleway: "scalewayApiKey",
  friendli: "friendliApiKey",
  nscale: "nscaleApiKey",
  nebius: "nebiusApiKey",
  ai21: "ai21ApiKey",
  coze: "cozeApiKey",
};

function customFieldFor(provider: string): string {
  return `custom_${provider.toLowerCase().replace(/[^a-z0-9]/g, "_")}_ApiKey`;
}

function fieldFor(provider: string): string {
  return FIELD_BY_PROVIDER[provider as BuiltinProviderId] ?? customFieldFor(provider);
}

function credsPath(): string {
  return path.join(configDir(), "credentials.json");
}

function readStored(): StoredCreds {
  try {
    const raw = fs.readFileSync(credsPath(), "utf8");
    return JSON.parse(raw) as StoredCreds;
  } catch {
    return {};
  }
}

export type KeySource = "env" | "file" | "anonymous" | "none";

export function resolveKey(provider: string): { key: string; source: KeySource } {
  const cfg = getProviderConfig(provider);
  if (cfg === null) {
    return { key: "", source: "none" };
  }
  const fromEnv = process.env[cfg.envVar] ?? "";
  if (fromEnv.length > 0) {
    return { key: fromEnv, source: "env" };
  }
  const stored = readStored()[fieldFor(provider)];
  if (typeof stored === "string" && stored.length > 0) {
    return { key: stored, source: "file" };
  }
  if (cfg.anonymousKey !== undefined && cfg.anonymousKey.length > 0) {
    return { key: cfg.anonymousKey, source: "anonymous" };
  }
  return { key: "", source: "none" };
}

/** Back-compat default (nvidia). */
export function resolveApiKey(): { key: string; source: KeySource } {
  return resolveKey("nvidia");
}

function writeStored(next: Record<string, string>): void {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(credsPath(), JSON.stringify(next) + "\n", { mode: 0o600 });
}

/** All stored keys merged, so writing one provider never drops the others'. */
function allStoredFields(): Record<string, string> {
  const stored = readStored();
  const out: Record<string, string> = {};
  for (const [field, v] of Object.entries(stored)) {
    if (typeof v === "string" && v.length > 0) {
      out[field] = v;
    }
  }
  return out;
}

export function saveKey(provider: string, key: string): void {
  writeStored({ ...allStoredFields(), [fieldFor(provider)]: key });
}

/** Back-compat default (nvidia). */
export function saveApiKey(key: string): void {
  saveKey("nvidia", key);
}

/** Returns false when nothing was stored. Preserves every other provider. */
export function clearKey(provider: string): boolean {
  const stored = readStored()[fieldFor(provider)];
  if (typeof stored !== "string" || stored.length === 0) {
    return false;
  }
  const rest = allStoredFields();
  delete rest[fieldFor(provider)];
  writeStored(rest);
  return true;
}

/** Back-compat default (nvidia). */
export function clearApiKey(): boolean {
  return clearKey("nvidia");
}

/** Hidden TTY prompt (prints *). Falls back to plain read when not a TTY. */
export function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(question);
    if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
      let data = "";
      stdin.resume();
      stdin.on("data", (chunk: Buffer) => {
        data += chunk.toString("utf8");
      });
      stdin.on("end", () => resolve(data.trim()));
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    let buf = "";
    const done = (value: string): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdout.write("\n");
      resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      const s = chunk.toString("utf8");
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") {
          done(buf);
          return;
        }
        if (ch === "\u0003") {
          done("");
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          buf = buf.slice(0, -1);
          stdout.write("\b \b");
        } else if (ch >= " " && buf.length < 500) {
          buf += ch;
          stdout.write("*");
        }
      }
    };
    stdin.on("data", onData);
  });
}
