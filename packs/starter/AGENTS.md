# AGENTS.md (starter pack excerpt)

- read-mostly, ask-before-destructive, never-exfiltrate.
- Never publish (`npm publish`), mutate infra (`terraform apply`,
  `kubectl delete`), or push to `main` without an explicit human `y`.
- `.env*` files are not editable — rotate secrets out of band.
