#!/usr/bin/env node
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { generateKeyPairSync } from "node:crypto";
import { isBuiltinProviderId, makePortForConfig, MAX_CHAT_TIMEOUT_MS, MIN_CHAT_TIMEOUT_MS, PROVIDERS, setStreamingEnabled, type ProviderId } from "./provider.js";
import { addCustomProvider, getProviderConfig, listAllProviderConfigs, removeCustomProvider } from "./custom-providers.js";
import { freeChainIds, listFreeProviders } from "./free-providers.js";
import { listModels } from "./models.js";
import { summarizeCalls, readProviderCalls, renderProviderHealth } from "./provider-stats.js";
import { agentLoop, type ApprovalAnswer, type FailoverTarget } from "./loop.js";
import { listRules } from "./remember-store.js";
import { listCheckpointRuns, resolveCheckpointRun, rollbackRun } from "./checkpoints.js";
import { appendOutcome, newRunId, promptHash, readOutcomeRecords, type UsageBucket } from "./outcomes.js";
import { sha256Hex } from "./hash.js";
import { appendEntry, auditPath, buildBundle, readAuditLog, readLastAuditEntries, readLastAuditRaw, verifyChain, type AuditEntry } from "./audit.js";
import { writeShareBundle } from "./share.js";
import { estimateCost, polishGate, resolveRoute, type TaskClass } from "./router.js";
import { renderMetrics, summarizeCwd } from "./metrics.js";
import { appendPromotedDeny, declineCandidates, loadPromotedDenies, policyMdPath } from "./policy-store.js";
import { BUILTIN_AGENTS, listAgentsWithErrors } from "./subagents.js";
import { isVerdict, resolveRunPrefix, setVerdict } from "./verdict.js";
import { defaultPacksDir, listPacks, pullPack } from "./pack.js";
import {
  clearKey,
  configDir,
  promptHidden,
  resolveKey,
  saveKey,
} from "./auth.js";

const require = createRequire(import.meta.url);
const pkg: { version: string } = require("../package.json");

/** Built-in agent names, for the [builtin]/[file] source tag in `codewhip agents`. */
const BUILTIN_AGENT_NAMES = new Set<string>(BUILTIN_AGENTS.map((a) => a.name));

type RunOptions = {
  prompt: string;
  model: string;
  /** Ordered rotation candidates, head === model. Empty = no rotation. */
  models: string[];
  provider: ProviderId;
  providerExplicit: boolean;
  tokenBudget: number;
  maxSteps: number;
  yolo: boolean;
  retryWait: boolean;
  failover: boolean;
  /** Arm the free-provider chain (mutually exclusive with --failover). */
  free: boolean;
  /** Run-scoped read-only: edit/write/bash denied, output is the plan. */
  plan: boolean;
  /** Write a redacted share bundle (.codewhip/share-<runId>.json) after the run. */
  share: boolean;
  /** Explicit per-call provider budget override (undefined = provider default, 120s builtin). */
  timeoutMs?: number;
  /** Disable SSE streaming (whole-body responses) — escape hatch per run. */
  noStream: boolean;
  /** Explicit --class routing override (undefined = auto-classify). */
  taskClass?: TaskClass;
  modelExplicit: boolean;
};

function printRunOptions(): void {
  console.log("Options (run):");
  console.log(`  --model <id>         model id (default depends on --provider)`);
  console.log(`  --models <a,b,c>     rotate models in order on rate-limit/timeout, each once per run (default: off)`);
  console.log("  --provider <id>      provider id (default: routed by --class; see: codewhip provider list)");
  console.log("  --class <c>          implement|polish|private — task class for routing (default: auto-classify)");
  console.log("  --token-budget <n>   max prompt+completion tokens for the run; enforced mid-run, stops with partial transcript + receipt (default: 250000)");
  console.log("  --max-steps <n>      hard stop with partial result + cost (default: 25)");
  console.log(`  --timeout-ms <n>     per-call provider budget in ms (default: provider default, 120s builtin; ${MIN_CHAT_TIMEOUT_MS}..${MAX_CHAT_TIMEOUT_MS})`);
  console.log("  --yolo               bypass ask (never the denylist), logged + bannered (default: off)");
  console.log("  --retry-wait         one Retry-After wait (<=60s) on 429 per run (default: off; avoid in CI)");
  console.log("  --failover           one switch to the next provider with a stored key on rate-limit/timeout per run (default: off; may bill pay-go)");
  console.log("  --free               arm the free-provider chain: hop provider on rate-limit/timeout, each free hop once per run, never bills pay-go (see: codewhip free; not with --failover)");
  console.log("  --plan               read-only run: edit/write/bash/delegate denied for the whole run (even with --yolo); the output is the plan");
  console.log("  --share              write a redacted share bundle (.codewhip/share-<runId>.json) after the run");
  console.log("  --no-stream          disable SSE streaming (whole-body responses; a provider that rejects streaming falls back on its own)");
  console.log("  -v, --version        print version");
}

function printKeysHelp(): void {
  // Key help derives from the registry (builtins + customs) — adding a
  // provider stays one table row, never a help-text edit. Consoles show
  // bare domains (the registry holds full URLs for error messages).
  const cfgs = listAllProviderConfigs();
  console.log(`Keys: env wins when set (${cfgs.map((c) => c.envVar).join("/")}); else \`codewhip auth login <provider>\`.`);
  console.log(`  key consoles: ${cfgs.map((c) => c.keyUrl.replace(/^https:\/\//, "")).filter((u) => u.length > 0).join(" · ")}`);
  console.log("  keyless: kilo/opencode/empero/llm7 run with no key (anonymous, rate-limited — see: codewhip free). Custom OpenAI-compatible endpoints: `codewhip provider add <id> --base-url https://… --model <id> --env-var FOO_API_KEY --key-url https://…`.");
}

/** One-command topics for `codewhip help <command>` / `codewhip <command> --help`. Returns false for unknown topics. */
function printCommandHelp(topic: string): boolean {
  switch (topic) {
    case "init":
      console.log('codewhip init — scaffold AGENTS.md + codewhip-policy.yaml + .codewhip/key (ed25519, local only).');
      console.log("  Existing files are kept, never overwritten.");
      console.log("  Next: codewhip demo --deny (offline, $0) — then: codewhip auth login nvidia");
      return true;
    case "run":
      console.log('codewhip run "<prompt>" [options] — run an agent session (headless; no prompt on a TTY = REPL).');
      printRunOptions();
      console.log("  No key yet? codewhip demo --deny (offline, $0) — or --provider llm7 (keyless, rate-limited).");
      printKeysHelp();
      return true;
    case "auth":
      console.log("codewhip auth login <provider>   — store a key (hidden prompt, 0600 file; env still wins)");
      console.log("codewhip auth logout <provider>  — forget the stored key");
      console.log("codewhip auth status [provider]  — set/missing per provider (keys are never printed)");
      printKeysHelp();
      return true;
    case "models":
      console.log("codewhip models [provider] — list served models with agency tags (default: nvidia).");
      console.log("  Needs the provider key (see: codewhip help auth) — except llm7, which is anonymous.");
      return true;
    case "provider":
      console.log("codewhip provider list            — known providers (builtin + custom)");
      console.log(`codewhip ${PROVIDER_ADD_USAGE}`);
      console.log("codewhip provider remove <id>     — forget a custom provider (builtins stay)");
      console.log("codewhip provider show <id>       — base URLs, default model, env var, key console");
      return true;
    case "free":
      console.log("codewhip free — list the free-provider chain (read-only: no key, no network).");
      console.log('  Keyless rows first. Arm the chain on a run: codewhip run "<prompt>" --free.');
      return true;
    case "audit":
      console.log("codewhip audit [--verify|--last <n>|--replay <runId>|--export <file>] — inspect the hash-chained log.");
      console.log("  --verify proves the chain (needs .codewhip/key); hashes cover redacted content only.");
      return true;
    case "metrics":
      console.log("codewhip metrics — aggregate outcomes into the H1 bars (blocks/100, $/task, memory/week).");
      console.log("  Reads .codewhip/outcomes.jsonl + verdicts.jsonl; honest about unmeasurable bars.");
      return true;
    case "stats":
      console.log("codewhip stats [provider-filter] — per-provider/model request health from provider-analytics.jsonl.");
      console.log("  Records every chat + models call (ok / auth / quota / timeout / network / bad_model / other).");
      console.log("  Flags providers/models below 80% success so you can avoid failing ones. Append a provider id to filter.");
      return true;
    case "trust":
      console.log("codewhip trust [--json] [--verbose] — print a single trust certificate (chain intact, violations blocked, polish gate, memory accruing, keys ready, policy active).");
      console.log("  --json     machine-readable output for CI/automation");
      console.log("  --verbose  show missing keys list (default: hidden)");
      console.log("  One command for a team lead to hand to an intern at 2am: does this repo pass the trust test?");
      return true;
    case "agents":
      console.log("codewhip agents — list the delegable read-only subagents (built-ins + .codewhip/agents/*.md) with validation errors surfaced.");
      console.log("  Custom agent file: .codewhip/agents/<name>.md — frontmatter description (required), model, max_steps; body = system prompt.");
      return true;
    case "verdict":
      console.log("codewhip verdict <runId-prefix> <accepted|edited|reverted|rejected> — record human judgment (prefix ok, >=4 chars).");
      console.log("  Every run prints its runId; verdicts feed codewhip metrics (task-success bar).");
      return true;
    case "demo":
      console.log("codewhip demo --deny — offline wedge demo: five disasters refused on the $0 fake port (no key needed).");
      console.log("  Writes to the local audit log like a real run; start here before fetching keys.");
      return true;
    case "policy":
      console.log("codewhip policy candidates        — tools declined 3+ times with the same shape (promotion-ready)");
      console.log('codewhip policy approve "<tool:shape>" — promote a candidate into a standing deny');
      console.log("codewhip policy list              — standing denies");
      return true;
    case "pack":
      console.log("codewhip pack list                — policy packs shipped locally (no registry in H1)");
      console.log("codewhip pack pull <name> [--force] — install a pack (enforced from the next run)");
      return true;
    case "rollback":
      console.log("codewhip rollback <runId-prefix> — undo a run: restore every file it edited/wrote to its pre-run content (files the run created are removed).");
      console.log("codewhip rollback --list         — runs with checkpoints (newest first).");
      console.log("  Every edit/write is snapshotted automatically (sha256-verified before the restore touches anything).");
      return true;
    default:
      return false;
  }
}

function printHelpTopicError(topic: string): void {
  console.error(`help: no topic "${topic}" (topics: init run auth agents models free provider rollback audit metrics stats trust verdict demo policy pack)`);
  process.exitCode = 1;
}

function printHelp(): void {
  console.log("codewhip - crack through code like a whip");
  console.log("");
  console.log("Usage:");
  console.log("  codewhip <command> [options]");
  console.log("");
  console.log("Commands:");
  console.log("  init                 scaffold AGENTS.md + policy + local key (30s)");
  console.log('  run "<prompt>"       run an agent session (headless; no prompt = REPL)');
  console.log("  auth                 store provider keys (login/logout/status [provider])");
  console.log("  models [provider]    list served models with agency tags (default: nvidia)");
  console.log("  provider             register OpenAI-compatible providers (list/add <id>/remove <id>/show <id>)");
  console.log("  free                 list the free-provider chain (keyless rows first, limits, key consoles)");
  console.log("  rollback <run>       undo a run: restore files it edited/wrote (or --list runs)");
  console.log("  audit                inspect the hash-chained audit log (--verify/--last/--replay/--export)");
  console.log("  metrics              aggregate outcomes into the H1 bars (blocks/100, $/task, memory/week)");
  console.log("  stats [provider]     per-provider/model request health (ok/auth/quota/timeout/network/bad_model/other)");
  console.log("  agents               list delegable read-only subagents (built-ins + .codewhip/agents/)");
  console.log("  trust                print a single trust certificate (chain, violations, polish, memory, keys, policy)");
  console.log("  verdict <run> <v>    record human judgment: accepted|edited|reverted|rejected (prefix ok)");
  console.log("  demo --deny          offline wedge demo: five disasters refused on the $0 fake port");
  console.log("  policy               promote repeated declines into denies (candidates/approve/list)");
  console.log("  pack                 team policy packs shipped locally (list/pull <name> [--force])");
  console.log("  help [command]       show this help (or one command's: codewhip help run)");
  console.log("");
  printRunOptions();
  console.log("");
  printKeysHelp();
  console.log("Receipts: every run prints `tokens / provider:model / cost` (nvidia + the free chain = $0; other providers print cost untracked).");
  console.log(`Model: agentLoop() live (read/search/edit/write/bash/webfetch + read-only subagents) — policy-checked, metered.`);
}

function costNote(provider: string, model?: string): string {
  // Honest meter: only known-$0 routes print $0 — nvidia's free tier and
  // the free-chain providers verified 2026-09-11 (kilo/openrouter/opencode
  // are $0 only on their free-suffixed models; empero's endpoint is openly
  // free but logs prompts). Everything else bills or caps in provider-
  // specific ways — point at their console, not fiction.
  if (provider === "nvidia" || provider === "groq" || provider === "cerebras" || provider === "gemini" || provider === "zai") {
    return `$0.0000 (${provider} free tier)`;
  }
  if (provider === "empero") {
    return "$0.0000 (empero free endpoint)";
  }
  const m = model ?? "";
  if (provider === "kilo" || provider === "openrouter") {
    if (m.endsWith(":free")) {
      return "$0.0000 (:free model)";
    }
  } else if (provider === "opencode" && m.endsWith("-free")) {
    return "$0.0000 (free model)";
  }
  const keyUrl = getProviderConfig(provider)?.keyUrl;
  return keyUrl !== undefined && keyUrl.length > 0
    ? `cost untracked (see ${keyUrl})`
    : "cost untracked (see provider console)";
}

function printReceipt(model: string, promptTokens: number, completionTokens: number, cost: string): void {
  console.log("");
  console.log(
    `receipt: ${promptTokens} prompt + ${completionTokens} completion tokens / ${model} / ${cost}`
  );
}

function mixReceiptString(buckets: UsageBucket[], provider: ProviderId, model: string): string {
  const list = buckets.length > 0
    ? buckets
    : [{ label: provider, model, prompt: 0, completion: 0 }];
  let p = 0;
  let c = 0;
  const parts: string[] = [];
  const costs: string[] = [];
  for (const b of list) {
    p += b.prompt;
    c += b.completion;
    // "est." is the honest marker for streams that ended without a usage
    // block — never present a chars/4 estimate as a meter reading.
    const est = b.estimated === true ? "est. " : "";
    parts.push(`${b.label}:${b.model} ${est}${b.prompt}+${b.completion}`);
    costs.push(costNote(b.label, b.model));
  }
  return `receipt: ${p} prompt + ${c} completion tokens / ${parts.join(" + ")} / ${costs.join(" + ")}`;
}

function printMixReceipt(buckets: UsageBucket[], provider: ProviderId, model: string): void {
  console.log("");
  console.log(mixReceiptString(buckets, provider, model));
}

function printStubReceipt(model: string, provider: ProviderId): void {
  printReceipt(model, 0, 0, costNote(provider, model));
}

function parseRunArgs(args: string[]): RunOptions | null {
  let model = PROVIDERS.nvidia.defaultModel;
  let modelExplicit = false;
  let modelsArg: string[] | null = null;
  let provider: ProviderId = "nvidia";
  let providerExplicit = false;
  let taskClass: TaskClass | undefined;
  let tokenBudget = 250000;
  let maxSteps = 25;
  let timeoutMs: number | undefined;
  let yolo = false;
  let retryWait = false;
  let failover = false;
  let free = false;
  let plan = false;
  let share = false;
  let noStream = false;
  const positional: string[] = [];

  const fail = (msg: string): null => {
    console.error(`run: ${msg} (see: codewhip help run)`);
    process.exitCode = 1;
    return null;
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--model") {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("-")) return fail("--model needs a value");
      if (modelsArg !== null) return fail("use --model or --models, not both");
      model = args[++i] as string;
      modelExplicit = true;
    } else if (a === "--models") {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("-")) return fail("--models needs a comma-separated value");
      const list = [...new Set(v.split(",").map((s) => s.trim()).filter((s) => s.length > 0))];
      if (list.length === 0) return fail("--models needs at least one model id");
      if (list.length > 8) return fail("--models accepts at most 8 models");
      if (modelExplicit) return fail("use --model or --models, not both");
      modelsArg = list;
      i++;
    } else if (a === "--provider") {
      const v = args[i + 1];
      const cfg = v === undefined ? null : getProviderConfig(v);
      if (cfg === null) return fail(`unknown provider "${v ?? ""}" (see: codewhip provider list)`);
      provider = cfg.id;
      providerExplicit = true;
      i++;
      if (!modelExplicit) {
        model = cfg.defaultModel;
      }
    } else if (a === "--class") {
      const v = args[i + 1];
      if (v !== "implement" && v !== "polish" && v !== "private") {
        return fail("--class must be implement|polish|private");
      }
      taskClass = v;
      i++;
    } else if (a === "--token-budget") {
      const v = args[i + 1];
      if (v === undefined) return fail("--token-budget needs a value");
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1000 || n > 5000000) {
        return fail("--token-budget must be an integer 1000..5000000");
      }
      tokenBudget = n;
    } else if (a === "--max-steps") {
      const v = args[i + 1];
      if (v === undefined) return fail("--max-steps needs a value");
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 100) return fail("--max-steps must be an integer 1..100");
      maxSteps = n;
    } else if (a === "--timeout-ms") {
      const v = args[i + 1];
      if (v === undefined) return fail("--timeout-ms needs a value in ms");
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < MIN_CHAT_TIMEOUT_MS || n > MAX_CHAT_TIMEOUT_MS) return fail(`--timeout-ms must be an integer ${MIN_CHAT_TIMEOUT_MS}..${MAX_CHAT_TIMEOUT_MS}`);
      timeoutMs = n;
    } else if (a === "--yolo") {
      yolo = true;
    } else if (a === "--retry-wait") {
      retryWait = true;
    } else if (a === "--failover") {
      if (free) return fail("use --free or --failover, not both");
      failover = true;
    } else if (a === "--free") {
      if (failover) return fail("use --free or --failover, not both");
      free = true;
    } else if (a === "--plan") {
      plan = true;
    } else if (a === "--no-stream") {
      noStream = true;
    } else if (a === "--share") {
      share = true;
    } else if (!a.startsWith("-")) {
      positional.push(a);
    } else {
      return fail(`unknown flag: ${a}`);
    }
  }
  return {
    prompt: positional.join(" "),
    model: modelsArg?.[0] ?? model,
    models: modelsArg ?? [],
    provider, providerExplicit, tokenBudget, maxSteps, yolo, retryWait, failover, free, plan, share,
    taskClass, timeoutMs, noStream,
    modelExplicit: modelExplicit || modelsArg !== null,
  };
}

function cmdInit(): void {
  const cwd = process.cwd();
  const codewhipDir = path.join(cwd, ".codewhip");
  const policyPath = path.join(cwd, "codewhip-policy.yaml");
  const agentsPath = path.join(cwd, "AGENTS.md");
  const privKey = path.join(codewhipDir, "key");
  const pubKey = path.join(codewhipDir, "key.pub");

  if (!fs.existsSync(codewhipDir)) {
    fs.mkdirSync(codewhipDir, { recursive: true });
  }
  if (!fs.existsSync(policyPath)) {
    fs.writeFileSync(
      policyPath,
      [
        "# CodeWhip policy (v1 preview) — LAST-match-wins, fail-closed",
        "defaults:",
        "  read: allow",
        "  edit: ask",
        "  shell: ask",
        "  external: deny",
        "deny:",
        '  - "rm -rf /"',
        '  - "git push --force"',
        '  - "curl .*\\.env"',
        "",
      ].join("\n"),
      "utf8"
    );
    console.log("wrote codewhip-policy.yaml");
  } else {
    console.log("kept codewhip-policy.yaml (exists)");
  }
  if (!fs.existsSync(agentsPath)) {
    fs.writeFileSync(
      agentsPath,
      "# AGENTS.md\n\n- read-mostly, ask-before-destructive, never-exfiltrate.\n",
      "utf8"
    );
    console.log("wrote AGENTS.md");
  } else {
    console.log("kept AGENTS.md (exists)");
  }
  if (!fs.existsSync(privKey) || !fs.existsSync(pubKey)) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    fs.writeFileSync(privKey, privateKey.export({ type: "pkcs8", format: "pem" }), {
      mode: 0o600,
    });
    fs.writeFileSync(pubKey, publicKey.export({ type: "spki", format: "pem" }), "utf8");
    console.log("generated .codewhip/key (ed25519, local only)");
  } else {
    console.log("kept .codewhip/key (exists)");
  }
  console.log('done. next: codewhip demo --deny (offline, $0) — then: codewhip auth login nvidia');
}

function missingKeyHelp(provider: string): void {
  const cfg = getProviderConfig(provider);
  const envVar = cfg?.envVar ?? `${provider.toUpperCase()}_API_KEY`;
  const keyUrl = cfg?.keyUrl ?? "the provider console";
  console.error(`codewhip: ${envVar} is not set and no stored ${provider} key found (the key is never printed or logged).`);
  console.error(`  Persist once: codewhip auth login ${provider}   (hidden prompt, 0600 file; env still wins)`);
  console.error(`  Or per terminal, PowerShell: $env:${envVar} = "..."`);
  console.error(`  Get a key at ${keyUrl}`);
  console.error(`  No key yet? Try the offline wedge demo (no key, $0): codewhip demo --deny`);
  console.error(`  Or run keyless now: codewhip run "<prompt>" --provider llm7 (anonymous, rate-limited)`);
  process.exitCode = 1;
}

/**
 * Pre-loop refusals (private-without-consent, missing key) leave a
 * content-free deny trail: prompt_hash + error hash only, zero prompt
 * content — audit-senior holds even when the loop never starts.
 */
function logPreLoopDeny(cwd: string, prompt: string, model: string, policy: string, error: string): void {
  try {
    const runId = newRunId();
    const ph = promptHash(prompt);
    const rh = sha256Hex(error);
    appendOutcome(cwd, {
      v: 1,
      ts: new Date().toISOString(),
      runId,
      model,
      prompt_hash: ph,
      yolo: false,
      tool_calls: [],
      usage: { prompt: 0, completion: 0 },
      result_preview_redacted: "",
      verdict: null,
    });
    appendEntry(cwd, { runId, actor: "policy", tool: "run", args_hash: ph, result_hash: rh, policy: `deny:${policy}` });
  } catch { /* trail best-effort, never blocks the refusal */ }
}

function promptApproval(question: string): Promise<ApprovalAnswer> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer: string) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === "a" || a === "always") resolve("always");
      else if (a === "y" || a === "yes") resolve("yes");
      else resolve("no");
    });
  });
}

async function cmdRun(opts: RunOptions): Promise<void> {
  // --free arms the free chain: head = the explicit --provider (must be a
  // free-catalog id) or the first free candidate with a usable key (env,
  // stored file, or the row's anonymousKey — kilo/opencode/empero/llm7 are
  // keyless). Chain = the remaining keyed candidates, catalog order.
  let freeChain: FailoverTarget[] = [];
  if (opts.free) {
    const candidates = freeChainIds();
    const head = opts.providerExplicit ? opts.provider : candidates.find((id) => resolveKey(id).key.length > 0);
    if (head === undefined || !candidates.some((c) => c === head)) {
      console.error(
        opts.providerExplicit
          ? `codewhip: --free runs the free chain only — "${opts.provider}" is not in it (see: codewhip free)`
          : "codewhip: --free found no runnable free provider (no keys set and no keyless candidate) — see: codewhip free"
      );
      process.exitCode = 1;
      printStubReceipt(opts.model, opts.provider);
      return;
    }
    const headModel = opts.modelExplicit ? opts.model : getProviderConfig(head)?.defaultModel ?? opts.model;
    freeChain = candidates
      .filter((id) => id !== head && resolveKey(id).key.length > 0)
      .flatMap((id) => {
        const cfg = getProviderConfig(id);
        return cfg === null ? [] : [{ label: cfg.id, model: cfg.defaultModel, port: makePortForConfig(cfg, resolveKey(id).key) }];
      });
    opts = { ...opts, provider: head, model: headModel };
  }
  const routed = resolveRoute({
    prompt: opts.prompt,
    taskClass: opts.taskClass,
    provider: opts.providerExplicit || opts.free ? opts.provider : undefined,
    model: opts.modelExplicit || opts.free ? opts.model : undefined,
    defaultProvider: "nvidia",
    defaultModel: PROVIDERS.nvidia.defaultModel,
  });
  if ("error" in routed) {
    console.error(`codewhip: ${routed.error}`);
    process.exitCode = 1;
    logPreLoopDeny(process.cwd(), opts.prompt, opts.model, "route:private-without-consent", routed.error);
    printStubReceipt(opts.model, opts.provider);
    return;
  }
  const route = opts.free && !opts.providerExplicit
    ? { ...routed, note: "--free chain head (first free candidate with a usable key)" }
    : routed;
  opts = { ...opts, provider: route.provider, model: route.model };
  console.log(`route: ${route.taskClass} → ${route.provider}:${route.model} (${route.auto ? "auto" : "manual"}: ${route.note})`);
  if (opts.plan) {
    console.log("!! --plan armed: read-only run — edit/write/bash/delegate denied for the whole run (even with --yolo); the output is the plan.");
  }
  if (opts.noStream) {
    setStreamingEnabled(false);
    console.log("!! --no-stream armed: whole-body responses (SSE off for this process).");
  }
  if (opts.yolo) {
    console.log("!! --yolo is explicit, logged, bannered. Denylist still applies — never bypassed.");
  }
  if (opts.retryWait) {
    console.log("!! --retry-wait armed: one wait up to 60s on 429. Avoid in CI.");
  }
  console.log(`model: ${opts.provider}:${opts.model}`);
  if (opts.models.length > 1) {
    console.log(`!! rotation armed: on rate-limit/timeout walk ${opts.models.join(" -> ")} (each once per run)`);
  }
  const runCfg = getProviderConfig(opts.provider);
  if (runCfg === null) {
    console.error(`codewhip: unknown provider "${opts.provider}" (see: codewhip provider list)`);
    process.exitCode = 1;
    printStubReceipt(opts.model, opts.provider);
    return;
  }
  if (opts.timeoutMs !== undefined) {
    console.log(`!! --timeout-ms armed: provider calls abort after ${opts.timeoutMs}ms (provider default ${runCfg.timeoutMs}ms overridden)`);
  }
  const { key: apiKey, source: keySource } = resolveKey(opts.provider);
  if (apiKey.length === 0) {
    missingKeyHelp(opts.provider);
    logPreLoopDeny(process.cwd(), opts.prompt, opts.model, "route:missing-key", `missing ${opts.provider} key`);
    printStubReceipt(opts.model, opts.provider);
    return;
  }
  if (keySource === "anonymous") {
    console.log(`auth: ${opts.provider} anonymous (no key stored, rate-limited) — codewhip auth login ${opts.provider} for higher limits (${runCfg.keyUrl})`);
  }
  let failoverTargets: FailoverTarget[] = [];
  if (opts.free) {
    failoverTargets = freeChain;
    if (failoverTargets.length > 0) {
      console.log(`!! --free armed: on rate-limit/timeout walk ${failoverTargets.map((t) => `${t.label}:${t.model}`).join(" -> ")} (free chain: never bills pay-go)`);
    } else {
      console.log("!! --free armed: head only — no other free provider has a key yet (see: codewhip free) (free chain: never bills pay-go)");
    }
  } else if (opts.failover) {
    const defaultModel = runCfg.defaultModel;
    if (opts.model !== defaultModel) {
      console.error("codewhip: --failover needs the default model first (drop --model/--models, or lead the chain with it)");
      process.exitCode = 1;
      printStubReceipt(opts.model, opts.provider);
      return;
    }
    const next = listAllProviderConfigs().map((c) => c.id).find((id) => id !== opts.provider && resolveKey(id).key.length > 0);
    if (next === undefined) {
      console.error("codewhip: --failover needs a key for some other provider (env var or: codewhip auth login <other>)");
      process.exitCode = 1;
      printStubReceipt(opts.model, opts.provider);
      return;
    }
    const nextCfg = getProviderConfig(next);
    if (nextCfg === null) {
      console.error(`codewhip: failover target "${next}" is no longer registered`);
      process.exitCode = 1;
      printStubReceipt(opts.model, opts.provider);
      return;
    }
    const targetModel = nextCfg.defaultModel;
    console.log(`!! --failover armed: one switch to ${next}:${targetModel} on rate-limit/timeout. May bill ${next} pay-go.`);
    failoverTargets = [{
      label: next,
      model: targetModel,
      port: makePortForConfig(nextCfg, resolveKey(next).key),
    }];
  }
  const ctrl = new AbortController();
  const onSigint = (): void => {
    ctrl.abort();
  };
  process.on("SIGINT", onSigint);
  try {
    const result = await agentLoop({
      prompt: opts.prompt,
      model: opts.model,
      label: opts.provider,
      cwd: process.cwd(),
      maxSteps: opts.maxSteps,
      yolo: opts.yolo,
      stdinIsTTY: process.stdin.isTTY === true,
      port: makePortForConfig(runCfg, apiKey, opts.timeoutMs),
      signal: ctrl.signal,
      askUser: promptApproval,
      remembered: listRules(process.cwd()),
      planMode: opts.plan,
      retryWait: opts.retryWait,
      failovers: failoverTargets,
      models: opts.models,
      tokenBudget: opts.tokenBudget,
      onEvent: (e) => console.log(`${e.kind === "tool" ? "▸" : e.kind === "policy" ? "◈" : "◆"} ${e.text}`),
    });
    if (result.cancelled) {
      console.log("cancelled — partial transcript kept.");
    }
    if (result.error !== undefined) {
      console.error(`codewhip: ${result.error}`);
      process.exitCode = 1;
    } else if (result.text.length > 0) {
      console.log("");
      console.log(result.text);
    }
    printMixReceipt(result.usageByModel, opts.provider, opts.model);
    if (result.checkpoints > 0) {
      console.log(`checkpoints: ${result.checkpoints} file(s) snapshotted — undo: codewhip rollback ${result.runId.slice(0, 8)}`);
    }
    if (result.compact.events > 0) {
      console.log(`compacted: ${result.compact.truncated} old tool output(s) truncated, ${result.compact.dropped} exchange(s) elided across ${result.compact.events} compaction(s) — transcript kept under the context ceiling`);
    }
    if (result.repeatCalls > 0) {
      console.log(`repeats: ${result.repeatCalls} identical idempotent tool call(s) served from the run memo instead of re-executing — a weak model wasting steps, not a harness fault`);
    }
    console.log(`runId: ${result.runId} — record judgment: codewhip verdict ${result.runId.slice(0, 8)} <accepted|edited|reverted|rejected>`);
    // Inline provider-health hint — only when this provider has recorded failures,
    // so healthy runs stay quiet. Full breakdown: codewhip stats <provider>.
    const healthRecs = readProviderCalls().filter((r) => r.provider === opts.provider);
    if (healthRecs.length > 0) {
      const ph = summarizeCalls(healthRecs).providers[0];
      if (ph !== undefined && ph.failed > 0) {
        console.log(`health: ${opts.provider} ${Math.round(ph.successRate * 100)}% ok over ${ph.total} call(s), ${ph.failed} failed — detail: codewhip stats ${opts.provider}`);
      }
    }
    if (route.taskClass === "polish") {
      const gate = polishGate(estimateCost(opts.provider, opts.model, result.promptTokens, result.completionTokens));
      console.log(`polish gate: ${gate.pass ? "PASS" : "OPEN"} — ${gate.reason}`);
    }
    if (opts.share) {
      const receipt = mixReceiptString(result.usageByModel, opts.provider, opts.model);
      const shared = writeShareBundle(process.cwd(), {
        runId: result.runId,
        model: `${opts.provider}:${opts.model}`,
        prompt: opts.prompt,
        resultText: result.text,
        error: result.error,
        trace: result.trace,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        usageByModel: result.usageByModel,
        receipt,
      });
      if ("error" in shared) {
        console.error(`codewhip: ${shared.error}`);
        process.exitCode = 1;
      } else {
        console.log(`share: ${shared.path} (sha256:${shared.hash.slice(0, 16)}…)`);
      }
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

function cmdRepl(defaults: Omit<RunOptions, "prompt">): void {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("codewhip repl (preview) — type a prompt, .exit to quit.");
  rl.setPrompt("codewhip> ");
  rl.prompt();
  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (trimmed === ".exit" || trimmed === ".quit") {
      rl.close();
      return;
    }
    if (trimmed.length > 0) {
      void cmdRun({ ...defaults, prompt: trimmed }).finally(() => rl.prompt());
      return;
    }
    rl.prompt();
  });
  rl.on("close", () => {
    printStubReceipt(defaults.model, defaults.provider);
  });
}

async function cmdAuth(args: string[]): Promise<void> {
  const sub = args[0] ?? "status";
  if (sub === "login" || sub === "logout") {
    const provider = args[1] ?? "nvidia";
    const cfg = getProviderConfig(provider);
    if (cfg === null) {
      console.error(`unknown provider "${provider}" (see: codewhip provider list)`);
      process.exitCode = 1;
      return;
    }
    if (sub === "login") {
      const key = (await promptHidden(`Enter ${provider} API key: `)).trim();
      if (key.length === 0) {
        console.error("auth: cancelled (empty key, not saved)");
        process.exitCode = 1;
        return;
      }
      saveKey(provider, key);
      console.log(`auth: ${provider} saved (source: file, ${configDir()})`);
      return;
    }
    if (clearKey(provider)) {
      console.log(`auth: ${provider} removed (source was file)`);
    } else {
      console.log(`auth: ${provider} nothing stored`);
      process.exitCode = 1;
    }
    return;
  }
  if (sub === "status") {
    const all = listAllProviderConfigs();
    let missing = 0;
    for (const { id: provider } of all) {
      const { source } = resolveKey(provider);
      if (source === "none") {
        console.log(`auth: ${provider} missing (no env, no file)`);
        missing++;
      } else if (source === "anonymous") {
        console.log(`auth: ${provider} anonymous (no key stored, gateway default; login for higher limits)`);
      } else {
        console.log(`auth: ${provider} set (source: ${source})`);
      }
    }
    if (missing === all.length) {
      process.exitCode = 1;
    }
    return;
  }
  console.error("usage: codewhip auth [login|logout|status] [provider] (see: codewhip provider list)");
  process.exitCode = 1;
}

async function cmdModels(args: string[]): Promise<void> {
  const raw = args[0];
  const provider = raw === undefined ? "nvidia" : raw;
  if (getProviderConfig(provider) === null) {
    console.error(`unknown provider "${provider}" (see: codewhip provider list)`);
    process.exitCode = 1;
    return;
  }
  const { key: apiKey } = resolveKey(provider);
  if (apiKey.length === 0) {
    missingKeyHelp(provider);
    return;
  }
  const result = await listModels(provider, apiKey);
  if (!result.ok) {
    console.error(`codewhip: ${result.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${provider} models (${result.models.length} served):`);
  for (const m of result.models) {
    console.log(`  ${m.isDefault ? "*" : " "} ${m.id}  [${m.tag}]${m.note.length > 0 ? ` — ${m.note}` : ""}`);
  }
  console.log("legend: * = codewhip default. agent = ran the tool loop in testing;");
  console.log("  completion-only = serves but refuses file work; non-chat = embed/ocr/audio/moderation;");
  console.log("  untested = served, agency unknown (probe before chaining).");
  if (provider === "mistral") {
    console.log("chain: --models mistral-small-latest,mistral-medium-latest,ministral-14b-latest");
  }
}

/** Read-only free-catalog listing (no key, no network). Keyless rows first. */
function cmdFree(): void {
  const rows = listFreeProviders();
  const ordered = [...rows.filter((r) => r.keyNeeded === "no"), ...rows.filter((r) => r.keyNeeded === "free-key")];
  console.log(`free providers (${rows.length}, verified 2026-09-11, keyless first — arm on a run: codewhip run "<prompt>" --free):`);
  for (const r of ordered) {
    console.log(`  ${r.id.padEnd(11)} [${r.keyNeeded === "no" ? "keyless" : "free-key"}] ${r.freeOffer}`);
    if (r.keyNeeded === "no") {
      console.log(`    no key needed — optional: $env:${r.envVar} = "…" or: codewhip auth login ${r.id} · ${r.keyUrl}`);
    } else {
      console.log(`    key: $env:${r.envVar} = "…" or: codewhip auth login ${r.id} · ${r.keyUrl}`);
    }
    console.log(`    limits: ${r.limits}`);
  }
}

const PROVIDER_ADD_USAGE = 'usage: codewhip provider add <id> --base-url https://… --model <id> --env-var FOO_API_KEY [--chat-path /…] [--models-path /…] [--key-url https://…] [--brand <name>] [--timeout-ms 45000]';

function cmdProvider(args: string[]): void {
  const sub = args[0] ?? "list";
  if (sub === "list") {
    const all = listAllProviderConfigs();
    const nCustom = all.filter((c) => !isBuiltinProviderId(c.id)).length;
    console.log(`provider: ${all.length} known (${all.length - nCustom} builtin + ${nCustom} custom):`);
    for (const c of all) {
      const { source } = resolveKey(c.id);
      const tag = isBuiltinProviderId(c.id) ? "builtin" : "custom";
      const key = source === "none" ? "no key" : source;
      console.log(`  ${c.id} [${tag}] ${c.baseUrl} default=${c.defaultModel} env=${c.envVar} key=${key}`);
    }
    return;
  }
  if (sub === "show") {
    const id = args[1] ?? "";
    const cfg = getProviderConfig(id);
    if (cfg === null) {
      console.error(`unknown provider "${id}" (see: codewhip provider list)`);
      process.exitCode = 1;
      return;
    }
    console.log(`provider: ${cfg.id} [${isBuiltinProviderId(cfg.id) ? "builtin" : "custom"}]`);
    console.log(`  base: ${cfg.baseUrl}${cfg.chatPath} (models: ${cfg.baseUrl}${cfg.modelsPath})`);
    console.log(`  default model: ${cfg.defaultModel} · env: ${cfg.envVar} · key: ${cfg.keyUrl.length > 0 ? cfg.keyUrl : "(none)"}`);
    return;
  }
  if (sub === "add") {
    const id = args[1] ?? "";
    const rest = args.slice(2);
    const usage = PROVIDER_ADD_USAGE;
    if (id.length === 0) {
      console.error(usage);
      process.exitCode = 1;
      return;
    }
    const flag = (name: string): string | undefined => {
      const i = rest.indexOf(name);
      return i !== -1 ? rest[i + 1] : undefined;
    };
    for (const a of rest) {
      if (a.startsWith("--") && !["--base-url", "--model", "--env-var", "--brand", "--chat-path", "--models-path", "--key-url", "--timeout-ms", "--rate-hint"].includes(a)) {
        console.error(`provider: unknown flag ${a}`);
        console.error(usage);
        process.exitCode = 1;
        return;
      }
    }
    const timeoutRaw = flag("--timeout-ms");
    const timeoutMs = timeoutRaw === undefined ? undefined : Number(timeoutRaw);
    if (timeoutRaw !== undefined && (!Number.isInteger(timeoutMs) || (timeoutMs as number) < MIN_CHAT_TIMEOUT_MS || (timeoutMs as number) > MAX_CHAT_TIMEOUT_MS)) {
      console.error(`provider: --timeout-ms must be an integer ${MIN_CHAT_TIMEOUT_MS}..${MAX_CHAT_TIMEOUT_MS}`);
      process.exitCode = 1;
      return;
    }
    const baseUrl = flag("--base-url") ?? "";
    const model = flag("--model") ?? "";
    const envVar = flag("--env-var") ?? "";
    if (baseUrl.length === 0 || model.length === 0 || envVar.length === 0) {
      console.error("provider: --base-url, --model and --env-var are required");
      console.error(usage);
      process.exitCode = 1;
      return;
    }
    const result = addCustomProvider({
      id,
      baseUrl,
      defaultModel: model,
      envVar,
      brand: flag("--brand"),
      chatPath: flag("--chat-path"),
      modelsPath: flag("--models-path"),
      keyUrl: flag("--key-url"),
      timeoutMs,
      rateLimitedHint: flag("--rate-hint"),
    });
    if (!result.ok) {
      console.error(`provider: ${result.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`provider: added "${result.id}" (${baseUrl}, default ${model})`);
    console.log(`  next: set a key via $env:${envVar} = "…" or: codewhip auth login ${result.id}`);
    return;
  }
  if (sub === "remove") {
    const id = args[1] ?? "";
    if (id.length === 0) {
      console.error("usage: codewhip provider remove <id>");
      process.exitCode = 1;
      return;
    }
    const result = removeCustomProvider(id);
    if (!result.ok) {
      console.error(`provider: ${result.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`provider: removed "${id}" (stored key, if any, left in place — clear with: codewhip auth logout ${id})`);
    return;
  }
  console.log("Usage: codewhip provider [list|show <id>|add <id> --base-url …|remove <id>]");
}

function renderAuditEntry(e: AuditEntry): string {
  const sig = e.sig === null ? "unsigned" : "signed";
  return `#${e.seq} ${e.ts.slice(0, 19)}  ${e.tool.padEnd(8)} ${e.policy.padEnd(28)} actor=${e.actor.padEnd(10)} args=${e.args_hash.slice(0, 16)}… res=${e.result_hash.slice(0, 16)}… [${sig}]`;
}

function renderAuditTail(cwd: string, n: number): void {
  const { entries } = readAuditLog(cwd);
  if (entries.length === 0) {
    console.log("audit: no entries yet.");
    return;
  }
  console.log(`audit chain (hashes of redacted content, newest last — ${entries.length} total):`);
  for (const e of readLastAuditEntries(cwd, n)) {
    console.log(`  ${renderAuditEntry(e)}`);
  }
}

function cmdAudit(args: string[]): void {
  const cwd = process.cwd();
  const ap = auditPath(cwd);
  if (args.includes("--verify")) {
    if (!fs.existsSync(ap)) {
      console.log("audit: no chain yet (.codewhip/audit.log missing) — nothing to verify.");
      return;
    }
    const v = verifyChain(cwd);
    console.log(
      `audit: ${v.total} entries — hash chain ${v.valid ? "INTACT" : "BROKEN"} (${v.signed} signed / ${v.unsigned} unsigned, ${v.keyPresent ? "key present" : "no local key"})`
    );
    for (const p of v.problems) {
      console.log(`  ! ${p}`);
    }
    if (!v.valid) {
      process.exitCode = 1;
    }
    return;
  }
  const replayIdx = args.indexOf("--replay");
  if (replayIdx !== -1) {
    const n = Number(args[replayIdx + 1]);
    renderAuditTail(cwd, Number.isInteger(n) && n > 0 ? n : 20);
    return;
  }
  const exportIdx = args.indexOf("--export");
  if (exportIdx !== -1) {
    const explicit = args[exportIdx + 1];
    const outPath =
      explicit !== undefined && !explicit.startsWith("-")
        ? path.join(process.cwd(), explicit)
        : path.join(cwd, ".codewhip", "audit-export.json");
    const result = buildBundle(cwd);
    if ("error" in result) {
      console.error(`audit: ${result.error}`);
      process.exitCode = 1;
      return;
    }
    fs.writeFileSync(outPath, result.json + "\n", "utf8");
    console.log(
      `audit: exported ${result.bundle.entries.length} entries to ${outPath} (${result.bundle.bundle_sig === null ? "unsigned — run `codewhip init` to sign" : "signed bundle"})`
    );
    return;
  }
  const lastIdx = args.indexOf("--last");
  if (lastIdx !== -1) {
    const n = Number(args[lastIdx + 1]);
    if (!Number.isInteger(n) || n <= 0) {
      console.error("usage: codewhip audit --last N (positive integer)");
      process.exitCode = 1;
      return;
    }
    const raw = readLastAuditRaw(cwd, n);
    if (raw.length === 0) {
      console.log("audit: no entries yet.");
      return;
    }
    console.log(raw);
    return;
  }
  if (args.length === 0) {
    renderAuditTail(cwd, 20);
    return;
  }
  console.log("Usage: codewhip audit [--verify] [--last N] [--replay N] [--export [path]]");
}

function cmdPolicy(args: string[]): void {
  const cwd = process.cwd();
  const sub = args[0];
  if (sub === "list") {
    const denies = loadPromotedDenies(cwd);
    if (denies.length === 0) {
      console.log("policy: no promoted denies (policy.md missing or empty).");
      return;
    }
    console.log(`policy: ${denies.length} promoted denies (${policyMdPath(cwd)}):`);
    for (const d of denies) {
      console.log(`  deny ${d.tool}:${d.shape}  (line ${d.line})`);
    }
    return;
  }
  if (sub === "candidates") {
    const cands = declineCandidates(cwd);
    if (cands.length === 0) {
      console.log("policy: no promotion candidates (need 3+ declines of the same tool:shape).");
      return;
    }
    console.log(`policy: ${cands.length} candidate(s) — approve with: codewhip policy approve "<tool:shape>"`);
    for (const c of cands) {
      console.log(`  ${c.tool}:${c.shape}  (${c.count} declines)`);
    }
    return;
  }
  if (sub === "approve") {
    const raw = args[1] ?? "";
    const sep = raw.indexOf(":");
    const tool = raw.slice(0, sep);
    const shape = raw.slice(sep + 1);
    if (sep <= 0 || shape.length === 0 || /[\r\n]/.test(raw)) {
      console.error('usage: codewhip policy approve "<tool:shape>"  (e.g. "bash:npm publish *")');
      process.exitCode = 1;
      return;
    }
    if (tool !== "bash" && tool !== "edit" && tool !== "write" && tool !== "webfetch") {
      console.error(`policy: tool must be bash|edit|write|webfetch (got "${tool}")`);
      process.exitCode = 1;
      return;
    }
    // Zero-evidence approve is refused: the shape must be a live candidate
    // at full threshold (3+ declines across 2+ runs in 30d).
    const known = declineCandidates(cwd).find((c) => c.tool === tool && c.shape === shape);
    if (known === undefined) {
      console.error(`policy: "${tool}:${shape}" is not a candidate (needs 3+ declines across 2+ runs) — see: codewhip policy candidates`);
      process.exitCode = 1;
      return;
    }
    if (!appendPromotedDeny(cwd, tool, shape, known?.count ?? 0)) {
      console.error(`policy: "${tool}:${shape}" is already promoted (or the disk failed) — see policy list.`);
      process.exitCode = 1;
      return;
    }
    console.log(`policy: approved deny ${tool}:${shape} → ${policyMdPath(cwd)} (pre-flight from next run)`);
    return;
  }
  console.log("Usage: codewhip policy [candidates|approve \"<tool:shape>\"|list]");
}

function cmdPack(args: string[]): void {
  const packsDir = defaultPacksDir();
  const sub = args[0];
  if (sub === "list") {
    const packs = listPacks(packsDir);
    if (packs.length === 0) {
      console.log("pack: no packs shipped with this install.");
      return;
    }
    console.log(`pack: ${packs.length} pack(s) shipped locally (no registry in H1):`);
    for (const p of packs) {
      console.log(`  ${p.name} (v${p.version}) — ${p.description}`);
    }
    return;
  }
  if (sub === "pull") {
    const name = args[1] ?? "";
    const force = args.includes("--force");
    const result = pullPack(packsDir, process.cwd(), name, force);
    if ("error" in result) {
      console.error(`codewhip: ${result.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`pack: pulled "${name}" → ${result.path} (enforced from next run; see: codewhip policy list)`);
    return;
  }
  console.log("Usage: codewhip pack [list|pull <name> [--force]]");
}

function cmdVerdict(args: string[]): void {
  const cwd = process.cwd();
  const prefix = args[0] ?? "";
  const value = args[1] ?? "";
  if (prefix.length < 4) {
    console.error(`verdict: prefix "${prefix}" is too short (need >=4 chars of the runId; see: codewhip metrics)`);
    process.exitCode = 1;
    return;
  }
  if (!isVerdict(value)) {
    console.error(`verdict: "${value}" is not a judgment (want: accepted|edited|reverted|rejected)`);
    process.exitCode = 1;
    return;
  }
  const hits = resolveRunPrefix(cwd, prefix);
  if (hits.length === 0) {
    console.error(`verdict: no run starts with "${prefix}" (see: codewhip metrics, .codewhip/outcomes.jsonl)`);
    process.exitCode = 1;
    return;
  }
  if (hits.length > 1) {
    console.error(`verdict: ambiguous prefix "${prefix}" (${hits.length} runs) — use more chars`);
    process.exitCode = 1;
    return;
  }
  const runId = hits[0] as string;
  if (!setVerdict(cwd, runId, value)) {
    console.error("verdict: failed to write (disk write)");
    process.exitCode = 1;
    return;
  }
  console.log(`verdict: ${runId.slice(0, 8)} → ${value} (.codewhip/verdicts.jsonl)`);
}

/** Undo a run's file mutations from its automatic pre-edit/write checkpoints. */
function cmdRollback(args: string[]): void {
  const cwd = process.cwd();
  if (args.includes("--list") || args.length === 0) {
    const runs = listCheckpointRuns(cwd);
    if (runs.length === 0) {
      console.log("rollback: no runs have checkpoints yet (checkpoints land on every edit/write).");
      return;
    }
    console.log(`rollback: ${runs.length} run(s) with checkpoints (newest last):`);
    for (const r of runs) {
      console.log(`  ${r.runId.slice(0, 8)}  ${r.files} file(s)`);
    }
    return;
  }
  const prefix = args[0] ?? "";
  const resolved = resolveCheckpointRun(cwd, prefix);
  if (resolved === "ambiguous") {
    console.error(`rollback: ambiguous prefix "${prefix}" — use more chars (see: codewhip rollback --list)`);
    process.exitCode = 1;
    return;
  }
  if (resolved === null) {
    console.error(`rollback: no run with checkpoints starts with "${prefix}" (see: codewhip rollback --list)`);
    process.exitCode = 1;
    return;
  }
  const runId = resolved;
  const result = rollbackRun(cwd, runId);
  if (!result.ok) {
    console.error(`rollback: ${result.error}`);
    process.exitCode = 1;
    return;
  }
  for (const f of result.restored) {
    console.log(`restored: ${f}`);
  }
  for (const f of result.removed) {
    console.log(`removed: ${f} (created by the run)`);
  }
  console.log(`rollback: ${result.restored.length + result.removed.length} file(s) back to pre-run state (run ${runId.slice(0, 8)}) — verify with git diff`);
  // The undo itself lands on the hash-chained trail: attributable, replayable.
  appendEntry(cwd, {
    runId,
    actor: "human",
    tool: "rollback",
    args_hash: sha256Hex(prefix),
    result_hash: sha256Hex(result.restored.concat(result.removed).join("\n")),
    policy: "allow:rollback",
  });
}

function cmdStats(args: string[]): void {
  const summary = summarizeCalls(readProviderCalls());
  if (args.length > 0) {
    const filter = args[0].toLowerCase();
    summary.providers = summary.providers.filter(
      (p) => p.provider.toLowerCase() === filter || p.provider.toLowerCase().includes(filter),
    );
  }
  console.log(renderProviderHealth(summary));
}

/** Inspect the delegable subagent roster: built-ins + .codewhip/agents/*.md. */
function cmdAgents(): void {
  const cwd = process.cwd();
  const { agents, errors } = listAgentsWithErrors(cwd);
  if (errors.length > 0) {
    console.log(`agents: ${errors.length} file(s) SKIPPED (fix or remove — they never load):`);
    for (const e of errors) {
      console.log(`  ! ${e}`);
    }
    console.log("");
  }
  console.log(`agents: ${agents.length} delegable (read-only subagents; spawn via delegate / delegate_many):`);
  for (const a of agents) {
    const src = BUILTIN_AGENT_NAMES.has(a.name) ? "builtin" : "file";
    console.log(`  ${a.name.padEnd(12)} [${src}] max_steps=${a.maxSteps}${a.model !== undefined ? ` model=${a.model}` : ""}`);
    console.log(`    ${a.description}`);
  }
  console.log("custom: .codewhip/agents/<name>.md — frontmatter: description (required), model, max_steps (1..25); body = the subagent's system prompt. A file overrides a same-name builtin.");
}

function cmdTrust(args: string[]): void {
  const cwd = process.cwd();
  const jsonOutput = args.includes("--json");
  const verbose = args.includes("--verbose");
  const lines: string[] = ["codewhip trust — single-command trust certificate"];
  const issues: string[] = [];

  // 1. Audit chain — fresh init generates key after demo entries, which is correct.
  // Treat "unsigned while key exists" for pre-key entries as expected, not broken.
  const v = verifyChain(cwd);
  let chainStatus = v.valid ? "INTACT" : "BROKEN";
  let chainClean = v.valid;
  if (!v.valid) {
    // Check if the only problems are pre-key entries being unsigned
    const preKeyProblems = v.problems.filter((p) =>
      p.includes("entry unsigned while a key exists")
    );
    if (preKeyProblems.length === v.problems.length && v.keyPresent) {
      // All problems are just the expected pre-key state
      chainStatus = "INTACT (pre-key entries unsigned as expected)";
      chainClean = true;
    }
  }
  lines.push(`  audit chain: ${chainStatus} (${v.total} entries, ${v.signed} signed, ${v.unsigned} unsigned${v.keyPresent ? ", key present" : ", no local key"})`);
  if (!chainClean) {
    for (const p of v.problems) {
      lines.push(`    ! ${p}`);
    }
    issues.push("audit");
  }

  // 2. Base policy (codewhip-policy.yaml) + promoted denies (policy.md)
  const basePolicyPath = path.join(cwd, "codewhip-policy.yaml");
  let baseDenies = 0;
  if (fs.existsSync(basePolicyPath)) {
    const raw = fs.readFileSync(basePolicyPath, "utf8");
    // YAML format: deny: followed by - "command" lines
    let inDenySection = false;
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (t === "deny:") {
        inDenySection = true;
        continue;
      }
      if (inDenySection && t.startsWith("- ") && t.includes('"')) {
        baseDenies++;
      }
      if (inDenySection && !t.startsWith("- ") && t.length > 0 && !t.startsWith("#")) {
        // Exit deny section on next top-level key
        inDenySection = false;
      }
    }
  }
  const promotedDenies = loadPromotedDenies(cwd);
  const hasPromotedDenies = promotedDenies.length > 0;
  lines.push(`  policy: ${baseDenies} base deny(es) + ${promotedDenies.length} promoted deny(es) active`);
  if (baseDenies === 0 && !hasPromotedDenies) {
    issues.push("policy");
  }

  // 3. Polish gate — evaluate from last polish run's actual cost
  const outcomes = readOutcomeRecords(cwd);
  const polishRuns = outcomes.filter((r) => {
    // Polished runs route to sensenova (cheapest inference)
    return r.model.includes("sensenova") || r.model.includes("flash") || r.model.includes("haiku");
  });
  let polishGateStatus = "no polish run recorded";
  let polishGatePassed = false;
  if (polishRuns.length > 0) {
    const lastPolish = polishRuns[polishRuns.length - 1];
    const cost = estimateCost(lastPolish.model.split(":")[0] as any, lastPolish.model.split(":")[1] ?? "", lastPolish.usage.prompt, lastPolish.usage.completion);
    const gate = polishGate(cost);
    polishGatePassed = gate.pass;
    polishGateStatus = gate.pass ? `PASS (${gate.reason})` : `OPEN (${gate.reason})`;
  }
  lines.push(`  polish gate: ${polishGateStatus}`);
  if (!polishGatePassed && polishRuns.length > 0) {
    issues.push("polish");
  }

  // 4. Memory accruing — at least 1 remembered rule for PASS
  const remembered = listRules(cwd);
  const hasMemory = remembered.length > 0;
  lines.push(`  memory: ${remembered.length} remembered rule(s) accruing`);
  if (!hasMemory) {
    issues.push("memory");
  }

  // 5. Keys — separate usable (env/file) from anonymous/rate-limited
  const allCfgs = listAllProviderConfigs();
  const usableKeys: string[] = [];
  const anonymousKeys: string[] = [];
  const missingKeys: string[] = [];
  for (const cfg of allCfgs) {
    const { source } = resolveKey(cfg.id);
    if (source === "env" || source === "file") {
      usableKeys.push(`${cfg.id} (${source})`);
    } else if (source === "anonymous") {
      anonymousKeys.push(`${cfg.id} (anonymous, rate-limited)`);
    } else {
      // Only mark as missing if it's a keyless-by-design provider
      if (cfg.anonymousKey === undefined) {
        missingKeys.push(cfg.id);
      } else {
        anonymousKeys.push(`${cfg.id} (anonymous, rate-limited)`);
      }
    }
  }
  lines.push(`  keys: ${usableKeys.length} usable (env/file), ${anonymousKeys.length} anonymous (rate-limited)${missingKeys.length > 0 ? `, ${missingKeys.length} missing` : ""}`);
  if (usableKeys.length > 0) {
    lines.push(`    usable: ${usableKeys.join(", ")}`);
  }
  if (anonymousKeys.length > 0) {
    lines.push(`    anonymous: ${anonymousKeys.join(", ")}`);
  }
  if (verbose && missingKeys.length > 0) {
    lines.push(`    missing: ${missingKeys.join(", ")} (set env or codewhip auth login)`);
  }

  // 6. Policy file check — show both files
  lines.push(`  codewhip-policy.yaml: ${baseDenies > 0 ? "active (has base denies)" : "empty or missing"}`);
  lines.push(`  policy.md: ${hasPromotedDenies ? `${promotedDenies.length} promoted deny(es)` : "no promoted denies"}`);

  // Summary — achievable PASS criteria
  const allGood = chainClean && baseDenies > 0 && hasMemory && usableKeys.length > 0;
  
  if (jsonOutput) {
    const output = {
      trust: allGood ? "PASS" : "NEEDS_WORK",
      auditChain: {
        status: chainClean ? "INTACT" : "BROKEN",
        total: v.total,
        signed: v.signed,
        unsigned: v.unsigned,
        keyPresent: v.keyPresent,
        problems: chainClean ? [] : v.problems,
      },
      policy: {
        baseDenies,
        promotedDenies: promotedDenies.length,
        codewhipPolicyYaml: baseDenies > 0,
        policyMd: hasPromotedDenies,
      },
      polishGate: {
        status: polishGatePassed ? "PASS" : (polishRuns.length > 0 ? "OPEN" : "UNEVALUATED"),
        detail: polishGateStatus,
        runsEvaluated: polishRuns.length,
      },
      memory: {
        rememberedRules: remembered.length,
        hasMemory,
      },
      keys: {
        usable: usableKeys.length,
        anonymous: anonymousKeys.length,
        missing: missingKeys.length,
        usableList: usableKeys,
        anonymousList: anonymousKeys,
        missingList: verbose ? missingKeys : [],
      },
      nextSteps: issues.length > 0 ? issues.map((i) => {
        switch (i) {
          case "audit": return "codewhip audit --verify";
          case "policy": return "codewhip init (creates base policy with 3 denies)";
          case "polish": return "codewhip run --class polish \"...\" (prove <$0.05)";
          case "memory": return "codewhip run ... (answer 'a' to remember a tool shape)";
          case "keys": return "codewhip auth login <provider> (or set env var)";
          default: return "";
        }
      }).filter(Boolean) : [],
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  lines.push("");
  lines.push(allGood ? "TRUST: PASS" : "TRUST: NEEDS WORK");
  if (!allGood) {
    const suggestions: string[] = [];
    if (!chainClean) suggestions.push("codewhip audit --verify");
    if (baseDenies === 0) suggestions.push("codewhip init (creates base policy with 3 denies)");
    if (!hasMemory) suggestions.push("codewhip run ... (answer 'a' to remember a tool shape)");
    if (usableKeys.length === 0) suggestions.push("codewhip auth login <provider> (or set env var)");
    if (polishRuns.length > 0 && !polishGatePassed) suggestions.push("codewhip run --class polish \"...\" (prove <$0.05)");
    if (suggestions.length > 0) {
      lines.push("  next: " + suggestions.join(" | "));
    }
  }

  console.log(lines.join("\n"));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";

  if (command === "--version" || command === "-v") {
    console.log(pkg.version);
    return;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    const topic = args[1] ?? "";
    if (topic.length === 0 || topic === "help") {
      printHelp();
      return;
    }
    if (printCommandHelp(topic)) return;
    printHelpTopicError(topic);
    return;
  }
  // `codewhip <command> --help` prints that command's topic. Help wins over
  // other flags (conventional); a prompt that is exactly --help/-h is the
  // accepted casualty — quote a longer prompt instead.
  const rest = args.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) {
    if (printCommandHelp(command)) return;
  }
  if (command === "init") {
    cmdInit();
    return;
  }
  if (command === "run") {
    const opts = parseRunArgs(args.slice(1));
    if (opts === null) {
      return;
    }
    if (opts.prompt.length === 0) {
      if (process.stdin.isTTY) {
        cmdRepl(opts);
        return;
      }
      console.error('usage: codewhip run "<prompt>" [--model id] [--token-budget 250000] [--max-steps 25] (see: codewhip help run)');
      process.exitCode = 1;
      return;
    }
    await cmdRun(opts);
    return;
  }
  if (command === "auth") {
    await cmdAuth(args.slice(1));
    return;
  }
  if (command === "audit") {
    cmdAudit(args.slice(1));
    return;
  }
  if (command === "metrics") {
    console.log(renderMetrics(summarizeCwd(process.cwd())));
    return;
  }
  if (command === "stats") {
    cmdStats(args.slice(1));
    return;
  }
  if (command === "trust") {
    cmdTrust(args.slice(1));
    return;
  }
  if (command === "agents") {
    cmdAgents();
    return;
  }
  if (command === "verdict") {
    cmdVerdict(args.slice(1));
    return;
  }
  if (command === "rollback") {
    cmdRollback(args.slice(1));
    return;
  }
  if (command === "demo") {
    if (args[1] !== "--deny") {
      console.error("usage: codewhip demo --deny  (offline, $0, no key needed)");
      process.exitCode = 1;
      return;
    }
    const { runDenyDemo } = await import("./demo.js");
    const r = await runDenyDemo(process.cwd());
    console.log(`demo: ${r.denied} denied / ${r.allowed} allowed (bar: ≥5 blocks in demo)`);
    console.log(`audit: chain ${r.auditValid ? "INTACT" : "BROKEN"} (see: codewhip audit --verify)`);
    console.log(r.receipt);
    console.log(`runId: ${r.runId}`);
    if (r.denied < 5 || r.allowed < 1 || !r.auditValid) process.exitCode = 1;
    return;
  }
  if (command === "policy") {
    cmdPolicy(args.slice(1));
    return;
  }
  if (command === "pack") {
    cmdPack(args.slice(1));
    return;
  }
  if (command === "models") {
    await cmdModels(args.slice(1));
    return;
  }
  if (command === "provider") {
    cmdProvider(args.slice(1));
    return;
  }
  if (command === "free") {
    cmdFree();
    return;
  }
  console.error(`unknown command: ${command}`);
  console.error('try: codewhip help');
  process.exitCode = 1;
}

void main();
