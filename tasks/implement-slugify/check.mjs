import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import * as path from "node:path";
const dir = process.argv[2];
try {
  const mod = await import(pathToFileURL(path.join(dir, "slug.mjs")));
  assert.equal(mod.slugify("Hello,  World!"), "hello-world");
  assert.equal(mod.slugify("  A  B  "), "a-b");
  assert.equal(mod.slugify("Price: $9.99"), "price-999");
  assert.equal(mod.slugify("Already-Kebab"), "already-kebab");
  console.log("ok");
} catch (err) {
  console.error(String(err.message ?? err));
  process.exit(1);
}