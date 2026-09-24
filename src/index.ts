#!/usr/bin/env node
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { generateKeyPairSync } from "node:crypto";
import { isBuiltinProviderId, makePortForConfig, MAX_CHAT_TIMEOUT_MS, MIN_CHAT_TIMEOUT_MS, PROVIDERS, setStreamingEnabled, type ProviderId } from "./provider.js";
import { addCustomProvider, getProviderConfig, isLoopbackBaseUrl, listAllProviderConfigs, removeCustomProvider } from "./custom-providers.js";
import { allowedModelsFor, disableEntries, enableEntries, isModelAllowed, loadAllowedEntries, providerIsEnabled } from "./model-allowlist.js";
import { freeChainCandidates, freeChainIds, listFreeProviders } from "./free-providers.js";
import { listModels } from "./models.js";
import { summarizeCalls, readProviderCalls, renderProviderHealth } from "./provider-stats.js";
import { agentLoop, type ApprovalAnswer, type AskUser, type LoopEvent, type FailoverTarget } from "./loop.js";
import type { LoopMsg } from "./provider-port.js";
import { listRules } from "./remember-store.js";
import { listCheckpointRuns, resolveCheckpointRun, rollbackRun } from "./checkpoints.js";
import { labelSession, listSessions, loadSession, nameTaken, sanitizeSessionLabel, sanitizeSessionName, saveSession, sessionIdentity, sessionRecord, SESSION_NAME_RULE, SESSION_TAG_RULE, type SessionLabels } from "./sessions.js";
import { describeToolFilter, parseToolFilterList, TOOL_FILTER_RULE, type ToolFilter } from "./tool-filter.js";
import { APPEND_MAX_CHARS } from "./system.js";
import { appendOutcome, newRunId, promptHash, readOutcomeRecords, type OutcomeRecord, type UsageBucket } from "./outcomes.js";
import { sha256Hex } from "./hash.js";
import { lockFileOwnerOnly, writeOwnerOnlyFile } from "./secure-file.js";
import { appendEntry, appendGenesis, auditPath, buildBundle, hasGenesis, interpretVerification, readAuditLog, readLastAuditEntries, readLastAuditRaw, verifyChain, type AuditEntry } from "./audit.js";
import { getTaskStatuses } from "./tools/background-status.js";
import { renderShareMarkdown, writeShareBundle } from "./share.js";
import { estimateCost, isPolishRun, meteredCost, polishGate, polishRunCost, resolveRoute, type TaskClass } from "./router.js";
import { buildFailure, buildResult, emitEvent, emitInit, emitResult, headless, outputFormat, parseOutputFormat, readStdin, say, setOutputFormat, STDIN_CONTEXT_WAIT_MS, writeResultText, type OutputFormat } from "./run-output.js";
import { renderMetrics, summarizeCwd } from "./metrics.js";
import { DEFAULT_COMPACT_TOKENS } from "./compact.js";
import { EVAL_TASKS_DIR, listEvalTasks, runEval } from "./eval.js";
import { readEvalRecords, summarizeEval } from "./eval-store.js";
import { appendPromotedDeny, declineCandidates, loadPromotedDenies, policyMdPath } from "./policy-store.js";
import { BUILTIN_AGENTS, listAgentsWithErrors } from "./subagents.js";
import { expandCommand, listCommandsWithErrors, maybeExpandCommand } from "./commands.js";
import { loadHooks } from "./hooks.js";
import { removeRule } from "./remember-store.js";
import { isVerdict, proposeVerdict, resolveRunPrefix, setVerdict, type Verdict } from "./verdict.js";
import { defaultPacksDir, listPacks, pullPack } from "./pack.js";
import type { ServeOptions } from "./serve.js";
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
  /**
   * Silent auto-failover: same $0-only chain as --free, but backend hops are
   * recorded (outcome/audit/receipt) rather than printed. Private runs stay
   * head-only (consent covers one target). Mutually exclusive with
   * --free/--failover/--models.
   */
  autoFailover: boolean;
  /** Run-scoped read-only: edit/write/bash denied, output is the plan. */
  plan: boolean;
  /**
   * `--allowed-tools`: shapes this run may pass an ask without a prompt.
   * Session-scoped by construction — it is an argument, never a file, so the
   * next run asks again.
   */
  allowedTools: ToolFilter[];
  /** `--disallowed-tools`: shapes refused above the ladder, for this run only. */
  disallowedTools: ToolFilter[];
  /** `--append-system-prompt` text, plus whatever `-file` read (see cmdRun). */
  appendSystemPrompt?: string;
  /** `--append-system-prompt-file`: path read at run time, not parse time. */
  appendSystemPromptFile?: string;
  /** `--exclude-dynamic-system-prompt-sections`: drop the agent roster. */
  excludeDynamicSections: boolean;
  /** Write a redacted share bundle (.codewhip/share-<runId>.json) after the run. */
  share: boolean;
  /** With --share: also print a pasteable Markdown receipt block to stdout. */
  sharePrint: boolean;
  /**
   * Opt-in conversation memory: resume a prior session (bare = most recent,
   * else that prefix) and persist the new transcript on exit. Implies
   * persistence — raw prompts land on disk (secrets redacted).
   */
  continue: boolean;
  /** Prefix or session name for --continue/-r (undefined = most recent). */
  continuePrefix?: string;
  /**
   * Write a session file on exit without resuming anything: `-r` implies it,
   * and so does naming a session at all. A `--name` nobody persisted would be
   * a silent no-op, so the intent arms the opt-in rather than being dropped.
   */
  persist: boolean;
  /**
   * Label for the session this run writes (`--name`), and `-r <name>` is how
   * one is read back. Validation lives in `sanitizeSessionName`, the single
   * rule both the CLI and the store apply.
   */
  sessionName?: string;
  /** `--tag` (repeatable) — free-form markers, listed by `codewhip sessions`. */
  sessionTags: string[];
  /**
   * `--fork-session`: resume another session's transcript but write a **new**
   * session file that names its parent, instead of accumulating in place.
   */
  forkSession: boolean;
  /** Explicit per-call provider budget override (undefined = provider default, 120s builtin). */
  timeoutMs?: number;
  /** Disable SSE streaming (whole-body responses) — escape hatch per run. */
  noStream: boolean;
  /** Explicit --class routing override (undefined = auto-classify). */
  taskClass?: TaskClass;
  modelExplicit: boolean;
  /** Opt into the TUI view (lazy-loads OpenTUI; headless stays default). */
  tui: boolean;
  /** Force 80-col screen-reader-safe output (overrides --tui). */
  noTui: boolean;
  /**
   * Headless (`-p`): stdout is reserved for data, so every human banner moves
   * to stderr, the REPL never opens, and interactive approvals are suppressed
   * (asks are held and denied, exactly as on a non-TTY run).
   */
  headless: boolean;
  /** Shape of the headless payload; only meaningful with headless. */
  outputFormat: OutputFormat;
  /**
   * Dollar ceiling, enforced mid-run on priced routes only. Refused up front
   * on an untracked route rather than silently inert — the meter never lies.
   */
  maxBudgetUsd?: number;
  /** Explicit stdin prompt (`run -`). */
  stdinPrompt: boolean;
};

function printRunOptions(): void {
  console.log("Options (run):");
  console.log(`  --model <id>         model id (default depends on --provider)`);
  console.log(`  --models <a,b,c>     rotate models in order on rate-limit/timeout/5xx, each once per run (default: off)`);
  console.log("  --provider <id>      provider id (default: routed by --class; see: codewhip provider list)");
  console.log("  --class <c>          implement|polish|private — task class for routing (default: auto-classify)");
  console.log("  --token-budget <n>   max prompt+completion tokens for the run; enforced mid-run, stops with partial transcript + receipt (default: 250000)");
  console.log("  --max-steps <n>      hard stop with partial result + cost (default: 25)");
  console.log(`  --timeout-ms <n>     per-call provider budget in ms (default: provider default, 120s builtin; ${MIN_CHAT_TIMEOUT_MS}..${MAX_CHAT_TIMEOUT_MS})`);
  console.log("  --yolo               bypass ask (never the denylist), logged + bannered (default: off)");
  console.log("  --retry-wait         one Retry-After wait (<=60s) on 429 per run (default: off; avoid in CI)");
  console.log("  --failover           one switch to the next provider with a stored key on rate-limit/timeout/5xx per run (default: off; may bill pay-go)");
  console.log("  --free               arm the free-provider chain: hop provider on rate-limit/timeout/5xx, each free hop once per run, never bills pay-go (see: codewhip free; not with --failover)");
  console.log("  --auto-failover      like --free but silent: backend hops are recorded in the outcome/audit, not printed (private runs stay head-only; not with --free/--failover)");
  console.log("  --plan               read-only run: edit/write/bash/delegate denied for the whole run (even with --yolo); the output is the plan");
  console.log(`  --allowed-tools <f>  session rung of the ladder: these shapes pass an ask with no prompt, this run only — nothing is written to disk. ${TOOL_FILTER_RULE}. Never a policy deny, --plan, or a .codewhip path (also --allowedTools)`);
  console.log("  --disallowed-tools <f>  refused above the ladder: no --yolo, remembered rule or human yes grants these, and a bare tool name is not even advertised to the model (also --disallowedTools)");
  console.log(`  --append-system-prompt <text>  your own last line of the system prompt (<=${APPEND_MAX_CHARS} chars, re-pays every turn); --append-system-prompt-file <path> reads it from a file`);
  console.log("  --exclude-dynamic-system-prompt-sections   drop the per-run delegable-agent roster from the system prompt (refusal notes are never dropped)");
  console.log("  --share              write a redacted share bundle (.codewhip/share-<runId>.json) after the run");
  console.log("  --print              with --share: also print a pasteable Markdown receipt block (audit-anchored) to stdout");
  console.log("  --continue [ref]     -r/--resume: resume a prior session by name, bare (most recent) or id prefix >=4 chars, and save this run's transcript on exit (raw prompts on disk, secrets redacted; see: codewhip sessions)");
  console.log("  --name <name>        label the session so -r <name> finds it again (one word, <=64 chars, unique across sessions)");
  console.log("  --tag <tag>          tag the session; repeatable up to 8, listed by codewhip sessions");
  console.log("  --fork-session       with -r: start a new session file from that transcript and record its parent, instead of accumulating into it");
  console.log("  --no-stream          disable SSE streaming (whole-body responses; a provider that rejects streaming falls back on its own)");
  console.log("  --tui                opt into the terminal UI (lazy-loads OpenTUI; headless stays default; may not be available in all environments)");
  console.log("  --no-tui             force 80-col screen-reader-safe output (overrides --tui)");
  console.log("  -p, --headless       scriptable one-shot: stdout carries only the result, every banner moves to stderr, the REPL never opens and interactive approvals are suppressed (asks are held and denied — pair with --yolo or a remembered rule to let work through)");
  console.log("  --output-format <f>  text|json|stream-json — implies -p: json prints one result document, stream-json prints NDJSON (init, one line per event, result)");
  console.log("  run -                read the prompt from stdin. Piped stdin alongside a prompt is appended to it as context: cat diff.patch | codewhip run -p \"review this\"");
  console.log("  --max-budget-usd <n> stop the run when metered cost crosses n on a priced route (refused on untracked routes rather than inert; not with --free/--auto-failover, which never bill)");
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
      console.log("  Key consoles and keyless tiers: codewhip help keys");
      console.log('  Custom commands: codewhip run "/name args" expands .codewhip/commands/<name>.md ($ARGUMENTS substituted).');
      console.log("  One-shot expansion is exact-match only — a prompt like \"/api returns 500\" runs verbatim; in the REPL unknown /name errors. See .help.");
      return true;
    case "keys":
      printKeysHelp();
      return true;
    case "auth":
      console.log("codewhip auth login <provider>   — store a key (hidden prompt, 0600 file; env still wins)");
      console.log("codewhip auth logout <provider>  — forget the stored key");
      console.log("codewhip auth status [provider]  — set/missing per provider (keys are never printed)");
      console.log("  key consoles and keyless tiers: codewhip help keys");
      return true;
    case "models":
      console.log("codewhip models [provider] — list served models with agency tags (default: nvidia).");
      console.log("  Needs the provider key (see: codewhip help auth) — except llm7, which is anonymous.");
      return true;
    case "provider":
      console.log("codewhip provider list            — known providers (builtin + custom) with enabled-model counts");
      console.log(`codewhip ${PROVIDER_ADD_USAGE}`);
      console.log("codewhip provider remove <id>     — forget a custom provider (builtins stay)");
      console.log("codewhip provider show <id>       — base URLs, default model, env var, key console");
      console.log("codewhip provider enable <p:m>    — allow one exact model (deny by default; no wildcards)");
      console.log("codewhip provider disable <p:m>   — take one exact model away");
      console.log("codewhip provider allowed         — the enabled models");
      return true;
    case "free":
      console.log("codewhip free — list the free-provider chain (read-only: no key, no network).");
      console.log('  Keyless rows first. Arm the chain on a run: codewhip run "<prompt>" --free.');
      return true;
    case "eval":
      console.log("codewhip eval [--task <name>] [--provider <p>] [--model <m>] [--free] [--max-steps 25] [--timeout-sec 600] [--keep]");
      console.log("  Runs the agent against the fixture tasks in tasks/ (disposable temp dirs) and machine-grades each with its checker.");
      console.log("  Feeds .codewhip/eval.jsonl → codewhip metrics reports the task-success bars (≥70% polish / ≥50% implement).");
      console.log("  Exit 0 only when every selected task passes — CI-usable. --keep keeps temp dirs for debugging.");
      return true;
    case "serve":
      console.log("codewhip serve [--port 8787] [--host 127.0.0.1] [--provider llm7] [--model <id>] [--token <secret>] [--no-auth-ui] [--ping-models]");
      console.log("  Exposes the provider registry as an OpenAI-compatible HTTP server:");
      console.log("    POST /v1/chat/completions   stream and non-stream; model = \"<provider>:<model>\" or \"auto\"");
      console.log("  \"auto\" only spends free keys (anonymous tiers + known-$0 routes with TTL health filter).");
      console.log("  A paid key on an untracked-cost route is never auto-touched unless CODEWHIP_AUTO_INCLUDE_UNTRACKED=1.");
      console.log("    GET  /v1/models             every provider as \"<provider>:<default-model>\"");
      console.log("    GET  /health");
      console.log("    GET  /playground            model playground UI");
      console.log("    GET  /auth                  provider key manager UI (on by default; --no-auth-ui to disable)");
      console.log("    POST /auth/_custom          register a custom endpoint (same as: codewhip provider add)");
      console.log("    DELETE /auth/_custom/<id>   remove one (same as: codewhip provider remove <id>)");
      console.log("  Defaults to llm7 (keyless) so it works with no setup. Any OpenAI client can point at it,");
      console.log("  including the ones that cannot speak to a non-OpenAI provider such as 1min.");
      console.log("  Binds 127.0.0.1 unless --host is given; a non-loopback bind REQUIRES --token.");
      console.log("  This proxies models only — it runs no tools, applies no policy, and writes no audit entries.");
      console.log("  The auth UI stores/clears provider keys and registers custom endpoints from the browser");
      console.log("  (env vars still win; keys are never echoed). Registered endpoints join /v1/models at once.");
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
    case "remember":
      console.log('codewhip remember list               — grants the agent auto-runs, with what each covers');
      console.log('codewhip remember forget "<tool:shape>" — revoke one grant (future runs ask again; audited)');
      console.log("  Grants come from answering `a` at an approval prompt; `s` scopes one to the session only.");
      return true;
    case "verdict":
      console.log("codewhip verdict <runId-prefix> <accepted|edited|reverted|rejected> — record human judgment (prefix ok, >=4 chars).");
      console.log("codewhip verdict --auto <runId-prefix> — propose a verdict from checkpoints + git, confirm with one keypress.");
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
    case "sessions":
      console.log("codewhip sessions — list saved conversation transcripts (newest first; opt-in via --continue only).");
      console.log('  Resume: codewhip run "<prompt>" -r <name|prefix> (bare -r = most recent, prefix >=4 chars, unique).');
      console.log("  codewhip sessions rename <session> <name>  ·  codewhip sessions tag <session> <tag>");
      console.log("  Each row: id prefix, name, timestamp, provider:model, message count, tags, parent, preview (redacted, 60 chars).");
      return true;
    default:
      return false;
  }
}

function printHelpTopicError(topic: string): void {
  console.error(`help: no topic "${topic}" (topics: init run auth agents remember models free provider serve rollback sessions audit metrics stats trust verdict demo policy pack)`);
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
  console.log("  serve                expose the providers as an OpenAI-compatible HTTP server (--port/--token)");
  console.log("  rollback <run>       undo a run: restore files it edited/wrote (or --list runs)");
  console.log("  sessions             list saved conversation transcripts (newest first; --continue to resume)");
  console.log("  audit                inspect the hash-chained audit log (--verify/--last/--replay/--export)");
  console.log("  metrics              aggregate outcomes into the H1 bars (blocks/100, $/task, memory/week)");
  console.log("  stats [provider]     per-provider/model request health (ok/auth/quota/timeout/network/bad_model/other)");
  console.log("  agents               list delegable read-only subagents (built-ins + .codewhip/agents/)");
  console.log("  remember             inspect/revoke auto-run grants (list/forget \"<tool:shape>\")");
  console.log("  trust                print a single trust certificate (chain, violations, polish, memory, keys, policy)");
  console.log("  verdict <run> <v>    record human judgment: accepted|edited|reverted|rejected (prefix ok)");
  console.log("  demo --deny          offline wedge demo: five disasters refused on the $0 fake port");
  console.log("  policy               promote repeated declines into denies (candidates/approve/list)");
  console.log("  pack                 team policy packs shipped locally (list/pull <name> [--force])");
  console.log("  help [command]       show this help (or one command's: codewhip help run)");
  console.log("");
  console.log('  "/name args"         custom slash command — expands .codewhip/commands/<name>.md (run + REPL; .help lists them)');
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
  // cerebras was removed here 2026-09-13: its grant needs a verified card and
  // expires in 30 days, so "$0 (cerebras free tier)" became a fiction.
  if (provider === "nvidia" || provider === "groq" || provider === "gemini" || provider === "zai") {
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
  // A loopback local runtime is genuinely $0 marginal and has NO console to
  // check, so "cost untracked (see provider console)" there sends the user
  // looking for a bill that cannot exist. Keep this branch in step with
  // `estimateCost()` in router.ts — the receipt and the polish gate read the
  // same route through two different functions, so they can silently disagree.
  const cfg = getProviderConfig(provider);
  if (cfg !== null && isLoopbackBaseUrl(cfg.baseUrl)) {
    return "$0.0000 (local runtime — your own machine)";
  }
  const keyUrl = cfg?.keyUrl;
  return keyUrl !== undefined && keyUrl.length > 0
    ? `cost untracked (see ${keyUrl})`
    : "cost untracked (see provider console)";
}

function printReceipt(model: string, promptTokens: number, completionTokens: number, cost: string): void {
  say("");
  say(
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
  say("");
  say(mixReceiptString(buckets, provider, model));
}

function printStubReceipt(model: string, provider: ProviderId): void {
  const cost = costNote(provider, model);
  // A scripted caller still gets a document on stdout: is_error true, zeros,
  // and the human cause on stderr (every refusal path prints it before here).
  if (headless()) {
    emitResult(buildFailure({
      provider,
      model,
      receipt: `receipt: 0 prompt + 0 completion tokens / ${provider}:${model} / ${cost}`,
      reason: "run refused before the loop started — see stderr",
    }));
  }
  printReceipt(model, 0, 0, cost);
}

/**
 * A flag's value from either shape — `--flag value` or `--flag=value` — plus
 * where the loop should continue. One helper because the two shapes have to
 * fail identically: silently accepting `--name` with no value, or swallowing
 * the next flag as its value, is the bug class this removes.
 */
type FlagValue = { ok: true; value: string; next: number } | { ok: false; error: string };

function takeValue(flag: string, args: string[], i: number, needs: string): FlagValue {
  const eq = flag.indexOf("=");
  if (eq !== -1) {
    const v = flag.slice(eq + 1);
    return v.length === 0 ? { ok: false, error: needs } : { ok: true, value: v, next: i };
  }
  const v = args[i + 1];
  if (v === undefined || v.startsWith("-")) return { ok: false, error: needs };
  return { ok: true, value: v, next: i + 1 };
}

/** Entries a single run's tool filters may carry — a wall of patterns is a
 * review surface nobody reviewed, and the flags are meant to be readable. */
const MAX_TOOL_FILTERS = 64;

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
  let autoFailover = false;
  let plan = false;
  const allowedTools: ToolFilter[] = [];
  const disallowedTools: ToolFilter[] = [];
  let appendSystemPrompt: string | undefined;
  let appendSystemPromptFile: string | undefined;
  let excludeDynamicSections = false;
  let share = false;
  let sharePrint = false;
  let noStream = false;
  let tui = false;
  let noTui = false;
  let cont = false;
  let continuePrefix: string | undefined;
  let sessionName: string | undefined;
  const sessionTags: string[] = [];
  let forkSession = false;
  let headlessFlag = false;
  let formatArg: OutputFormat | null = null;
  let maxBudgetUsd: number | undefined;
  let stdinPrompt = false;
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
      if (free || autoFailover) return fail("use --failover or --free/--auto-failover, not both");
      failover = true;
    } else if (a === "--free") {
      if (failover || autoFailover) return fail("use --free or --failover/--auto-failover, not both");
      free = true;
    } else if (a === "--auto-failover") {
      if (failover || free) return fail("use --auto-failover or --free/--failover, not both");
      autoFailover = true;
    } else if (a === "--plan") {
      plan = true;
    } else if (a === "--allowed-tools" || a === "--allowedTools" || a.startsWith("--allowed-tools=") || a.startsWith("--allowedTools=")) {
      const v = takeValue(a, args, i, "--allowed-tools needs a filter list");
      if (!v.ok) return fail(v.error);
      i = v.next;
      const parsed = parseToolFilterList(v.value);
      if (parsed.ok === false) return fail(`--allowed-tools: ${parsed.error}`);
      allowedTools.push(...parsed.filters);
      if (allowedTools.length > MAX_TOOL_FILTERS) return fail(`--allowed-tools is capped at ${MAX_TOOL_FILTERS} entries`);
    } else if (a === "--disallowed-tools" || a === "--disallowedTools" || a.startsWith("--disallowed-tools=") || a.startsWith("--disallowedTools=")) {
      const v = takeValue(a, args, i, "--disallowed-tools needs a filter list");
      if (!v.ok) return fail(v.error);
      i = v.next;
      const parsed = parseToolFilterList(v.value);
      if (parsed.ok === false) return fail(`--disallowed-tools: ${parsed.error}`);
      disallowedTools.push(...parsed.filters);
      if (disallowedTools.length > MAX_TOOL_FILTERS) return fail(`--disallowed-tools is capped at ${MAX_TOOL_FILTERS} entries`);
    } else if (a === "--append-system-prompt" || a.startsWith("--append-system-prompt=")) {
      const v = takeValue(a, args, i, "--append-system-prompt needs text");
      if (!v.ok) return fail(v.error);
      i = v.next;
      if (v.value.length > APPEND_MAX_CHARS) {
        return fail(`--append-system-prompt is capped at ${APPEND_MAX_CHARS} characters — it re-pays on every turn of the run`);
      }
      appendSystemPrompt = v.value;
    } else if (a === "--append-system-prompt-file" || a.startsWith("--append-system-prompt-file=")) {
      const v = takeValue(a, args, i, "--append-system-prompt-file needs a path");
      if (!v.ok) return fail(v.error);
      i = v.next;
      appendSystemPromptFile = v.value;
    } else if (a === "--exclude-dynamic-system-prompt-sections") {
      excludeDynamicSections = true;
    } else if (a === "--no-stream") {
      noStream = true;
    } else if (a === "--share") {
      share = true;
    } else if (a === "--print") {
      sharePrint = true;
    } else if (a === "--tui") {
      tui = true;
    } else if (a === "--no-tui") {
      noTui = true;
    } else if (a === "--continue" || a === "-r" || a === "--resume" || a.startsWith("--continue=") || a.startsWith("--resume=") || a.startsWith("-r=")) {
      cont = true;
      const eq = a.indexOf("=");
      if (eq !== -1) {
        const v = a.slice(eq + 1);
        if (v.length === 0) return fail("-r/--continue needs a session name or an id prefix >=4 chars, or nothing (bare = most recent)");
        continuePrefix = v;
      } else {
        const v = args[i + 1];
        if (v !== undefined && !v.startsWith("-")) {
          continuePrefix = v;
          i++;
        }
      }
    } else if (a === "--name" || a.startsWith("--name=")) {
      const v = takeValue(a, args, i, "--name needs a session label");
      if (!v.ok) return fail(v.error);
      i = v.next;
      const clean = sanitizeSessionName(v.value);
      if (clean === null) return fail(`--name "${v.value}" — ${SESSION_NAME_RULE}`);
      sessionName = clean;
    } else if (a === "--tag" || a.startsWith("--tag=")) {
      const v = takeValue(a, args, i, "--tag needs a label");
      if (!v.ok) return fail(v.error);
      i = v.next;
      const clean = sanitizeSessionLabel(v.value);
      if (clean === null) return fail(`--tag "${v.value}" — ${SESSION_TAG_RULE}`);
      if (!sessionTags.includes(clean)) sessionTags.push(clean);
      if (sessionTags.length > 8) return fail("--tag is capped at 8 per session");
    } else if (a === "--fork-session") {
      forkSession = true;
    } else if (a === "-p" || a === "--headless") {
      headlessFlag = true;
    } else if (a === "--output-format" || a.startsWith("--output-format=")) {
      const v = takeValue(a, args, i, "--output-format needs text|json|stream-json");
      if (!v.ok) return fail(v.error);
      i = v.next;
      const f = parseOutputFormat(v.value);
      if (f === null) return fail(`--output-format must be text|json|stream-json (got "${v.value}")`);
      formatArg = f;
      headlessFlag = true;
    } else if (a === "--max-budget-usd" || a.startsWith("--max-budget-usd=")) {
      const v = takeValue(a, args, i, "--max-budget-usd needs a dollar amount");
      if (!v.ok) return fail(v.error);
      i = v.next;
      const n = Number(v.value);
      if (!Number.isFinite(n) || n <= 0 || n > 10000) return fail("--max-budget-usd must be a number > 0 and <= 10000");
      maxBudgetUsd = n;
    } else if (a === "-") {
      stdinPrompt = true;
    } else if (!a.startsWith("-")) {
      positional.push(a);
    } else {
      return fail(`unknown flag: ${a}`);
    }
  }
  if (sharePrint && !share) return fail("--print needs --share");
  if (forkSession && !cont) return fail("--fork-session needs -r/--continue <session> to fork from");
  // `-p`/`--output-format` owns stdout, so the mode that grabs it for itself loses.
  if (headlessFlag && tui) return fail("--output-format/-p cannot combine with --tui (stdout is reserved for data)");
  if (maxBudgetUsd !== undefined && (free || autoFailover)) {
    return fail("--max-budget-usd is meaningless on the free chain (it never bills pay-go) — cap tokens with --token-budget");
  }
  if (headlessFlag) setOutputFormat(formatArg ?? "text");
  return {
    prompt: positional.join(" "),
    model: modelsArg?.[0] ?? model,
    models: modelsArg ?? [],
    provider, providerExplicit, tokenBudget, maxSteps, yolo, retryWait, failover, free, autoFailover, plan, share, sharePrint,
    allowedTools, disallowedTools, excludeDynamicSections,
    ...(appendSystemPrompt === undefined ? {} : { appendSystemPrompt }),
    ...(appendSystemPromptFile === undefined ? {} : { appendSystemPromptFile }),
    taskClass, timeoutMs, noStream,
    modelExplicit: modelExplicit || modelsArg !== null,
    continue: cont,
    persist: cont || sessionName !== undefined || sessionTags.length > 0,
    tui,
    noTui,
    headless: headlessFlag,
    outputFormat: formatArg ?? "text",
    stdinPrompt,
    sessionTags,
    forkSession,
    ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
    ...(continuePrefix === undefined ? {} : { continuePrefix }),
    ...(sessionName === undefined ? {} : { sessionName }),
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
    const lockWarning = writeOwnerOnlyFile(privKey, privateKey.export({ type: "pkcs8", format: "pem" }));
    fs.writeFileSync(pubKey, publicKey.export({ type: "spki", format: "pem" }), "utf8");
    console.log("generated .codewhip/key (ed25519, local only)");
    if (lockWarning !== null) console.warn(`init: warning: ${lockWarning}`);
    // Signed genesis marker: bounds the pre-key unsigned prefix so
    // verification can detect prepend-forgery instead of forgiving it
    // unboundedly (docs/moat/torvalds-architecture-review.md, finding 6).
    if (appendGenesis(cwd)) {
      console.log("signed genesis marker appended (bounds pre-key history)");
    } else {
      console.warn("init: warning: genesis marker could not be appended — the audit chain has no verifiable pre-key bound");
    }
  } else {
    // Repair pass: keys written by older versions predate owner-only files.
    const lockWarning = lockFileOwnerOnly(privKey);
    if (lockWarning !== null) console.warn(`init: warning: ${lockWarning}`);
    console.log("kept .codewhip/key (exists)");
    // Legacy chains predate the genesis marker; appending one on repair
    // upgrades them so future prepend-forgery is detectable.
    if (!hasGenesis(cwd)) {
      if (appendGenesis(cwd)) {
        console.log("signed genesis marker appended — pre-key history is now bounded");
      } else {
        console.warn("init: warning: genesis marker could not be appended — the audit chain has no verifiable pre-key bound");
      }
    }
  }
  console.log('done. next: codewhip demo --deny (offline, $0) — then: codewhip auth login nvidia');
}

function missingKeyHelp(provider: string): void {
  const cfg = getProviderConfig(provider);
  const envVar = cfg?.envVar ?? `${provider.toUpperCase()}_API_KEY`;
  const keyUrl = cfg?.keyUrl ?? "the provider console";
  console.error(`codewhip: ${envVar} is not set and no stored ${provider} key found (the key is never printed or logged).`);
  console.error(`  Persist once: codewhip auth login ${provider}   (hidden prompt, owner-only file; env still wins)`);
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
      else if (a === "s" || a === "session") resolve("session");
      else if (a === "y" || a === "yes") resolve("yes");
      else resolve("no");
    });
  });
}

type ReplState = {
  history: LoopMsg[];
  provider: ProviderId;
  model: string;
  lastRunId: string | null;
  /** Session this REPL writes on .exit; null until the first run gives it an id. */
  sessionId: string | null;
  /** Name/tags/lineage — what `/rename`, `/tag` and `/branch` mutate. */
  labels: SessionLabels;
};

async function cmdRun(opts: RunOptions, replState?: ReplState): Promise<void> {
  const cwd = process.cwd();
  // --continue: opt-in transcript persistence. Load once (single-shot) or
  // reuse the REPL's shared in-memory history (per-line saves deferred to
  // .exit so one REPL session writes one file, not one per line).
  let history: LoopMsg[] = [];
  let replMode = false;
  // Which session this run writes, and what it is called. `--name`/`--tag` win
  // over the resumed session's own labels; otherwise a resume keeps them, so
  // `-r auth` keeps landing on the session named auth.
  let resumedFrom: string | undefined;
  let labels: SessionLabels = {
    ...(opts.sessionName === undefined ? {} : { name: opts.sessionName }),
    tags: opts.sessionTags,
  };
  if (replState !== undefined) {
    replMode = true;
    history = replState.history;
    labels = replState.labels;
    resumedFrom = replState.sessionId ?? undefined;
  } else if (opts.continue) {
    const loaded = loadSession(cwd, opts.continuePrefix);
    if (!loaded.ok) {
      console.error(`codewhip: ${loaded.error}`);
      process.exitCode = 1;
      printStubReceipt(opts.model, opts.provider);
      return;
    }
    history = loaded.record.messages.filter((m) => m.role !== "system");
    resumedFrom = loaded.record.runId;
    labels = {
      ...(opts.sessionName === undefined && loaded.record.name !== undefined ? { name: loaded.record.name } : {}),
      tags: opts.sessionTags.length > 0 ? opts.sessionTags : (loaded.record.tags ?? []),
    };
    const asWhat = loaded.record.name === undefined
      ? loaded.record.runId.slice(0, 8)
      : `${loaded.record.runId.slice(0, 8)} ("${loaded.record.name}")`;
    say(`!! --continue armed: resuming ${asWhat} (${history.length} prior messages) — transcript saved on exit (raw prompts on disk)`);
  } else if (opts.persist) {
    say(`!! ${opts.sessionName === undefined ? "--tag" : `--name "${opts.sessionName}"`} arms session saving: this transcript will be written on exit (raw prompts on disk, secrets redacted)`);
  }
  // A name is how `-r` finds a session, so two sessions cannot share one. Fail
  // before spending a token: a collision discovered after the run has burned a
  // whole transcript nobody can resume by name. A fork owns nothing yet, so it
  // collides with any existing holder of the name.
  if (opts.persist && labels.name !== undefined && nameTaken(cwd, labels.name, opts.forkSession ? "" : resumedFrom ?? "")) {
    console.error(`codewhip: another session is already named "${labels.name}" — names resume by -r <name>, so they stay unique (see: codewhip sessions)`);
    process.exitCode = 1;
    printStubReceipt(opts.model, opts.provider);
    return;
  }
  // --free / --auto-failover arm the free chain: head = the explicit
  // --provider (must be a free-catalog id) or the first free candidate with
  // a usable key (env, stored file, or the row's anonymousKey — kilo/opencode/
  // empero/llm7 are keyless). Chain = the remaining keyed candidates, catalog
  // order. Both never bill pay-go; --auto-failover additionally silences the
  // hop chatter (recorded, not printed).
  let freeChain: FailoverTarget[] = [];
  if (opts.free || opts.autoFailover) {
    const allFree = freeChainIds();
    // Consent gate: the chain only walks providers with ≥1 enabled model.
    const candidates = allFree.filter((id) => providerIsEnabled(id));
    if (candidates.length === 0 && allFree.length > 0) {
      console.error("codewhip: --free found no enabled free provider — every free-chain provider is disabled by the allowlist. Enable models with: codewhip provider enable <provider>:<model> (see: codewhip provider allowed)");
      process.exitCode = 1;
      printStubReceipt(opts.model, opts.provider);
      return;
    }
    // Chain hops run on each provider's DEFAULT model, so that exact id must
    // be enabled — a provider with one non-default model enabled would 403
    // mid-hop.
    const hopUsable = (id: string): boolean =>
      resolveKey(id).key.length > 0 && isModelAllowed(id, getProviderConfig(id)?.defaultModel ?? "");
    const head = opts.providerExplicit ? opts.provider : candidates.find(hopUsable);
    if (head === undefined || !candidates.some((c) => c === head)) {
      console.error(
        opts.providerExplicit
          ? `codewhip: --free runs the free chain only — "${opts.provider}" is not in it (see: codewhip free)`
          : "codewhip: --free found no runnable free provider (no key + enabled default model; see: codewhip free, codewhip provider allowed)"
      );
      process.exitCode = 1;
      printStubReceipt(opts.model, opts.provider);
      return;
    }
    const headModel = opts.modelExplicit ? opts.model : getProviderConfig(head)?.defaultModel ?? opts.model;
    freeChain = candidates
      .filter((id) => id !== head && hopUsable(id))
      .flatMap((id) => {
        const cfg = getProviderConfig(id);
        if (cfg === null) return [];
        const { key, source } = resolveKey(id);
        return [{ label: cfg.id, model: cfg.defaultModel, port: makePortForConfig(cfg, key, undefined, source) }];
      });
    opts = { ...opts, provider: head, model: headModel };
  }
  const routed = resolveRoute({
    prompt: opts.prompt,
    taskClass: opts.taskClass,
    provider: opts.providerExplicit || opts.free || opts.autoFailover ? opts.provider : undefined,
    model: opts.modelExplicit || opts.free || opts.autoFailover ? opts.model : undefined,
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
    : opts.autoFailover && !opts.providerExplicit
      ? { ...routed, note: "--auto-failover chain head (first free candidate with a usable key)" }
      : routed;
  opts = { ...opts, provider: route.provider, model: route.model };
  say(`route: ${route.taskClass} → ${route.provider}:${route.model} (${route.auto ? "auto" : "manual"}: ${route.note})`);
  if (opts.plan) {
    say("!! --plan armed: read-only run — edit/write/bash/delegate denied for the whole run (even with --yolo); the output is the plan.");
  }
  if (opts.noStream) {
    setStreamingEnabled(false);
    say("!! --no-stream armed: whole-body responses (SSE off for this process).");
  }
  if (opts.yolo) {
    say("!! --yolo is explicit, logged, bannered. The denylist still applies (spelling-normalized) — and the ask ladder, worktree wall, and signed audit remain the enforcement boundary; no string screen is absolute.");
  }
  if (opts.retryWait) {
    say("!! --retry-wait armed: one wait up to 60s on 429. Avoid in CI.");
  }
  say(`model: ${opts.provider}:${opts.model}`);
  const runCfg = getProviderConfig(opts.provider);
  if (runCfg === null) {
    console.error(`codewhip: unknown provider "${opts.provider}" (see: codewhip provider list)`);
    process.exitCode = 1;
    printStubReceipt(opts.model, opts.provider);
    return;
  }
  // Consent gate: no exact provider:model entry, no run — the same rule serve
  // enforces. Loopback locals are exempt (registration is the consent there).
  if (!isLoopbackBaseUrl(runCfg.baseUrl) && !isModelAllowed(opts.provider, opts.model)) {
    console.error(`codewhip: model "${opts.provider}:${opts.model}" is not enabled — run: codewhip provider enable ${opts.provider}:${opts.model} (see: codewhip provider allowed)`);
    process.exitCode = 1;
    logPreLoopDeny(process.cwd(), opts.prompt, opts.model, "route:model-not-enabled", `${opts.provider}:${opts.model} not enabled`);
    printStubReceipt(opts.model, opts.provider);
    return;
  }
  if (opts.models.length > 1) {
    const kept = opts.models.filter((m) => isLoopbackBaseUrl(runCfg.baseUrl) || isModelAllowed(opts.provider, m));
    if (kept.length !== opts.models.length) {
      say(`!! rotation pruned to enabled models: ${opts.models.join(" -> ")} → ${kept.join(" -> ") || "(none left)"} (enable with: codewhip provider enable ${opts.provider}:<model>)`);
    }
    if (kept.length === 0 && opts.models.length > kept.length) {
      console.error("codewhip: --models rotation has no enabled models left — enable them with: codewhip provider enable <provider>:<model>");
      process.exitCode = 1;
      printStubReceipt(opts.model, opts.provider);
      return;
    }
    opts = { ...opts, models: kept };
  }
  if (opts.models.length > 1) {
    say(`!! rotation armed: on rate-limit/timeout/5xx walk ${opts.models.join(" -> ")} (each once per run)`);
  }
  if (opts.timeoutMs !== undefined) {
    say(`!! --timeout-ms armed: provider calls abort after ${opts.timeoutMs}ms (provider default ${runCfg.timeoutMs}ms overridden)`);
  }
  // Compaction ceiling: model-aware when the provider row carries a VERIFIED
  // context window (0.7×), else the default. Fixed per run from the head
  // provider — a live /model switch does not re-derive it (windowless
  // context-overflow 400s join the rotation path regardless).
  const compactCeiling =
    runCfg.contextWindow !== undefined
      ? Math.min(DEFAULT_COMPACT_TOKENS, Math.floor(runCfg.contextWindow * 0.7))
      : DEFAULT_COMPACT_TOKENS;
  const { key: apiKey, source: keySource } = resolveKey(opts.provider);
  if (apiKey.length === 0) {
    missingKeyHelp(opts.provider);
    logPreLoopDeny(process.cwd(), opts.prompt, opts.model, "route:missing-key", `missing ${opts.provider} key`);
    printStubReceipt(opts.model, opts.provider);
    return;
  }
  if (keySource === "anonymous") {
    // A loopback local runtime resolves the same placeholder source as a
    // keyless free tier, but "rate-limited, log in for higher limits" is
    // simply false there — there is no quota and no key to log in with.
    if (isLoopbackBaseUrl(runCfg.baseUrl)) {
      say(`auth: ${opts.provider} local runtime at ${runCfg.baseUrl} — no credential needed, nothing is billed`);
    } else {
      say(`auth: ${opts.provider} anonymous (no key stored, rate-limited) — codewhip auth login ${opts.provider} for higher limits (${runCfg.keyUrl})`);
    }
  }
  let failoverTargets: FailoverTarget[] = [];
  if (opts.free || opts.autoFailover) {
    failoverTargets = freeChain;
    if (route.taskClass === "private") {
      // Explicit-provider consent covers ONE cloud target: silent hops to
      // other providers would exceed it, so private runs stay head-only.
      // (Private without an explicit provider was already refused above.)
      failoverTargets = [];
      say("!! private run: head provider only — no silent hops (consent covers one target)");
    } else if (failoverTargets.length > 0) {
      say(opts.autoFailover
        ? `!! --auto-failover armed: ${failoverTargets.length} silent $0 fallback(s) — hops recorded in the outcome/audit, not printed (exhaustion still reports what was tried)`
        : `!! --free armed: on rate-limit/timeout/5xx walk ${failoverTargets.map((t) => `${t.label}:${t.model}`).join(" -> ")} (free chain: never bills pay-go)`);
    } else {
      say(opts.autoFailover
        ? "!! --auto-failover armed: head only — no other free provider has a key yet (see: codewhip free)"
        : "!! --free armed: head only — no other free provider has a key yet (see: codewhip free) (free chain: never bills pay-go)");
    }
  } else if (opts.failover) {
    const defaultModel = runCfg.defaultModel;
    if (opts.model !== defaultModel) {
      console.error("codewhip: --failover needs the default model first (drop --model/--models, or lead the chain with it)");
      process.exitCode = 1;
      printStubReceipt(opts.model, opts.provider);
      return;
    }
    const next = listAllProviderConfigs()
      .map((c) => c.id)
      .find((id) => id !== opts.provider && resolveKey(id).key.length > 0 && isModelAllowed(id, getProviderConfig(id)?.defaultModel ?? ""));
    if (next === undefined) {
      console.error("codewhip: --failover needs another provider with a key AND an enabled default model (env var or: codewhip auth login <other>; enable models with: codewhip provider enable <provider>:<model>)");
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
    say(`!! --failover armed: one switch to ${next}:${targetModel} on rate-limit/timeout/5xx. May bill ${next} pay-go.`);
    const { key: failoverKey, source: failoverSource } = resolveKey(next);
    failoverTargets = [{
      label: next,
      model: targetModel,
      port: makePortForConfig(nextCfg, failoverKey, undefined, failoverSource),
    }];
  }
  // Run-scoped request shaping, resolved pre-flight (before a token is spent)
  // so an unreadable --append-system-prompt-file fails like every other guard.
  let runAppend = opts.appendSystemPrompt ?? "";
  if (opts.appendSystemPromptFile !== undefined) {
    const appendPath = path.resolve(process.cwd(), opts.appendSystemPromptFile);
    let size = -1;
    try {
      size = fs.statSync(appendPath).size;
    } catch {
      size = -1;
    }
    if (size < 0 || size > APPEND_MAX_CHARS) {
      console.error(
        `codewhip: --append-system-prompt-file "${opts.appendSystemPromptFile}" ${size < 0 ? "is unreadable" : `is ${size} bytes, over the ${APPEND_MAX_CHARS} cap`}`
      );
      process.exitCode = 1;
      printStubReceipt(opts.model, opts.provider);
      return;
    }
    const text = fs.readFileSync(appendPath, "utf8");
    runAppend = runAppend.length > 0 ? `${runAppend}\n${text}` : text;
  }
  if (runAppend.length > APPEND_MAX_CHARS) {
    console.error(`codewhip: --append-system-prompt and -file together are ${runAppend.length} chars, over the ${APPEND_MAX_CHARS} cap (it re-pays on every turn)`);
    process.exitCode = 1;
    printStubReceipt(opts.model, opts.provider);
    return;
  }
  if (opts.allowedTools.length > 0) {
    say(`!! --allowed-tools armed: ${opts.allowedTools.map(describeToolFilter).join(", ")} — these asks pass without a prompt, this run only (nothing written to .codewhip/remembered.jsonl)`);
  }
  if (opts.disallowedTools.length > 0) {
    say(`!! --disallowed-tools armed: ${opts.disallowedTools.map(describeToolFilter).join(", ")} — refused above --yolo and remembered rules${opts.disallowedTools.some((f) => (f.tool === "read" || f.tool === "search") && f.shape === null) ? "; delegate is refused too (a subagent reads by proxy)" : ""}`);
  }
  if (runAppend.length > 0) {
    say(`!! system prompt appended: ${runAppend.length} chars, re-sent on every turn of the run`);
  }
  if (opts.excludeDynamicSections) {
    say("!! --exclude-dynamic-system-prompt-sections armed: the delegable-agent roster is left out of the system prompt (refusal notes are never left out — a prompt that hides a refusal produces a model that retries it).");
  }
  const ctrl = new AbortController();
  const onSigint = (): void => {
    ctrl.abort();
  };
  process.on("SIGINT", onSigint);

  // TUI bridge: lazy-import on --tui; headless uses the existing readline
  // promptApproval + console.log onEvent. --no-tui forces headless.
  let askUserFn: AskUser | undefined;
  let onEventFn: (e: LoopEvent) => void;
  let tuiBridge: { stop: () => void } | null = null;
  let tuiModel: { setRunId: (id: string) => void } | null = null;
  // Live /model switch (TUI only): the bridge validates and stages a port;
  // the loop consumes it at the next turn boundary. Headless runs ignore it.
  let pendingSwitch: FailoverTarget | null = null;
  const takePendingSwitch = (): FailoverTarget | null => {
    const t = pendingSwitch;
    pendingSwitch = null;
    return t;
  };
  if (opts.tui && !opts.noTui) {
    say("!! --tui armed: terminal UI enabled (lazy OpenTUI import; headless unaffected if pkg absent).");
    try {
      const tuiMod = await import("./tui/bridge.js");
      const { TuiModel } = await import("./tui/model.js");
      const model = new TuiModel();
      tuiModel = model;
      const bridge = tuiMod.createTuiBridge({
        model,
        signal: ctrl.signal,
        cwd: process.cwd(),
        pollBackground: () => getTaskStatuses().map((t) => ({
          id: t.id,
          label: t.command.slice(0, 40),
          status: t.status,
          preview: t.outputPreview,
        })),
        switchModel: (provider, modelId) => {
          const cfg = getProviderConfig(provider);
          if (cfg === undefined || cfg === null) {
            return `/model: unknown provider "${provider}" (see: codewhip provider list)`;
          }
          const { key, source } = resolveKey(cfg.id);
          if (key.length === 0) {
            return `/model: no key for ${cfg.id} — codewhip auth login ${cfg.id}, or pick a provider with one`;
          }
          const nextModel = modelId ?? cfg.defaultModel;
          pendingSwitch = { label: cfg.id, model: nextModel, port: makePortForConfig(cfg, key, opts.timeoutMs, source) };
          return `model: switching to ${cfg.id}:${nextModel} from the next turn (receipts will show the mix)`;
        },
        describeFree: () => {
          const all = listFreeProviders();
          const usable = freeChainCandidates();
          const keyless = all.filter((r) => r.keyNeeded === "no").length;
          return `free chain: ${usable.length}/${all.length} hops usable now (${keyless} keyless) — \`codewhip free\` lists them; rerun with --free to start on one`;
        },
      });
      bridge.start();
      tuiBridge = bridge;
      askUserFn = bridge.askUser;
      onEventFn = (e: LoopEvent) => bridge.onEvent(e);
    } catch {
      say("!! --tui armed but OpenTUI unavailable — falling back to headless prompts.");
      askUserFn = promptApproval;
      onEventFn = (e) => say(`${e.kind === "tool" ? "▸" : e.kind === "policy" ? "◈" : "◆"} ${e.text}`);
    }
  } else if (opts.noTui) {
    say("!! --no-tui armed: forced 80-col screen-reader-safe output (no TUI).");
    askUserFn = promptApproval;
    onEventFn = (e) => say(`${e.kind === "tool" ? "▸" : e.kind === "policy" ? "◈" : "◆"} ${e.text}`);
  } else {
    askUserFn = promptApproval;
    onEventFn = (e) => say(`${e.kind === "tool" ? "▸" : e.kind === "policy" ? "◈" : "◆"} ${e.text}`);
  }
  // Headless (`-p`): stdout is reserved for data, so run chatter becomes NDJSON
  // events (stream-json) or stderr prose, and no interactive approval is ever
  // offered — the loop then holds-and-denies every ask, the same safe default a
  // non-TTY run already had. Let work through with --yolo or a remembered rule.
  if (opts.headless) {
    askUserFn = undefined;
    onEventFn = (e) => {
      if (outputFormat() === "stream-json") emitEvent(e);
      else say(`${e.kind === "tool" ? "▸" : e.kind === "policy" ? "◈" : "◆"} ${e.text}`);
    };
  }
  // A dollar ceiling is only real where the meter can read: refuse up front on
  // an untracked route instead of shipping an option that silently does nothing.
  const usdCap = opts.maxBudgetUsd;
  if (usdCap !== undefined && estimateCost(opts.provider, opts.model, 1000, 1000) === null) {
    say(`!! --max-budget-usd refused: ${opts.provider}:${opts.model} is unpriced (cost untracked) — cap tokens with --token-budget`);
    process.exitCode = 1;
    printStubReceipt(opts.model, opts.provider);
    return;
  }
  const startedAt = Date.now();
  emitInit({
    version: pkg.version,
    provider: opts.provider,
    model: opts.model,
    task_class: route.taskClass,
    output_format: opts.outputFormat,
    permission_mode: opts.plan ? "plan" : opts.yolo ? "yolo" : "ask",
    ...(opts.allowedTools.length > 0 ? { allowed_tools: opts.allowedTools.map(describeToolFilter) } : {}),
    ...(opts.disallowedTools.length > 0 ? { disallowed_tools: opts.disallowedTools.map(describeToolFilter) } : {}),
    ...(runAppend.length > 0 ? { appended_system_prompt_chars: runAppend.length } : {}),
    ...(opts.excludeDynamicSections ? { exclude_dynamic_system_prompt_sections: true } : {}),
    max_steps: opts.maxSteps,
    token_budget: opts.tokenBudget,
    ...(opts.maxBudgetUsd === undefined ? {} : { max_budget_usd: opts.maxBudgetUsd }),
    cwd: process.cwd(),
  });
  // Carried into the machine document so a scripted run reports the same
  // gate/share facts a human sees on stderr.
  let gateOut: { pass: boolean; reason: string } | undefined;
  let shareOut: { path: string; sha256: string } | undefined;

  try {
    const result = await agentLoop({
      prompt: opts.prompt,
      model: opts.model,
      label: opts.provider,
      taskClass: route.taskClass,
      cwd: process.cwd(),
      maxSteps: opts.maxSteps,
      yolo: opts.yolo,
      stdinIsTTY: process.stdin.isTTY === true && !opts.headless,
      port: makePortForConfig(runCfg, apiKey, opts.timeoutMs, keySource),
      signal: ctrl.signal,
      askUser: askUserFn,
      remembered: listRules(process.cwd()),
      planMode: opts.plan,
      allowedTools: opts.allowedTools,
      disallowedTools: opts.disallowedTools,
      ...(runAppend.length > 0 ? { appendSystemPrompt: runAppend } : {}),
      excludeDynamicSections: opts.excludeDynamicSections,
      retryWait: opts.retryWait,
      failovers: failoverTargets,
      quietFailover: opts.autoFailover,
      models: opts.models,
      takePendingSwitch,
      tokenBudget: opts.tokenBudget,
      costCheck: usdCap === undefined ? undefined : (buckets) => {
        let metered = 0;
        for (const b of buckets) {
          const c = estimateCost(b.label, b.model, b.prompt, b.completion);
          if (c === null) {
            // The ceiling is a contract; an unpriced hop (failover, /model
            // switch) breaks it, so stop rather than overspend unmeasured.
            return {
              stopReason: "error" as const,
              message: `--max-budget-usd ${usdCap} cannot be metered: ${b.label}:${b.model} is unpriced (cost untracked) — partial transcript kept`,
            };
          }
          metered += c;
        }
        return metered > usdCap
          ? {
            stopReason: "cost_budget" as const,
            message: `cost budget exhausted ($${metered.toFixed(4)}/$${usdCap}) — partial transcript kept`,
          }
          : null;
      },
      compactTokens: compactCeiling,
      history,
      onEvent: onEventFn,
      // Loaded ONCE here, before the run exists: the model can never
      // register or edit a hook mid-run (docs/moat/19-qol-parity.md).
      hooks: loadHooks(process.cwd()),
    });
    // Set runId on the TUI model for the rollback footer.
    tuiModel?.setRunId(result.runId);
    // Thread the transcript forward: single-shot saves below; REPL feeds it
    // back in-memory and saves once on .exit (no per-line files).
    const continued = result.messages.slice(1);
    // Which file this run writes: a fresh run owns a new id, a resumed run
    // accumulates into the session it resumed, a fork starts a new file that
    // records its parent (docs/moat/20-claude-code-parity.md wave 2).
    const ident = sessionIdentity({ currentRunId: result.runId, resumedFrom, fork: opts.forkSession });
    const sessionLabels: SessionLabels = { ...labels, ...(ident.parent === undefined ? {} : { parent: ident.parent }) };
    if (replMode && replState !== undefined) {
      replState.history.length = 0;
      replState.history.push(...continued);
      replState.provider = opts.provider;
      replState.model = opts.model;
      replState.lastRunId = result.runId;
      replState.sessionId = ident.sessionId;
      replState.labels = sessionLabels;
    }
    if (result.cancelled) {
      say("cancelled — partial transcript kept.");
    }
    if (result.error !== undefined) {
      console.error(`codewhip: ${result.error}`);
      process.exitCode = 1;
    } else if (result.text.length > 0) {
      if (!opts.headless) {
        say("");
        say(result.text);
      } else if (opts.outputFormat === "text") {
        // `-p` prints only the result on stdout; json/stream-json carry the
        // same text inside the machine document below instead.
        writeResultText(result.text);
      }
    }
    printMixReceipt(result.usageByModel, opts.provider, opts.model);
    if (result.checkpoints > 0) {
      say(`checkpoints: ${result.checkpoints} file(s) snapshotted — undo: codewhip rollback ${result.runId.slice(0, 8)}`);
    }
    if (result.compact.events > 0) {
      say(`compacted: ${result.compact.truncated} old tool output(s) truncated, ${result.compact.dropped} exchange(s) elided across ${result.compact.events} compaction(s) — transcript kept under the context ceiling`);
    }
    if (result.repeatCalls > 0) {
      say(`repeats: ${result.repeatCalls} identical idempotent tool call(s) served from the run memo instead of re-executing — a weak model wasting steps, not a harness fault`);
    }
    if ((result.auditDropped ?? 0) > 0) {
      say(`!! audit: ${result.auditDropped} entr(y|ies) NOT recorded this run (lock contention or disk failure) — the signed trail has holes for ${result.runId.slice(0, 8)}; investigate before trusting this run's history`);
    }
    say(`runId: ${result.runId} — record judgment: codewhip verdict ${result.runId.slice(0, 8)} <accepted|edited|reverted|rejected>`);
    // Inline provider-health hint — only when this provider has recorded failures,
    // so healthy runs stay quiet. Full breakdown: codewhip stats <provider>.
    const healthRecs = readProviderCalls().filter((r) => r.provider === opts.provider);
    if (healthRecs.length > 0) {
      const ph = summarizeCalls(healthRecs).providers[0];
      if (ph !== undefined && ph.failed > 0) {
        say(`health: ${opts.provider} ${Math.round(ph.successRate * 100)}% ok over ${ph.total} call(s), ${ph.failed} failed — detail: codewhip stats ${opts.provider}`);
      }
    }
    if (route.taskClass === "polish") {
      const gate = polishGate(estimateCost(opts.provider, opts.model, result.promptTokens, result.completionTokens));
      gateOut = gate;
      say(`polish gate: ${gate.pass ? "PASS" : "OPEN"} — ${gate.reason}`);
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
        shareOut = { path: shared.path, sha256: shared.hash };
        say(`share: ${shared.path} (sha256:${shared.hash.slice(0, 16)}…)`);
        if (opts.sharePrint) {
          say("");
          say(renderShareMarkdown(shared.bundle, shared.hash));
        }
      }
    }
    // Opt-in persistence lands on every loop exit path (success/error/cancel):
    // the saved transcript is the post-compaction one — honest. System is
    // stripped (rebuilt fresh on resume); secrets redacted at write time.
    if (opts.persist && !replMode) {
      const ok = saveSession(process.cwd(), sessionRecord({
        sessionId: ident.sessionId,
        runId: result.runId,
        provider: opts.provider,
        model: opts.model,
        messages: continued,
        labels: sessionLabels,
      }));
      if (!ok) {
        console.error("codewhip: session save failed (disk write) — transcript kept in memory only");
      } else {
        const asWhat = sessionLabels.name === undefined
          ? ident.sessionId.slice(0, 8)
          : `${ident.sessionId.slice(0, 8)} ("${sessionLabels.name}")`;
        say(`session: ${asWhat} (${continued.length} messages) — continue: codewhip run "…" -r ${ident.sessionId.slice(0, 8)}`);
      }
    }
    if (opts.headless) {
      const metered = meteredCost(result.usageByModel);
      emitResult(buildResult(result, {
        provider: opts.provider,
        model: opts.model,
        taskClass: route.taskClass,
        durationMs: Date.now() - startedAt,
        receipt: mixReceiptString(result.usageByModel, opts.provider, opts.model),
        costUsd: metered,
        costNote: (result.usageByModel.length > 0
          ? result.usageByModel.map((b) => costNote(b.label, b.model))
          : [costNote(opts.provider, opts.model)]).join(" + "),
        tokenBudget: opts.tokenBudget,
        ...(usdCap === undefined ? {} : { maxBudgetUsd: usdCap }),
        ...(opts.persist ? { sessionId: ident.sessionId } : {}),
        ...(gateOut === undefined ? {} : { polishGate: gateOut }),
        ...(shareOut === undefined ? {} : { share: shareOut }),
      }));
    }
  } finally {
    tuiBridge?.stop();
    process.removeListener("SIGINT", onSigint);
  }
}

function cmdSessions(args: string[]): void {
  const cwd = process.cwd();
  const sub = args[0];
  if (sub === "rename" || sub === "tag") {
    const ref = args[1] ?? "";
    const rest = args.slice(2).join(" ");
    if (ref.length === 0 || rest.length === 0) {
      console.error(`usage: codewhip sessions ${sub} <session> <${sub === "rename" ? "new name" : "tag"}>`);
      console.error("       (a <session> is its name, or any unique id prefix of >=4 chars — see: codewhip sessions)");
      process.exitCode = 1;
      return;
    }
    const out = labelSession(cwd, ref, sub === "rename" ? { name: rest } : { addTag: rest });
    if (!out.ok) {
      console.error(`codewhip: ${out.error}`);
      process.exitCode = 1;
      return;
    }
    const as = out.name ?? out.runId.slice(0, 8);
    const what = sub === "tag" ? `tagged #${sanitizeSessionLabel(rest) ?? rest}` : `named "${as}"`;
    console.log(`sessions ${sub}: ${out.runId.slice(0, 8)} ${what} — resume: codewhip run "…" -r ${as}`);
    return;
  }
  if (sub !== undefined) {
    console.error("usage: codewhip sessions [rename <session> <name> | tag <session> <tag>]");
    process.exitCode = 1;
    return;
  }
  const rows = listSessions(cwd);
  if (rows.length === 0) {
    console.log("sessions: no saved sessions yet (run once with --continue to save one).");
    return;
  }
  console.log(`sessions: ${rows.length} saved (newest first; resume: codewhip run "…" -r <name|prefix>):`);
  for (const r of rows) {
    const who = r.provider.length > 0 && r.model.length > 0 ? `${r.provider}:${r.model}` : r.model || r.provider || "unknown";
    const label = (r.name ?? "").padEnd(12).slice(0, 12);
    const tags = r.tags === undefined || r.tags.length === 0 ? "" : ` #${r.tags.join(" #")}`;
    const from = r.parent === undefined ? "" : ` ←${r.parent.slice(0, 8)}`;
    console.log(`  ${r.runId.slice(0, 8)}  ${label}  ${r.ts.slice(0, 19)}  ${who}  ${r.messages} msgs${tags}${from}  ${r.preview}`);
  }
}

/** How a session gets announced: `1a2b3c4d ("auth")` when it has a name. */
function replSessionLabel(state: ReplState, id: string): string {
  const name = state.labels.name;
  return name === undefined ? id.slice(0, 8) : `${id.slice(0, 8)} ("${name}")`;
}

const MAX_SESSION_TAGS = 8;

/**
 * REPL session commands — `.rename`, `.tag`, `.branch`, `.sessions`. They mutate
 * only in-memory state; the one file write happens on `.exit`, same as the
 * transcript. Returns the lines to print, or null when this is not a session
 * command (so `/foo` still reaches custom commands).
 */
function replSessionCommand(cwd: string, state: ReplState, line: string): string[] | null {
  const m = /^(?:[/.])(rename|tag|branch|sessions)\b\s*(.*)$/u.exec(line);
  if (m === null) return null;
  const verb = m[1] ?? "";
  const arg = (m[2] ?? "").trim();
  const id = state.sessionId ?? state.lastRunId;
  switch (verb) {
    case "rename": {
      if (arg.length === 0) return [`usage: .rename <name>   (${SESSION_NAME_RULE}; -r <name> resumes it)`];
      const clean = sanitizeSessionName(arg);
      if (clean === null) return [`!! rejected: "${arg}" — ${SESSION_NAME_RULE}`];
      const taken = nameTaken(cwd, clean, id ?? "");
      if (taken) return [`!! another session is already named "${clean}" — names stay unique so -r <name> is unambiguous`];
      state.labels.name = clean;
      return [`.rename: this session is now "${clean}" (applies when the transcript saves)`];
    }
    case "tag": {
      if (arg.length === 0) {
        const tags = state.labels.tags;
        return [tags === undefined || tags.length === 0 ? ".tag: no tags yet" : `.tag: #${tags.join(" #")}`];
      }
      const clean = sanitizeSessionLabel(arg);
      if (clean === null) return [`!! rejected: "${arg}" — ${SESSION_TAG_RULE}`];
      const tags = state.labels.tags ?? [];
      if (tags.includes(clean)) return [`.tag: #${clean} already set`];
      if (tags.length >= MAX_SESSION_TAGS) return [`.tag: capped at ${MAX_SESSION_TAGS} tags — drop one by editing .codewhip/sessions/`];
      state.labels.tags = [...tags, clean];
      return [`.tag: #${clean} set (${state.labels.tags.length} tag${state.labels.tags.length === 1 ? "" : "s"})`];
    }
    case "branch": {
      if (id === null) return [".branch: nothing to fork yet — run a prompt first, then .branch"];
      const named = arg.length === 0 ? null : sanitizeSessionName(arg);
      if (arg.length > 0 && named === null) return [`!! rejected: "${arg}" — ${SESSION_NAME_RULE}`];
      const from = id;
      const carried = state.labels.name;
      const nextName = named ?? (carried === undefined ? undefined : `${carried}-branch`);
      // A fork writes a new file, so it owns no name yet — any holder blocks it.
      if (nextName !== undefined && nameTaken(cwd, nextName, "")) {
        return [`!! another session is already named "${nextName}" — .branch <name> with a free one`];
      }
      state.sessionId = null;
      state.labels = {
        tags: [...(state.labels.tags ?? [])],
        parent: from,
        ...(nextName === undefined ? {} : { name: nextName }),
      };
      return [`.branch: the next save forks ${from.slice(0, 8)} into a new session${state.labels.name === undefined ? "" : ` ("${state.labels.name}")`} — history kept, parent recorded`];
    }
    default: {
      const rows = listSessions(cwd);
      if (rows.length === 0) return ["sessions: none saved yet (run once with --continue)"];
      return rows.map((r) => `  ${r.runId.slice(0, 8)}  ${r.name ?? "-"}  ${r.messages} msgs  ${(r.tags ?? []).join(",")}`);
    }
  }
}


/** REPL-local help: tips plus the custom-command table with parse errors. */
function printReplHelp(cwd: string): void {
  console.log("codewhip repl — type a prompt to run it; .exit/.quit to leave; .help for this list.");
  console.log("  /<name> [args] expands .codewhip/commands/<name>.md ($ARGUMENTS substituted) before the run.");
  console.log("  .sessions list · .rename <name> · .tag <tag> · .branch [name] fork this transcript");
  const { commands, errors } = listCommandsWithErrors(cwd);
  if (commands.length === 0) {
    console.log("  no custom commands yet — add .codewhip/commands/<name>.md (body = prompt template).");
  } else {
    for (const c of commands) {
      console.log(`  /${c.name}${c.description.length > 0 ? ` — ${c.description}` : ""}`);
    }
  }
  for (const e of errors) console.error(`  !! ${e}`);
}

function cmdRepl(defaults: Omit<RunOptions, "prompt">): void {
  const cwd = process.cwd();
  const shared: ReplState = {
    history: [],
    provider: defaults.provider,
    model: defaults.model,
    lastRunId: null,
    sessionId: null,
    labels: { tags: [...defaults.sessionTags] },
  };
  if (defaults.sessionName !== undefined) shared.labels.name = defaults.sessionName;
  if (defaults.continue) {
    const loaded = loadSession(cwd, defaults.continuePrefix);
    if (!loaded.ok) {
      console.error(`codewhip: ${loaded.error}`);
      process.exitCode = 1;
      printStubReceipt(defaults.model, defaults.provider);
      return;
    }
    shared.history.push(...loaded.record.messages.filter((m) => m.role !== "system"));
    if (loaded.record.provider.length > 0) shared.provider = loaded.record.provider as ProviderId;
    if (loaded.record.model.length > 0) shared.model = loaded.record.model;
    shared.sessionId = loaded.record.runId;
    if (defaults.sessionName === undefined && loaded.record.name !== undefined) shared.labels.name = loaded.record.name;
    if (defaults.sessionTags.length === 0 && loaded.record.tags !== undefined) shared.labels.tags = [...loaded.record.tags];
    if (loaded.record.parent !== undefined) shared.labels.parent = loaded.record.parent;
    console.log(`!! --continue armed: resuming ${replSessionLabel(shared, loaded.record.runId)} (${shared.history.length} prior messages) — transcript saved on exit (raw prompts on disk)`);
  } else if (defaults.persist) {
    console.log(`!! ${defaults.sessionName === undefined ? "--tag" : `--name "${defaults.sessionName}"`} arms session saving: this transcript will be written on .exit (raw prompts on disk, secrets redacted)`);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("codewhip repl (preview) — type a prompt, .exit to quit.");
  rl.setPrompt("codewhip> ");
  rl.prompt();
  let saved = false;
  const saveOnExit = (): void => {
    if (saved || !defaults.persist) return;
    saved = true;
    // Nothing new this REPL session: no file, no noise.
    if (shared.lastRunId === null) return;
    const ok = saveSession(cwd, sessionRecord({
      sessionId: shared.sessionId ?? shared.lastRunId,
      runId: shared.lastRunId,
      provider: shared.provider,
      model: shared.model,
      messages: [...shared.history],
      labels: shared.labels,
    }));
    if (ok) {
      console.log(`session: ${shared.sessionId ?? shared.lastRunId} (${shared.history.length} messages) — continue: codewhip run "…" -r ${(shared.sessionId ?? shared.lastRunId).slice(0, 8)}`);
    }
  };
  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (trimmed === ".exit" || trimmed === ".quit") {
      rl.close();
      return;
    }
    if (trimmed === ".help") {
      printReplHelp(cwd);
      rl.prompt();
      return;
    }
    if (trimmed.length > 0) {
      const builtIn = replSessionCommand(cwd, shared, trimmed);
      if (builtIn !== null) {
        for (const out of builtIn) console.log(out);
        rl.prompt();
        return;
      }
      // In the REPL a leading "/" is unambiguous intent: unknown commands
      // error to the user instead of being sent blind to the model.
      const expanded = trimmed.startsWith("/") ? expandCommand(cwd, trimmed) : null;
      if (expanded !== null && "error" in expanded) {
        console.error(`codewhip: ${expanded.error}`);
        rl.prompt();
        return;
      }
      const promptText = expanded !== null ? expanded.prompt : trimmed;
      // continue:false here: persistence is deferred to .exit (one file for
      // the whole REPL), while history threads in-memory via shared.
      void cmdRun({ ...defaults, prompt: promptText, continue: false }, shared).finally(() => rl.prompt());
      return;
    }
    rl.prompt();
  });
  rl.on("close", () => {
    saveOnExit();
    printStubReceipt(shared.model, shared.provider);
  });
  rl.on("SIGINT", () => {
    rl.close();
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
      const lockWarning = saveKey(provider, key);
      console.log(`auth: ${provider} saved (source: file, ${configDir()})`);
      if (lockWarning !== null) console.warn(`auth: warning: ${lockWarning}`);
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

/** Fixture tasks ship at the package root (uncompiled) — resolve from this file. */
function defaultEvalTasksRoot(): string {
  const here = fileURLToPath(import.meta.url);
  const pkgRoot = path.resolve(path.dirname(here), "..");
  const local = path.join(process.cwd(), EVAL_TASKS_DIR);
  if (fs.existsSync(local)) return local;
  return path.join(pkgRoot, EVAL_TASKS_DIR);
}

async function cmdEval(args: string[]): Promise<void> {
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : undefined;
  };
  const only = flag("--task");
  const keep = args.includes("--keep");
  const maxSteps = Number(flag("--max-steps") ?? 25);
  const tokenBudgetRaw = flag("--token-budget");
  const tokenBudget = tokenBudgetRaw !== undefined ? Number(tokenBudgetRaw) : undefined;
  const timeoutSec = Number(flag("--timeout-sec") ?? 600);
  const tasksRoot = flag("--tasks") ?? defaultEvalTasksRoot();
  if (!Number.isFinite(maxSteps) || maxSteps < 1 || maxSteps > 100) {
    console.error("codewhip eval: --max-steps must be 1..100");
    process.exitCode = 1;
    return;
  }
  if (!Number.isFinite(timeoutSec) || timeoutSec < 30 || timeoutSec > 3600) {
    console.error("codewhip eval: --timeout-sec must be 30..3600");
    process.exitCode = 1;
    return;
  }
  if (tokenBudget !== undefined && (!Number.isFinite(tokenBudget) || tokenBudget < 1000)) {
    console.error("codewhip eval: --token-budget must be a number >= 1000");
    process.exitCode = 1;
    return;
  }
  // Provider/model resolution mirrors `run`: explicit flags win, --free walks
  // to the first usable chain hop, otherwise the run default (nvidia).
  let provider = flag("--provider");
  let model = flag("--model");
  if (model !== undefined && provider === undefined) {
    console.error("codewhip eval: --model needs --provider (or use --free)");
    process.exitCode = 1;
    return;
  }
  if (args.includes("--free")) {
    const head = freeChainCandidates()[0];
    if (head === undefined) {
      console.error("codewhip eval: --free found no runnable free provider — see: codewhip free");
      process.exitCode = 1;
      return;
    }
    provider = head;
  }
  provider = provider ?? "nvidia";
  const cfg = getProviderConfig(provider);
  if (cfg === null || cfg === undefined) {
    console.error(`codewhip eval: unknown provider "${provider}" (see: codewhip provider list)`);
    process.exitCode = 1;
    return;
  }
  const { key, source } = resolveKey(cfg.id);
  if (key.length === 0) {
    missingKeyHelp(cfg.id);
    process.exitCode = 1;
    return;
  }
  model = model ?? cfg.defaultModel;
  const { tasks, errors } = listEvalTasks(tasksRoot, only);
  for (const e of errors) {
    console.error(`eval: task "${e.name}" skipped — ${e.error}`);
  }
  if (tasks.length === 0) {
    console.error(`codewhip eval: no runnable tasks under ${tasksRoot}${only !== undefined ? ` matching "${only}"` : ""}`);
    process.exitCode = 1;
    return;
  }
  console.log(`eval: ${tasks.length} task(s) · ${provider}:${model}${source === "anonymous" ? " (anonymous)" : ""} · max-steps ${maxSteps} · per-task timeout ${timeoutSec}s`);
  console.log("eval: fixtures run in disposable temp dirs — yolo armed there (the dir is the sandbox; the denylist still applies), checkers live outside the agent's reach.");
  const { results } = await runEval({
    tasksRoot,
    cwd: process.cwd(),
    only,
    port: makePortForConfig(cfg, key, undefined, source),
    provider: cfg.id,
    model,
    maxSteps,
    tokenBudget,
    taskTimeoutMs: timeoutSec * 1000,
    keepTemp: keep,
    onLog: (line) => console.log(line),
  });
  if (results.length === 0) {
    console.error("eval: no tasks ran");
    process.exitCode = 1;
    return;
  }
  const passed = results.filter((r) => r.pass).length;
  const promptTokens = results.reduce((s, r) => s + r.promptTokens, 0);
  const completionTokens = results.reduce((s, r) => s + r.completionTokens, 0);
  console.log("");
  console.log(`eval: ${passed}/${results.length} task(s) pass this run · receipt: ${promptTokens} prompt + ${completionTokens} completion tokens (est. where the provider hides usage)`);
  const allTime = summarizeEval(readEvalRecords(process.cwd()));
  const barFor = (cls: string): string => (cls === "polish" ? "≥70%" : "≥50%");
  for (const [cls, score] of Object.entries(allTime)) {
    if (score === null) continue;
    const pct = Math.round((score.pass / score.total) * 100);
    const met = pct >= (cls === "polish" ? 70 : 50);
    console.log(`eval bar [${cls}]: ${score.pass}/${score.total} pass (${pct}%) — bar ${barFor(cls)} ${met ? "MET" : "NOT MET"} (latest run per task wins)`);
  }
  console.log("eval: history in .codewhip/eval.jsonl — codewhip metrics folds it into the task-success bars.");
  if (passed < results.length) process.exitCode = 1;
}

const PROVIDER_ADD_USAGE = 'usage: codewhip provider add <id> --base-url https://… --model <id> --env-var FOO_API_KEY [--chat-path /…] [--models-path /…] [--key-url https://…] [--brand <name>] [--timeout-ms 45000]';function cmdProvider(args: string[]): void {
  const sub = args[0] ?? "list";
  if (sub === "list") {
    const all = listAllProviderConfigs();
    const nCustom = all.filter((c) => !isBuiltinProviderId(c.id)).length;
    console.log(`provider: ${all.length} known (${all.length - nCustom} builtin + ${nCustom} custom):`);
    for (const c of all) {
      const { source } = resolveKey(c.id);
      const tag = isBuiltinProviderId(c.id) ? "builtin" : "custom";
      const key = source === "none" ? "no key" : source;
      const n = allowedModelsFor(c.id).length;
      console.log(`  ${c.id} [${tag}] ${c.baseUrl} default=${c.defaultModel} env=${c.envVar} key=${key} enabled=${n}`);
    }
    const total = loadAllowedEntries().length;
    console.log(total === 0
      ? "allowlist: EMPTY — deny by default, nothing is callable. Enable with: codewhip provider enable <provider>:<model>"
      : `allowlist: ${total} model(s) enabled (deny by default; \`codewhip provider allowed\` lists them)`);
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
    console.log(`  enabled ${result.id}:${model} (registration is consent — add more models with: codewhip provider enable ${result.id}:<model>)`);
    if (isLoopbackBaseUrl(baseUrl)) {
      console.log("  local runtime: no credential needed — the router's `private` class routes here");
    } else {
      console.log(`  next: set a key via $env:${envVar} = "…" or: codewhip auth login ${result.id}`);
    }
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
    console.log(`provider: removed "${id}" (stored key, if any, left in place — clear with: codewhip auth logout ${id}; its allowlist entries were dropped)`);
    return;
  }
  if (sub === "enable" || sub === "disable") {
    const raw = args.slice(1).join(",").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    if (raw.length === 0) {
      console.error(`usage: codewhip provider ${sub} <provider>:<model>[,<provider>:<model>…]`);
      console.error("  exact ids only — there are no wildcards. The first colon splits provider from model,");
      console.error("  so ids like kilo:cohere/north-mini-code:free keep their own colons.");
      process.exitCode = 1;
      return;
    }
    if (sub === "enable") {
      const result = enableEntries(raw);
      if (!result.ok) {
        console.error(`provider: ${result.error}`);
        process.exitCode = 1;
        return;
      }
      console.log(result.added.length > 0
        ? `provider: enabled ${result.added.join(", ")}`
        : "provider: already enabled (nothing changed)");
    } else {
      const result = disableEntries(raw);
      if (!result.ok) {
        console.error(`provider: ${result.error}`);
        process.exitCode = 1;
        return;
      }
      console.log(result.removed.length > 0
        ? `provider: disabled ${result.removed.join(", ")}`
        : "provider: nothing was enabled (nothing changed)");
    }
    console.log("  a running `codewhip serve` honors this within its 60s catalog cache (chat gating is immediate)");
    return;
  }
  if (sub === "allowed") {
    const entries = loadAllowedEntries();
    if (entries.length === 0) {
      console.log("allowlist: EMPTY — deny by default. Enable with: codewhip provider enable <provider>:<model> (or model-by-model at the /auth UI).");
      return;
    }
    console.log(`allowlist: ${entries.length} model(s) enabled:`);
    for (const e of entries) console.log(`  ${e}`);
    return;
  }
  console.log("Usage: codewhip provider [list|show <id>|add <id> --base-url …|remove <id>|enable <p:m>[,…]|disable <p:m>[,…]|allowed]");
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
    const raw = verifyChain(cwd);
    const v = interpretVerification(raw, cwd);
    console.log(
      `audit: ${raw.total} entries — hash chain ${v.status} (${raw.signed} signed / ${raw.unsigned} unsigned, ${raw.keyPresent ? "key present" : "no local key"})`
    );
    for (const p of v.problems) {
      console.log(`  ! ${p}`);
    }
    if (!v.clean) {
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
  // --auto: propose a verdict from mechanical evidence (checkpoints vs the
  // tree, git cross-check) and confirm interactively — removes the manual
  // crank (remembering runIds, diffing by hand) while keeping the judgment
  // human-attached.
  if (args[0] === "--auto") {
    const prefix = args[1] ?? "";
    if (prefix.length < 4) {
      console.error("verdict: usage — codewhip verdict --auto <runId-prefix> (prefix >=4 chars; runIds print at the end of every run)");
      process.exitCode = 1;
      return;
    }
    const hits = resolveRunPrefix(cwd, prefix);
    if (hits.length === 0) {
      console.error(`verdict: no run starts with "${prefix}"`);
      process.exitCode = 1;
      return;
    }
    if (hits.length > 1) {
      console.error(`verdict: ambiguous prefix "${prefix}" (${hits.length} runs) — use more chars`);
      process.exitCode = 1;
      return;
    }
    const runId = hits[0] as string;
    const proposal = proposeVerdict(cwd, runId);
    if ("error" in proposal) {
      console.error(`verdict: ${proposal.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`verdict: proposal for ${runId.slice(0, 8)} — ${proposal.verdict} (confidence: ${proposal.confidence})`);
    for (const line of proposal.evidence) {
      console.log(`  · ${line}`);
    }
    if (process.stdin.isTTY !== true) {
      console.error("verdict: non-interactive session — confirm by passing an explicit verdict: codewhip verdict <prefix> <accepted|edited|reverted|rejected>");
      process.exitCode = 1;
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("record this verdict? [y]es / [n]o, or type a different one (accepted/edited/reverted/rejected): ", (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      let chosen: Verdict | null = null;
      if (a === "y" || a === "yes") chosen = proposal.verdict;
      else if (isVerdict(a)) chosen = a;
      else if (a === "n" || a === "no" || a.length === 0) {
        console.log("verdict: nothing recorded.");
        return;
      } else {
        console.error(`verdict: "${a}" is not a judgment — nothing recorded.`);
        process.exitCode = 1;
        return;
      }
      if (!setVerdict(cwd, runId, chosen)) {
        console.error("verdict: failed to write (disk write)");
        process.exitCode = 1;
        return;
      }
      console.log(`verdict: ${runId.slice(0, 8)} → ${chosen} (.codewhip/verdicts.jsonl — feeds codewhip metrics)`);
    });
    return;
  }
  const prefix = args[0] ?? "";
  const value = args[1] ?? "";
  if (prefix === "--auto" || prefix === "-a") {
    console.error("verdict: usage — codewhip verdict --auto <runId-prefix>");
    process.exitCode = 1;
    return;
  }
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

/** Inspect and revoke remembered grants (consent must be revocable). */
function cmdRemember(args: string[]): void {
  const cwd = process.cwd();
  const sub = args[0] ?? "list";
  if (sub === "list") {
    const rules = listRules(cwd);
    if (rules.length === 0) {
      console.log("remember: no rules stored (.codewhip/remembered.jsonl) — every ask-class call prompts.");
      return;
    }
    console.log(`remember: ${rules.length} rule(s) — the agent auto-runs these without asking (revoke: codewhip remember forget <tool:shape>):`);
    for (const r of rules) {
      const scope =
        r.tool === "bash"
          ? `every "${r.shape.replace(/ \*$/, "")}" command`
          : r.tool === "webfetch"
            ? `every fetch to ${r.shape}`
            : `the exact path ${r.shape}`;
      console.log(`  ${r.tool}:${r.shape}  (granted ${r.ts.slice(0, 10)} in run ${r.runId.slice(0, 8)} — covers ${scope})`);
    }
    return;
  }
  if (sub === "forget") {
    const raw = args[1] ?? "";
    const sep = raw.indexOf(":");
    const tool = raw.slice(0, sep);
    const shape = raw.slice(sep + 1);
    if (sep <= 0 || shape.length === 0) {
      console.error('usage: codewhip remember forget "<tool:shape>"  (see: codewhip remember list)');
      process.exitCode = 1;
      return;
    }
    if (removeRule(cwd, tool, shape)) {
      console.log(`remember: revoked ${tool}:${shape} — future runs ask again (the revocation lands on the audit trail)`);
      appendEntry(cwd, {
        runId: "revocation",
        actor: "human",
        tool: "remember",
        args_hash: sha256Hex(`${tool}:${shape}`),
        result_hash: sha256Hex("revoked"),
        policy: "allow:remember-revoke",
      });
    } else {
      console.error(`remember: no rule "${raw}" found (see: codewhip remember list)`);
      process.exitCode = 1;
    }
    return;
  }
  console.log("Usage: codewhip remember [list|forget \"<tool:shape>\"]");
}

function cmdTrust(args: string[]): void {
  const cwd = process.cwd();
  const jsonOutput = args.includes("--json");
  const verbose = args.includes("--verbose");
  const lines: string[] = ["codewhip trust — single-command trust certificate"];
  const broken: string[] = []; // things that are WRONG (fail closed)
  const unproven: string[] = []; // things merely not yet evidenced

  // 1. Audit chain — ONE interpretation shared with `audit --verify` and
  // `demo` (product panel: two verifiers must never disagree).
  const raw = verifyChain(cwd);
  const v = interpretVerification(raw, cwd);
  const chainClean = v.clean;
  lines.push(`  audit chain: ${v.status} (${raw.total} entries, ${raw.signed} signed, ${raw.unsigned} unsigned${raw.keyPresent ? ", key present" : ", no local key"})`);
  if (!chainClean) {
    for (const p of v.problems) {
      lines.push(`    ! ${p}`);
    }
    broken.push("audit");
  }

  // 2. Base policy (codewhip-policy.yaml) + promoted denies (policy.md)
  const basePolicyPath = path.join(cwd, "codewhip-policy.yaml");
  let baseDenies = 0;
  if (fs.existsSync(basePolicyPath)) {
    const rawYaml = fs.readFileSync(basePolicyPath, "utf8");
    // YAML format: deny: followed by - "command" lines
    let inDenySection = false;
    for (const line of rawYaml.split("\n")) {
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
  const denyWord = (n: number): string => `den${n === 1 ? "y" : "ies"}`;
  lines.push(`  policy: ${baseDenies} base ${denyWord(baseDenies)} + ${promotedDenies.length} promoted ${denyWord(promotedDenies.length)} active`);
  if (baseDenies === 0 && promotedDenies.length === 0) {
    broken.push("policy");
  }

  // 3. Polish gate — evaluate from the last polish run's actual cost
  // (task_class when recorded; model-substring markers for older runs).
  const outcomes = readOutcomeRecords(cwd);
  const polishRuns = outcomes.filter(isPolishRun);
  let polishGateStatus = "no polish run recorded";
  let polishGatePassed = false;
  if (polishRuns.length > 0) {
    const lastPolish = polishRuns[polishRuns.length - 1] as OutcomeRecord;
    const cost = polishRunCost(lastPolish);
    const gate = polishGate(cost);
    polishGatePassed = gate.pass;
    polishGateStatus = gate.pass ? `PASS (${gate.reason})` : `OPEN (${gate.reason})`;
  }
  lines.push(`  polish gate: ${polishGateStatus}`);
  if (!polishGatePassed) {
    unproven.push("polish");
  }

  // 4. Memory accruing — evidence of the compounding loop, never a nudge to
  // press `a` (the UX panel: a trust certificate must not farm grants).
  const remembered = listRules(cwd);
  const hasMemory = remembered.length > 0;
  lines.push(`  memory: ${remembered.length} remembered rule(s) accruing${hasMemory ? " — inspect: codewhip remember list" : ""}`);
  if (!hasMemory) {
    unproven.push("memory");
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
  if (usableKeys.length === 0 && anonymousKeys.length === 0) {
    broken.push("keys");
  }

  // 6. Policy file check — show both files
  lines.push(`  codewhip-policy.yaml: ${baseDenies > 0 ? "active (has base denies)" : "empty or missing"}`);
  lines.push(`  policy.md: ${promotedDenies.length > 0 ? `${promotedDenies.length} promoted ${denyWord(promotedDenies.length)}` : "no promoted denies"}`);

  // Summary — three tiers (product panel): BROKEN things fail; a clean repo
  // with missing evidence is UNPROVEN, not NEEDS WORK.
  const verdict = broken.length > 0 ? "NEEDS WORK" : unproven.length > 0 ? "UNPROVEN" : "PASS";
  const allGood = verdict === "PASS";

  if (jsonOutput) {
    const nextSteps: string[] = [];
    if (broken.includes("audit")) nextSteps.push("codewhip audit --verify");
    if (broken.includes("policy")) nextSteps.push("codewhip init (creates base policy with 3 denies)");
    if (broken.includes("keys")) nextSteps.push("codewhip auth login <provider> (or set env var)");
    if (unproven.includes("memory")) nextSteps.push("codewhip remember list (inspect stored rules)");
    if (unproven.includes("polish") && polishRuns.length > 0) nextSteps.push('codewhip run --class polish "..." (prove <$0.05)');
    const output = {
      trust: verdict.replace(" ", "_"),
      auditChain: {
        status: chainClean ? "INTACT" : "BROKEN",
        total: raw.total,
        signed: raw.signed,
        unsigned: raw.unsigned,
        keyPresent: raw.keyPresent,
        problems: chainClean ? [] : raw.problems,
      },
      policy: {
        baseDenies,
        promotedDenies: promotedDenies.length,
        codewhipPolicyYaml: baseDenies > 0,
        policyMd: promotedDenies.length > 0,
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
      nextSteps,
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  lines.push("");
  lines.push(`TRUST: ${verdict}`);
  const suggestions: string[] = [];
  if (broken.includes("audit")) suggestions.push("codewhip audit --verify");
  if (broken.includes("policy")) suggestions.push("codewhip init (creates base policy with 3 denies)");
  if (broken.includes("keys")) suggestions.push("codewhip auth login <provider> (or set env var)");
  if (unproven.includes("memory")) suggestions.push("codewhip remember list (see what the agent may auto-run)");
  if (unproven.includes("polish") && polishRuns.length > 0) suggestions.push('codewhip run --class polish "..." (prove <$0.05)');
  if (suggestions.length > 0) {
    lines.push("  next: " + suggestions.join(" | "));
  }
  void allGood;
  console.log(lines.join("\n"));
}

async function cmdServe(args: string[]): Promise<void> {
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const rawPort = flag("--port") ?? "8787";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`serve: bad --port "${rawPort}" (need an integer 0..65535)`);
    process.exitCode = 1;
    return;
  }
  // llm7 is the default on purpose: it is keyless, so `codewhip serve` works
  // with no setup at all. Point it anywhere else with --provider, or pass
  // --provider auto for a health-weighted pick per request (free keys only —
  // paid keys on untracked-cost routes are never auto-touched; recent
  // failures deactivated by TTL).
  const provider = flag("--provider") ?? "llm7";
  const cfg = provider === "auto" ? null : getProviderConfig(provider);
  if (provider !== "auto" && cfg === null) {
    console.error(`serve: unknown provider "${provider}" (see: codewhip provider list)`);
    process.exitCode = 1;
    return;
  }
  const opts: ServeOptions = {
    port,
    host: flag("--host") ?? "127.0.0.1",
    provider,
    model: flag("--model") ?? cfg?.defaultModel ?? "auto",
  };
  const token = flag("--token");
  if (token !== undefined) opts.token = token;
  opts.authUi = args.indexOf("--no-auth-ui") === -1;
  opts.pingModels = args.includes("--ping-models");
  const { createShutdown, startServe } = await import("./serve.js");
  try {
    const server = startServe(opts);
    // Idempotent by construction — see createShutdown. Repeated signals must
    // not stack close listeners, and idle keep-alive sockets must not hold the
    // process open (that hang is what makes an operator press Ctrl-C again).
    const controller = createShutdown(server, (code) => process.exit(code));
    const onSignal = (): void => {
      if (!controller.isShuttingDown()) {
        console.log("");
        console.log("serve: shutting down (press Ctrl-C again to force)");
      }
      controller.shutdown();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  } catch (err) {
    console.error(`serve: ${err instanceof Error ? err.message : "failed to start"}`);
    process.exitCode = 1;
  }
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
      if (process.stdin.isTTY === true && !opts.stdinPrompt) {
        if (opts.headless) {
          console.error('codewhip: -p needs a prompt — pass one, or pipe it (echo "…" | codewhip run -p -)');
          process.exitCode = 1;
          return;
        }
        cmdRepl(opts);
        return;
      }
      // No positional prompt: stdin *is* the prompt, so wait for it.
      const piped = await readStdin(process.stdin);
      if (piped.error !== undefined) {
        console.error(`codewhip: ${piped.error}`);
        process.exitCode = 1;
        return;
      }
      if (piped.text === undefined) {
        console.error('usage: codewhip run "<prompt>" [--model id] [--token-budget 250000] [--max-steps 25] (see: codewhip help run)');
        process.exitCode = 1;
        return;
      }
      opts.prompt = piped.text;
    } else if (opts.stdinPrompt) {
      console.error("codewhip: `-` (read the prompt from stdin) cannot combine with a positional prompt");
      process.exitCode = 1;
      return;
    } else if (process.stdin.isTTY !== true) {
      // `cat diff.patch | codewhip run -p "review this"` — Claude Code's
      // idiom: the query is the argument, the pipe is the material.
      const piped = await readStdin(process.stdin, STDIN_CONTEXT_WAIT_MS);
      if (piped.error !== undefined) {
        console.error(`codewhip: ${piped.error}`);
        process.exitCode = 1;
        return;
      }
      if (piped.text !== undefined) {
        opts.prompt = `${opts.prompt}\n\n${piped.text}`;
        say(`stdin: ${piped.text.length} chars appended to the prompt as context`);
      }
    }
    // One-shot lenient expansion: only an EXACT command-file match rewrites
    // the prompt — path-like prompts ("/api endpoint 500") run verbatim.
    const expanded = maybeExpandCommand(process.cwd(), opts.prompt);
    if (expanded !== null && "error" in expanded) {
      console.error(`codewhip: ${expanded.error}`);
      process.exitCode = 1;
      return;
    }
    if (expanded !== null) opts.prompt = expanded.prompt;
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
  if (command === "eval") {
    await cmdEval(args.slice(1));
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
  if (command === "remember") {
    cmdRemember(args.slice(1));
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
  if (command === "sessions") {
    cmdSessions(args.slice(1));
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
  if (command === "serve") {
    await cmdServe(args.slice(1));
    return;
  }
  console.error(`unknown command: ${command}`);
  console.error('try: codewhip help');
  process.exitCode = 1;
}

// Exported for unit tests (sessions --continue parsing). Guarded so importing
// this module never runs the CLI as a side effect.
export { parseRunArgs, cmdRun, cmdSessions, cmdRepl, replSessionCommand, type ReplState };

const entry = process.argv[1] ?? "";
if (entry.endsWith("index.ts") || entry.endsWith("index.js")) {
  void main();
}
