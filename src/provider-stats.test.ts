import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import {
  summarizeCalls,
  renderProviderHealth,
  outcomeForStatus,
  LISTING_MODEL,
  type ProviderCallRecord,
} from "./provider-stats.js";

function rec(p: Partial<ProviderCallRecord>): ProviderCallRecord {
  return {
    ts: "2026-09-11T00:00:00.000Z",
    provider: "stepfun",
    model: "step-3.5-flash",
    kind: "chat",
    outcome: "ok",
    ...p,
  };
}

describe("provider-stats", () => {
  it("outcomeForStatus buckets http statuses", () => {
    strictEqual(outcomeForStatus(401), "auth");
    strictEqual(outcomeForStatus(403), "auth");
    strictEqual(outcomeForStatus(402), "quota");
    strictEqual(outcomeForStatus(429), "quota");
    strictEqual(outcomeForStatus(404), "bad_model");
    strictEqual(outcomeForStatus(500), "other");
  });

  it("empty summary renders a no-data message", () => {
    const s = summarizeCalls([]);
    strictEqual(s.total, 0);
    ok(renderProviderHealth(s).includes("no requests recorded"));
  });

  it("aggregates per provider+model with success rate and error kinds", () => {
    const records = [
      rec({ outcome: "ok" }),
      rec({ outcome: "ok" }),
      rec({ outcome: "quota", status: 402, ts: "2026-09-11T01:00:00.000Z" }),
      rec({ model: "step-3.7-flash", outcome: "ok" }),
      rec({ model: "step-3.7-flash", outcome: "auth", status: 401, ts: "2026-09-11T02:00:00.000Z" }),
    ];
    const s = summarizeCalls(records);
    strictEqual(s.total, 5);
    const stepfun = s.providers.find((p) => p.provider === "stepfun")!;
    strictEqual(stepfun.total, 5);
    strictEqual(stepfun.ok, 3);
    strictEqual(stepfun.failed, 2);
    ok(Math.abs(stepfun.successRate - 0.6) < 1e-9);
    const m35 = stepfun.models.find((m) => m.model === "step-3.5-flash")!;
    strictEqual(m35.total, 3);
    strictEqual(m35.ok, 2);
    strictEqual(m35.failed, 1);
    strictEqual(m35.lastFailureOutcome, "quota");
    strictEqual(m35.errorKinds["quota"], 1);
    const m37 = stepfun.models.find((m) => m.model === "step-3.7-flash")!;
    strictEqual(m37.lastFailureOutcome, "auth");
  });

  it("flags low success rate with a warning marker", () => {
    const records = [rec({ outcome: "quota" }), rec({ outcome: "quota" })];
    const out = renderProviderHealth(summarizeCalls(records));
    ok(out.includes("⚠"), "expected a low-success-rate warning marker");
    ok(out.includes("stepfun"), "expected provider name in output");
  });

  it("separates providers and models", () => {
    const records = [rec({ provider: "nvidia", outcome: "ok" }), rec({ provider: "moonshot", outcome: "ok" })];
    const s = summarizeCalls(records);
    strictEqual(s.providers.length, 2);
  });

  it("aggregates upstream-reported tokens and tokens/sec", () => {
    const records = [
      rec({ outcome: "ok", ms: 2000, promptTokens: 300, completionTokens: 100 }),
      rec({ outcome: "ok", ms: 2000, promptTokens: 100, completionTokens: 100 }),
      rec({ outcome: "quota", ms: 500, status: 429 }), // failures carry no tokens
    ];
    const s = summarizeCalls(records);
    const stepfun = s.providers.find((p) => p.provider === "stepfun")!;
    strictEqual(stepfun.promptTokens, 400);
    strictEqual(stepfun.completionTokens, 200);
    const m = stepfun.models.find((x) => x.model === "step-3.5-flash")!;
    strictEqual(m.promptTokens, 400);
    strictEqual(m.completionTokens, 200);
    // 600 tokens over the 4000ms of token-bearing calls = 150 tok/s
    strictEqual(m.tokensPerSec, 150);
    ok(renderProviderHealth(s).includes("600 tok @ 150 tok/s"), "expected token throughput in render");
  });

  it("keeps model ids that contain colons intact", () => {
    const records = [rec({ provider: "kilo", model: "cohere/north-mini-code:free", outcome: "ok" })];
    const s = summarizeCalls(records);
    const kilo = s.providers.find((p) => p.provider === "kilo")!;
    strictEqual(kilo.models.length, 1);
    strictEqual(kilo.models[0].model, "cohere/north-mini-code:free");
  });

  it("renders listing checks as a check row, not a model row", () => {
    const records = [
      rec({ model: LISTING_MODEL, kind: "models", outcome: "ok" }),
      rec({ outcome: "ok" }),
    ];
    const out = renderProviderHealth(summarizeCalls(records));
    ok(out.includes("model-listing checks"), "expected a listing-check row");
    ok(!/\(listing\):/.test(out), "(listing) must not render as a model name");
  });
});
