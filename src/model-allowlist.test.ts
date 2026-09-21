import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  allowedPath,
  allowedModelsFor,
  disableEntries,
  enableEntries,
  isModelAllowed,
  loadAllowedEntries,
  parseEntry,
  providerIsEnabled,
  saveAllowedEntries,
  setProviderAllowlist,
} from "./model-allowlist.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cw-allow-"));
}

describe("model-allowlist", () => {
  it("parseEntry: provider lowercased, model verbatim incl. inner colons, wildcards rejected", () => {
    assert.deepEqual(parseEntry("Kilo:cohere/north-mini-code:free"), { provider: "kilo", model: "cohere/north-mini-code:free" });
    assert.equal(parseEntry("Kilo:*"), null);
    assert.equal(parseEntry("*:*"), null);
    assert.equal(parseEntry(":x"), null);
    assert.equal(parseEntry("kilo:"), null);
    assert.deepEqual(parseEntry("UPPER:m"), { provider: "upper", model: "m" }); // provider case folds; ids are keys, not secrets
    assert.equal(parseEntry("k"), null); // provider needs 2 chars
    assert.equal(parseEntry("kilo:has\nnewline"), null);
    assert.equal(parseEntry("kilo:" + "m".repeat(201)), null);
  });

  it("save→load round trip is sorted, deduped, lowercased", () => {
    const dir = tmpDir();
    assert.equal(saveAllowedEntries(["Kilo:b", "kilo:a", "kilo:b", "llm7:default"], dir), true);
    assert.deepEqual(loadAllowedEntries(dir), ["kilo:a", "kilo:b", "llm7:default"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(allowedPath(dir), "utf8")).allowed, ["kilo:a", "kilo:b", "llm7:default"]);
  });

  it("isModelAllowed is exact-match only", () => {
    const dir = tmpDir();
    saveAllowedEntries(["kilo:cohere/north-mini-code:free", "llm7:default"], dir);
    assert.equal(isModelAllowed("kilo", "cohere/north-mini-code:free", dir), true);
    assert.equal(isModelAllowed("KILO", "cohere/north-mini-code:free", dir), true);
    assert.equal(isModelAllowed("kilo", "cohere/north-mini", dir), false);
    assert.equal(isModelAllowed("other", "default", dir), false);
  });

  it("missing or corrupt file reads as empty = deny-all (the inversion)", () => {
    const dir = tmpDir();
    assert.deepEqual(loadAllowedEntries(dir), []);
    assert.equal(isModelAllowed("kilo", "anything", dir), false);
    fs.writeFileSync(allowedPath(dir), "{not json", "utf8");
    assert.deepEqual(loadAllowedEntries(dir), []);
    assert.equal(providerIsEnabled("kilo", dir), false);
    fs.writeFileSync(allowedPath(dir), JSON.stringify({ allowed: ["ok:m", "bad entry", "*", ":x"] }), "utf8");
    assert.deepEqual(loadAllowedEntries(dir), ["ok:m"]); // invalid entries dropped on read
  });

  it("enableEntries rejects a malformed batch without writing; disable removes exacts", () => {
    const dir = tmpDir();
    saveAllowedEntries(["alpha:x"], dir);
    const before = fs.readFileSync(allowedPath(dir), "utf8");
    assert.equal(enableEntries(["beta:y", "wild:*"], dir).ok, false);
    assert.equal(fs.readFileSync(allowedPath(dir), "utf8"), before);
    const r = enableEntries(["beta:y", "alpha:x"], dir);
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.added, ["beta:y"]); // alpha:x already present → not re-added
    assert.deepEqual(loadAllowedEntries(dir), ["alpha:x", "beta:y"]);
    const d = disableEntries(["beta:y", "ghost:z"], dir);
    assert.equal(d.ok, true);
    assert.deepEqual(d.ok && d.removed, ["beta:y"]);
    assert.deepEqual(loadAllowedEntries(dir), ["alpha:x"]);
  });

  it("setProviderAllowlist replaces only that provider's entries", () => {
    const dir = tmpDir();
    saveAllowedEntries(["llm7:default", "kilo:keep"], dir);
    const r = setProviderAllowlist("Kilo", ["m/one", "m/two", "m/one"], dir);
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.allowed, ["kilo:m/one", "kilo:m/two"]);
    assert.deepEqual(loadAllowedEntries(dir), ["kilo:m/one", "kilo:m/two", "llm7:default"]);
    assert.deepEqual(allowedModelsFor("kilo", dir), ["m/one", "m/two"]);
    assert.equal(setProviderAllowlist("kilo", [], dir).ok, true);
    assert.deepEqual(loadAllowedEntries(dir), ["llm7:default"]);
    assert.equal(setProviderAllowlist("KILO!", ["a"], dir).ok, false);
    assert.equal(setProviderAllowlist("kilo", ["bad\nid"], dir).ok, false);
    assert.equal(providerIsEnabled("llm7", dir), true);
  });
});
