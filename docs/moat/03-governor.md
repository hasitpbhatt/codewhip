# 03 — Governor: Governance Is the Product

Thesis: a model instruction is a memo. Enforcement is a control system. OpenCode admits its permissions are a "workflow safeguard, not a security sandbox." the incumbent's governance is real but closed and provider-locked. CodeWhip's opening: **policy-as-code + verifiable audit + real sandbox, checked into the repo, enforced by the harness — not the model.**

## 1. Policy schema (`codewhip-policy.yaml`)

Rules are ordered. **LAST match wins.** Deny beats everything on conflict within the same match set (multi-resource ops: any-deny ⇒ deny, else any-ask ⇒ ask). No policy file ⇒ fail-closed default: `read:allow, edit:ask, shell:ask, external:deny`.

```yaml
version: 1
defaults: { effect: ask }  # fail closed; OpenCode's allow-by-default is the bug we sell against
rules:
  - action: read   # read|edit|shell|network|memory|subagent|external
    resource: "**" # glob for paths, raw prefix-glob for commands/URLs
    effect: allow

  - { action: edit, resource: "src/**", effect: allow }
  - { action: edit, resource: "**/*.env*", effect: deny }
  - { action: edit, resource: "infra/prod/**", effect: ask,
      require: { approval: 1, tests: ["npm run test:prod-gate"] } }
  - { action: edit, resource: "migrations/**", effect: ask,
      require: { approval: 2, tests: ["npm run migrate:dry-run"] } }

  - { action: shell, resource: "git status *", effect: allow }
  - { action: shell, resource: "git diff *", effect: allow }
  - { action: shell, resource: "npm test *", effect: allow }
  - { action: shell, resource: "rm -rf *", effect: deny }
  - { action: shell, resource: "git push --force *", effect: deny }
  - { action: shell, resource: "curl *|wget *", effect: ask }
  - { action: shell, resource: "*", effect: ask }

  - { action: network, resource: "registry.npmjs.org", effect: allow }
  - { action: network, resource: "*", effect: ask }
  - { action: external, resource: "../*", effect: deny }  # path jail; override per-rule only
```

Enforcement point: the `run` harness resolves every tool call against this file **before** the model output executes. Model can beg; harness says no. Policy file itself is protected: edits to it always `ask` + get audit-logged + require a signed commit.

## 2. Audit schema + replay contract

Append-only JSONL at `.codewhip/audit.log`. Each line:

```json
{"seq":41,"ts":"2026-09-10T05:00:00Z","actor":"agent:build#3","tool":"shell",
 "args_hash":"sha256:9f…","result_hash":"sha256:ab…","prev_hash":"sha256:77…",
 "policy":"allow:rule#12","sig":"ed25519:…"}
```

- Hash chain: `prev_hash` = sha256 of prior line; tampering breaks the chain. Verify with `codewhip audit --verify`.
- `args_hash`/`result_hash` cover canonical JSON of inputs/outputs — never raw secrets. Redact `*.env*`, tokens at write time.
- `codewhip audit --last 20` prints human-readable tail. `codewhip audit --replay --seq 41` re-resolves the policy decision deterministically and re-prints the diff. `codewhip audit --export --since 2026-09-01` emits a **signed bundle** (log slice + chain manifest + policy snapshot hash) — that bundle is the auditor artifact.
- Signed diffs: every `edit` stores `result_hash` over the unified diff, signed with the repo's local ed25519 key (`codewhip init` generates, never leaves the machine unless the team opts into shared signing).

## 3. Sandbox v1 + v2 path

**v1 (ship now, solo builder, pure Node ≥18, zero deps):** process-level jail around `run`.
- Path jail: resolve every `read/edit/shell.cwd` to realpath; must stay inside worktree root. `external` action defaults to deny. No symlinks escape (`lstat` + realpath check).
- Command denylist (non-overridable without `--yolo`): `rm -rf /`, `rm -rf ~`, `mkfs`, `dd of=/dev/*`, `git push --force`, `chmod -R 777`, credential exfil patterns (`env | curl`, `cat ~/.ssh/* |`). Denylist is code, not policy — users can add denies, never remove these except via `--yolo`.
- `codewhip run` prompts on `ask`. `codewhip run --yolo` escapes the jail (explicit, logged, bannered: actor takes accountability under their own name). CI sets `CODEWHIP_NONINTERACTIVE=1`: `ask` ⇒ deny unless `--approve-all` with a signed policy.
- No network sandboxing in v1 beyond `network` policy + logging. Documented honestly as "harness jail, not OS isolation."

**v2 (when paid pain appears):** profiles, not rewrites.
- `sandbox: { profile: local|e2b|firecracker }` in policy. `e2b` profile routes `shell`+`edit` into a Firecracker microVM via E2B SDK (<200ms cold start, per-agent VM, template per repo). `firecracker` profile is self-hosted jailer for on-prem/regulated buyers.
- v1 policy/audit schemas unchanged — only the executor backend swaps. That compatibility is the contract: today's YAML and audit bundles still verify under v2.

## 4. Auditor story (what we hand compliance)

One command: `codewhip audit --export --since <quarter> --sign`. Output: `audit-bundle.zip` containing (a) JSONL slice with intact hash chain, (b) pinned `codewhip-policy.yaml` snapshot + its sha, (c) signed diff list per change, (d) `--verify` transcript. That maps 1:1 to SOC2 CC7/CC8 evidence: who did what, under which rule, with what approval, reproducibly. The incumbent's enterprise tier sells this via a closed Compliance API; we sell it as a file the auditor can verify offline without calling our servers. Trust that compounds.

## 5. Open disagreements

**To naval-leverage (speed-first):** you will argue `--yolo` should be the default and prompts are friction that kills flow. Wrong trade. Approval fatigue is real, but OpenCode's allow-by-default already proved where that ends: one `rm -rf` and the user never trusts the agent again. My ruling: keep `ask` the default, kill fatigue with **scope** (sandbox boundaries + allowlisted safe commands), not with blindness. Speed without a jail is a demo; speed inside a jail is a product. If you want velocity, help me auto-approve `git status` inside the sandbox — don't gut the denylist.

**To naval-memory (memory-first):** you will argue memory state is the moat and audit is overhead — log the summary, skip the chain. I object hardest here. Unverifiable memory is liability, not moat: an agent that "remembers" but can't prove what it changed is unauditable and unsellable to any team with a compliance function. My ruling: **audit is senior to memory.** Memory writes are themselves audited tool calls (`memory.write` needs a policy rule + hash-chained entry). If your memory store can't replay who asserted a fact and when, it doesn't ship.

**To naval-scout (GTM-first):** you will argue governance doesn't demo well and we should lead with connectors/velocity to win users, bolting on policy later. That concedes the only wedge we have. Connectors are commodity; every CLI adds them in a weekend. The buyer who pays — the team lead putting an agent on prod code — buys one thing: **"what will you let me prove to my auditor after your agent touches main?"** My ruling: governance leads the README, the demo (`watch it deny rm -rf, then prove it`), and the pricing page. GTM sells trust; everything else is a feature.
