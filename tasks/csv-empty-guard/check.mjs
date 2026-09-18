import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import * as path from "node:path";
const dir = process.argv[2];
try {
  const mod = await import(pathToFileURL(path.join(dir, "parse.mjs")));
  assert.deepEqual(mod.parseCsv(""), []);
  assert.deepEqual(mod.parseCsv("   "), []);
  assert.deepEqual(mod.parseCsv("a,b\nc,d"), [["a", "b"], ["c", "d"]]);
  console.log("ok");
} catch (err) {
  console.error(String(err.message ?? err));
  process.exit(1);
}