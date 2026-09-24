import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ok, strictEqual } from "node:assert/strict";
import {
  extractJson,
  MAX_ERRORS,
  MAX_PATTERN_INPUT,
  MAX_REPAIRS,
  MAX_SCHEMA_CHARS,
  parseSchema,
  repairNote,
  structuredInstruction,
  structuredTurn,
  validateJson,
} from "./structured.js";
import { agentLoop } from "./loop.js";
import { makeFakePort, textTurn } from "./testkit/fakePort.js";
import { parseRunArgs } from "./index.js";

/**
 * `--json-schema` (parity wave 2d). Two claims hold this up. The first is the
 * subset: a schema naming a keyword the validator cannot check is refused at
 * parse time, because a gate that never fires is worse than no gate. The
 * second is the loop: a prose answer to a JSON demand costs one billed repair
 * round and, if it still misses, ends as an error — never as a result.
 */

function tempDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `codewhip-schema-${tag}-`));
}

function withConfigDir<T>(dir: string, fn: () => T): T {
  const prior = process.env.CODEWHIP_CONFIG_DIR;
  process.env.CODEWHIP_CONFIG_DIR = dir;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.CODEWHIP_CONFIG_DIR;
    else process.env.CODEWHIP_CONFIG_DIR = prior;
  }
}

const schema = (doc: unknown): string => JSON.stringify(doc);

describe("parseSchema — the subset is enforced at the door", () => {
  it("accepts a plain object schema", () => {
    const r = parseSchema(schema({ type: "object", properties: { a: { type: "string" } }, required: ["a"] }));
    ok(r.ok);
  });
  it("accepts booleans (accept-all and accept-nothing are real schemas)", () => {
    ok(parseSchema("true").ok);
    ok(parseSchema("false").ok);
  });
  it("accepts $schema, which is metadata rather than a constraint", () => {
    ok(parseSchema(schema({ $schema: "http://json-schema.org/draft-07/schema#", type: "number" })).ok);
  });
  it("refuses $ref by name", () => {
    const r = parseSchema(schema({ $ref: "#/definitions/x", definitions: {} }));
    ok(!r.ok && /\$ref/.test(r.error), r.ok ? "accepted" : r.error);
  });
  it("refuses composition keywords it cannot evaluate", () => {
    for (const kw of ["allOf", "anyOf", "oneOf", "not", "if"]) {
      const r = parseSchema(schema({ type: "object", [kw]: [] }));
      ok(!r.ok && r.error.includes(kw), `${kw}: ${r.ok ? "accepted" : r.error}`);
    }
  });
  it("finds an unsupported keyword nested in properties and items", () => {
    const nested = parseSchema(schema({ type: "object", properties: { a: { format: "date" } } }));
    ok(!nested.ok && /format/.test(nested.error) && nested.error.includes("properties/a"), nested.ok ? "accepted" : nested.error);
    const inItems = parseSchema(schema({ type: "array", items: { type: "object", properties: { b: { uniqueItems: true } } } }));
    ok(!inItems.ok && /uniqueItems/.test(inItems.error), inItems.ok ? "accepted" : inItems.error);
  });
  it("refuses a typo rather than ignoring a keyword nobody implemented", () => {
    const r = parseSchema(schema({ tipe: "string" }));
    ok(!r.ok && /tipe/.test(r.error), r.ok ? "accepted" : r.error);
  });
  it("reports bad JSON, empty and oversized documents", () => {
    ok(!parseSchema("{").ok);
    ok(!parseSchema("   ").ok);
    ok(!parseSchema(`{"type":"object","note":"${"x".repeat(MAX_SCHEMA_CHARS)}"}`).ok);
  });
});

describe("validateJson — the keywords it does claim to check", () => {
  const obj = schema({
    type: "object",
    properties: { name: { type: "string" }, count: { type: "integer" }, ok: { type: "boolean" } },
    required: ["name"],
    additionalProperties: false,
  });
  const parsed = (s: string): unknown => JSON.parse(s) as unknown;

  it("accepts a matching document", () => {
    strictEqual(validateJson(parsed('{"name":"a","count":2,"ok":true}'), parseSchema(obj).ok ? JSON.parse(obj) : {}).length, 0);
  });
  it("names a missing required property by path", () => {
    const errs = validateJson({}, JSON.parse(obj));
    strictEqual(errs.length, 1);
    ok(errs[0]?.startsWith("#:") && errs[0].includes("name"), String(errs[0]));
  });
  it("refuses an undeclared property under additionalProperties:false", () => {
    ok(validateJson({ name: "a", extra: 1 }, JSON.parse(obj)).some((e) => /extra/.test(e)));
  });
  it("checks a nested property against its own path", () => {
    const s = JSON.parse(schema({ type: "object", properties: { a: { type: "object", properties: { b: { type: "number" } } } } }));
    const errs = validateJson({ a: { b: "no" } }, s);
    ok(errs.some((e) => e.startsWith("#/a/b:")), String(errs));
  });
  it("treats integer as a kind of number, and not the way round", () => {
    ok(validateJson(3, { type: "number" }).length === 0);
    ok(validateJson(3.5, { type: "integer" }).length === 1);
  });
  it("accepts a type list", () => {
    ok(validateJson(null, { type: ["string", "null"] }).length === 0);
    ok(validateJson(1, { type: ["string", "null"] }).length === 1);
  });
  it("checks enum and const by value, not by string prefix", () => {
    ok(validateJson("x", { enum: ["a", "b"] }).length === 1);
    ok(validateJson("a", { enum: ["a", "b"] }).length === 0);
    ok(validateJson({ k: 1 }, { const: { k: 1 } }).length === 0);
    ok(validateJson({ k: 2 }, { const: { k: 1 } }).length === 1);
  });
  it("checks bounds, exclusive bounds and their spellings", () => {
    ok(validateJson(5, { type: "number", minimum: 6 }).length === 1);
    ok(validateJson(6, { type: "number", exclusiveMinimum: 6 }).length === 1);
    ok(validateJson(5, { type: "number", maximum: 4 }).length === 1);
    ok(validateJson(5, { type: "number", exclusiveMaximum: 5 }).length === 1);
  });
  it("checks string length and pattern", () => {
    ok(validateJson("ab", { type: "string", minLength: 3 }).length === 1);
    ok(validateJson("abc", { type: "string", maxLength: 2 }).length === 1);
    ok(validateJson("abc", { type: "string", pattern: "^a" }).length === 0);
    ok(validateJson("xbc", { type: "string", pattern: "^a" }).length === 1);
    ok(validateJson("abc", { type: "string", pattern: "(" }).length === 1);
  });
  it("refuses to skip a pattern it cannot run in bounded time", () => {
    const errs = validateJson("x".repeat(MAX_PATTERN_INPUT + 1), { type: "string", pattern: "^x" });
    ok(errs.some((e) => /not checked/.test(e)), String(errs));
  });
  it("validates every array element against items, and tuple positions against items[]", () => {
    const s = JSON.parse(schema({ type: "array", items: { type: "string" } }));
    strictEqual(validateJson(["a", "b"], s).length, 0);
    ok(validateJson(["a", 2], s).some((e) => e.startsWith("#/1:")));
    const tuple = JSON.parse(schema({ type: "array", items: [{ type: "string" }, { type: "number" }] }));
    strictEqual(validateJson(["a", 1], tuple).length, 0);
    ok(validateJson(["a", "b"], tuple).length === 1);
    ok(validateJson(["a", 1, true], tuple).some((e) => /no tuple schema/.test(e)));
  });
  it("checks item and property counts", () => {
    ok(validateJson([1], { type: "array", minItems: 2 }).length === 1);
    ok(validateJson([1, 2, 3], { type: "array", maxItems: 2 }).length === 1);
  });
  it("applies additionalProperties as a schema to undeclared keys", () => {
    const s = JSON.parse(schema({ type: "object", properties: { a: { type: "string" } }, additionalProperties: { type: "number" } }));
    strictEqual(validateJson({ a: "x", b: 1 }, s).length, 0);
    ok(validateJson({ a: "x", b: "y" }, s).some((e) => e.startsWith("#/b:")));
  });
  it("stops at the shape when the type is wrong instead of dumping noise", () => {
    const s = JSON.parse(schema({ type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false }));
    const errs = validateJson("not an object", s);
    strictEqual(errs.length, 1);
    ok(/expected object/.test(errs[0] ?? ""), String(errs));
  });
  it("caps the report but says it capped", () => {
    const s = JSON.parse(schema({ type: "array", items: { type: "string" } }));
    const errs = validateJson(Array.from({ length: MAX_ERRORS + 10 }, () => 1), s);
    ok(errs.length <= MAX_ERRORS + 1, `${errs.length} errors`);
    ok(errs.some((e) => /more/.test(e)), String(errs.at(-1)));
  });
  it("honours the boolean schemas", () => {
    strictEqual(validateJson("anything", true).length, 0);
    ok(validateJson("anything", false).length === 1);
  });
});

describe("extractJson — finding the document the model meant", () => {
  it("parses a bare document", () => {
    const r = extractJson('{"a":1}');
    ok(r.ok && (r.value as { a: number }).a === 1);
  });
  it("unwraps a fenced block", () => {
    const r = extractJson('```json\n{"a":1}\n```');
    ok(r.ok && JSON.stringify(r.value) === '{"a":1}');
  });
  it("takes the first balanced span out of prose", () => {
    const r = extractJson('Sure! Here it is: {"a":{"b":"} not the end"}} hope that helps');
    ok(r.ok && JSON.stringify(r.value) === '{"a":{"b":"} not the end"}}', JSON.stringify(r.ok ? r.value : null));
  });
  it("honours escapes inside strings", () => {
    const r = extractJson('{"a":"\\"}\\""}');
    ok(r.ok && (r.value as { a: string }).a === '"}"');
  });
  it("reports an empty answer and an unclosed one distinctly from prose", () => {
    ok(!extractJson("   ").ok);
    ok(!extractJson('{"a":1').ok);
    const r = extractJson("no json here");
    ok(!r.ok && /no JSON document/.test(r.error), r.ok ? "accepted" : r.error);
  });
});

describe("structuredTurn, the instruction and the nudge", () => {
  const s = parseSchema(schema({ type: "object", properties: { a: { type: "string" } }, required: ["a"] }));
  const schemaDoc = s.ok ? s.schema : {};

  it("returns the value when both extraction and validation pass", () => {
    const r = structuredTurn('{"a":"x"}', schemaDoc);
    ok(r.ok && JSON.stringify(r.value) === '{"a":"x"}');
  });
  it("reports validation problems, not extraction problems, when the shape is wrong", () => {
    const r = structuredTurn('{"a":1}', schemaDoc);
    ok(!r.ok && r.errors.some((e) => /expected string/.test(e)), String(r.ok ? "ok" : r.errors));
  });
  it("keeps the repair note short enough to be worth a turn", () => {
    const note = repairNote(["#/a: expected string"]);
    ok(note.includes("#/a: expected string") && note.length < 600, note);
    ok(/ONLY the JSON/.test(note), note);
  });
  it("spells the demand to the model once, from the schema", () => {
    const ins = structuredInstruction(schemaDoc);
    ok(ins.includes('"required":["a"]') && /nothing else/.test(ins), ins);
  });
});

async function runWithTurns(turns: string[], cwd: string, schemaDoc: unknown) {
  const cfg = tempDir("cfg");
  return withConfigDir(cfg, async () => {
    const { port } = makeFakePort(turns.map((t) => textTurn(t)));
    return await agentLoop({
      prompt: "go", model: "m", label: "nvidia", cwd, maxSteps: 5,
      yolo: false, stdinIsTTY: false, port,
      structuredSchema: schemaDoc,
      onEvent: () => undefined,
    });
  });
}

describe("the loop enforces the schema on the answer", () => {
  const s = parseSchema(schema({ type: "object", properties: { answer: { type: "number" } }, required: ["answer"] }));
  const doc = s.ok ? s.schema : {};

  it("accepts a valid document and reports no repair", async () => {
    const r = await runWithTurns(['{"answer":42}'], tempDir("ok"), doc);
    strictEqual(r.stopReason, "complete");
    ok(r.structured?.ok === true && JSON.stringify(r.structured.value) === '{"answer":42}');
    strictEqual(r.structuredRepairs, undefined);
  });
  it("asks once when the answer is prose, and counts the repair", async () => {
    const r = await runWithTurns(["The answer is 42, in prose.", '{"answer":42}'], tempDir("repair"), doc);
    strictEqual(r.stopReason, "complete");
    strictEqual(r.structuredRepairs, MAX_REPAIRS);
    ok(r.structured?.ok === true, JSON.stringify(r.structured));
    strictEqual(r.steps, 2);
  });
  it("fails the run when the answer still misses after the repair", async () => {
    const r = await runWithTurns(["still prose", "and still prose"], tempDir("fail"), doc);
    strictEqual(r.stopReason, "error");
    ok(r.error !== undefined && /does not satisfy --json-schema/.test(r.error), r.error ?? "no error");
    ok(r.structured?.ok === false && r.structured.errors.length > 0);
    strictEqual(r.steps, 1 + MAX_REPAIRS);
  });
  it("spends no extra turn when there is no schema", async () => {
    const cfg = tempDir("cfg");
    const r = await withConfigDir(cfg, async () => {
      const { port } = makeFakePort([textTurn("plain prose")]);
      return await agentLoop({
        prompt: "go", model: "m", label: "nvidia", cwd: cfg, maxSteps: 5,
        yolo: false, stdinIsTTY: false, port, onEvent: () => undefined,
      });
    });
    strictEqual(r.stopReason, "complete");
    strictEqual(r.structured, undefined);
    strictEqual(r.text, "plain prose");
  });
});

describe("the CLI refuses a schema it could not enforce", () => {
  const savedExit = process.exitCode;
  const parse = (args: string[]): ReturnType<typeof parseRunArgs> | null => {
    try {
      return parseRunArgs(args);
    } finally {
      process.exitCode = savedExit;
    }
  };

  it("takes --json-schema inline and as a file", () => {
    strictEqual(parse(['--json-schema={"type":"object"}', "go"])?.jsonSchema, '{"type":"object"}');
    strictEqual(parse(["--json-schema-file", "s.json", "go"])?.jsonSchemaFile, "s.json");
  });
  it("rejects a bad schema at parse time, naming the keyword", () => {
    strictEqual(parse(['--json-schema={"$ref":"#/x"}', "go"]), null);
  });
  it("rejects both spellings at once", () => {
    strictEqual(parse(['--json-schema={"type":"object"}', "--json-schema-file", "s.json", "go"]), null);
  });
  it("spells out the subset in help", () => {
    const help = fs.readFileSync(path.join(process.cwd(), "src/index.ts"), "utf8");
    ok(help.includes("--json-schema") && help.includes("additionalProperties"), "help text");
  });
});
