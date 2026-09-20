import { describe, it } from "node:test";
import { ok, rejects, strictEqual } from "node:assert/strict";
import { authFailure, makeFakePort, textTurn } from "../testkit/fakePort.js";
import { evaluateJudge, llmJudge, llmPolicyRules, parsePolicyLines } from "./baselines.js";
import type { LabeledEvent } from "./samples.js";

function ev(tool: string, shape: string, label: "decline" | "approval", runId = "r1"): LabeledEvent {
  return {
    ts: "2026-09-20T00:00:00Z",
    runId,
    tool,
    shape,
    label,
    ruleId: `default:shell:ask${label === "decline" ? "+declined" : ""}`,
    verdict: null,
  };
}

const events = [
  ev("bash", "curl *", "decline"),
  ev("bash", "curl *", "decline", "r2"),
  ev("bash", "curl *", "decline", "r3"),
  ev("bash", "docker *", "approval"),
];

describe("immunity/baselines", () => {
  it("parsePolicyLines keeps the deny grammar and drops junk and duplicates", () => {
    const parsed = parsePolicyLines(
      'Sure!\ndeny bash:curl *\ndeny edit:src/a.ts\ndeny spaceship:x\ndeny bash:curl *\n"deny webfetch:https://a.test"'
    );
    strictEqual(parsed.map((p) => `${p.tool}:${p.shape}`).join(","), "bash:curl *,edit:src/a.ts,webfetch:https://a.test");
  });

  it("llm-policy arm mines matcher-identical rules and prints a cost receipt", async () => {
    const { port, messagesSeen } = makeFakePort([textTurn("deny bash:curl *\n\nprose", { prompt: 120, completion: 8 })]);
    const r = await llmPolicyRules({ port, model: "m", events });
    strictEqual(r.rules.length, 1);
    strictEqual(r.rules[0]?.id, "llm:bash:curl *");
    strictEqual(r.rules[0]?.predicate.kind, "prefix");
    strictEqual(r.usage.calls, 1);
    strictEqual(r.usage.promptTokens, 120);
    const user = messagesSeen[0]?.at(-1)?.content ?? "";
    ok(user.includes('bash "curl *": 3 declines'), user);
  });

  it("a port failure throws with the retry class", async () => {
    const { port } = makeFakePort([authFailure()]);
    await rejects(llmPolicyRules({ port, model: "m", events }), /baseline port failure: invalid key \(auth\)/);
  });

  it("llm-judge arm scores coverage and autoimmune cost against the human labels", async () => {
    const { port } = makeFakePort([textTurn("1. deny\n2. allow", { prompt: 50, completion: 4 })]);
    const r = await llmJudge({ port, model: "m", events });
    // shapeStats order: declines desc → curl first, docker second.
    strictEqual(r.decisions.get("bash:curl *"), "deny");
    strictEqual(r.decisions.get("bash:docker *"), "allow");
    const s = evaluateJudge(r.decisions, events);
    strictEqual(s.coverageRate, 1);
    strictEqual(s.overblockRate, 0);
    strictEqual(s.shapes, 2);
    strictEqual(s.judged, 2);
  });

  it("unanswered shapes count as allow (abstention has a price)", async () => {
    const { port } = makeFakePort([textTurn("not a valid reply", { prompt: 50, completion: 4 })]);
    const r = await llmJudge({ port, model: "m", events });
    strictEqual(r.decisions.size, 0);
    const s = evaluateJudge(r.decisions, events);
    strictEqual(s.coverageRate, 0);
    strictEqual(s.judged, 0);
  });
});
