# Steve Jobs Review: The System Prompt Rewrite

**Date:** 2026-09-12
**Scope:** `src/system.ts` (SYSTEM_PROMPT, 1073 → 805 chars), `src/tools/registry.ts`
(bash + webfetch specs), and the question under it: does CodeWhip need a
web-search tool?
**Verdict:** Ship the rewrite. Then stop polishing prose and fix the tool the
prose is apologizing for.

---

## The One-Sentence Verdict

The prompt is now honest about failure — but the tool is not yet *useful* in
failure. You taught the model to vary its approach and took away the map.

---

## What's Right (ship it)

**1. The two-failure taxonomy is the best sentence in the file.**
"A policy denial is final; a transient failure is a problem to work." This is
not prompt-hedging, it's a classification — and it matches what the harness
actually does (fail-closed policy vs. the world being broken). Every agent
prompt I've read conflates these, and the conflation produces exactly the
failure you observed: the model treats a 403 like a no from God and goes home.
Denied → never retry. Failed → vary. Two verbs, no ambiguity. That's writing.

**2. You deleted the right things.**
The old prompt restated what the tool specs already say — write semantics,
redirection lists, shell syntax. The specs are re-read every turn; the prompt
is re-sent every turn. Duplicating a fact across both isn't just wasted tokens,
it's two places to drift out of sync. One authority per fact. Correct.

**3. The comment is longer than the prompt and that's fine.**
Comments are free; prompt bytes are metered on every call. Recording the
observed linux.do failure next to the code that prevents it is how a lesson
survives its author. Do this everywhere.

**4. "Never fake success" — right words.**
Giving up quietly *is* a form of faking. Naming it as dishonesty instead of
laziness is what makes the instruction bite.

---

## What's Wrong (three things, in descending weight)

**1. "Vary the URL" has no vehicle. This is the real finding.**
Read `src/tools/webfetch.ts`. In the default `text` format, `stripHtml`
deletes every tag — including anchors. I reproduced it:

```
<a href="https://example.com/api/v2">API v2 reference</a>
→ "API v2 reference"          (href destroyed)
```

So when the model lands on a login wall, a moved docs page, or a results page,
the tool hands it prose with the exits removed. Then the spec tells it to
"vary the URL — different path, a JSON/reader endpoint." Vary to *what*? The
model's only remaining move is guessing URLs from memory — which is what it
was doing when it gave up on linux.do, just with more steps.

The friction is not in the prompt wording. It's in the capability gap the
wording papers over. Fix it in code, ~6 lines: preserve anchors as
`[text](url)` before the tag-strip, decode entities inside link text. Now
"vary" has a map — links survive, a results page yields title—url—snippet
lines, the model can follow a citation. The 6000-char output cap already
keeps this cheap.

**2. You lumped two different failures into one instruction.**
webfetch already returns distinct, honest messages (`HTTP 403 from {origin}`,
`HTTP 404`, `timed out`, `fetch failed`). But the spec teaches one response to
all of them: vary. A 404 or timeout usually means *your* URL is wrong — vary
away. A 403 from a host that serves browsers means the host refuses agents —
no path variation helps, and every retry burns the meter (30s timeout,
`--max-steps 25`, token budget) against a wall that doesn't move. Your $0
brand cannot afford three retries into Cloudflare. One clause fixes it:

> 404/timeout/network → vary the URL. 403/429 → the host refuses agents;
> another path won't help — another source, or report honestly.

And "a JSON/reader endpoint" is advice pointing at unnamed third-party
services — smuggled into a spec without a recorded decision. Name the pattern
or cut it. I'd cut it; the wall-vs-wrong distinction does the work.

**3. There is no stop condition.**
The old failure was under-trying. Your fix can over-correct into thrash: a
model that learned "don't give up" will spend its 25 steps and its budget
inventing variants. One clause: "two honest variants of the same approach,
then report." A policy that says *try harder* without saying *when to stop*
just relocates the failure.

**Nits:**
- System line 1 ("Shell runs one plain command per call (chaining/redirect
  denied)") duplicates bashSpec. Your own architecture says specs are the
  authority. Say it once — trust the spec.
- "tool error" in the transient list is vague; every tool failure is a tool
  error. Cut it or say which.
- The deleted jewel — "Destructive commands are blocked by the harness, not by
  instruction — never restate policy as promises" — I'd let go. "Never fake
  success" + "receipts are the harness's job" carry the honesty cluster in
  fewer words, positively framed. But note the loss so the next editor doesn't
  think the honesty was an accident.

---

## Websearch: No. You already have it.

The razor: the observed failure was not "no search tool." It was "one fetch,
one wall, quit." The rewrite fixes that for zero scope. Adding a search tool
now would be solving the demoable failure ("look, it searches!") instead of
the observed one, and it would break the house law — everything is earned by
user pain, not imagined (SOUL.md creed 6).

Here's what nobody said out loud: **webfetch takes any https URL, and a search
results page is an https URL.** The model can fetch a keyless results page
(duckduckgo's html endpoint — links are redirect-wrapped; decode the `uddg`
param or accept the hop) *today*: no key, no account, no dependency. What's
missing is the result URLs — which is bug #1 above. Fix link preservation and
codewhip has search for free, inheriting the entire trust floor as-is:
https-only, ask-gated per origin (the user sees and approves exactly what
leaves), audit-logged, output-capped, redacted. Children can't use it —
correct; the parent fetches and passes content. The failure policy's
"another source" promise becomes keepable.

Be honest about the trade: keyless scraping is gray-zone and fragile. Fine —
*if* it fails honestly ("upstream blocked — give me a URL"), which the failure
policy now guarantees, and *if* the evidence channel decides when it's not
enough. That channel exists: `outcomes.jsonl` will count runs that stall on
"needed a source." When the pain shows up in the meter, ship the tool.

**The minimal delightful websearch (when earned):**

- `query` → top 5 lines: `title — url — snippet`. No page content. Finding and
  reading are different tools; each stays honest and small (webfetch reads).
- <150 lines, Node builtin fetch, no deps, no key, no account. $0 or it
  doesn't ship.
- Same trust floor as webfetch: https-only, ask-gated, audit-logged,
  output-capped, depth-0 only (`toolSpecs` already has the pattern).
- The detail that makes it *yours*: run the secret redactor over the query and
  refuse key-shaped input. A search box is an exfil hose pointed at a third
  party's logs. Nobody in this category does that. It's one regex. It's the
  brand.
- Honest, classified failures — the failure policy does the rest.

What not to build: a browsing agent. Search is a door out of a dead end, not a
room in the house. The wedge is prod-adjacent code at 2am.

---

## The Friction, Located

| Layer    | Friction                                        | Fix                                          |
|----------|-------------------------------------------------|----------------------------------------------|
| Tool code| text mode strips links — "vary" has no map      | preserve `[text](url)` in `stripHtml` (~6 lines) |
| webfetch spec | 403 and 404 taught the same response       | one clause: wall ≠ wrong URL; cut "JSON/reader endpoint" |
| system prompt | "vary" has no stop condition               | "two honest variants, then report"           |
| system prompt | line 1 duplicates bashSpec                 | delete the clause, trust the spec            |
| Product  | "another source" promised, no discovery behind it | free via the link fix + search-URL pattern; real `websearch` earned later via outcomes.jsonl |

---

## Ship Order

1. `stripHtml` link preservation — code, not prose (~6 lines + a test).
2. webfetch spec: wall-vs-wrong-URL clause.
3. system prompt: stop-condition clause; drop the shell duplication.
4. websearch: not now. The meter decides.

---

## Final Word

This is the first prompt in this repo that behaves like a product decision
instead of a wish list. It says no to retrying denials, no to faking success,
no to duplicating specs. It spent its 25% savings on the one distinction that
was costing real tasks.

But a prompt that says "vary the approach" wired to a tool that deletes the
links is a mission statement screwed onto a broken elevator. The words are
done. The elevator isn't. Fix `stripHtml`, split 403 from 404, give "vary" a
stop sign — three edits, two of them one clause — and this rewrite goes from
honest to *effective*. Honest is table stakes. Effective is the product.

— *Steve*
