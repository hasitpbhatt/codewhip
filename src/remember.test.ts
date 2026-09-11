import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import { bashShape, isMemorable, shapeOf, targetsSelfProtected, MEMORABLE_SINGLE_HEADS, MEMORABLE_MULTI_HEADS } from "./remember.js";

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
  it("shapeOf returns edit:path for edit", () => {
    strictEqual(shapeOf("edit", "x.md"), "edit:x.md");
  });
  it("targetsSelfProtected flags protected paths", () => {
    strictEqual(targetsSelfProtected("bash:echo > .codewhip/remembered.jsonl"), true);
    strictEqual(targetsSelfProtected("bash:echo x"), false);
    strictEqual(targetsSelfProtected("edit:codewhip-policy.yaml"), true);
  });
});
