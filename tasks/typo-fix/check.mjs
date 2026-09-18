import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
const dir = process.argv[2];
try {
  const src = fs.readFileSync(path.join(dir, "src", "app.mjs"), "utf8");
  assert.ok(!src.includes("recieve"), "recieve still present");
  assert.ok(src.includes("will receive:"), "expected receive phrase missing");
  assert.ok(src.includes("recieves".replace("recieve", "receive") + " "), "second occurrence not fixed");
  assert.ok(src.includes("Reply STOP to cancel."), "unrelated line was altered");
  console.log("ok");
} catch (err) {
  console.error(String(err.message ?? err));
  process.exit(1);
}