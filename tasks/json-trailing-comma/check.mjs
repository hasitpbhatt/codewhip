import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
const dir = process.argv[2];
try {
  const data = JSON.parse(fs.readFileSync(path.join(dir, "data.json"), "utf8"));
  assert.deepEqual(data.items, ["alpha", "beta"]);
  assert.equal(data.count, 2);
  console.log("ok");
} catch (err) {
  console.error(String(err.message ?? err));
  process.exit(1);
}