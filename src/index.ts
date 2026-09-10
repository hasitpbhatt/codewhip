#!/usr/bin/env node
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { generateKeyPairSync } from "node:crypto";
import { makeMistralPort, makeNvidiaPort, NVIDIA_DEFAULT_MODEL, MISTRAL_DEFAULT_MODEL } from "./provider.js";
import { agentLoop, type FailoverTarget } from "./loop.js";
import type { UsageBucket } from "./outcomes.js";
import {
  clearKey,
  configDir,
  envVarFor,
  keyUrlFor,
  parseProviderId,
  promptHidden,
  resolveKey,
  saveKey,
  type ProviderId,
} from "./auth.js";

const require = createRequire(import.meta.url);
const pkg: { version: string } = require("../package.json");

type RunOptions = {
  prompt: string;
  model: string;
  provider: ProviderId;
  budget: number;
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
  console.log("  auth                 store provider keys (login/logout/status [nvidia|mistral])");
  console.log("  audit                inspect the audit chain (--verify, --last N)");
  console.log("  help                 show this help");
  console.log("");
  console.log("Options (run):");
  console.log(`  --model <id>         model id (default depends on --provider)`);
  console.log("  --provider <id>      nvidia|mistral (default: nvidia)");
  console.log("  --budget <dollars>   max spend, preflight check (default: 0.50)");
  console.log("  --max-steps <n>      hard stop with partial result + cost (default: 25)");
  console.log("  --yolo               bypass ask (never the denylist), logged + bannered (default: off)");
  console.log("  --retry-wait         one Retry-After wait (<=60s) on 429 per run (default: off; avoid in CI)");
  console.log("  --failover           one switch to the other provider on 429 per run (default: off; may bill pay-go)");
  console.log("  -v, --version        print version");
  console.log("");
  console.log("Keys: NVIDIA_API_KEY / MISTRAL_API_KEY env wins when set; else `codewhip auth login <provider>`.");
  console.log("  (nvidia free key: build.nvidia.com/settings/api-keys; mistral key: console.mistral.ai)");
  console.log("Receipts: every run prints `tokens / provider:model / cost` (nvidia free tier = $0; mistral cost untracked).");
  console.log("Status: agentLoop() live (read/search/edit/bash) — policy-checked, metered.");
}

function costNote(provider: ProviderId): string {
  // Honest meter: only NVIDIA's free tier is known-$0. Mistral free mode is
  // $0 but pay-go bills — point at their console instead of printing fiction.
  return provider === "nvidia"
    ? "$0.0000 (nvidia free tier)"
    : "cost untracked (see console.mistral.ai usage)";
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
    costs.push(costNote(b.label === "mistral" ? "mistral" : "nvidia"));
  }
  console.log("");
  console.log(`receipt: ${p} prompt + ${c} completion tokens / ${parts.join(" + ")} / ${costs.join(" + ")}`);
}

function printStubReceipt(model: string, provider: ProviderId): void {
  printReceipt(model, 0, 0, costNote(provider));
}

function parseRunArgs(args: string[]): RunOptions | null {
  let model = NVIDIA_DEFAULT_MODEL;
  let modelExplicit = false;
  let provider: ProviderId = "nvidia";
  let budget = 0.5;
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
      model = args[++i] as string;
      modelExplicit = true;
    } else if (a === "--provider") {
      const v = args[i + 1];
      const parsed = parseProviderId(v);
      if (parsed === null) return fail("--provider must be nvidia|mistral");
      provider = parsed;
      i++;
      if (!modelExplicit) {
        model = provider === "mistral" ? MISTRAL_DEFAULT_MODEL : NVIDIA_DEFAULT_MODEL;
      }
    } else if (a === "--budget") {
      const v = args[i + 1];
      if (v === undefined) return fail("--budget needs a value");
      const n = Number(args[++i]);
      if (!Number.isFinite(n) || n <= 0 || n > 5) return fail("--budget must be a number 0 < b <= 5");
      budget = n;
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
  return { prompt: positional.join(" "), model, provider, budget, maxSteps, yolo, retryWait, failover, modelExplicit };
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
  console.error(`codewhip: ${envVarFor(provider)} is not set and no stored ${provider} key found (the key is never printed or logged).`);
  console.error(`  Persist once: codewhip auth login ${provider}   (hidden prompt, 0600 file; env still wins)`);
  console.error(`  Or per terminal, PowerShell: $env:${envVarFor(provider)} = "..."`);
  console.error(`  Get a key at ${keyUrlFor(provider)}`);
  process.exitCode = 1;
}

function promptApproval(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer: string) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === "y" || a === "yes");
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
  const { key: apiKey } = resolveKey(opts.provider);
  if (apiKey.length === 0) {
    missingKeyHelp(opts.provider);
    printStubReceipt(opts.model, opts.provider);
    return;
  }
  let failoverTarget: FailoverTarget | undefined;
  if (opts.failover) {
    const other: ProviderId = opts.provider === "nvidia" ? "mistral" : "nvidia";
    if (opts.modelExplicit) {
      console.error("codewhip: --failover needs the default model (drop --model; per-provider defaults apply)");
      process.exitCode = 1;
      printStubReceipt(opts.model, opts.provider);
      return;
    }
    const target = resolveKey(other);
    if (target.key.length === 0) {
      console.error(`codewhip: --failover needs a ${other} key (${envVarFor(other)} or: codewhip auth login ${other})`);
      process.exitCode = 1;
      printStubReceipt(opts.model, opts.provider);
      return;
    }
    const targetModel = other === "mistral" ? MISTRAL_DEFAULT_MODEL : NVIDIA_DEFAULT_MODEL;
    console.log(`!! --failover armed: one switch to ${other}:${targetModel} on 429. May bill ${other} pay-go.`);
    failoverTarget = {
      label: other,
      model: targetModel,
      port: other === "mistral" ? makeMistralPort(target.key) : makeNvidiaPort(target.key),
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
      port: opts.provider === "mistral" ? makeMistralPort(apiKey) : makeNvidiaPort(apiKey),
      signal: ctrl.signal,
      askUser: promptApproval,
      retryWait: opts.retryWait,
      failover: failoverTarget,
      onEvent: (e) => console.log(`${e.kind === "tool" ? "▸" : "◆"} ${e.text}`),
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
      console.error("usage: codewhip auth login|logout [nvidia|mistral]");
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
    for (const provider of ["nvidia", "mistral"] as ProviderId[]) {
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
  console.error("usage: codewhip auth [login|logout|status] [nvidia|mistral]");
  process.exitCode = 1;
}

function cmdAudit(args: string[]): void {
  const logPath = path.join(process.cwd(), ".codewhip", "audit.log");
  if (args.includes("--verify")) {
    if (!fs.existsSync(logPath)) {
      console.log("audit: no chain yet (.codewhip/audit.log missing) — nothing to verify.");
      return;
    }
    console.log("audit --verify: chain check not implemented yet (Week 3).");
    return;
  }
  const lastIdx = args.indexOf("--last");
  if (lastIdx !== -1) {
    const n = Number(args[lastIdx + 1] ?? "20");
    if (!fs.existsSync(logPath)) {
      console.log("audit: no entries yet.");
      return;
    }
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    console.log(lines.slice(-n).join("\n"));
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
      console.error('usage: codewhip run "<prompt>" [--model id] [--budget 0.50] [--max-steps 25]');
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
  console.error(`unknown command: ${command}`);
  console.error('try: codewhip help');
  process.exitCode = 1;
}

void main();
