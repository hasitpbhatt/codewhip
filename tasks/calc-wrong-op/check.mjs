import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import * as path from "node:path";
const dir = process.argv[2];
try {
  const mod = await import(pathToFileURL(path.join(dir, "calc.mjs")));
  assert.equal(mod.add(2, 3), 5);
  assert.equal(mod.add(-1, 1), 0);
  assert.equal(mod.sub(5, 2), 3, "sub must stay untouched");
  console.log("ok");
} catch (err) {
  console.error(String(err.message ?? err));
  process.exit(1);
}