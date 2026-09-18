import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
const dir = process.argv[2];
try {
  const readme = fs.readFileSync(path.join(dir, "README.md"), "utf8");
  assert.ok(readme.includes("Version: 2.3.0"), "README version not updated");
  assert.ok(!readme.includes("1.0.0"), "stale version still present");
  assert.ok(readme.includes("Run `node main.mjs`."), "unrelated README line altered");
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "pkg.json"), "utf8"));
  assert.equal(pkg.version, "2.3.0", "pkg.json must stay untouched");
  console.log("ok");
} catch (err) {
  console.error(String(err.message ?? err));
  process.exit(1);
}