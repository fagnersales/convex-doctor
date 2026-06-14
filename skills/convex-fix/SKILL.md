---
name: convex-fix
description: Drive convex-doctor's group-by-group fix loop on a Convex project — lock one rule code at a time, fix every site, re-scan to verify, and commit per group until the codebase is clean. Use when the user wants to fix convex-doctor findings, resolve Convex anti-patterns (await-in-loop, unbounded collect, filter-in-query, returns-validator drift, …), or "run convex-doctor and fix what it finds". Optional arg: a single rule CODE, a category, or `--convex-dir <path>`.
---

# convex-fix

Fix a Convex codebase the way convex-doctor is meant to be driven: **one rule code at a time**, not all-files-at-once. A *group* is every issue sharing a code; the fix inside a group is one repeatable recipe. Lock a group → fix every site → re-scan to verify → commit → next. The loop converges to zero with clean, per-group, reviewable commits.

## Invocation

The tool is published as `@fagnersales/convex-doctor` and runs on Bun.

- Prefer a local install if present (`bunx convex-doctor` resolves it); otherwise use `bunx @fagnersales/convex-doctor`. Pick one form at the start and use it throughout — call it `DOCTOR` below.
- Default convex dir is `convex`. If the project's is elsewhere (e.g. `backend/convex`), pass `--convex-dir <path>` to **every** call.

**Args** (all optional):
- a single rule `CODE` (e.g. `AWAIT_IN_LOOP`) → fix only that group, then stop.
- a category (e.g. `performance`) → fix only groups in that category.
- `--convex-dir <path>` → non-default convex location.

## Preflight

1. Confirm you're in a Convex project (a `convex/` dir with `schema.ts`, or the path the user gave).
2. **Check git is clean** (`git status --porcelain`). If dirty, tell the user and ask whether to proceed (uncommitted work will get swept into the per-group commits) or stop so they can stash. Per-group commits depend on a clean starting tree.
3. Do **not** create a branch. Commit on the current branch (respect the user's git preferences).
4. Find the project's green-gate command — its typecheck/test/lint step (check `package.json` scripts for `typecheck`, `test`, `lint`, or a `tsc`/`tsgo` call). If none exists, note that and skip the gate (still re-scan to verify).

## The loop

Repeat until `groups` reports `done: true` (or the user's arg-scoped groups are all done):

1. **List groups**

   ```bash
   DOCTOR groups --json [--convex-dir <path>]
   ```

   Parse `{ done, groupCount, groups[] }`. If `done`, stop — announce the codebase is clean. Otherwise pick the **top** group (the array is already priority-ordered: errors → warnings → info). If the user scoped to a CODE/category, pick the first matching group and ignore the rest.

2. **Announce the lock.** State the `code`, `count`, `files`, and `autofix` tag so the user can follow. Let the tag set your effort:
   - `mechanical` — the edit is fully determined; apply it directly.
   - `guided` — deterministic recipe; open each file and read the handler/schema context before editing.
   - `manual` — architectural/judgment. If the fix needs a design decision you can't make safely, **skip this group**, record why, and move on (see Stopping).

3. **Load a bounded batch of sites** — never pull the whole group at once; a big
   group (hundreds of sites) would flood your context.

   ```bash
   DOCTOR --only <CODE> --json --limit 25 [--convex-dir <path>]
   ```

   Response shape: `{ total, returned, remaining, rule, sites[] }`.
   - `rule` carries the shared recipe **once**: `why`, `fix`, `docUrl`, `autofix`.
   - each `site` has `file`, `line`, `function`, `message`, an optional concise
     `fixCode` (validator edits), and a `pointer` ({line, column, length}).
   For lint-style groups there's no per-site `fixCode` — open `file` at `line`,
   apply the `rule.fix` recipe, keep edits faithful to the surrounding style.
   Fix every site in the batch.

4. **Verify / advance — re-scan the same group**

   ```bash
   DOCTOR --only <CODE> --json --limit 25 [--convex-dir <path>]
   ```

   **Re-scanning is the cursor.** The sites you just fixed are gone, so this
   returns the next batch (and surfaces any *new* issue your edits introduced).
   Repeat 3–4 until `total` reaches **0** — only then is the group complete. Keep
   `--limit` small enough that each batch fits comfortably in context.

5. **Green-gate.** Run the project's typecheck/test command found in preflight. If it fails, **stop the loop**, report the failure and the diff, and let the user decide. Never commit over a red gate.

6. **Commit this group alone**

   ```bash
   git add -A
   git commit -m "fix(convex): resolve all <CODE> (<n> sites)"
   ```

   One group per commit — never mix codes. End the commit body with the project's usual co-author trailer if it has one.

7. **Go to 1.**

## Rules of engagement

- **One group per commit.** This is the whole point — keep the history bisectable and revertable.
- **Always re-scan before committing.** Step 4 is the proof the fix landed; don't trust the edit alone.
- **Never commit over a failing green-gate.**
- Don't widen scope: fix the locked code's sites only. If you spot an unrelated problem, note it for later — don't fold it into this commit.

## Stopping

Stop and summarize when any of:
- `groups` reports `done: true` (or all arg-scoped groups are resolved).
- A `manual` group needs a decision you can't make — skip it, finish the rest, then list what was skipped and why so the user can decide.
- The green-gate fails after a group's edits.

End with a short summary: which groups were fixed (and commit hashes), which were skipped and why, and the remaining `groups` output so the user sees what's left.
