import * as fs from "node:fs";
import * as path from "node:path";
import { parseFlatFrontmatter } from "./frontmatter.js";

/**
 * Custom slash commands: `.codewhip/commands/<name>.md` prompt templates
 * expanded harness-side (zero model tokens for the definition itself).
 * Config + prompt expansion, not a marketplace — the body becomes the
 * run's user prompt with $ARGUMENTS substituted.
 */

export type CommandDef = { name: string; description: string; body: string };

const NAME_RX = /^[a-z][a-z0-9_-]{1,31}$/;
const MAX_BODY_CHARS = 8000;

export function parseCommandFile(fileName: string, raw: string): { command: CommandDef } | { error: string } {
  const name = fileName.replace(/\.md$/, "");
  if (!NAME_RX.test(name)) {
    return { error: `invalid command name from filename: ${fileName}` };
  }
  const fm = parseFlatFrontmatter(fileName, raw);
  if ("error" in fm) {
    return fm;
  }
  const description = fm.fields.get("description") ?? "";
  if (description.length > 200) {
    return { error: `${fileName}: description too long (max 200 chars)` };
  }
  if (fm.body.length === 0) {
    return { error: `${fileName}: empty command body` };
  }
  if (fm.body.length > MAX_BODY_CHARS) {
    return { error: `${fileName}: command body too long (${fm.body.length} chars, max ${MAX_BODY_CHARS})` };
  }
  return { command: { name, description, body: fm.body } };
}

export function listCommandsWithErrors(cwd: string): { commands: CommandDef[]; errors: string[] } {
  const dir = path.join(cwd, ".codewhip", "commands");
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return { commands: [], errors: [] };
  }
  const commands: CommandDef[] = [];
  const errors: string[] = [];
  for (const f of files.sort()) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
      errors.push(`${f}: unreadable`);
      continue;
    }
    const parsed = parseCommandFile(f, raw);
    if ("command" in parsed) commands.push(parsed.command);
    else errors.push(parsed.error);
  }
  return { commands, errors };
}

function substitute(body: string, args: string): string {
  return body.includes("$ARGUMENTS") ? body.split("$ARGUMENTS").join(args) : `${body}\n\nARGUMENTS: ${args}`;
}

/**
 * Strict expansion for the REPL: a leading `/` is unambiguous intent, so
 * an unknown command is an error (never sent to the model).
 * Returns null only for non-slash lines.
 */
export function expandCommand(cwd: string, line: string): { prompt: string } | { error: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return null;
  const rest = trimmed.slice(1);
  const sp = rest.search(/\s/);
  const name = sp === -1 ? rest : rest.slice(0, sp);
  const args = sp === -1 ? "" : rest.slice(sp + 1).trim();
  // Validated BEFORE the read: a name like "a/../../x" must never reach
  // path.join — command files live only under .codewhip/commands/.
  if (!NAME_RX.test(name)) {
    return { error: `invalid command name "/${name}" (lowercase, first char [a-z], then [a-z0-9_-], 2..32 chars)` };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(cwd, ".codewhip", "commands", `${name}.md`), "utf8");
  } catch {
    return { error: `unknown command /${name} — add .codewhip/commands/${name}.md or see .help` };
  }
  const parsed = parseCommandFile(`${name}.md`, raw);
  if ("error" in parsed) return { error: parsed.error };
  return { prompt: substitute(parsed.command.body, args) };
}

/**
 * Lenient expansion for one-shot `run`: prompts are routinely quoted text
 * that starts with a path ("/api endpoint returns 500"), so an UNKNOWN
 * slash line passes through verbatim (null). A file that exists but is
 * broken still errors — the intent was a command; silence would be fiction.
 */
export function maybeExpandCommand(cwd: string, line: string): { prompt: string } | { error: string } | null {
  const name = nameOf(line);
  if (name === null) return null;
  try {
    fs.statSync(path.join(cwd, ".codewhip", "commands", `${name}.md`));
  } catch {
    return null;
  }
  return expandCommand(cwd, line);
}

function nameOf(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return null;
  const rest = trimmed.slice(1);
  const sp = rest.search(/\s/);
  const name = sp === -1 ? rest : rest.slice(0, sp);
  return NAME_RX.test(name) ? name : null;
}
