# Provider reference

The registry holds **134 builtins** (`codewhip provider list`). This document
is the detail behind the README's one-paragraph summary: which providers are keyed or keyless, and the honest caveats on free tiers.

Curation rules (how a provider earns a row, and how it gets removed):
[`moat/17-provider-curation-policy.md`](moat/17-provider-curation-policy.md).

## Picking a provider

Every run names its destination explicitly: `--provider <id>` (or
`--provider:model <id>:<model>`). There is no auto-routing and no free-chain — the meter prices what you picked and says `cost untracked`
for anything it cannot price. Store a key first with
`codewhip auth login <id>` (env var wins when set, which is CI-friendly).

## Keyless and free-key gateways

| Provider | Keyless? | Env var | Key URL |
|---|---|---|---|
| kilo | yes — `:free` models are fully anonymous | `KILO_API_KEY` (optional) | https://kilo.ai |
| opencode | yes — Zen's anonymous `public` key + identity headers, handled by codewhip | `OPENCODE_API_KEY` (optional) | https://opencode.ai/zen |
| empero | yes — openly free endpoint (`free` placeholder key); see maintenance note | `EMPERO_API_KEY` (optional) | https://free.empero.org |
| groq | free key required | `GROQ_API_KEY` | https://console.groq.com/keys |
| cerebras | no longer free — see removal note | `CEREBRAS_API_KEY` | https://cloud.cerebras.ai |
| openrouter | free key required | `OPENROUTER_API_KEY` | https://openrouter.ai/keys |
| gemini | free key required | `GEMINI_API_KEY` | https://aistudio.google.com/apikey |
| zai | free key required | `ZAI_API_KEY` | https://z.ai |
| nvidia | free key required (~40 req/min, $0) | `NVIDIA_API_KEY` | https://build.nvidia.com/settings/api-keys |
| mistral | free key required (evaluation-grade free mode: RPS + token caps — check Limits) | `MISTRAL_API_KEY` | https://console.mistral.ai |
| sensenova | key required | `SENSENOVA_API_KEY` | https://token.sensenova.ai |
| alibaba | key required | `ALIBABA_API_KEY` | https://dashscope-intl.aliyun.com |
| tokenharbor | key required (free account works, `thk_…`) | `TOKENHARBOR_API_KEY` | https://tokenharbor.ai/dashboard/api-keys |
| bai | key required (paid, metered per model) | `BAI_API_KEY` | https://chat.b.ai/chat |
| fabryka | free key, then $0.20/$0.60 per 1M in/out (single reasoning model, concurrency 1) | `FABRYKA_API_KEY` | https://router.fabryka.ai |

The bare default (`run` with no flags) routes to nvidia and needs its key — for
a $0 start with no keys use `--provider llm7` (anonymous, rate-limited). Env wins when set (CI-friendly).

A further **18 free-key tiers** joined the registry on 2026-09-13 (harvested
from freellm.net and peer directories, each cross-checked against a second
source): `cloudflare`, `modelscope`, `ovhcloud`, `ollama`, `cohere`,
`siliconflow`, `aionlabs`, `agnes`, `requesty`, `inference`, `hetzner`,
`venice`, `scaleway`, `friendli`, `nscale`, `nebius`, `ai21`, `coze`. All 18
require a key — none runs keyless — so they run only once you add one. Their `defaultModel` values are catalog-derived rather than
live-probed (confirm with `codewhip models <id>`), and `cloudflare`
additionally needs `CLOUDFLARE_ACCOUNT_ID`, because Workers AI scopes its API
by account id.

## Trial-credit and paid gateways

Signup grants are not permanent free tiers; pay-go gateways bill from the first call.

| Provider | Why not in free tier | Reach it |
|---|---|---|
| `1min` | credit-metered from the first call; also the only non-OpenAI builtin (see below) | `--provider 1min`, key `ONEMIN_API_KEY` |
| `hcnsec` | New API relay; free allowance is a console quota, not a fixed grant | `--provider hcnsec`, key `HCNSEC_API_KEY` at `https://api.hcnsec.cn/console` |
| `hashneuron` | RouteOpen gateway; calls past the daily 500k grant draw on a paid balance instead of rate-limiting | `--provider hashneuron`, key `HASHNEURON_API_KEY` at `https://hashneuron.space/#keys` |
| `codiv` | diffusion-LM host; 10M-token grant "while the experiment runs" (renewability unconfirmed) | `--provider codiv`, key `CODIV_API_KEY` at `https://codiv.ai/signup` |
| trial-credit aggregators (`together`, `deepinfra`, `fireworks`, `cometapi`, `mkeai`, `apiyi`, `xai`, `novita`, and others) | one-time signup grants are not free tiers | `--provider <id>` |
| `wrouter` (AccelsRouter) | trial credit for new accounts | `--provider wrouter`, key `WROUTER_API_KEY` at `https://router.accels.tech/register` |
| `arouter` (ARouter) | keyed gateway, no verified free tier | `--provider arouter`, key `AROUTER_API_KEY` at `https://api.arouter.ai` |

Relays and aggregator gateways see every prompt in plaintext — **never send secrets
through them**. A relay's served set shifts, so relay rows default to the
gateway's own routing id (`auto`, `default`) rather than a pinned model that
would 404.

## Rows that were corrected, not kept

Three rows were repaired on 2026-09-13 because they had stopped being truthful:
`cerebras` (now needs a verified card, grant expires in 30 days) and `chutes`
(pay-per-token since 2026-03) both left the free tiers — and `lepton` was removed outright (Lepton AI ceased operations
2025-05-20; `api.lepton.ai` no longer resolves). `cerebras` and `chutes` stay
usable via `--provider`; they are simply no longer *free*.

`empero` has been in a **declared maintenance window** since at least
2026-09-11; re-probed 2026-09-14 it returns a consistent 503 with
`code: "maintenance"` and the message "we are switching the free endpoint to
new models". Its own notice says the served
**models are changing**, so both its `defaultModel` and its `$0` price entry
need re-verifying when it returns.

## Non-OpenAI wire: the 1min adapter

`1min` (added 2026-09-13) is the first builtin that is **not**
OpenAI-compatible, so it does not ride the shared HTTP port at all. Its row
carries `port: "onemin"` and `src/onemin.ts` translates: one flattened prompt
string instead of a `messages[]` array, an `API-KEY` header instead of
`Bearer`, a required `type: "UNIFY_CHAT_WITH_AI"` discriminator, the reply
unwrapped from `aiRecord.aiRecordDetail.resultObject`, and — because 1min
returns no `usage` block — token counts that are always labelled **estimated**
on the receipt.

Because 1min has no wire-level function calling, tool use is **emulated**: tool
specs are rendered into the prompt and the model is asked to reply with a
`tool_call` block carrying the name and JSON arguments, which codewhip parses
back out. This is best-effort — it depends on the model cooperating. A model
that ignores the instruction degrades to plain text rather than failing.
Responses are non-streaming, because such a block can be split across SSE
deltas and whole bodies keep the parse reliable.

## Pricing on the receipt

Every free-tier default is priced `$0` — never fiction-priced, and non-free
models on the same gateway print `cost untracked`. A loopback local runtime is
priced `$0` too: that is a fact about your own machine rather than a guess, and
there is no provider console to go and check.

Free tiers are **rate-limited** (openrouter: 50 req/day without credits; groq:
~30 req/min per model; opencode zen: small per-IP anonymous quota) and
free-model status can be **time-limited** (zai's `glm-5.3-flash` is a promo —
expect quota errors when it ends). Free tiers may use your data for
**provider-side model improvement** — never send private or production code on
free tiers.
