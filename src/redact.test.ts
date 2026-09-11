import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import { redactEnvValues, redactSecrets } from "./redact.js";

describe("redact", () => {
  it("masks key-shaped tokens, PEM blocks, and emails", () => {
    strictEqual(redactSecrets("key nvapi-abc123 tail"), "key [redacted] tail");
    strictEqual(redactSecrets("token sk-abcDEF123xyz!"), "token [redacted]!");
    strictEqual(redactSecrets("id AKIAIOSFODNN7EXAMPLE"), "id [redacted]");
    strictEqual(redactSecrets("pat ghp_deadbeefcafe"), "pat [redacted]");
    strictEqual(redactSecrets("mail bob@example.com ok"), "mail [redacted] ok");
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----";
    strictEqual(redactSecrets(`x ${pem} y`), "x [redacted] y");
  });
  it("passes ordinary output through unchanged", () => {
    strictEqual(redactSecrets("hello world\nline two"), "hello world\nline two");
    strictEqual(redactSecrets("abc123 short"), "abc123 short");
  });
  it("masks generic high-entropy bare tokens (provider-agnostic)", () => {
    strictEqual(redactSecrets("token abcd1234efgh5678ijkl9012 tail"), "token [redacted] tail");
    ok(redactSecrets("key 90k5TVFLvKOZwFWzZEEl8wPQsLvOzKOC9xYz12").includes("[redacted]"));
  });
  it("masks env-assignment values but keeps names", () => {
    strictEqual(redactEnvValues("DATABASE_URL=postgres://u:p@h/db"), "DATABASE_URL= [redacted]");
    strictEqual(redactEnvValues("export AWS_SECRET=abc123"), "export AWS_SECRET= [redacted]");
    strictEqual(redactEnvValues("api_key=supersecret123"), "api_key= [redacted]");
    strictEqual(redactEnvValues("authToken: abc"), "authToken: [redacted]");
    strictEqual(redactEnvValues("image: nginx:latest"), "image: nginx:latest");
    strictEqual(redactEnvValues("NOTE: plain prose stays"), "NOTE: [redacted]");
  });
  it("leaves non-secret lowercase assignments and empty values alone", () => {
    strictEqual(redactEnvValues("retries = 3"), "retries = 3");
    strictEqual(redactEnvValues("EMPTY="), "EMPTY=");
  });
});