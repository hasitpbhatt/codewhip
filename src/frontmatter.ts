/**
 * Shared flat-frontmatter parser for harness markdown files
 * (.codewhip/agents/*.md, .codewhip/commands/*.md). One parser, one
 * error grammar — extracted verbatim from subagents.parseAgentFile so
 * agent-file behavior stays pinned by its existing tests.
 */
export function parseFlatFrontmatter(
  fileName: string,
  raw: string
): { fields: Map<string, string>; body: string } | { error: string } {
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) {
    return { error: `${fileName}: missing frontmatter (start with ---)` };
  }
  const end = text.indexOf("\n---", 3);
  if (end === -1) {
    return { error: `${fileName}: frontmatter not closed (--- ... ---)` };
  }
  const header = text.slice(3, end).split("\n");
  const body = text.slice(end + 4).trim();
  const fields = new Map<string, string>();
  for (const line of header) {
    const t = line.trim();
    if (t.length === 0 || t.startsWith("#")) continue;
    const m = /^([a-z_]+)\s*:\s*(.+?)\s*$/.exec(t);
    if (m === null) return { error: `${fileName}: malformed frontmatter line "${t.slice(0, 40)}"` };
    fields.set(m[1] as string, m[2] as string);
  }
  return { fields, body };
}
