# Privacy & Threat Model

CodeWhip is a terminal agent whose primary function is sending user
code (and prompts) to third-party LLM providers. This document
describes what leaves the machine, when, with what consent, and what
protections exist.

## Data flows

| Data | Leaves machine? | When | Consent |
|------|----------------|------|---------|
| Prompt text | Yes | Every `codewhip run` turn | User runs the command |
| API keys | No (env/file only) | Auth setup | User stores them |
| Provider list | No (local registry) | — | — |
| Usage stats | Yes (provider-analytics.jsonl) | Per chat/models call | Always recorded; best-effort |
| Audit trail | No (local .codewhip/) | Per tool call | Always recorded |
| Share bundle | Yes (if `--share`) | On explicit request | User passes `--share` |
| Model listing | Yes (when `codewhip models`) | On demand | User runs the command |
| Telemetry | **No** | — | Never collected |

## What never happens

- **No telemetry, no phone-home.** No analytics endpoints, no
  tracking pixels, no external JS. The serve proxy has no external
  script references — all UI is inline HTML/JS.
- **No data sharing.** Usage stats stay local. Nothing is sent to a
  third party except the API calls themselves.
- **No logging of keys.** `redact.ts` scrubs keys from share bundles
  and audit previews. `auth status` never prints keys.
- **No cloud state.** All state is flat files on the local machine
  (JSONL, JSON). No remote database.

## Threat model

### Adversary: malicious model output

**Risk:** A compromised or jailbroken provider returns tool calls
that escape the repo jail.

**Mitigations:**
- `src/tools/jail.ts` — realpath jail confines file operations to the
  repo directory
- `src/policy.ts` — non-overridable denylist blocks path traversal,
  shell chaining, and worktree escapes
- `--yolo` is explicit, logged, bannered — the user must opt in
- In CI, `ask`-gated calls are denied by construction

**Residual risk:** The jail is a Node path jail, not OS isolation.
E2B/Firecracker profiles are planned for H2.

### Adversary: compromised dependency

**Risk:** A malicious npm package steals API keys or exfiltrates
data.

**Mitigations:**
- Zero runtime dependencies (no `node_modules` of third-party code
  in the production path)
- Dev dependencies are lint/test/build only
- CI runs `npm audit --audit-level=high`
- `package-lock.json` is committed (deterministic installs)

**Residual risk:** Node itself and TypeScript compiler are dependencies.
`prepublishOnly` gate runs the full suite before publish.

### Adversary: local compromise

**Risk:** Another user on the same machine reads provider keys.

**Mitigations:**
- `credentials.json` is `0600` (owner-only)
- `secure-file.ts` enforces ownership checks on write
- `provider-hosts.json` is not present on the remote

**Residual risk:** Filesystem permissions are not encryption. On a
shared machine, prefer env-var keys over `auth login`.

### Adversary: audit tampering

**Risk:** Someone modifies `.codewhip/audit.log` to hide an action.

**Mitigations:**
- Hash-chained audit log: each entry contains `prev_hash` of the
  previous entry
- `audit --verify` detects any tampering that breaks the chain
- Bundle hashes anchor the tail — tampering is visible even if the
  middle is rewritten

**Residual risk:** An attacker with filesystem access can rewrite the
entire chain. The chain's value is detecting *opportunistic* tampering
and proving integrity against a third party, not against root.

## Privacy of the free chain

The `--free` chain routes through ~30 free providers. Every call
sends the full prompt to the provider. The free chain documentation
honestly warns about this:

> "prompts may be logged: never send private code" (empero)
> "requests without the x-opencode-session header are refused"
  (opencode)

Users on `--free` should assume their prompts are visible to the
provider's operators. The `private` task class refuses to route to
cloud providers by default — the only way a secret-bearing prompt
reaches a remote model is an explicit `--provider`, which is
informed consent and is logged on the receipt line.

## Provider registry privacy

The provider registry (`src/provider-registry.ts`) contains ~135
builtin providers with URLs, model paths, and rate limit hints. It is
not an endorsement of any service. The registry is a directory —
users who add a key to a provider are sending their code to that
provider's servers. The registry does not filter, rank, or vouch for
providers beyond the honesty of the documented limits.

## Compliance notes

- **No PII collection.** The tool does not collect usernames,
  emails, or identifiers beyond what the user explicitly provides
  (e.g., `runId` generated from `randomUUID`).
- **No data retention policy for the tool itself.** Audit logs and
  analytics stay on the local filesystem until the user deletes them.
  The tool does not transmit them anywhere.
- **GDPR/CCPA:** The tool does not process personal data as a data
  controller. It is a tool, not a service. The user is the controller
  of whatever they send to providers.
