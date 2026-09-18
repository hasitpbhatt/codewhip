import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import * as path from "node:path";
const dir = process.argv[2];
try {
  const mod = await import(pathToFileURL(path.join(dir, "validate.mjs")));
  assert.equal(mod.validate({ name: "x" }), true, "valid input must still pass");
  assert.throws(() => mod.validate({}), /missing name$/, "wrong message");
  assert.throws(() => mod.validate({ name: "" }), /missing name$/, "wrong message (empty)");
  console.log("ok");
} catch (err) {
  console.error(String(err.message ?? err));
  process.exit(1);
}