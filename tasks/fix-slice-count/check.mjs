import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import * as path from "node:path";
const dir = process.argv[2];
try {
  const mod = await import(pathToFileURL(path.join(dir, "picks.mjs")));
  assert.deepEqual(mod.lastN([1, 2, 3, 4, 5], 3), [3, 4, 5]);
  assert.deepEqual(mod.lastN(["a"], 1), ["a"]);
  assert.deepEqual(mod.lastN([1, 2, 3], 5), [1, 2, 3], "asking for more than exists returns everything");
  console.log("ok");
} catch (err) {
  console.error(String(err.message ?? err));
  process.exit(1);
}