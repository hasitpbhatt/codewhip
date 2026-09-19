import * as fs from "node:fs";
import * as path from "node:path";
import { configDir } from "./config-dir.js";
import { getProviderConfig } from "./custom-providers.js";
import { lockFileOwnerOnly, writeOwnerOnlyFile } from "./secure-file.js";
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
  /** id is "1min"; the field is `onemin…` to pair with ONEMIN_API_KEY (a
   *  POSIX env name cannot begin with a digit). */
  oneminApiKey?: unknown;
  /** id is "hcnsec" (api.hcnsec.cn) — a New API gateway. */
  hcnsecApiKey?: unknown;
  /** id is "hashneuron" (hashneuron.space) — the RouteOpen gateway. */
  hashneuronApiKey?: unknown;
  // 2026-09-16: new providers.
  anyrouterApiKey?: unknown;
  apinexApiKey?: unknown;
  zukijourneyApiKey?: unknown;
  nagaaiApiKey?: unknown;
  zanityaiApiKey?: unknown;
  kimetsuApiKey?: unknown;
  navyapiApiKey?: unknown;
  mnnApiKey?: unknown;
  hcapApiKey?: unknown;
  voltaiApiKey?: unknown;
  electronhubApiKey?: unknown;
  // User-sourced gateways (2026-09-16).
  xkiroApiKey?: unknown;
  gonkarouterApiKey?: unknown;
  bazaarlinkApiKey?: unknown;
  seldonApiKey?: unknown;
  cavotiApiKey?: unknown;
  getunikeyApiKey?: unknown;
  // 2026-09-18: freellm free providers.
  freetheaiApiKey?: unknown;
  gmicloudApiKey?: unknown;
  inferxApiKey?: unknown;
  kkiaiApiKey?: unknown;
  seekaiApiKey?: unknown;
  bynaraApiKey?: unknown;
  atriaApiKey?: unknown;
  onerouterApiKey?: unknown;
  xpikiApiKey?: unknown;
  // 2026-09-18: completeness batch (free tiers + trial aggregators + relays).
  githubmodelsApiKey?: unknown;
  aihubmixApiKey?: unknown;
  fastrouterApiKey?: unknown;
  vercelApiKey?: unknown;
  zenmuxApiKey?: unknown;
  llmgatewayApiKey?: unknown;
  togetherApiKey?: unknown;
  deepinfraApiKey?: unknown;
  fireworksApiKey?: unknown;
  cometapiApiKey?: unknown;
  suyuApiKey?: unknown;
  voapiApiKey?: unknown;
  nioApiKey?: unknown;
  mkeaiApiKey?: unknown;
  apiyiApiKey?: unknown;
  /** id is "codiv" (api.codiv.ai) — OpenAI-compatible diffusion-LM host. */
  codivApiKey?: unknown;
  // 2026-09-19: OmniRoute + awesome-freellm cross-harvest (deduped).
  openaiApiKey?: unknown;
  perplexityApiKey?: unknown;
  writerApiKey?: unknown;
  lambdaApiKey?: unknown;
  featherlessApiKey?: unknown;
  metallamaApiKey?: unknown;
  yiApiKey?: unknown;
  baichuanApiKey?: unknown;
  internlmApiKey?: unknown;
  iflytekApiKey?: unknown;
  rekaApiKey?: unknown;
  sarvamApiKey?: unknown;
  typhoonApiKey?: unknown;
  plamoApiKey?: unknown;
  liquidApiKey?: unknown;
  inceptionApiKey?: unknown;
  nousApiKey?: unknown;
  byteplusApiKey?: unknown;
  xiaomiApiKey?: unknown;
  arceeApiKey?: unknown;
  herokuApiKey?: unknown;
  modalApiKey?: unknown;
  basetenApiKey?: unknown;
  predibaseApiKey?: unknown;
  monsterapiApiKey?: unknown;
  wandbApiKey?: unknown;
  aimlapiApiKey?: unknown;
  bytezApiKey?: unknown;
  syntheticApiKey?: unknown;
  nanogptApiKey?: unknown;
  kieApiKey?: unknown;
  morphApiKey?: unknown;
  galadrielApiKey?: unknown;
  v0ApiKey?: unknown;
  factoryApiKey?: unknown;
  poeApiKey?: unknown;
  // 2026-09-19: user-sourced gateways.
  wrouterApiKey?: unknown;
  arouterApiKey?: unknown;
  /** id is "tokenrouter" (api.tokenrouter.io). */
  tokenrouterApiKey?: unknown;
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
  "1min": "oneminApiKey",
  hcnsec: "hcnsecApiKey",
  hashneuron: "hashneuronApiKey",
  // 2026-09-16: new providers.
  anyrouter: "anyrouterApiKey",
  apinex: "apinexApiKey",
  zukijourney: "zukijourneyApiKey",
  nagaai: "nagaaiApiKey",
  zanityai: "zanityaiApiKey",
  kimetsu: "kimetsuApiKey",
  navyapi: "navyapiApiKey",
  mnn: "mnnApiKey",
  hcap: "hcapApiKey",
  voltai: "voltaiApiKey",
  electronhub: "electronhubApiKey",
  // User-sourced gateways (2026-09-16).
  xkiro: "xkiroApiKey",
  gonkarouter: "gonkarouterApiKey",
  bazaarlink: "bazaarlinkApiKey",
  seldon: "seldonApiKey",
  cavoti: "cavotiApiKey",
  getunikey: "getunikeyApiKey",
  // 2026-09-18: freellm free providers.
  freetheai: "freetheaiApiKey",
  gmicloud: "gmicloudApiKey",
  inferx: "inferxApiKey",
  kkiai: "kkiaiApiKey",
  seekai: "seekaiApiKey",
  bynara: "bynaraApiKey",
  atria: "atriaApiKey",
  onerouter: "onerouterApiKey",
  xpiki: "xpikiApiKey",
  // 2026-09-18: completeness batch.
  githubmodels: "githubmodelsApiKey",
  aihubmix: "aihubmixApiKey",
  fastrouter: "fastrouterApiKey",
  vercel: "vercelApiKey",
  zenmux: "zenmuxApiKey",
  llmgateway: "llmgatewayApiKey",
  together: "togetherApiKey",
  deepinfra: "deepinfraApiKey",
  fireworks: "fireworksApiKey",
  cometapi: "cometapiApiKey",
  suyu: "suyuApiKey",
  voapi: "voapiApiKey",
  nio: "nioApiKey",
  mkeai: "mkeaiApiKey",
  apiyi: "apiyiApiKey",
  codiv: "codivApiKey",
  // 2026-09-19: cross-harvest batch.
  openai: "openaiApiKey",
  perplexity: "perplexityApiKey",
  writer: "writerApiKey",
  lambda: "lambdaApiKey",
  featherless: "featherlessApiKey",
  metallama: "metallamaApiKey",
  yi: "yiApiKey",
  baichuan: "baichuanApiKey",
  internlm: "internlmApiKey",
  iflytek: "iflytekApiKey",
  reka: "rekaApiKey",
  sarvam: "sarvamApiKey",
  typhoon: "typhoonApiKey",
  plamo: "plamoApiKey",
  liquid: "liquidApiKey",
  inception: "inceptionApiKey",
  nous: "nousApiKey",
  byteplus: "byteplusApiKey",
  xiaomi: "xiaomiApiKey",
  arcee: "arceeApiKey",
  heroku: "herokuApiKey",
  modal: "modalApiKey",
  baseten: "basetenApiKey",
  predibase: "predibaseApiKey",
  monsterapi: "monsterapiApiKey",
  wandb: "wandbApiKey",
  aimlapi: "aimlapiApiKey",
  bytez: "bytezApiKey",
  synthetic: "syntheticApiKey",
  nanogpt: "nanogptApiKey",
  kie: "kieApiKey",
  morph: "morphApiKey",
  galadriel: "galadrielApiKey",
  v0: "v0ApiKey",
  factory: "factoryApiKey",
  poe: "poeApiKey",
  wrouter: "wrouterApiKey",
  arouter: "arouterApiKey",
  tokenrouter: "tokenrouterApiKey",
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

/**
 * resolveKey runs per chat request and per provider row on the auth page, so
 * credentials.json is cached keyed by (mtime, size): a stat replaces the
 * read+parse on every call, while edits from this process, another process,
 * or a hand edit still invalidate naturally. Written keys drop the cache
 * outright so a save is visible immediately.
 */
let credsCache: { mtimeMs: number; size: number; creds: StoredCreds } | null = null;

function readStored(): StoredCreds {
  try {
    const st = fs.statSync(credsPath());
    if (credsCache !== null && credsCache.mtimeMs === st.mtimeMs && credsCache.size === st.size) {
      return credsCache.creds;
    }
    const creds = JSON.parse(fs.readFileSync(credsPath(), "utf8")) as StoredCreds;
    credsCache = { mtimeMs: st.mtimeMs, size: st.size, creds };
    return creds;
  } catch {
    // Missing/unreadable file: drop any cached value for a since-deleted file.
    credsCache = null;
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

function writeStored(next: Record<string, string>): string | null {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch { /* best-effort (Windows ignores mode) */ }
  const err = writeOwnerOnlyFile(credsPath(), JSON.stringify(next) + "\n");
  // Same-tick saves can land inside one mtime tick — invalidate explicitly.
  credsCache = null;
  return err;
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

export function saveKey(provider: string, key: string): string | null {
  return writeStored({ ...allStoredFields(), [fieldFor(provider)]: key });
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
  const warning = writeStored(rest);
  // The rewrite inherits the file's existing ACLs/mode; re-lock so a file
  // left loose by an older version is repaired on the way out too.
  const relock = lockFileOwnerOnly(credsPath());
  for (const w of [warning, relock]) {
    if (w !== null) console.warn(`auth: warning: ${w}`);
  }
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
