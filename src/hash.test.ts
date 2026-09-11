import { describe, it } from "node:test";
import { strictEqual } from "node:assert/strict";
import { canonicalJson, sha256Hex, argsHash } from "./hash.js";

describe("hash", () => {
  it("canonicalJson sorts object keys recursively", () => {
    strictEqual(
      canonicalJson({ b: 1, a: { z: 1, a: 2 } }),
      '{"a":{"a":2,"z":1},"b":1}',
    );
  });
  it("sha256Hex returns a 64-char hex string", () => {
    const h = sha256Hex("hello");
    strictEqual(h.length, 64);
    strictEqual(/^[0-9a-f]+$/.test(h), true);
  });
  it("argsHash is stable for equal args", () => {
    strictEqual(argsHash({ x: 1, y: 2 }), argsHash({ y: 2, x: 1 }));
  });
});
