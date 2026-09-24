/**
 * Structured output: `--json-schema` and the validator behind it.
 *
 * The honest contract is a *subset*. A JSON Schema draft-07 document can say
 * things this file cannot check (`$ref`, `allOf`, `format`, `multipleOf`), and
 * a flag that accepts such a schema and then validates something else is worse
 * than no flag at all — the caller believes a gate exists that never fired. So
 * `parseSchema` refuses any keyword it does not implement, naming it, and
 * `--json-schema` never reaches the model with a schema it cannot enforce.
 *
 * Nothing here is a trust boundary: the schema comes from the operator, the
 * JSON comes from a model, and the only consumer is the operator's own script.
 */

/** A schema bigger than this is a mistake or an attack on the prompt budget. */
export const MAX_SCHEMA_CHARS = 65_536;
/** Patterns are not checked past this — a pathological regex must not hang a run. */
export const MAX_PATTERN_INPUT = 16_384;
/** Errors past this are truncated: the model gets a fixable note, not a wall. */
export const MAX_ERRORS = 20;
/** How many times the loop may ask for a repair before reporting the failure. */
export const MAX_REPAIRS = 1;

const KEYWORDS = new Set([
  "type", "properties", "required", "additionalProperties", "items",
  "enum", "const", "minLength", "maxLength", "pattern",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "minItems", "maxItems",
]);

export type SchemaParse = { ok: true; schema: unknown } | { ok: false; error: string };

/** JSON Schema *or* a bare `true`/`false` (accept-all / accept-nothing). */
export function parseSchema(raw: string): SchemaParse {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, error: "--json-schema is empty" };
  if (trimmed.length > MAX_SCHEMA_CHARS) {
    return { ok: false, error: `--json-schema is ${trimmed.length} chars, over the ${MAX_SCHEMA_CHARS} limit` };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(trimmed);
  } catch (err) {
    return { ok: false, error: `--json-schema is not valid JSON: ${err instanceof Error ? err.message : "error"}` };
  }
  const bad = unsupported(doc, "#");
  return bad === null ? { ok: true, schema: doc } : { ok: false, error: bad };
}

function unsupported(node: unknown, path: string): string | null {
  if (Array.isArray(node)) {
    for (const [i, v] of node.entries()) {
      const bad = unsupported(v, `${path}/${i}`);
      if (bad !== null) return bad;
    }
    return null;
  }
  if (typeof node !== "object" || node === null) return null;
  const obj = node as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key === "$schema") continue;
    if (!KEYWORDS.has(key)) {
      return `unsupported keyword ${JSON.stringify(key)} at ${path} — --json-schema enforces a documented subset; refusing to run with a gate it cannot check`;
    }
    // `properties` maps names to schemas, so its own keys are not keywords;
    // `items` is either one schema or a tuple of them.
    if (key === "properties") {
      const map = obj[key];
      if (typeof map === "object" && map !== null && !Array.isArray(map)) {
        for (const [name, sub] of Object.entries(map as Record<string, unknown>)) {
          const bad = unsupported(sub, `${path}/${key}/${name}`);
          if (bad !== null) return bad;
        }
      }
    } else if (key === "additionalProperties" || key === "items") {
      const bad = unsupported(obj[key], `${path}/${key}`);
      if (bad !== null) return bad;
    }
  }
  return null;
}

function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function matchesType(v: unknown, want: string): boolean {
  const got = jsonType(v);
  return got === want || (want === "number" && got === "integer");
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** `[]` when the value satisfies the schema; otherwise one line per problem. */
export function validateJson(value: unknown, schema: unknown, path = "#"): string[] {
  const errors: string[] = [];
  if (schema === true) return errors;
  if (schema === false) {
    errors.push(`${path}: schema is false — nothing validates`);
    return errors;
  }
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return errors;
  const s = schema as Record<string, unknown>;

  const want = s["type"];
  if (typeof want === "string") {
    if (!matchesType(value, want)) errors.push(`${path}: expected ${want}, got ${jsonType(value)}`);
  } else if (Array.isArray(want)) {
    if (!want.some((t) => typeof t === "string" && matchesType(value, t))) {
      errors.push(`${path}: expected one of ${want.join("|")}, got ${jsonType(value)}`);
    }
  }
  if (errors.length > 0) return errors; // shape is wrong: deeper messages are noise

  if (s["enum"] !== undefined) {
    const allowed = s["enum"];
    if (Array.isArray(allowed) && !allowed.some((a) => equal(a, value))) {
      errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(allowed)}`);
    }
  }
  if (s["const"] !== undefined && !equal(s["const"], value)) {
    errors.push(`${path}: expected const ${JSON.stringify(s["const"])}, got ${JSON.stringify(value)}`);
  }
  if (typeof value === "string") {
    if (typeof s["minLength"] === "number" && value.length < s["minLength"]) errors.push(`${path}: shorter than minLength ${s["minLength"]}`);
    if (typeof s["maxLength"] === "number" && value.length > s["maxLength"]) errors.push(`${path}: longer than maxLength ${s["maxLength"]}`);
    if (typeof s["pattern"] === "string") {
      if (value.length > MAX_PATTERN_INPUT) {
        errors.push(`${path}: pattern not checked (${value.length} chars exceeds ${MAX_PATTERN_INPUT}) — treated as a failure`);
      } else {
        let re: RegExp | null = null;
        try {
          re = new RegExp(s["pattern"]);
        } catch {
          errors.push(`${path}: schema pattern ${JSON.stringify(s["pattern"])} is not a valid regex`);
        }
        if (re !== null && !re.test(value)) errors.push(`${path}: ${JSON.stringify(value)} does not match pattern ${JSON.stringify(s["pattern"])}`);
      }
    }
  }
  if (typeof value === "number") {
    const num = (k: string): number | null => (typeof s[k] === "number" ? (s[k] as number) : null);
    const min = num("minimum"), max = num("maximum");
    const xmin = num("exclusiveMinimum"), xmax = num("exclusiveMaximum");
    if (min !== null && value < min) errors.push(`${path}: ${value} is below minimum ${min}`);
    if (max !== null && value > max) errors.push(`${path}: ${value} is above maximum ${max}`);
    if (xmin !== null && value <= xmin) errors.push(`${path}: ${value} is not above exclusiveMinimum ${xmin}`);
    if (xmax !== null && value >= xmax) errors.push(`${path}: ${value} is not below exclusiveMaximum ${xmax}`);
  }
  if (Array.isArray(value)) {
    const minItems = s["minItems"], maxItems = s["maxItems"];
    if (typeof minItems === "number" && value.length < minItems) errors.push(`${path}: ${value.length} items is fewer than minItems ${minItems}`);
    if (typeof maxItems === "number" && value.length > maxItems) errors.push(`${path}: ${value.length} items exceeds maxItems ${maxItems}`);
    const items = s["items"];
    if (Array.isArray(items)) {
      if (!items.every(isSubschema)) {
        errors.push(`${path}: items array must be a list of schemas (tuple)`);
        return errors;
      }
      for (const [i, v] of value.entries()) {
        if (i >= items.length) {
          errors.push(`${path}/${i}: no tuple schema at this position (items has ${items.length} entries)`);
          break;
        }
        errors.push(...validateJson(v, items[i], `${path}/${i}`));
        if (errors.length > MAX_ERRORS) break;
      }
    } else if (isSubschema(items)) {
      for (const [i, v] of value.entries()) {
        errors.push(...validateJson(v, items, `${path}/${i}`));
        if (errors.length > MAX_ERRORS) break;
      }
    }
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    const required = s["required"];
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === "string" && !Object.hasOwn(rec, key)) errors.push(`${path}: missing required property ${JSON.stringify(key)}`);
      }
    }
    const props = s["properties"];
    const addl = s["additionalProperties"];
    if (addl === false) {
      for (const key of Object.keys(rec)) {
        if (typeof props === "object" && props !== null && Object.hasOwn(props, key)) continue;
        errors.push(`${path}: additional property ${JSON.stringify(key)} is not allowed`);
      }
    }
    if (typeof props === "object" && props !== null) {
      for (const [key, sub] of Object.entries(props as Record<string, unknown>)) {
        if (Object.hasOwn(rec, key)) errors.push(...validateJson(rec[key], sub, `${path}/${key}`));
      }
    }
    if (typeof addl === "object" && addl !== null && !Array.isArray(addl)) {
      for (const [key, v] of Object.entries(rec)) {
        if (typeof props === "object" && props !== null && Object.hasOwn(props, key)) continue;
        errors.push(...validateJson(v, addl, `${path}/${key}`));
        if (errors.length > MAX_ERRORS) break;
      }
    }
  }
  return errors.length > MAX_ERRORS
    ? [...errors.slice(0, MAX_ERRORS), `…and ${errors.length - MAX_ERRORS} more (schema enforced as written)`]
    : errors;
}

function isSubschema(node: unknown): node is Record<string, unknown> | boolean {
  return node === true || node === false || (typeof node === "object" && node !== null && !Array.isArray(node));
}

/**
 * The model's answer, as JSON. Bare documents parse directly; a fenced
 * ```json block is unwrapped; anything else is scanned for the first balanced
 * object or array so prose around the answer does not cost a repair round.
 */
export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, error: "the answer is empty" };
  const attempts: string[] = [trimmed];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1] !== undefined) attempts.push(fence[1].trim());
  const span = balancedSpan(trimmed);
  if (span !== null) attempts.push(span);
  for (const candidate of attempts) {
    try {
      return { ok: true, value: JSON.parse(candidate) as unknown };
    } catch {
      // next candidate
    }
  }
  return { ok: false, error: "no JSON document found in the answer" };
}

/** First balanced `{...}` / `[...]`, honouring string escapes and fences. */
function balancedSpan(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start < 0) return null;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** One turn's verdict on the model's answer against the operator's schema. */
export function structuredTurn(text: string, schema: unknown): { ok: true; value: unknown } | { ok: false; errors: string[] } {
  const extracted = extractJson(text);
  if (!extracted.ok) return { ok: false, errors: [extracted.error] };
  const errors = validateJson(extracted.value, schema);
  return errors.length === 0 ? { ok: true, value: extracted.value } : { ok: false, errors };
}

/** The user-role nudge that asks for a repair — terse, and says why. */
export function repairNote(errors: readonly string[]): string {
  const list = errors.slice(0, 8).map((e) => `- ${e}`).join("\n");
  return `Your answer is not valid against the required JSON schema:\n${list}\n\nReply again with ONLY the JSON document — no prose, no code fence — satisfying every constraint above.`;
}

/** The instruction that makes the model produce the document in the first place. */
export function structuredInstruction(schema: unknown): string {
  return `Respond with a single JSON document and nothing else (no prose, no code fence) that validates against this JSON Schema:\n${JSON.stringify(schema)}\nIf a field cannot be known from the work, use null rather than inventing one, unless the schema requires it.`;
}
