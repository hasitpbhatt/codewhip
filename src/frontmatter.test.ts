import { describe, it } from "node:test";
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { parseFlatFrontmatter } from "./frontmatter.js";

/**
 * The grammar both `.codewhip/agents/*.md` and `.codewhip/commands/*.md` are
 * read with. Which keys MEAN anything belongs to each caller's own tests — this
 * file only pins what the parser accepts, because that is the one place a field
 * name can become invisible before a caller ever sees it.
 */
describe("frontmatter", () => {
  it("parses flat keys and the body", () => {
    const r = parseFlatFrontmatter("f.md", "---\ndescription: one line\nmax_steps: 4\n---\nthe body");
    ok(!("error" in r), JSON.stringify(r));
    deepStrictEqual([...r.fields.entries()], [["description", "one line"], ["max_steps", "4"]]);
    strictEqual(r.body, "the body");
  });

  it("accepts camelCase and snake_case keys alike — Claude Code's names and this repo's", () => {
    const r = parseFlatFrontmatter("f.md", "---\ndescription: d\ndisallowedTools: Write\nmax_steps: 3\n---\nb");
    ok(!("error" in r), JSON.stringify(r));
    strictEqual(r.fields.get("disallowedTools"), "Write");
    strictEqual(r.fields.get("max_steps"), "3");
  });

  it("fails closed on a line that is not `key: value`", () => {
    for (const raw of ["no frontmatter", "---\nunclosed", "---\ndescription\n---\nb", "---\n2bad: x\n---\nb"]) {
      ok("error" in parseFlatFrontmatter("f.md", raw), raw);
    }
  });

  it("ignores blank and # comment lines, and keeps a value's inner colons", () => {
    const r = parseFlatFrontmatter("f.md", "---\n# a note\n\ndescription: https://x.com/a\n---\nb");
    ok(!("error" in r), JSON.stringify(r));
    strictEqual(r.fields.get("description"), "https://x.com/a");
    strictEqual(r.fields.size, 1);
  });
});
