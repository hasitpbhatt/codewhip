import { describe, it, beforeEach } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import {
  appendEntry,
  auditPath,
  buildBundle,
  entryHash,
  readAuditLog,
  verifyChain,
  type AuditEntry,
} from "./audit.js";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-audit-"));

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  v: 1,
  seq: 1,
  ts: "2026-09-10T12:00:00.000Z",
  runId: "r-1",
  actor: "policy",
  tool: "bash",
  args_hash: "a",
  result_hash: "b",
  prev_hash: "",
  policy: "deny:denylist:rm-rf",
  sig: null,
  ...over,
});

function writeKey(cwd: string): void {
  const dir = path.join(cwd, ".codewhip");
  fs.mkdirSync(dir, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  fs.writeFileSync(path.join(dir, "key"), privateKey.export({ type: "pkcs8", format: "pem" }), "utf8");
  fs.writeFileSync(path.join(dir, "key.pub"), publicKey.export({ type: "spki", format: "pem" }), "utf8");
}

describe("audit chain", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = tmp();
  });

  it("appends chained entries with seq + prev_hash, unsigned without a key", () => {
    const a1 = appendEntry(cwd, { runId: "r1", actor: "policy", tool: "bash", args_hash: "x", result_hash: "y", policy: "deny:denylist:rm-rf" });
    const a2 = appendEntry(cwd, { runId: "r1", actor: "human", tool: "edit", args_hash: "p", result_hash: "q", policy: "allow:default:edit:ask" });
    strictEqual(a1, true);
    strictEqual(a2, true);
    const { entries, parseErrors } = readAuditLog(cwd);
    strictEqual(parseErrors.length, 0);
    strictEqual(entries.length, 2);
    strictEqual(entries[0]?.seq, 1);
    strictEqual(entries[1]?.seq, 2);
    strictEqual(entries[0]?.prev_hash, "");
    strictEqual(entries[1]?.prev_hash, entryHash(entries[0] as AuditEntry));
    strictEqual(entries[0]?.sig, null);
    strictEqual(entries[1]?.sig, null);
  });

  it("verifies an intact unsigned chain", () => {
    appendEntry(cwd, { runId: "r1", actor: "policy", tool: "bash", args_hash: "x", result_hash: "y", policy: "deny:denylist:rm-rf" });
    appendEntry(cwd, { runId: "r1", actor: "human", tool: "edit", args_hash: "p", result_hash: "q", policy: "allow:default:edit:ask" });
    const v = verifyChain(cwd);
    strictEqual(v.valid, true);
    strictEqual(v.total, 2);
    strictEqual(v.signed, 0);
    strictEqual(v.unsigned, 2);
    strictEqual(v.keyPresent, false);
  });

  it("detects a tampered non-tail entry (next link breaks)", () => {
    appendEntry(cwd, { runId: "r1", actor: "policy", tool: "bash", args_hash: "x", result_hash: "y", policy: "deny:denylist:rm-rf" });
    appendEntry(cwd, { runId: "r1", actor: "human", tool: "edit", args_hash: "p", result_hash: "q", policy: "allow:default:edit:ask" });
    appendEntry(cwd, { runId: "r1", actor: "policy", tool: "read", args_hash: "m", result_hash: "n", policy: "allow:default:read:allow" });
    const file = auditPath(cwd);
    const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
    const second = JSON.parse(lines[1] as string) as AuditEntry;
    second.args_hash = "tampered";
    fs.writeFileSync(
      file,
      (lines[0] as string) + "\n" + JSON.stringify(second) + "\n" + (lines[2] as string) + "\n",
      "utf8"
    );
    const v = verifyChain(cwd);
    strictEqual(v.valid, false);
    ok(v.problems.some((p) => p.includes("prev_hash")), v.problems.join(" | "));
  });

  it("anchors the tail in the export bundle (chain_tail)", () => {
    appendEntry(cwd, { runId: "r1", actor: "policy", tool: "bash", args_hash: "x", result_hash: "y", policy: "a" });
    const result = buildBundle(cwd);
    if ("error" in result) {
      throw new Error(result.error);
    }
    // Tail tampering is invisible to link checks alone (nothing references
    // the last hash yet) — the bundle's chain_tail is the external anchor.
    const { entries } = readAuditLog(cwd);
    strictEqual(result.bundle.chain_tail, entryHash(entries[entries.length - 1] as AuditEntry));
  });

  it("detects a deleted line (seq gap) in the chain", () => {
    appendEntry(cwd, { runId: "r1", actor: "policy", tool: "bash", args_hash: "x", result_hash: "y", policy: "a" });
    appendEntry(cwd, { runId: "r1", actor: "human", tool: "edit", args_hash: "p", result_hash: "q", policy: "b" });
    appendEntry(cwd, { runId: "r1", actor: "policy", tool: "read", args_hash: "m", result_hash: "n", policy: "c" });
    const file = auditPath(cwd);
    const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
    fs.writeFileSync(file, (lines[0] as string) + "\n" + (lines[2] as string) + "\n", "utf8");
    const v = verifyChain(cwd);
    strictEqual(v.valid, false);
    ok(v.problems.some((p) => p.includes("seq mismatch")), v.problems.join(" | "));
  });

  it("reports a malformed line as a chain break", () => {
    appendEntry(cwd, { runId: "r1", actor: "policy", tool: "bash", args_hash: "x", result_hash: "y", policy: "a" });
    fs.appendFileSync(auditPath(cwd), "not-json\n", "utf8");
    const v = verifyChain(cwd);
    strictEqual(v.valid, false);
    ok(v.problems.some((p) => p.includes("not valid JSON")), v.problems.join(" | "));
  });

  it("signs entries when a key exists and verifies them", () => {
    writeKey(cwd);
    const s1 = appendEntry(cwd, { runId: "r1", actor: "policy", tool: "bash", args_hash: "x", result_hash: "y", policy: "deny:denylist:rm-rf" });
    strictEqual(s1, true);
    const { entries } = readAuditLog(cwd);
    const sig = (entries[0] as AuditEntry).sig;
    ok(typeof sig === "string" && sig.length > 0, "signature present");
    const v = verifyChain(cwd);
    strictEqual(v.valid, true);
    strictEqual(v.signed, 1);
    strictEqual(v.unsigned, 0);
    strictEqual(v.keyPresent, true);
  });

  it("flags an unsigned entry when a key exists", () => {
    writeKey(cwd);
    appendEntry(cwd, { runId: "r1", actor: "policy", tool: "bash", args_hash: "x", result_hash: "y", policy: "a" });
    const file = auditPath(cwd);
    const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
    const first = JSON.parse(lines[0] as string) as AuditEntry;
    first.sig = null;
    fs.writeFileSync(file, JSON.stringify(first) + "\n", "utf8");
    const v = verifyChain(cwd);
    strictEqual(v.valid, false);
    ok(v.problems.some((p) => p.includes("unsigned while a key exists")), v.problems.join(" | "));
  });

  it("detects an invalid signature", () => {
    writeKey(cwd);
    appendEntry(cwd, { runId: "r1", actor: "policy", tool: "bash", args_hash: "x", result_hash: "y", policy: "a" });
    const file = auditPath(cwd);
    const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
    const first = JSON.parse(lines[0] as string) as AuditEntry;
    const orig = first.sig as string;
    // Flip a byte in the middle — guaranteed to differ (no 1/256 no-op).
    const flip = orig.slice(10, 12) === "ff" ? "00" : "ff";
    first.sig = orig.slice(0, 10) + flip + orig.slice(12);
    strictEqual(first.sig === orig, false);
    fs.writeFileSync(file, JSON.stringify(first) + "\n", "utf8");
    const v = verifyChain(cwd);
    strictEqual(v.valid, false);
    ok(v.problems.some((p) => p.includes("signature invalid")), v.problems.join(" | "));
  });

  it("exports a signed content-addressed bundle", () => {
    writeKey(cwd);
    appendEntry(cwd, { runId: "r1", actor: "policy", tool: "bash", args_hash: "x", result_hash: "y", policy: "a" });
    const result = buildBundle(cwd);
    if ("error" in result) {
      throw new Error(result.error);
    }
    strictEqual(result.bundle.entries.length, 1);
    strictEqual(result.bundle.chain_tail, entryHash(result.bundle.entries[0] as AuditEntry));
    ok(result.bundle.pubkey?.includes("PUBLIC KEY") === true);
    ok((result.bundle.bundle_sig as string).length > 0);
  });

  it("refuses to export a broken chain", () => {
    appendEntry(cwd, { runId: "r1", actor: "policy", tool: "bash", args_hash: "x", result_hash: "y", policy: "a" });
    fs.appendFileSync(auditPath(cwd), "broken\n", "utf8");
    const result = buildBundle(cwd);
    ok("error" in result);
  });

  it("refuses to export a tampered chain (verify gate, not just parse)", () => {
    appendEntry(cwd, { runId: "r1", actor: "policy", tool: "bash", args_hash: "x", result_hash: "y", policy: "a" });
    appendEntry(cwd, { runId: "r1", actor: "human", tool: "edit", args_hash: "p", result_hash: "q", policy: "b" });
    appendEntry(cwd, { runId: "r1", actor: "policy", tool: "read", args_hash: "m", result_hash: "n", policy: "c" });
    const file = auditPath(cwd);
    const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
    const second = JSON.parse(lines[1] as string) as AuditEntry;
    second.args_hash = "tampered";
    fs.writeFileSync(file, (lines[0] as string) + "\n" + JSON.stringify(second) + "\n" + (lines[2] as string) + "\n", "utf8");
    const result = buildBundle(cwd);
    ok("error" in result);
  });

  it("key deletion reads BROKEN for a signed chain", () => {
    writeKey(cwd);
    appendEntry(cwd, { runId: "r1", actor: "policy", tool: "bash", args_hash: "x", result_hash: "y", policy: "a" });
    fs.rmSync(path.join(cwd, ".codewhip", "key"));
    fs.rmSync(path.join(cwd, ".codewhip", "key.pub"));
    const v = verifyChain(cwd);
    strictEqual(v.valid, false);
    ok(v.problems.some((p) => p.includes("BROKEN") || p.includes("no pubkey")), v.problems.join(" | "));
  });

  it("hashes the same recorded content independently (matches fixture)", () => {
    const e = entry();
    ok(entryHash(e).length === 64);
    ok(entryHash(entry({ result_hash: "z" })) !== entryHash(e));
  });
});