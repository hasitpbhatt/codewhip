# Security Policy

CodeWhip's whole wedge is trust, so its disclosure bar is higher than its
feature bar. If you find a hole in the harness, tell us privately first.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |
| < 0.1 | No |

## How to report

Email **hasit.p.bhatt@gmail.com** with:

- What you ran (command, flags, provider) — redact your API keys.
- What you expected the harness to do (deny / ask / redact).
- What it actually did, with the `.codewhip/audit.log` tail if relevant.
- Whether the finding reproduces on the `$0` fake port (`codewhip demo --deny`).

Do not open a public issue for a live vulnerability. Reports are acknowledged
within 3 business days. Fixes ship with a CHANGELOG entry crediting the
reporter (unless you prefer anonymity).

## What counts

**Critical** — the trust story breaks:

- Policy-jail escape: a tool executes outside the repo jail or past the
  non-overridable denylist (path traversal, symlink escape, shell-chaining
  smuggle, `--yolo` bypassing the denylist).
- Audit forgery: tampering with `.codewhip/audit.log` that `audit --verify`
  does not catch, or a run that leaves no audit trail.
- Redaction leak: provider keys, PEMs, or env-assignment values appearing in
  share bundles, outcomes, audit previews, or logs.

**High** — a control fails open:

- An `ask`-default action executing without a prompt or a logged `--yolo`
  banner (outside CI, where ask⇒deny is by construction).
- Stored provider keys readable by other users (wrong file permissions) or
  printed by any command (`auth status` must never print keys).

**Medium/Low** — everything else: error messages that leak paths, unsigned
repos claiming signed status, misleading receipts.

## Known v1 limits (not vulnerabilities)

Honest about what sandbox v1 is *not*:

- The jail is a Node path jail, not OS isolation. A malicious model output
  that stays inside the jail and inside policy is contained by policy, not
  by a sandbox — E2B/Firecracker profiles are H2 (`docs/roadmap.md`).
- The `init` keypair is filesystem permissions (0600), not encryption. On a
  shared machine, prefer env-var keys over `auth login`.
- Unsigned repos (`sig: null`) are expected before `codewhip init`; verify
  warns rather than errors. The bundle's `chain_tail` anchors tail tampering.

## Key handling for contributors

Never commit keys, tokens, or `*.env*` files. CI runs the full `$0` suite
with no secrets. If you leak a key into git history, rotate it immediately
and say so in the report — rewriting history hides the audit trail, so we
don't.
