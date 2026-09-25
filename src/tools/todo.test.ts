import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isTodoArgs, loadTodos, todoPath, todoTool } from "./todo.js";
import { TOOLS } from "./registry.js";
import { permissionSubject } from "../policy.js";

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
    strictEqual(isTodoArgs({ action: "get" }), true);
    strictEqual(isTodoArgs({ action: "bogus" }), false);
    strictEqual(isTodoArgs(null), false);
    const ctx = tmpCwd();
    const r = await TOOLS.todo.exec(ctx, { action: "nuke" });
    strictEqual(r.ok, false);
    ok(r.output.includes("bad args"), r.output);
  });

  it("names each action as its own policy subject, so a team can deny one", async () => {
    strictEqual(permissionSubject("todo", { action: "get", id: "a" }, "todo get"), "todo:get");
    strictEqual(permissionSubject("todo", { action: "replace" }, "todo replace"), "todo:replace");
  });

  it("a blocker written in either direction is stored in both", async () => {
    const ctx = tmpCwd();
    const back = [
      { id: "a", text: "first", status: "pending" },
      { id: "b", text: "second", status: "pending", blockedBy: ["a"] },
    ];
    const r = await todoTool(ctx, { action: "replace", items: back });
    strictEqual(r.ok, true);
    ok(r.output.includes("- [ ] b second · blocked by a"), r.output);
    const stored = loadTodos(ctx.cwd);
    strictEqual(stored[0]?.blocks?.join(","), "b", "a records that it blocks b");
    strictEqual(stored[1]?.blockedBy?.join(","), "a", "b records what blocks it");
  });

  it("the forward direction unblocks the dependent, and list shows it", async () => {
    const ctx = tmpCwd();
    await todoTool(ctx, {
      action: "replace",
      items: [
        { id: "a", text: "first", status: "pending", blocks: ["b"] },
        { id: "b", text: "second", status: "pending" },
      ],
    });
    strictEqual(loadTodos(ctx.cwd)[1]?.blockedBy?.join(","), "a");
    const r = await todoTool(ctx, { action: "update", id: "a", status: "done" });
    strictEqual(r.ok, true);
    ok(!r.output.includes("blocked by"), r.output);
  });

  it("a blocked item cannot be claimed until its blocker is done", async () => {
    const ctx = tmpCwd();
    await todoTool(ctx, {
      action: "replace",
      items: [
        { id: "a", text: "first", status: "pending" },
        { id: "b", text: "second", status: "pending", blockedBy: ["a"] },
        { id: "c", text: "third", status: "pending" },
      ],
    });
    const refused = await todoTool(ctx, { action: "update", id: "b", status: "in_progress" });
    strictEqual(refused.ok, false);
    ok(refused.output.includes("blocked by a"), refused.output);
    strictEqual(loadTodos(ctx.cwd)[1]?.status, "pending", "the refusal changed nothing");
    strictEqual((await todoTool(ctx, { action: "update", id: "c", status: "in_progress" })).ok, true);
    strictEqual((await todoTool(ctx, { action: "update", id: "c", status: "pending" })).ok, true);
    strictEqual((await todoTool(ctx, { action: "update", id: "a", status: "done" })).ok, true);
    strictEqual((await todoTool(ctx, { action: "update", id: "b", status: "in_progress" })).ok, true);
  });

  it("replace refuses an in_progress item that its own edges block", async () => {
    const ctx = tmpCwd();
    const r = await todoTool(ctx, {
      action: "replace",
      items: [
        { id: "a", text: "first", status: "pending" },
        { id: "b", text: "second", status: "in_progress", blockedBy: ["a"] },
      ],
    });
    strictEqual(r.ok, false);
    ok(r.output.includes("blocked by a"), r.output);
  });

  it("an edge to an id that is not in the list is refused, not dropped", async () => {
    const ctx = tmpCwd();
    const r = await todoTool(ctx, {
      action: "replace",
      items: [{ id: "a", text: "first", status: "pending", blockedBy: ["ghost"] }],
    });
    strictEqual(r.ok, false);
    ok(r.output.includes('"ghost"'), r.output);
  });

  it("a cycle is refused by name instead of deadlocking the list", async () => {
    const ctx = tmpCwd();
    const r = await todoTool(ctx, {
      action: "replace",
      items: [
        { id: "a", text: "one", status: "pending", blockedBy: ["c"] },
        { id: "b", text: "two", status: "pending", blockedBy: ["a"] },
        { id: "c", text: "three", status: "pending", blockedBy: ["b"] },
      ],
    });
    strictEqual(r.ok, false);
    ok(r.output.includes("cycle"), r.output);
    ok(r.output.includes("a → c → b → a"), r.output);
  });

  it("an item cannot block itself", async () => {
    const ctx = tmpCwd();
    const r = await todoTool(ctx, {
      action: "replace",
      items: [{ id: "a", text: "one", status: "pending", blockedBy: ["a"] }],
    });
    strictEqual(r.ok, false);
    ok(r.output.includes("block itself"), r.output);
  });

  it("get reports the contract, the owner and what is ready to claim", async () => {
    const ctx = tmpCwd();
    await todoTool(ctx, {
      action: "replace",
      items: [
        { id: "a", text: "write the store", status: "pending", description: "todos.json round-trips", owner: "sam" },
        { id: "b", text: "wire the tool", status: "pending", blockedBy: ["a"], activeForm: "wiring the tool" },
        { id: "c", text: "write the tests", status: "pending" },
      ],
    });
    const r = await todoTool(ctx, { action: "get", id: "b" });
    strictEqual(r.ok, true);
    ok(r.output.includes("- b [pending] wire the tool"), r.output);
    ok(r.output.includes("blocked by: a (pending)"), r.output);
    ok(r.output.includes("ready: no"), r.output);
    ok(r.output.includes("ready to claim: a, c"), r.output);
    const a = await todoTool(ctx, { action: "get", id: "a" });
    ok(a.output.includes("done means: todos.json round-trips"), a.output);
    ok(a.output.includes("owner: sam"), a.output);
  });

  it("an in_progress item is labelled by its activeForm", async () => {
    const ctx = tmpCwd();
    await todoTool(ctx, {
      action: "replace",
      items: [{ id: "a", text: "wire the tool", activeForm: "wiring the tool", status: "in_progress" }],
    });
    const r = await todoTool(ctx, { action: "list" });
    ok(r.output.includes("- [>] a wiring the tool"), r.output);
  });

  it("description and owner are redacted at save too", async () => {
    const ctx = tmpCwd();
    const r = await todoTool(ctx, {
      action: "replace",
      items: [{ id: "a", text: "one", status: "pending", description: "TOKEN=sk-secret-value", owner: "sk-secret-value" }],
    });
    strictEqual(r.ok, true);
    strictEqual(fs.readFileSync(todoPath(ctx.cwd), "utf8").includes("sk-secret-value"), false);
  });

  it("an old three-field list still loads, and gains edges on the next write", async () => {
    const ctx = tmpCwd();
    fs.mkdirSync(path.join(ctx.cwd, ".codewhip"), { recursive: true });
    fs.writeFileSync(todoPath(ctx.cwd), JSON.stringify([{ id: "a", text: "legacy", status: "pending" }]));
    strictEqual(loadTodos(ctx.cwd).length, 1);
    const r = await todoTool(ctx, { action: "list" });
    strictEqual(r.output, "- [ ] a legacy");
  });
});
