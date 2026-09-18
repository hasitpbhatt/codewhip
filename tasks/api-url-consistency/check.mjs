import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
const dir = process.argv[2];
try {
  const client = fs.readFileSync(path.join(dir, "client.mjs"), "utf8");
  const legacy = fs.readFileSync(path.join(dir, "legacy.mjs"), "utf8");
  assert.ok(client.includes("https://api.example.com/v2"), "client changed — it was the reference");
  assert.ok(legacy.includes("https://api.example.com/v2"), "legacy not updated to v2");
  assert.ok(!legacy.includes("v1"), "v1 still present in legacy");
  console.log("ok");
} catch (err) {
  console.error(String(err.message ?? err));
  process.exit(1);
}