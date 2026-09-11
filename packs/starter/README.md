# starter pack

One starter team pack: sensible denies for publishing, infra mutation, and
secret files. Local-file v1 — no registry, no network.

```sh
codewhip pack list            # packs shipped with this install
codewhip pack pull starter    # copy packs/starter/policy.md -> ./policy.md
codewhip pack pull starter --force   # overwrite an existing policy.md
codewhip policy list          # what the engine enforces from next run
```

Versioned team packs with fork/override ranking and private hosting are the
H2 pack registry (`docs/roadmap.md`) — this directory is its seed format:
`pack.json` (name/version/description) + `policy.md` (deny lines) +
`AGENTS.md` (conventions excerpt).
