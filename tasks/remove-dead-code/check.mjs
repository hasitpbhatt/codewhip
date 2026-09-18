import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import * as path from "node:path";
const dir = process.argv[2];
try {
  const mod = await import(pathToFileURL(path.join(dir, "util.mjs")));
  assert.equal(mod.keepMe(1), 2, "keepMe must keep working");
  assert.equal(mod.legacyFn, undefined, "legacyFn export must be gone");
  console.log("ok");
} catch (err) {
  console.error(String(err.message ?? err));
  process.exit(1);
}