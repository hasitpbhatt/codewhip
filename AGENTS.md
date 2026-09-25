# AGENTS.md — working agreement for coding agents

Read `SOUL.md` first. It outranks everything below on any conflict.

## Commands

```sh
npm install
npm run dev        # tsx src/index.ts (dev loop)
npm run build      # tsc -> dist/
npm run typecheck  # tsc --noEmit (run before finishing any src/ change)
npm run lint       # oxlint src --deny-warnings (TS-7-native; typescript-eslint can't run here)
npm test           # tsx --test src/**/*.test.ts
npm start          # node dist/index.js
```

Optional runners: `npm run bench` (quality/cost benchmarks),
`npm run parity` (recount `docs/moat/20-parity-matrix.md` and fail if its
Score section no longer matches its own rows — run it after touching that file)
and `npm run immunity` (the C3 escape suite and replay; see
`docs/moat/18-verdict-privilege-experiments.md`).

Node >= 20. TypeScript strict, ESM (`"type": "module"`).

## Repo conventions

- `src/` is the only source root (`rootDir: src`, `outDir: dist`).
- Small modules, explicit types, no `any` without justification.
- Every tool the agent loop exposes: <150 lines, JSON I/O, validated inputs,
  timeout-bounded, failure returns a tool-result string — never throws
  the loop over. When one outgrows the bar, split it along its own seams
  (lifecycle / contract / behaviour) rather than trimming it.
- No new runtime dependency without a one-paragraph justification in the PR:
  prefer Node builtins. (Kill-list rule: infra is earned by user pain.)
- JSONL + flat markdown for state (`.codewhip/`); no DB clients in H1.

## Safety rules (from the governance debate, binding on agents too)

- Never `rm -rf /`, `rm -rf ~`, `push --force`, credential exfil, or secrets
  in logs. Redact `*.env*` and tokens at write time.
- `ask`-class actions (edits outside `src/`, destructive shell, network)
  require explicit user approval — state the exact command first.
- Policy/audit/memory schemas are frozen by `docs/moat/00-convergence.md`;
  changing them needs a recorded ruling, not a drive-by edit.

## Definition of done

1. `npm run lint`, `npm run typecheck` and `npm test` pass.
2. `npm run build` passes.
3. Every run-affecting change prints or preserves cost receipts
   (`tokens / model mix / $`).
4. Findings and strategy go in `docs/moat/`; the single bet stays in
   `docs/moat/00-convergence.md`; the build order stays in `docs/roadmap.md`.
   Update them when decisions change — no shadow roadmaps.
