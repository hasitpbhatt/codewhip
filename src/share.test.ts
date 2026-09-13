import { describe, it, beforeEach } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { appendEntry, chainTail } from "./audit.js";
import { buildShareBundle, sharePath, writeShareBundle, type ShareInput } from "./share.js";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-share-"));

function writeKey(cwd: string): void {
  const dir = path.join(cwd, ".codewhip");
  fs.mkdirSync(dir, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  fs.writeFileSync(path.join(dir, "key"), privateKey.export({ type: "pkcs8", format: "pem" }), "utf8");
  fs.writeFileSync(path.join(dir, "key.pub"), publicKey.export({ type: "spki", format: "pem" }), "utf8");
}

const input = (over: Partial<ShareInput> = {}): ShareInput => ({
  runId: "r-share-1",
  model: "nvidia:m",
  prompt: "fix the bug with key sk-abcDEF123xyz",
  resultText: "done, see admin@example.com",
  trace: [
    { seq: 1, tool: "bash", policy: "deny:denylist:rm-rf", actor: "policy", preview: "denied by denylist", subject: "rm -rf /" },
    { seq: 2, tool: "read", policy: "allow:default:read:allow", actor: "policy", preview: "DATABASE_URL=postgres://u:p@h/db", subject: ".env" },
  ],
  promptTokens: 10,
  completionTokens: 5,
  usageByModel: [],
  receipt: "receipt: 10 prompt + 5 completion tokens / nvidia:m 10+5 / $0.0000",
  ...over,
});

describe("share", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = tmp();
  });

  it("scrubs secrets from prompt, previews, and result", () => {
    const { bundle } = buildShareBundle(cwd, input());
    ok(!bundle.prompt_redacted.includes("sk-abcDEF123xyz"), bundle.prompt_redacted);
    ok(bundle.prompt_redacted.includes("[redacted]"));
    ok(!bundle.result_redacted.includes("admin@example.com"), bundle.result_redacted);
    const read = bundle.tool_calls[1] as { preview_redacted: string };
    ok(!read.preview_redacted.includes("postgres://"), read.preview_redacted);
    ok(read.preview_redacted.includes("DATABASE_URL="), read.preview_redacted);
  });

  it("anchors to the audit chain tail", () => {
    appendEntry(cwd, { runId: "r1", actor: "policy", tool: "bash", args_hash: "x", result_hash: "y", policy: "a" });
    const { bundle } = buildShareBundle(cwd, input());
    strictEqual(bundle.audit_tail, chainTail(cwd));
    ok(bundle.audit_tail.length === 64);
  });

  it("leaves audit_tail empty when no chain exists yet", () => {
    const { bundle } = buildShareBundle(cwd, input());
    strictEqual(bundle.audit_tail, "");
  });

  it("signs the bundle when a key exists, null otherwise", () => {
    const unsigned = buildShareBundle(cwd, input());
    strictEqual(unsigned.bundle.bundle_sig, null);
    writeKey(cwd);
    const signed = buildShareBundle(cwd, input());
    ok(typeof signed.bundle.bundle_sig === "string" && (signed.bundle.bundle_sig as string).length > 0);
  });

  it("writes the bundle file and reports its content hash", () => {
    const result = writeShareBundle(cwd, input());
    if ("error" in result) {
      throw new Error(result.error);
    }
    strictEqual(result.path, sharePath(cwd, "r-share-1"));
    strictEqual(result.hash.length, 64);
    const onDisk = fs.readFileSync(result.path, "utf8").trim();
    strictEqual(onDisk, JSON.stringify(JSON.parse(onDisk)));
    ok(onDisk.includes("r-share-1"));
  });
});