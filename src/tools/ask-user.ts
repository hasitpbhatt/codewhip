import type { ToolContext, ToolResult, UserQuestion } from "./types.js";
import type { ToolSpec } from "../provider-port.js";
import type { ToolDef } from "./registry.js";

/**
 * The `ask_user` tool: the model puts a multiple-choice question to the human
 * who started the run and their answer comes back as a tool result — the
 * `AskUserQuestion` pattern used by several agent CLIs.
 *
 * Two things make this safe to hand an agent. It grants nothing: it reads one
 * line from the human and returns it as text, so every mutation still walks the
 * consent ladder whether or not a question was asked. And it exists only where
 * a human actually is — the channel is injected by the CLI when there is a
 * terminal to read from, and never reaches a child run — so a headless
 * `run -p` gets a refusal that names the open question rather than a hang
 * waiting for a keystroke nobody will press.
 */

/** A human deciding is the slowest thing in the harness. Bounded anyway: the
 * run's own deadline and Ctrl-C abort the signal, which closes the prompt. */
export const ASK_TIMEOUT_MS = 15 * 60_000;

const MAX_QUESTION_CHARS = 400;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;
const MAX_OPTION_CHARS = 80;

export type AskUserArgs = { question: string; options: unknown; multiSelect?: unknown };

function askUserSpec(): ToolSpec {
  return {
    name: "ask_user",
    description:
      `Ask the human who started this run one multiple-choice question and wait for the answer. ` +
      `Args: question, options (${MIN_OPTIONS}-${MAX_OPTIONS} short distinct choices), multiSelect (optional). ` +
      `Use it when a choice they own would change what you do — scope, which of two designs, a destructive step — not to confirm what you could infer. ` +
      `It grants nothing: an answer is information, and edits, shell and network still pass the normal consent check. ` +
      `Refused when no human is at a keyboard (headless -p, subagent): then decide from the evidence or put the question in your final answer.`,
    parameters: {
      type: "object",
      properties: {
        question: { type: "string" },
        options: { type: "array", items: { type: "string" }, minItems: MIN_OPTIONS, maxItems: MAX_OPTIONS },
        multiSelect: { type: "boolean" },
      },
      required: ["question", "options"],
      additionalProperties: false,
    },
  };
}

function isAskUserArgs(args: unknown): args is AskUserArgs {
  if (typeof args !== "object" || args === null) return false;
  const r = args as Record<string, unknown>;
  if (typeof r["question"] !== "string") return false;
  if (!Array.isArray(r["options"])) return false;
  if (r["multiSelect"] !== undefined && typeof r["multiSelect"] !== "boolean") return false;
  return true;
}

/** Structure is the guard's job; sense (2-6 distinct, non-empty, bounded) is here. */
function toQuestion(args: AskUserArgs): { q: UserQuestion } | { error: string } {
  const question = args.question.trim();
  if (question.length === 0) return { error: "question is empty" };
  if (question.length > MAX_QUESTION_CHARS) {
    return { error: `question too long (${question.length} chars, max ${MAX_QUESTION_CHARS})` };
  }
  const options = (args.options as unknown[]).map((o) => (typeof o === "string" ? o.trim() : ""));
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    return { error: `options must be ${MIN_OPTIONS}-${MAX_OPTIONS} choices (got ${options.length})` };
  }
  for (const o of options) {
    if (o.length === 0) return { error: "every option must be non-empty text" };
    if (o.length > MAX_OPTION_CHARS) return { error: `option too long (${o.length} chars, max ${MAX_OPTION_CHARS}): "${o.slice(0, 40)}…"` };
  }
  const seen = new Set(options.map((o) => o.toLowerCase()));
  if (seen.size !== options.length) return { error: `options must be distinct (got ${options.join(" | ")})` };
  const multiSelect = args.multiSelect === true;
  return { q: { question, options, multiSelect } };
}

export async function runAskUser(
  ctx: ToolContext,
  args: AskUserArgs,
  signal?: AbortSignal
): Promise<ToolResult> {
  const parsed = toQuestion(args);
  if ("error" in parsed) return { ok: false, output: `ask_user: ${parsed.error}` };
  const { q } = parsed;
  // The loop refuses this for a child before the ladder; checked again for the
  // direct-call path, because reaching the human is an authority, not a read.
  if (ctx.depth !== undefined && ctx.depth > 0) {
    return { ok: false, output: "ask_user: subagents cannot prompt the human — report the question in your findings" };
  }
  if (signal?.aborted === true) return { ok: false, output: "ask_user: cancelled before the question was asked" };
  if (ctx.askUserQuestion === undefined) {
    return {
      ok: false,
      output:
        `ask_user: no human at this keyboard (headless run), so the question cannot be answered — ` +
        `decide from the evidence you have, or state it as an open question in your answer. ` +
        `Unanswered: ${q.question} [${q.options.join(" | ")}]`,
    };
  }
  const answer = await ctx.askUserQuestion(q, signal);
  if (answer === null || answer.length === 0) {
    return { ok: false, output: `ask_user: no answer (interrupted) — "${q.question}"` };
  }
  return { ok: true, output: `the human answered: ${answer.join("; ")}` };
}

export const askUserTool: ToolDef = {
  name: "ask_user",
  spec: askUserSpec(),
  // Sits above the asker's own patience: withTimeout is the net, and the abort
  // signal (Ctrl-C, the run's deadline) is what actually ends a wait.
  timeoutMs: ASK_TIMEOUT_MS + 30_000,
  exec: (ctx, args, signal) =>
    isAskUserArgs(args)
      ? runAskUser(ctx, args, signal)
      : Promise.resolve({ ok: false, output: "ask_user: bad args (want question, options[, multiSelect])" } as ToolResult),
};
