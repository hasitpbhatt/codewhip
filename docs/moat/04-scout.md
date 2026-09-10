# Scout: The Uncopyable Wedge

Ground truth: `codewhip@0.1.0`, Node>=18, TS ESM. `src/index.ts` is a stub — `run` prints "agent session not implemented yet". Nothing compounds yet. Good. That means we still get to choose what compounds.

Market (verified Sep 2026): OpenCode ~195k stars, 950 contributors, claims 16M devs/mo, MIT, TUI/desktop/IDE, model-agnostic. Claude Code ~$2.5B ARR (Feb 2026) → ~$8B run-rate (May 2026), >50% enterprise, ~20 hrs/week per dev, closed + subscription-gated, revoked third-party OAuth Jan 2026. Cursor $0 → $2B ARR in ~18 months on $0 marketing: fork VS Code, paid-power-user metric, bottom-up smuggling, custom Tab/Composer model trained on accept/reject data.

Gap is real: open + model-agnostic + enforcement-grade governance, terminal-native. Nobody owns trusted autonomy in the terminal.

## Non-clone list

1. **No TUI/desktop/IDE fork.** OpenCode already won breadth. A solo builder chasing three surfaces loses to 950 contributors on shipping cadence. Terminal is the whole bet: SSH-able, CI-runnable, scriptable. Depth beats breadth.
2. **No MCP catalog land-grab.** Connectors are `>>` lowest on the house moat ranking for a reason — commodity, unowned, copied in a weekend. Ship 5 sharp tools (read, edit, bash, search, git), not 500 thin ones.
3. **No 75-provider matrix on day one.** Provider routing is table stakes, not a wedge. Ship Anthropic + OpenAI + one local (Ollama) behind one interface. Add providers when users scream, not before.
4. **No model training.** Cursor's Composer bet worked because they had 1M power users generating accept/reject signal first. We have zero users. Training now is burning money to be a worse lab.
5. **No Claude Code enterprise-sales motion.** No top-down SSO-first, compliance-deck-first playbook. We smuggle in at $0 via `init`, then formalize — Cursor's order of operations, not Anthropic's.

## Wedge statement + copyability defense

**Wedge: CodeWhip is the terminal agent a team lead can let an intern run on prod-adjacent code at 2am — because every action is policy-checked, memory-scoped, and replayable from a redacted audit link.**

Why this, specifically: OpenCode optimized for freedom (run anywhere, any model). Claude Code optimized for capability (best agent, closed box). Neither optimized for *delegatability* — the moment a senior trusts the tool in a junior's hands unsupervised. That is the uncopyable wedge because it is not a feature, it is a trust record.

Why can't OpenCode copy this in a weekend? They could ship a policy file in a weekend. They cannot ship the *corpus*: thousands of real redacted audit trails showing "this class of action was blocked, this override was justified, this is what safe looks like in a Rails monolith vs. a Terraform repo." Trust data compounds; policy parsers don't. Their brand is freedom — adding enforcement feels like friction to their base and they will underinvest in it.

Why can't Claude Code copy this? They could, technically, in a sprint. They won't, structurally: their moat is closed-model + subscription lock-in ($8B run-rate says don't touch it). An open, portable, model-agnostic audit trail that lets a customer leave is anti-revenue for them. And they will never ship the redacted public share link — enterprise security review would kill it. Openness is the feature they are forbidden from cloning.

## GTM design (init → share → team)

Solo-builder-shippable. Three commands, one Action. Nothing else until these convert.

1. **`codewhip init` (30 seconds).** Scaffolds `AGENTS.md` (3 defaults: read-mostly, ask-before-destructive, never-exfiltrate) + `policy.yaml` (deny-list: `rm -rf /`, `.env*` reads, `git push --force` to main, outbound curl except allowlist). Prints: "Try `codewhip run 'fix failing test'`. Destructive actions will ask first." Goal: first wow in under 5 min, Cursor-style.
2. **`codewhip run` → `--share` (redacted audit link).** Every run emits a local transcript; `--share` strips secrets (env values, keys, emails via allowlist regex) and uploads the redacted DAG: intent → plan → tool calls → policy checks → diff. This is the viral object — the screenshot Tweet Cursor never had to buy. "Look what my agent did, and look what it *refused* to do."
3. **Team policy packs + GitHub Action.** `codewhip pull team/stripe-rails` fetches a versioned policy pack. `codewhip-action@v1` runs the same policy in CI: agent proposes, policy disposes, audit link posts to the PR. Bottom-up smuggling path: dev expenses $0 → team lead sees audit links in PRs → org buys packs + private audit hosting. Enterprise arrives after demand, never before.

Pricing ladder (Cursor logic): free local (generous, not crippled) → $20 pro (hosted audit links, packs) → $40 team (private pack registry, SSO, retention). Price to value delivered (blocked disasters + shipped diffs), not seats warmed.

## Distribution flywheel

Each new user makes the *product* stronger, not just revenue:

1. Every `--share` redaction decision (what got stripped, what got flagged) improves the redactor for everyone.
2. Every policy pack fork + override ("allowed `terraform apply` on staging, denied on prod") becomes an anonymized template ranked by adoption — the pack registry gets smarter per team.
3. Every accept/reject on a policy prompt ("agent asked before `DROP TABLE`, human said no + why") is labeled governance-training signal competitors cannot buy — Cursor's Tab flywheel, applied to trust instead of completions.
4. More shared audit links → more GitHub PRs carrying "audited by CodeWhip" → more devs clicking through → more packs → tighter defaults. The artifact markets itself.

Metric that matters: **trusted runs per team per week** (runs completed with zero policy bypasses + shared audit). Not stars, not DAUs. If that number grows 4–5 days a week per team, we have Cursor's paid-power-user dynamic with a governance skin.

## Open disagreements

**To naval-leverage (infra-first):** you want execution substrate and provider breadth first. Wrong order. Execution is table stakes — OpenCode already runs everywhere on every model, and the Jan 2026 OAuth revocation proved routing is a hostage game, not a moat. A solo builder spending month one on a 75-provider abstraction and a perfect tool runtime ships infrastructure nobody delegates to. Build the thinnest runtime that can enforce one policy, then let user pain dictate which provider breaks next. Infra without trust demand is a faster horse nobody rides.

**To naval-memory (memory-first):** you want compounding memory before distribution. Memory with no users is a diary nobody reads — and worse, it is a liability: unbounded stored state with no redaction story and no policy scoping is exactly what gets us banned from the enterprises we need. Cold-start kills you: your memory has nothing to compound on day one, while my shared audit links generate the only memory worth keeping (justified overrides, blocked disasters) from run one. Earn the right to remember by first being worth delegating to. Distribution first, memory second — or your memory is just disk usage.

**To naval-governor (governance-first):** you want enforcement-grade policy completeness before GTM — full schema, formal semantics, provable denials. That is bureaucracy in search of a user. Nobody adopts a policy engine; they adopt a tool that saved them at 2am and *happened* to block one disaster along the way. Ship 5 deny-rules that actually fire, not 50 that theoretically cover everything. Your completeness instinct delays the share link, delays the pack registry, delays the only corpus that makes future governance real. Governance that nobody runs is not governance — it is a whitepaper. Let the audit trail pull the policy forward, not the other way around.
