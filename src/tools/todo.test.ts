import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isTodoArgs, loadTodos, todoPath, todoTool } from "./todo.js";
import { TOOLS } from "./registry.js";

function tmpCwd(): { cwd: string } {
  return { cwd: fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-todo-")) };
}

describe("todo tool", () => {
  it("list on an empty store renders the hint without writing", async () => {
    const ctx = tmpCwd();
    const r = await todoTool(ctx, { action: "list" });
    strictEqual(r.ok, true);
    ok(r.output.includes("no todos"), r.output);
    strictEqual(fs.existsSync(todoPath(ctx.cwd)), false);
  });

  it("replace round-trips through .codewhip/todos.json", async () => {
    const ctx = tmpCwd();
    const items = [
      { id: "1", text: "wire registry", status: "in_progress" },
      { id: "2", text: "add policy branch", status: "pending" },
    ];
    const r = await todoTool(ctx, { action: "replace", items });
    strictEqual(r.ok, true);
    ok(r.output.includes("- [>] 1 wire registry"), r.output);
    ok(fs.existsSync(todoPath(ctx.cwd)));
    strictEqual(loadTodos(ctx.cwd).length, 2);
    strictEqual(loadTodos(ctx.cwd)[1]?.status, "pending");
  });

  it("replace rejects duplicate ids", async () => {
    const ctx = tmpCwd();
    const r = await todoTool(ctx, {
      action: "replace",
      items: [
        { id: "a", text: "one", status: "pending" },
        { id: "a", text: "two", status: "pending" },
      ],
    });
    strictEqual(r.ok, false);
    ok(r.output.includes("unique"), r.output);
  });

  it("replace rejects more than one in_progress", async () => {
    const ctx = tmpCwd();
    const r = await todoTool(ctx, {
      action: "replace",
      items: [
        { id: "a", text: "one", status: "in_progress" },
        { id: "b", text: "two", status: "in_progress" },
      ],
    });
    strictEqual(r.ok, false);
    ok(r.output.includes("in_progress"), r.output);
  });

  it("replace rejects over-cap lists and oversized text", async () => {
    const ctx = tmpCwd();
    const many = Array.from({ length: 65 }, (_, i) => ({ id: `i${i}`, text: "x", status: "pending" }));
    strictEqual((await todoTool(ctx, { action: "replace", items: many })).ok, false);
    const long = [{ id: "a", text: "x".repeat(501), status: "pending" }];
    strictEqual((await todoTool(ctx, { action: "replace", items: long })).ok, false);
  });

  it("update flips one status and persists", async () => {
    const ctx = tmpCwd();
    await todoTool(ctx, {
      action: "replace",
      items: [
        { id: "a", text: "one", status: "in_progress" },
        { id: "b", text: "two", status: "pending" },
      ],
    });
    const r = await todoTool(ctx, { action: "update", id: "a", status: "done" });
    strictEqual(r.ok, true);
    ok(r.output.includes("- [x] a one"), r.output);
    strictEqual(loadTodos(ctx.cwd)[0]?.status, "done");
  });

  it("update on unknown id fails soft with a hint", async () => {
    const ctx = tmpCwd();
    await todoTool(ctx, { action: "replace", items: [{ id: "a", text: "one", status: "pending" }] });
    const r = await todoTool(ctx, { action: "update", id: "zz", status: "done" });
    strictEqual(r.ok, false);
    ok(r.output.includes("list shows current ids"), r.output);
  });

  it("a corrupt store reads empty and replace repairs it", async () => {
    const ctx = tmpCwd();
    fs.mkdirSync(path.join(ctx.cwd, ".codewhip"), { recursive: true });
    fs.writeFileSync(todoPath(ctx.cwd), "{not json");
    strictEqual(loadTodos(ctx.cwd).length, 0);
    strictEqual((await todoTool(ctx, { action: "list" })).ok, true);
    const r = await todoTool(ctx, { action: "replace", items: [{ id: "a", text: "fresh", status: "pending" }] });
    strictEqual(r.ok, true);
    strictEqual(loadTodos(ctx.cwd)[0]?.text, "fresh");
  });

  it("secret-shaped text is redacted at save", async () => {
    const ctx = tmpCwd();
    const r = await todoTool(ctx, { action: "replace", items: [{ id: "a", text: "API_KEY=sk-secret-value", status: "pending" }] });
    strictEqual(r.ok, true);
    ok(!r.output.includes("sk-secret-value"), r.output);
    const onDisk = fs.readFileSync(todoPath(ctx.cwd), "utf8");
    strictEqual(onDisk.includes("sk-secret-value"), false);
  });

  it("isTodoArgs + registry exec guard malformed args without throwing", async () => {
    strictEqual(isTodoArgs({ action: "list" }), true);
    strictEqual(isTodoArgs({ action: "bogus" }), false);
    strictEqual(isTodoArgs(null), false);
    const ctx = tmpCwd();
    const r = await TOOLS.todo.exec(ctx, { action: "nuke" });
    strictEqual(r.ok, false);
    ok(r.output.includes("bad args"), r.output);
  });
});
