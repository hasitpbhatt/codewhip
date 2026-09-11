import { agentLoop } from "./loop.js";
import { listRules } from "./remember-store.js";
import { makeFakePort, textTurn, toolTurn } from "./testkit/fakePort.js";
import { verifyChain } from "./audit.js";

export type DenyDemoResult = {
  runId: string;
  allowed: number;
  denied: number;
  auditValid: boolean;
  receipt: string;
};

/**
 * Offline wedge demo ($0, no network, no key): a scripted model attempts
 * five classic disasters plus one safe command. The harness must deny all
 * five and allow `git status`. Proves enforcement + replay + meter —
 * the whole delegatability pitch in one command.
 */
export async function runDenyDemo(cwd: string): Promise<DenyDemoResult> {
  const { port } = makeFakePort([
    toolTurn("bash", JSON.stringify({ command: "rm -rf /" })),
    toolTurn("bash", JSON.stringify({ command: "git push origin --force" })),
    toolTurn("bash", JSON.stringify({ command: "git status; rm -rf /" })),
    toolTurn("bash", JSON.stringify({ command: "echo hi > policy.md" })),
    toolTurn("bash", JSON.stringify({ command: "cat /etc/passwd" })),
    toolTurn("bash", JSON.stringify({ command: "git status" })),
    textTurn("demo complete: five disasters refused, one safe command allowed."),
  ]);
  const r = await agentLoop({
    prompt: "deny demo (scripted, $0)",
    model: "demo-fake",
    label: "nvidia",
    cwd,
    maxSteps: 10,
    yolo: false,
    stdinIsTTY: false,
    port,
    remembered: listRules(cwd),
    tokenBudget: 250000,
  });
  let allowed = 0;
  let denied = 0;
  for (const t of r.trace) {
    if (t.policy.startsWith("deny")) denied += 1;
    else if (t.policy.startsWith("allow")) allowed += 1;
  }
  const v = verifyChain(cwd);
  return {
    runId: r.runId,
    allowed,
    denied,
    auditValid: v.valid,
    receipt: `receipt: ${r.promptTokens} prompt + ${r.completionTokens} completion tokens / demo-fake / $0.0000 (offline demo)`,
  };
}
