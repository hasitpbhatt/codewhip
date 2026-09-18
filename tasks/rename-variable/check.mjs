import assert from "node:assert/strict";
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import * as path from "node:path";
const dir = process.argv[2];
try {
  const src = fs.readFileSync(path.join(dir, "stats.mjs"), "utf8");
  assert.ok(!/\bd\b/.test(src), "identifier d still present");
  const mod = await import(pathToFileURL(path.join(dir, "stats.mjs")));
  const out = mod.summarize([{ name: "a", value: 2 }, { name: "b", value: 3 }]);
  assert.deepEqual(out, { names: ["a", "b"], total: 5, count: 2 });
  console.log("ok");
} catch (err) {
  console.error(String(err.message ?? err));
  process.exit(1);
}