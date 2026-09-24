import { CHAIN_RX, matchDenylist, matchScriptBlock, matchWorktreeEscape } from "../policy.js";

/**
 * The shell screen `bash` and the background tools share, so the two paths
 * cannot drift: denylist, statement separation, worktree escape and script
 * block — each non-overridable. Pass the TRIMMED command, and spawn that same
 * trimmed string, so the 2000-char cap and the command the shell actually
 * receives describe the same text.
 *
 * Refusals say `bash:` even from the background tools because `bash` names the
 * primitive being screened, not the tool that called.
 */
export function commandGuard(command: string): string | null {
  if (command.length === 0) return "bash: missing required arg `command` (string)";
  if (command.length > 2000) return "bash: `command` too long (max 2000 chars)";
  const denied = matchDenylist(command);
  if (denied !== null) return `bash: denied by denylist:${denied} (non-overridable)`;
  // Defense-in-depth: the loop's policy denies chaining before exec, but the
  // shell is a privileged primitive — refuse separators here too so a future
  // non-loop caller can't smuggle statements past the prefix allowlist.
  if (CHAIN_RX.test(command)) {
    return "bash: shell chaining/statement separation is denied (newlines, ;, |, &, <, >, `, $())";
  }
  const escape = matchWorktreeEscape(command);
  if (escape !== null) return `bash: denied — ${escape} (non-overridable)`;
  const block = matchScriptBlock(command);
  if (block !== null) return `bash: denied — ${block} (non-overridable)`;
  return null;
}
