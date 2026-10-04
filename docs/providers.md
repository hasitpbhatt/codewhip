# Provider reference

There are **no builtin providers**. Every provider is user-registered with
`codewhip provider add <id> --base-url <https origin> --model <m> --env-var <VAR>`.
Keys live in an owner-only file (or env, which wins) and `codewhip auth status`
never prints one. Every provider is explicit: name it with `--provider <id>`
(or `--provider:model <id>:<model>`) and store its key with `codewhip auth login <id>`.

There is no auto-routing and no free chain — you pick the destination, the meter
prices it honestly, and the receipt says `cost untracked` when the route has no
known price.

## Custom providers (any OpenAI-compatible endpoint)

The only way to add a provider is:

```sh
codewhip provider add my-gw --base-url https://gateway.example.com --model my-model --env-var MY_GW_API_KEY --key-url https://gateway.example.com/keys
codewhip auth login my-gw
codewhip run "Say OK" --provider my-gw
```

### Flags

| Flag | Required | Description |
|---|---|---|
| `--base-url` | yes | HTTPS origin (no trailing slash). Loopback `http://` allowed only for local runtimes (Ollama, vLLM, LM Studio). |
| `--model` | yes | Default model id (e.g. `gpt-4o-mini`). |
| `--env-var` | yes | UPPER_SNAKE env var name (e.g. `MY_GW_API_KEY`). |
| `--key-url` | no | Where to get the key (printed by `provider show`). |
| `--chat-path` | no | Default `/v1/chat/completions`. |
| `--models-path` | no | Default `/v1/models`. |
| `--timeout-ms` | no | Per-call budget (default 45000ms; range 5000..600000). |

### Trust rules

- **Relays/aggregators**: if you point at a relay that routes to upstream models, that relay sees every prompt in plaintext. Never send private or production code through an aggregator you do not control.
- **Free tiers**: many free tiers train on prompts or log them. Read the provider's policy before sending sensitive code.
- **Account-scoped base URLs**: if your base URL contains a placeholder (e.g. `{ACCOUNT_ID}`), that env var must be set before the provider works.

### Listing and removing

```sh
codewhip provider list                # all registered providers with enabled model counts
codewhip provider show my-gw          # base URLs, default model, env var, key URL
codewhip provider remove my-gw        # forget a provider (requires re-login if you want it back)
```

### Curation policy

There is no builtin curation — the trust boundary is your registration. See
[`moat/17-provider-curation-policy.md`](moat/17-provider-curation-policy.md) for the historical rules that governed the removed builtin registry.
