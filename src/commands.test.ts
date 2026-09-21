import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expandCommand, listCommandsWithErrors, maybeExpandCommand, parseCommandFile } from "./commands.js";
import { parseAgentFile } from "./subagents.js";

function tmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-cmd-"));
}

function writeCommand(cwd: string, fileName: string, raw: string): void {
  const dir = path.join(cwd, ".codewhip", "commands");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), raw, "utf8");
}

describe("custom slash commands", () => {
  it("parseCommandFile accepts a minimal command (empty frontmatter, body only)", () => {
    const r = parseCommandFile("hello.md", "---\n---\nSay hello.");
    ok("command" in r, JSON.stringify(r));
    strictEqual(r.command.name, "hello");
    strictEqual(r.command.description, "");
    strictEqual(r.command.body, "Say hello.");
  });

  it("parseCommandFile rejects invalid names, unclosed frontmatter, empty and oversized bodies", () => {
    ok("error" in parseCommandFile("Bad_Name.md", "---\n---\nx"));
    ok("error" in parseCommandFile("a.md", "no frontmatter"));
    ok("error" in parseCommandFile("a.md", "---\ndescription: d\nbody not closed"));
    ok("error" in parseCommandFile("a.md", "---\n---\n"));
    ok("error" in parseCommandFile("a.md", `---\n---\n${"y".repeat(8001)}`));
  });

  it("listCommandsWithErrors skips corrupt files and reports each reason", () => {
    const cwd = tmpCwd();
    writeCommand(cwd, "good.md", "---\ndescription: works\n---\nbody text");
    writeCommand(cwd, "broken.md", "missing frontmatter");
    writeCommand(cwd, "UPPER.md", "---\n---\nx");
    const r = listCommandsWithErrors(cwd);
    strictEqual(r.commands.length, 1);
    strictEqual(r.commands[0]?.name, "good");
    strictEqual(r.errors.length, 2);
    ok(r.errors.some((e) => e.includes("broken.md")), r.errors.join(" | "));
    ok(r.errors.some((e) => e.includes("UPPER.md")), r.errors.join(" | "));
  });

  it("listCommandsWithErrors on a repo without the directory is empty, not an error", () => {
    const r = listCommandsWithErrors(tmpCwd());
    strictEqual(r.commands.length, 0);
    strictEqual(r.errors.length, 0);
  });

  it("expandCommand substitutes every $ARGUMENTS occurrence", () => {
    const cwd = tmpCwd();
    writeCommand(cwd, "fix.md", "---\n---\nFix $ARGUMENTS then test $ARGUMENTS");
    const r = expandCommand(cwd, "/fix src/a.ts and src/b.ts");
    ok(r !== null && "prompt" in r, JSON.stringify(r));
    strictEqual(r.prompt, "Fix src/a.ts and src/b.ts then test src/a.ts and src/b.ts");
  });

  it("expandCommand appends ARGUMENTS when the placeholder is absent; empty args yields the bare body", () => {
    const cwd = tmpCwd();
    writeCommand(cwd, "review.md", "---\n---\nReview this adversarially.");
    const withArgs = expandCommand(cwd, "/review loop.ts");
    ok(withArgs !== null && "prompt" in withArgs);
    strictEqual(withArgs.prompt, "Review this adversarially.\n\nARGUMENTS: loop.ts");
    const noArgs = expandCommand(cwd, "/review");
    ok(noArgs !== null && "prompt" in noArgs);
    strictEqual(noArgs.prompt, "Review this adversarially.\n\nARGUMENTS: ");
  });

  it("expandCommand: null for non-slash lines, error for unknown or invalid names", () => {
    const cwd = tmpCwd();
    strictEqual(expandCommand(cwd, "just a prompt"), null);
    const unknown = expandCommand(cwd, "/nope args");
    ok(unknown !== null && "error" in unknown);
    ok(unknown.error.includes("unknown command /nope"), unknown.error);
    // Path-traversal guard: the name is rejected before any filesystem read.
    const traversal = expandCommand(cwd, "/a/../../../etc/passwd");
    ok(traversal !== null && "error" in traversal);
    ok(traversal.error.includes("invalid command name"), traversal.error);
  });

  it("expandCommand surfaces parse errors of an existing broken file", () => {
    const cwd = tmpCwd();
    writeCommand(cwd, "bad.md", "still no frontmatter");
    const r = expandCommand(cwd, "/bad");
    ok(r !== null && "error" in r);
    ok(r.error.includes("frontmatter"), r.error);
  });

  it("maybeExpandCommand (one-shot): unknown passes through verbatim, broken files still error", () => {
    const cwd = tmpCwd();
    strictEqual(maybeExpandCommand(cwd, "/api endpoint returns 500"), null);
    strictEqual(maybeExpandCommand(cwd, "plain prompt"), null);
    writeCommand(cwd, "ship.md", "---\n---\nship $ARGUMENTS");
    const okR = maybeExpandCommand(cwd, "/ship v1");
    ok(okR !== null && "prompt" in okR);
    strictEqual(okR.prompt, "ship v1");
    writeCommand(cwd, "broken2.md", "nope");
    const errR = maybeExpandCommand(cwd, "/broken2");
    ok(errR !== null && "error" in errR, JSON.stringify(errR));
  });

  it("agent files share the frontmatter parser (error grammar identical after refactor)", () => {
    const good = parseAgentFile("scout.md", "---\ndescription: find things\n---\nYou search.");
    ok("agent" in good, JSON.stringify(good));
    strictEqual(good.agent.description, "find things");
    strictEqual(good.agent.systemPrompt, "You search.");
    const bad = parseAgentFile("scout.md", "---\ndescription: no close");
    ok("error" in bad);
    ok(bad.error.includes("frontmatter not closed"), bad.error);
  });
});
