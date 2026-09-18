import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
const dir = process.argv[2];
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
  assert.equal(cfg.port, 8080, "port not changed");
  assert.equal(cfg.host, "localhost", "host must stay untouched");
  assert.equal(cfg.debug, false, "debug must stay untouched");
  console.log("ok");
} catch (err) {
  console.error(String(err.message ?? err));
  process.exit(1);
}