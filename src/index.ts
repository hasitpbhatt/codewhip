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
import { appendOutcome, newRunId, promptHash, type UsageBucket } from "./outcomes.js";
import { sha256Hex } from "./hash.js";
import { appendEntry, auditPath, buildBundle, readAuditLog, readLastAuditEntries, readLastAuditRaw, verifyChain, type AuditEntry } from "./audit.js";
import { writeShareBundle } from "./share.js";
import { estimateCost, polishGate, resolveRoute, type TaskClass } from "./router.js";
import { renderMetrics, summarizeCwd } from "./metrics.js";
import { appendPromotedDeny, declineCandidates, loadPromotedDenies, policyMdPath } from "./policy-store.js";
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
  /** Write a redacted share bundle (.codewhip/share-<runId>.json) after the run. */
  share: boolean;
  /** Explicit --class routing override (undefined = auto-classify). */
  taskClass?: TaskClass;
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
  console.log("  audit                inspect the hash-chained audit log (--verify/--last/--replay/--export)");
  console.log("  metrics              aggregate outcomes into the H1 bars (blocks/100, $/task, memory/week)");
  console.log("  policy               promote repeated declines into denies (candidates/approve/list)");
  console.log("  pack                 team policy packs shipped locally (list/pull <name> [--force])");
  console.log("  help                 show this help");
  console.log("");
  console.log("Options (run):");
  console.log(`  --model <id>         model id (default depends on --provider)`);
  console.log(`  --models <a,b,c>     rotate models in order on 429, each once per run (default: off)`);
  console.log("  --provider <id>      nvidia|mistral|sensenova|alibaba (default: routed by --class)");
  console.log("  --class <c>          implement|polish|private — task class for routing (default: auto-classify)");
  console.log("  --token-budget <n>   max prompt+completion tokens for the run; enforced mid-run, stops with partial transcript + receipt (default: 250000)");
  console.log("  --max-steps <n>      hard stop with partial result + cost (default: 25)");
  console.log("  --yolo               bypass ask (never the denylist), logged + bannered (default: off)");
  console.log("  --retry-wait         one Retry-After wait (<=60s) on 429 per run (default: off; avoid in CI)");
  console.log("  --failover           one switch to the next provider with a stored key on 429 per run (default: off; may bill pay-go)");
  console.log("  --share              write a redacted share bundle (.codewhip/share-<runId>.json) after the run");
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
    parts.push(`${b.label}:${b.model} ${b.prompt}+${b.completion}`);
    costs.push(costNote(b.label));
  }
  return `receipt: ${p} prompt + ${c} completion tokens / ${parts.join(" + ")} / ${costs.join(" + ")}`;
}

function printMixReceipt(buckets: UsageBucket[], provider: ProviderId, model: string): void {
  console.log("");
  console.log(mixReceiptString(buckets, provider, model));
}

function printStubReceipt(model: string, provider: ProviderId): void {
  printReceipt(model, 0, 0, costNote(provider));
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
  let yolo = false;
  let retryWait = false;
  let failover = false;
  let share = false;
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
      providerExplicit = true;
      i++;
      if (!modelExplicit) {
        model = PROVIDERS[provider].defaultModel;
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
    } else if (a === "--yolo") {
      yolo = true;
    } else if (a === "--retry-wait") {
      retryWait = true;
    } else if (a === "--failover") {
      failover = true;
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
    provider, providerExplicit, tokenBudget, maxSteps, yolo, retryWait, failover, share,
    taskClass,
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
  const routed = resolveRoute({
    prompt: opts.prompt,
    taskClass: opts.taskClass,
    provider: opts.providerExplicit ? opts.provider : undefined,
    model: opts.modelExplicit ? opts.model : undefined,
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
  opts = { ...opts, provider: routed.provider, model: routed.model };
  console.log(`route: ${routed.taskClass} → ${routed.provider}:${routed.model} (${routed.auto ? "auto" : "manual"}: ${routed.note})`);
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
    logPreLoopDeny(process.cwd(), opts.prompt, opts.model, "route:missing-key", `missing ${opts.provider} key`);
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
    if (routed.taskClass === "polish") {
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
    if (tool !== "bash" && tool !== "edit" && tool !== "write") {
      console.error(`policy: tool must be bash|edit|write (got "${tool}")`);
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
  if (command === "metrics") {
    console.log(renderMetrics(summarizeCwd(process.cwd())));
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
  console.error(`unknown command: ${command}`);
  console.error('try: codewhip help');
  process.exitCode = 1;
}

void main();
