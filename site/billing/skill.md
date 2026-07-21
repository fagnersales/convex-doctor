---
name: convex-watchdog-it
description: "Cost-aware Convex debugging against your local watchdog's billing data. No args: full cost sweep of the current project. With a question: scoped diagnosis, e.g. /convex-watchdog-it check if this new function has any potential issue."
disable-model-invocation: true
---

# convex-watchdog-it

Join the user's real Convex billing data (collected locally by their watchdog —
spec: https://convex-doctor.fagner.ink/billing/llms.txt) with the source code in
the current repo. The watchdog dashboard already says WHAT costs money; your job
is WHY — found in the code — and what to do about it.

This file is the forkable reference (https://convex-doctor.fagner.ink/billing/skill.md).
Install it globally (e.g. `~/.claude/skills/convex-watchdog-it/SKILL.md`) so it works
from any repo. Keep `disable-model-invocation: true` — this skill reads billing data
and must only ever run because the user asked.

## Ground rules (non-negotiable)

- **Advise + offer.** Never edit code, never append interventions, never deploy,
  never install anything as part of this skill. Diagnose, recommend, then offer —
  the user accepts or they don't.
- **Data honesty.** Billing rows are daily; today's row is partial and updates
  ~hourly. Anything based on fewer than 2 full days is a *preliminary read* —
  label it so. Always state the data's as-of time (from `data/last_run.json`).
- **Privacy.** The data dir holds real billing numbers. Discuss them with the user
  freely; never commit them to a repo, never publish them, never send them to
  external services.
- **Dollars, not gigabytes.** Convert findings to $/month using the install's
  pricing config (the collector keeps one; else the table in the spec).

## Step 1 — find the watchdog

1. Read `~/.convex-watchdog/location.json` → `{"path": "...", "team": "..."}`.
2. Fallback: a `convex-watchdog` directory under the user's usual project root;
   if still not found, ask the user where it lives.
3. Read the install's `AGENTS.md` — it maps that install's operations (refresh,
   log an intervention, open dashboard, update). Prefer its commands over guessing.

If `last_run` is older than ~6 hours, say so and offer to run the install's
refresh operation before diagnosing (don't run it unasked).

## Step 2 — load the picture

From the install's `data/` dir: `summary_mtd.json` (billed truth),
`daily.json` (per-project daily series), `functions_daily.json` (per-function
daily series), `interventions.jsonl` (what's already been tried and how it went).

Resolve which Convex project the current repo is: match the repo name and its
Convex config against the projects map in `daily.json`; if ambiguous, ask.
If the current repo isn't a Convex project at all, run team-wide.

## Step 3 — answer in the right mode

### No specific question → sweep

Deliver, ranked by dollar impact, for the resolved project (or the team):

1. Tier trajectory — MTD, projection, which tiers cross and when, projected overage $.
2. Top cost drivers — functions by IO / calls / egress, each with KB-per-call vs
   the fleet median and its own trend.
3. Anomalies currently active (from the latest collect).
4. Open interventions — anything still `watching`, plus verdicts the user may not
   have seen yet.
5. "What I'd look at first" — 1–3 items, each with the code-level suspicion,
   after actually opening the source.

### Scoped question → diagnose

Resolve what the user means ("this new function", a pasted name, the change in
front of you) to function name(s) in the data — fuzzy-match `file.js:fn`, and
check `git diff` / recent commits when they say "this change".

1. Pull its numbers: calls/day, KB/call vs its own baseline and the fleet median,
   first-seen date, trend, share of project cost.
2. **Read the actual source** and check the cost smells below.
3. Verdict: what it costs now, what it costs at trend, whether that shape is
   justified by what the code does, and the cheapest structural fix if not.

If the data doesn't have it yet (deployed < 1 full day ago), say so, do a
static-only read labeled preliminary, and offer to re-check when full days exist.

## Cost smells to check in the source

- `.collect()` / `.filter()` on a query without `.withIndex` — full-table scan per
  call. The #1 real-world bill spike, often a *regression* (an index arg dropped
  in a refactor). Cross-check: did KB/call jump at a deploy date?
- Over-fetch: returning whole documents where the caller needs a few fields
  (KB/call far above what the UI could possibly render).
- Reactive over-subscription: a hot table invalidating broad queries → uncached
  query storms (look at the cached vs uncached call mix).
- Cron/interval cadence: many calls, tiny KB/call — the frequency is the cost,
  not the payload (a calls-tier problem, not bandwidth).
- Per-item fanout: a mutation/action per element where one batch would do.
- Actions moving big payloads (files/base64 through functions) → action compute
  and egress at once.
- A new function whose KB/call lands at the fleet's P90+ from day one — designed
  expensive rather than regressed; different fix conversation.

## End with offers, not actions

Close every run with the applicable subset:

- "Want me to write the fix?" — only touch code after a yes.
- "When you deploy it, log an intervention (your watchdog's AGENTS.md has the op)
  so the collector measures whether it actually worked."
- "Ask me to re-check in N days when full post-deploy data exists."
