# CodeWhip Maintainers

## Project overview

CodeWhip is a model-agnostic terminal coding agent. It is built
around a strict policy engine, an append-only signed audit chain,
metered receipts, and a `--free` provider chain that guarantees it
never bills the user for pay-go.

## Single maintainer (bus factor 1)

- **Hasit Bhatt** — `hasit.p.bhatt@gmail.com`
- GitHub: `@hasitpbhatt`

Until the maintainer list grows below, all merge, release, and
policy decisions flow through one person. Contributions are
welcome; the path to becoming a maintainer is documented below.

## Becoming a maintainer

A maintainer candidate must demonstrate:

1. **Sustained contribution** — at least 5 merged PRs across
   different areas (not just provider rows)
2. **Policy understanding** — has read and can explain
   `docs/moat/00-convergence.md`
3. **Security review** — has reviewed at least one security issue
   reported via `SECURITY.md`
4. **DCO sign-off** — all their contributions are signed
5. **Governance alignment** — agrees to the CodeWhip Social
   Contract (below)

Candidates are proposed by the current maintainer and confirmed
after a 1-week discussion period. The current maintainer has
veto power; a candidate may also be ratified by 3 existing
contributors with 2+ merged PRs each.

## Social contract

All maintainers and contributors agree to:

- **Freedom first.** Never add a runtime dependency that
  restricts users. Prefer Node builtins. No telemetry,
  no phone-home, no external JS.
- **SaaSS honesty.** The registry is a directory of services.
  It must never be presented as an endorsement of proprietary
  platforms. When adding a provider, the `rateLimitedHint`
  and comments must be honest about what the user actually gets.
- **Free means free.** `--free` never bills. A provider whose
  "free" tier requires a card leaves `FREE_CHAIN`.
- **No force pushes.** History is append-only for audit
  integrity. Reverts are done as new commits, not rewrites.
- **Transparency.** All governance decisions are recorded in
  `docs/moat/`. No private forks for feature decisions.

## Release policy

- Semver. `0.x.y` means API may break at any time.
- Releases are tagged `v0.x.y` with `gh release create`.
- The `.github/workflows/ci.yml` must pass before a release.
- `CHANGELOG.md` is updated per release (not yet present —
  tracked in `docs/roadmap.md`).

## Key files

| File | Purpose |
|------|---------|
| `src/provider-registry.ts` | Single source of truth for providers |
| `src/provider-stats.ts` | Health tracking, outcome classification |
| `src/router.ts` | Routing, TTL cooling, health gating |
| `src/audit.ts` | Hash-chained signed audit log |
| `src/loop.ts` | Agent loop with policy enforcement |
| `src/policy.ts` | Harness-side policy denylist |
| `docs/moat/00-convergence.md` | Frozen policy/audit/memory schemas |
| `docs/roadmap.md` | Build order and feature decisions |
| `SECURITY.md` | Vulnerability disclosure |
| `CODE_OF_CONDUCT.md` | Contributor Covenant v2.1 |
| `.github/workflows/ci.yml` | CI pipeline |

## Governance decisions

All recorded in `docs/moat/`:

- `00-convergence.md` — the 7 frozen rulings that shape everything
- `07-committee.md` — the five-persona committee verdict
- `06-post-h1-verdict.md` — post-launch findings
- Governance gaps and analysis: `../governance-analysis.md`
