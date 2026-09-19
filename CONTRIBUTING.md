# Contributing to CodeWhip

The product conscience is `SOUL.md` — read it first. It wins every design
argument. The working agreement for day-to-day work is `AGENTS.md`. The build
order is `docs/roadmap.md`; strategy reasoning lives in `docs/moat/`.

## Setup

```sh
npm install
npm run dev        # tsx src/index.ts (fastest local loop)
npm run typecheck  # tsc --noEmit (run before finishing any src/ change)
npm test           # $0-quota suite: tsx --test, no API key needed
npm run build      # tsc -> dist/
```

Requires Node >= 22. TypeScript strict, ESM (`"type": "module"`).

Tests never touch the network: model calls go through the `$0` fake ChatPort
in `src/testkit/`. If your change needs a provider key to verify, say so in
the PR — reviewers run what they can without one.

## Repo map

`src/` is the only source root. Orientation (kept here, not in the README,
so user docs never rot on contributor churn):

```
src/index.ts            CLI entry (help, run/auth/models/audit)
src/loop.ts             agentLoop(): stream → permission → exec → append, budget
src/policy.ts           harness policy: denylist, chaining-deny, ask/allow defaults
src/policy-store.ts     policy.md promoted denies (declines → candidates → approve)
src/pack.ts             team policy packs shipped locally (list/pull)
src/router.ts           3-class task router (implement/polish/private) + polish gate
src/metrics.ts          `codewhip metrics`: blocks/100, $/task, memory/week from outcomes
src/remember.ts         curated memorable shapes (no redirects/chains)
src/remember-store.ts   .codewhip/remembered.jsonl (provenance: ts/runId/preview_hash)
src/tools/              read/search/write/edit/bash/webfetch + jail
src/testkit/            $0 fake ChatPort for the test suite
src/auth.ts             provider keys (login/logout/status; env wins, file 0600)
src/config-dir.ts       global key/config dir (%APPDATA% | ~/.config)
src/custom-providers.ts user-registered OpenAI-compatible providers
src/models.ts           served-model listing with agency tags
src/provider-registry.ts builtin registry (+ free-chain.ts; provider.ts re-exports)
src/onemin.ts           1min.ai port: prompt flattening + emulated tool calls (not OpenAI-shaped)
src/serve.ts            `codewhip serve`: OpenAI-compatible HTTP front end over the registry
src/wire-util.ts        shared wire helpers ({ENV} base-URL placeholders, Retry-After)
src/audit.ts            hash-chained signed audit log
src/outcomes.ts         outcomes.jsonl per-run records
src/redact.ts           key/secret scrubber (share + audit previews)
src/share.ts            redacted chain-anchored share bundles
src/verdict.ts          human verdicts sidecar (accepted/edited/reverted/rejected)
src/system.ts           system prompt (harness rules stay out of it)
src/demo.ts             offline wedge demo ($0 fake port)
src/hash.ts             sha256 helpers
```

## Conventions

- `src/` is the only source root (`rootDir: src`, `outDir: dist`).
- Small modules, explicit types. No `any` without a justification comment.
- Every agent-facing tool: <150 lines, JSON I/O, validated inputs,
  timeout-bounded. A tool failure returns a tool-result string — it never
  throws the loop over.
- No new runtime dependency without a one-paragraph justification in the PR.
  Prefer Node builtins. (Infra is earned by user pain, not imagined.)
- Every run-affecting change prints or preserves cost receipts
  (`tokens / model mix / $`).
- Policy/audit/memory schemas are frozen by `docs/moat/00-convergence.md`.
  Changing them needs a recorded ruling, not a drive-by edit.
- Findings and strategy go in `docs/moat/`; the single bet stays in
  `docs/moat/00-convergence.md`; the build order stays in `docs/roadmap.md`.
  Update them when decisions change — no shadow roadmaps.

## Commit style

Short, prefixed, imperative — matching history:

```
p0: hash-chained signed audit log with verify/replay/export
p1: 3-class task router with polish gate
providers: default mistral model to mistral-small-latest
docs: record four-lens H1 gap audit, correct README drift
```

One concern per commit. Don't mix a feature with a revamp.

## PR checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm test` passes (note the count if it changed)
- [ ] `npm run build` passes
- [ ] Run-affecting changes preserve cost receipts
- [ ] README updated if commands, flags, or behavior changed
- [ ] No secrets in the diff (keys, tokens, `*.env*` — see `SECURITY.md`)

## Safety

Never `rm -rf /`, `rm -rf ~`, `push --force`, exfiltrate credentials, or put
secrets in logs. Edits outside `src/`, destructive shell, and network calls
get stated before they run. See the agent rules in `AGENTS.md` — they bind
humans too.
