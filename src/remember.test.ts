import { describe, it } from "node:test";
import { strictEqual } from "node:assert/strict";
import { bashShape, declineShape, isMemorable, isValidStoredShape, shapeOf, targetsSelfProtected, MEMORABLE_SINGLE_HEADS, MEMORABLE_MULTI_HEADS } from "./remember.js";

describe("remember", () => {
  it("MEMORABLE_MULTI_HEADS lists the curated multi-word heads", () => {
    strictEqual(MEMORABLE_MULTI_HEADS.includes("git status"), true);
    strictEqual(MEMORABLE_MULTI_HEADS.includes("npm test"), true);
    strictEqual(MEMORABLE_MULTI_HEADS.includes("git push"), false);
  });
  it("MEMORABLE_SINGLE_HEADS lists the curated single-word heads", () => {
    strictEqual(MEMORABLE_SINGLE_HEADS.includes("ls"), true);
    strictEqual(MEMORABLE_SINGLE_HEADS.includes("echo"), true);
    strictEqual(MEMORABLE_SINGLE_HEADS.includes("curl"), false);
  });
  it("bashShape returns null for redirect-bearing commands", () => {
    strictEqual(bashShape("echo x >> f"), null);
    strictEqual(bashShape("echo x > f"), null);
    strictEqual(bashShape("ls | grep x"), null);
  });
  it("bashShape returns null for chained commands", () => {
    strictEqual(bashShape("ls; rm -rf /"), null);
    strictEqual(bashShape("ls && cat f"), null);
    strictEqual(bashShape("echo `whoami`"), null);
    strictEqual(bashShape("cat < secrets.txt"), null);
  });
  it("bashShape returns null for newline-bearing commands", () => {
    strictEqual(bashShape("ls" + String.fromCharCode(10) + "rm"), null);
  });
  it("bashShape returns shape for allowed single-word heads", () => {
    strictEqual(bashShape("ls -la"), "ls *");
    strictEqual(bashShape("cat f"), "cat *");
    strictEqual(bashShape("echo hello"), "echo *");
  });
  it("bashShape returns shape for allowed multi-word heads", () => {
    strictEqual(bashShape("git status"), "git status *");
    strictEqual(bashShape("npm test --watch"), "npm test *");
  });
  it("bashShape returns null for non-memorable heads", () => {
    strictEqual(bashShape("curl https://x"), null);
    strictEqual(bashShape("rm -rf ."), null);
    strictEqual(bashShape("node -e '1'"), null);
  });
  it("isMemorable delegates to bashShape for bash", () => {
    strictEqual(isMemorable("bash", "ls"), true);
    strictEqual(isMemorable("bash", "curl https://x"), false);
    strictEqual(isMemorable("bash", "echo x >> f"), false);
  });
  it("isMemorable allows edit shapes", () => {
    strictEqual(isMemorable("edit", "x.md"), true);
  });
  it("webfetch remembers per https origin, never per URL", () => {
    strictEqual(isMemorable("webfetch", "https://docs.example.com/a?token=1"), true);
    strictEqual(shapeOf("webfetch", "https://docs.example.com/a?token=1"), "https://docs.example.com");
    strictEqual(shapeOf("webfetch", "https://docs.example.com/other/path"), "https://docs.example.com");
    strictEqual(isMemorable("webfetch", "http://docs.example.com/x"), false);
    strictEqual(shapeOf("webfetch", "http://docs.example.com/x"), null);
    strictEqual(shapeOf("webfetch", "not a url"), null);
    strictEqual(declineShape("webfetch", "https://evil.example/x"), "https://evil.example");
  });
  it("shapeOf returns the bare path for edit", () => {
    strictEqual(shapeOf("edit", "x.md"), "x.md");
    strictEqual(shapeOf("write", "a/b.txt"), "a/b.txt");
  });
  it("declineShape generalizes any sane head for deny-promotion", () => {
    strictEqual(declineShape("bash", "rm -rf /tmp/x"), "rm -rf *");
    strictEqual(declineShape("bash", "curl https://evil"), "curl *");
    strictEqual(declineShape("bash", "npm publish --access public"), "npm publish *");
    strictEqual(declineShape("bash", "echo hi; rm -rf /"), null);
    strictEqual(declineShape("edit", "src/a.ts"), "src/a.ts");
  });
  it("targetsSelfProtected flags protected paths", () => {
    strictEqual(targetsSelfProtected("echo *"), false);
    strictEqual(targetsSelfProtected(".codewhip/remembered.jsonl"), true);
    strictEqual(targetsSelfProtected(".codewhip\\key"), true);
    strictEqual(targetsSelfProtected("codewhip-policy.yaml"), true);
    strictEqual(targetsSelfProtected("policy.md"), true);
    strictEqual(targetsSelfProtected("src/policy.md.ejs"), false);
    strictEqual(targetsSelfProtected("src/a.ts"), false);
  });
  it("isValidStoredShape accepts curated shapes, rejects injections", () => {
    strictEqual(isValidStoredShape("bash", "echo *"), true);
    strictEqual(isValidStoredShape("bash", "git status *"), true);
    strictEqual(isValidStoredShape("bash", "rm *"), false);
    strictEqual(isValidStoredShape("bash", "echo *\nrm *"), false);
    strictEqual(isValidStoredShape("edit", "src/a.ts"), true);
    strictEqual(isValidStoredShape("edit", "policy.md"), false);
    strictEqual(isValidStoredShape("read", "x"), false);
    strictEqual(isValidStoredShape("webfetch", "https://docs.example.com"), true);
    strictEqual(isValidStoredShape("webfetch", "https://docs.example.com/path"), false);
    strictEqual(isValidStoredShape("webfetch", "http://docs.example.com"), false);
    strictEqual(isValidStoredShape("webfetch", "https://docs.example.com *"), false);
  });
});
