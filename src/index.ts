#!/usr/bin/env node
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { generateKeyPairSync } from "node:crypto";
import { makePort, parseProviderId, PROVIDERS, PROVIDER_IDS, type ProviderId } from "./provider.js";
import { listModels } from "./models.js";
import { agentLoop, type ApprovalAnswer, type FailoverTarget } from "./loop.js";
import { listRules } from "./remember-store.js";
import { readLastOutcomes, type UsageBucket } from "./outcomes.js";
import {
  clearKey,
  configDir,
  promptHidden,
  resolveKey,
  saveKey,
} from "./auth.js";

const require = createRequire(import.meta.url);
const pkg: { version: string } = require("../package.json");

type RunOptions = {
  prompt: string;
  model: string;
  /** Ordered rotation candidates, head === model. Empty = no rotation. */
  models: string[];
  provider: ProviderId;
  tokenBudget: number;
  maxSteps: number;
  yolo: boolean;
  retryWait: boolean;
  failover: boolean;
  modelExplicit: boolean;
};

function printHelp(): void {
  console.log("codewhip - crack through code like a whip");
  console.log("");
  console.log("Usage:");
  console.log("  codewhip <command> [options]");
  console.log("");
  console.log("Commands:");
  console.log("  init                 scaffold AGENTS.md + policy + local key (30s)");
  console.log('  run "<prompt>"       run an agent session (headless; no prompt = REPL)');
  console.log("  auth                 store provider keys (login/logout/status [nvidia|mistral|sensenova|alibaba])");
  console.log("  models [provider]    list served models with agency tags (nvidia|mistral|sensenova|alibaba, default: nvidia)");
  console.log("  audit                inspect the audit chain (--verify, --last N)");
  console.log("  help                 show this help");
  console.log("");
  console.log("Options (run):");
  console.log(`  --model <id>         model id (default depends on --provider)`);
  console.log(`  --models <a,b,c>     rotate models in order on 429, each once per run (default: off)`);
  console.log("  --provider <id>      nvidia|mistral|sensenova|alibaba (default: nvidia)");
  console.log("  --token-budget <n>   max prompt+completion tokens for the run; enforced mid-run, stops with partial transcript + receipt (default: 250000)");
  console.log("  --max-steps <n>      hard stop with partial result + cost (default: 25)");
  console.log("  --yolo               bypass ask (never the denylist), logged + bannered (default: off)");
  console.log("  --retry-wait         one Retry-After wait (<=60s) on 429 per run (default: off; avoid in CI)");
  console.log("  --failover           one switch to the next provider with a stored key on 429 per run (default: off; may bill pay-go)");
  console.log("  -v, --version        print version");
  console.log("");
  console.log("Keys: NVIDIA_API_KEY / MISTRAL_API_KEY / SENSENOVA_API_KEY / ALIBABA_API_KEY env wins when set; else `codewhip auth login <provider>`.");
  console.log("  key consoles: build.nvidia.com/settings/api-keys · console.mistral.ai · token.sensenova.ai · dashscope-intl.aliyun.com");
  console.log("Receipts: every run prints `tokens / provider:model / cost` (nvidia free tier = $0; mistral cost untracked).");
  console.log(`Model: agentLoop() live (read/search/edit/write/bash) — policy-checked, metered.`);
}

function costNote(provider: ProviderId): string {
  // Honest meter: only NVIDIA's free tier is known-$0. Other providers bill
  // or cap in provider-specific ways — point at their console, not fiction.
  return provider === "nvidia"
    ? "$0.0000 (nvidia free tier)"
    : `cost untracked (see ${PROVIDERS[provider].keyUrl})`;
}

function printReceipt(model: string, promptTokens: number, completionTokens: number, cost: string): void {
  console.log("");
  console.log(
    `receipt: ${promptTokens} prompt + ${completionTokens} completion tokens / ${model} / ${cost}`
  );
}

function printMixReceipt(buckets: UsageBucket[], provider: ProviderId, model: string): void {
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
    parts.push(`${b.label}:${b.model} ${b.prompt}+${b.completion}`);
    costs.push(costNote(b.label));
  }
  console.log("");
  console.log(`receipt: ${p} prompt + ${c} completion tokens / ${parts.join(" + ")} / ${costs.join(" + ")}`);
}

function printStubReceipt(model: string, provider: ProviderId): void {
  printReceipt(model, 0, 0, costNote(provider));
}

function parseRunArgs(args: string[]): RunOptions | null {
  let model = PROVIDERS.nvidia.defaultModel;
  let modelExplicit = false;
  let modelsArg: string[] | null = null;
  let provider: ProviderId = "nvidia";
  let tokenBudget = 250000;
  let maxSteps = 25;
  let yolo = false;
  let retryWait = false;
  let failover = false;
  const positional: string[] = [];

  const fail = (msg: string): null => {
    console.error(`run: ${msg}`);
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
      const parsed = parseProviderId(v);
      if (parsed === null) return fail("--provider must be nvidia|mistral|sensenova|alibaba");
      provider = parsed;
      i++;
      if (!modelExplicit) {
        model = PROVIDERS[provider].defaultModel;
      }
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
    } else if (a === "--yolo") {
      yolo = true;
    } else if (a === "--retry-wait") {
      retryWait = true;
    } else if (a === "--failover") {
      failover = true;
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
    provider, tokenBudget, maxSteps, yolo, retryWait, failover,
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
  console.log('done. try: codewhip run "fix the failing test"');
}

function missingKeyHelp(provider: ProviderId): void {
  const cfg = PROVIDERS[provider];
  console.error(`codewhip: ${cfg.envVar} is not set and no stored ${provider} key found (the key is never printed or logged).`);
  console.error(`  Persist once: codewhip auth login ${provider}   (hidden prompt, 0600 file; env still wins)`);
  console.error(`  Or per terminal, PowerShell: $env:${cfg.envVar} = "..."`);
  console.error(`  Get a key at ${cfg.keyUrl}`);
  process.exitCode = 1;
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
  if (opts.yolo) {
    console.log("!! --yolo is explicit, logged, bannered. Denylist still applies — never bypassed.");
  }
  if (opts.retryWait) {
    console.log("!! --retry-wait armed: one wait up to 60s on 429. Avoid in CI.");
  }
  console.log(`model: ${opts.provider}:${opts.model}`);
  if (opts.models.length > 1) {
    console.log(`!! rotation armed: on 429 walk ${opts.models.join(" -> ")} (each once per run, 429-only)`);
  }
  const { key: apiKey } = resolveKey(opts.provider);
  if (apiKey.length === 0) {
    missingKeyHelp(opts.provider);
    printStubReceipt(opts.model, opts.provider);
    return;
  }
  let failoverTarget: FailoverTarget | undefined;
  if (opts.failover) {
    const defaultModel = PROVIDERS[opts.provider].defaultModel;
    if (opts.model !== defaultModel) {
      console.error("codewhip: --failover needs the default model first (drop --model/--models, or lead the chain with it)");
      process.exitCode = 1;
      printStubReceipt(opts.model, opts.provider);
      return;
    }
    const next = PROVIDER_IDS.find((id) => id !== opts.provider && resolveKey(id).key.length > 0);
    if (next === undefined) {
      console.error("codewhip: --failover needs a key for some other provider (env var or: codewhip auth login <other>)");
      process.exitCode = 1;
      printStubReceipt(opts.model, opts.provider);
      return;
    }
    const targetModel = PROVIDERS[next].defaultModel;
    console.log(`!! --failover armed: one switch to ${next}:${targetModel} on 429. May bill ${next} pay-go.`);
    failoverTarget = {
      label: next,
      model: targetModel,
      port: makePort(next, resolveKey(next).key),
    };
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
      port: makePort(opts.provider, apiKey),
      signal: ctrl.signal,
      askUser: promptApproval,
      remembered: listRules(process.cwd()),
      retryWait: opts.retryWait,
      failover: failoverTarget,
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
    const provider = parseProviderId(args[1]) ?? "nvidia";
    if (args[1] !== undefined && parseProviderId(args[1]) === null) {
      console.error("usage: codewhip auth login|logout [nvidia|mistral|sensenova|alibaba]");
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
    let missing = 0;
    for (const provider of PROVIDER_IDS) {
      const { source } = resolveKey(provider);
      if (source === "none") {
        console.log(`auth: ${provider} missing (no env, no file)`);
        missing++;
      } else {
        console.log(`auth: ${provider} set (source: ${source})`);
      }
    }
    if (missing === 2) {
      process.exitCode = 1;
    }
    return;
  }
  console.error("usage: codewhip auth [login|logout|status] [nvidia|mistral|sensenova|alibaba]");
  process.exitCode = 1;
}

async function cmdModels(args: string[]): Promise<void> {
  const raw = args[0];
  const provider: ProviderId = raw === undefined ? "nvidia" : parseProviderId(raw) ?? "nvidia";
  if (raw !== undefined && parseProviderId(raw) === null) {
    console.error("usage: codewhip models [nvidia|mistral|sensenova|alibaba]");
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

function cmdAudit(args: string[]): void {
  const outcomesPath = path.join(process.cwd(), ".codewhip", "outcomes.jsonl");
  if (args.includes("--verify")) {
    if (!fs.existsSync(outcomesPath)) {
      console.log("audit: no chain yet (.codewhip/outcomes.jsonl missing) — nothing to verify.");
      return;
    }
    console.log("audit --verify: chain check not implemented yet (Week 3).");
    return;
  }
  const lastIdx = args.indexOf("--last");
  if (lastIdx !== -1) {
    const n = Number(args[lastIdx + 1] ?? "20");
    const tail = readLastOutcomes(process.cwd(), Number.isInteger(n) && n > 0 ? n : 20);
    if (tail.length === 0) {
      console.log("audit: no entries yet.");
      return;
    }
    console.log(tail);
    return;
  }
  console.log("Usage: codewhip audit [--verify] [--last N]");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";

  if (command === "--version" || command === "-v") {
    console.log(pkg.version);
    return;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
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
      console.error('usage: codewhip run "<prompt>" [--model id] [--token-budget 250000] [--max-steps 25]');
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
  if (command === "models") {
    await cmdModels(args.slice(1));
    return;
  }
  console.error(`unknown command: ${command}`);
  console.error('try: codewhip help');
  process.exitCode = 1;
}

void main();
