import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { notEnabledMessage, providersAllowing, unconsentedAgentModels } from "./agent-consent.js";
import { addCustomProvider } from "./custom-providers.js";
import { saveAllowedEntries } from "./model-allowlist.js";
import { CONFIG_DIR_ENV } from "./config-dir.js";

/**
 * Consent for the model ids a delegated child could dial (`src/agent-consent.ts`).
 *
 * The defect this pins: a child's `model:` rides the PARENT's port with no
 * check against the allowlist (`runChildAgent` in `src/subagents.ts`), so a
 * repo-committed `.codewhip/agents/<n>.md` could dial any id the provider
 * accepts on the operator's key — the file's body even replaces the child's
 * system prompt. `isModelAllowed` gates the run's own model in
 * `src/index.ts` and `src/sdk.ts`; neither mouth gated the roster.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-consent-cfg-"));
process.env[CONFIG_DIR_ENV] = dir;

/** A workspace with one agent file. `model` lines are written by each case. */
function workspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-consent-ws-"));
  fs.mkdirSync(path.join(cwd, ".codewhip", "agents"), { recursive: true });
  return cwd;
}

function writeAgent(cwd: string, name: string, body: string): void {
  fs.writeFileSync(path.join(cwd, ".codewhip", "agents", `${name}.md`), body, "utf8");
}

test("an entry with no model is never a problem", () => {
  const cwd = workspace();
  writeAgent(cwd, "plain", "---\ndescription: no pin\n---\nReport findings.\n");
  assert.deepEqual(unconsentedAgentModels(cwd, [], ["nvidia"], dir), []);
});

test("a committed pin that is not enabled for the run's provider is refused", () => {
  saveAllowedEntries(["nvidia:moonshotai/kimi-k3"], dir);
  const cwd = workspace();
  writeAgent(cwd, "review", "---\ndescription: pin\nmodel: expensive/model\n---\nReport findings.\n");
  const pins = unconsentedAgentModels(cwd, [], ["nvidia"], dir);
  assert.equal(pins.length, 1);
  assert.equal(pins[0]?.name, "review");
  assert.equal(pins[0]?.model, "expensive/model");
});

test("a pin enabled for ANOTHER provider is still refused (an agent's model is a model on the run's provider)", () => {
  saveAllowedEntries(["nvidia:moonshotai/kimi-k3", "kilo:cohere/north-mini-code:free"], dir);
  const cwd = workspace();
  writeAgent(cwd, "cheap", "---\ndescription: pin\nmodel: cohere/north-mini-code:free\n---\nReport.\n");
  assert.equal(unconsentedAgentModels(cwd, [], ["nvidia"], dir).length, 1);
  // ...and the same pin on the provider that does hold it is fine.
  assert.deepEqual(unconsentedAgentModels(cwd, [], ["kilo"], dir), []);
});

test("the pin is graded on EVERY provider the run can hand a child (consent covers one target at a time)", () => {
  saveAllowedEntries(["nvidia:moonshotai/kimi-k3", "kilo:cohere/north-mini-code:free"], dir);
  const cwd = workspace();
  writeAgent(cwd, "cheap", "---\ndescription: pin\nmodel: cohere/north-mini-code:free\n---\nReport.\n");
  // Enabled on the head is not enough: a failover hop could hand the child a
  // port it was never consented on, which is the same rule a private run uses
  // to lose its hops.
  assert.equal(unconsentedAgentModels(cwd, [], ["kilo", "opencode"], dir).length, 1);
  assert.deepEqual(unconsentedAgentModels(cwd, [], ["kilo"], dir), []);
});

test("loopback ports exempt every pin (registration is the consent there)", () => {
  const cwd = workspace();
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-consent-local-"));
  addCustomProvider({ id: "ollama-local", baseUrl: "http://127.0.0.1:11434", defaultModel: "qwen3:35b", envVar: "OLLAMA_LOCAL_API_KEY" }, local);
  writeAgent(cwd, "local", "---\ndescription: pin\nmodel: qwen3:35b\n---\nReport.\n");
  // The allowlist is empty (deny-all) and a loopback provider still passes.
  saveAllowedEntries([], dir);
  assert.deepEqual(unconsentedAgentModels(cwd, [], ["ollama-local"], local), []);
});

test("only the resolved entry is graded: an --agents entry outranks the same-name file", () => {
  saveAllowedEntries(["nvidia:moonshotai/kimi-k3"], dir);
  const cwd = workspace();
  writeAgent(cwd, "review", "---\ndescription: file pin\nmodel: expensive/model\n---\nReport.\n");
  // The flag entry owns the name, so the file's pin is never consulted.
  const extra = [
    { name: "review", description: "flag entry", systemPrompt: "Report.", maxSteps: 5 },
    { name: "plan", description: "flag entry", systemPrompt: "Plan.", maxSteps: 5, model: "moonshotai/kimi-k3" },
  ];
  assert.deepEqual(unconsentedAgentModels(cwd, extra, ["nvidia"], dir), []);
});

test("an unreadable roster is not a consent answer", () => {
  saveAllowedEntries(["nvidia:moonshotai/kimi-k3"], dir);
  const cwd = workspace();
  writeAgent(cwd, "broken", "---\ndescription: pin\nmodel: expensive/model\n---\nReport.\n");
  // The file's body is unregulated (parse errors are the roster's problem,
  // reported by listAgentsWithErrors) — what this module grades is only the
  // model ids it can read.
  assert.equal(unconsentedAgentModels(cwd, [], ["nvidia"], dir).length, 1);
});

test("notEnabledMessage names the enable command when the id is enabled nowhere", () => {
  saveAllowedEntries(["nvidia:moonshotai/kimi-k3"], dir);
  const msg = notEnabledMessage("nvidia", "expensive/model", dir);
  assert.ok(msg.includes("not enabled"), msg);
  assert.ok(msg.includes("codewhip provider enable nvidia:expensive/model"), msg);
});

test("notEnabledMessage names the other provider when the id is enabled there", () => {
  saveAllowedEntries(["nvidia:moonshotai/kimi-k3", "kilo:cohere/north-mini-code:free"], dir);
  const msg = notEnabledMessage("nvidia", "cohere/north-mini-code:free", dir);
  assert.ok(msg.includes("enabled for kilo"), msg);
  assert.ok(msg.includes("--provider kilo"), msg);
  // The trap: telling a nvidia-routed run to enable it on nvidia would send
  // the author reinstalling the same line they already have.
  assert.ok(!msg.includes("provider enable nvidia"), msg);
});

test("providersAllowing finds every provider holding one exact id", () => {
  saveAllowedEntries(["nvidia:moonshotai/kimi-k3", "kilo:cohere/north-mini-code:free"], dir);
  assert.deepEqual(providersAllowing("cohere/north-mini-code:free", dir), ["kilo"]);
  assert.deepEqual(providersAllowing("moonshotai/kimi-k3", dir), ["nvidia"]);
  assert.deepEqual(providersAllowing("nope", dir), []);
});

test("an empty provider list refuses a pin rather than waving it through", () => {
  saveAllowedEntries(["nvidia:moonshotai/kimi-k3"], dir);
  const cwd = workspace();
  writeAgent(cwd, "pinned", "---\ndescription: pin\nmodel: anything\n---\nReport.\n");
  // No provider to consent on is not "no provider to refuse on": a pin is
  // refused so a caller that forgets the ports cannot accidentally open the gate.
  assert.equal(unconsentedAgentModels(cwd, [], [], dir).length, 1);
});
