---
name: execute
description: Implement one milestone from the task record, or fix its verify findings.
argument-hint: "[M<n> | fix M<n>]"
model: sonnet
disable-model-invocation: true
---

# /flow:execute

Input: $ARGUMENTS

## 0. Load
- Open the task record `.workflow/<task>.md` (ask if several match). Read the Spec and the named milestone. For `fix M<n>`, also read that milestone's latest Findings. Your own notes are in `.workflow/<task>.log.md`.
- If the milestone is missing or underspecified, stop and suggest `/flow:plan M<n>`. Do not plan it yourself.
- Check `git status --short`; don't touch pre-existing changes listed in Baseline.
- Treat a milestone as done only when its newest Findings block (from either verifier) was taken at the current `git rev-parse --short HEAD`, has no "+ uncommitted", and lists no open Defects (or the user explicitly accepted them). If the named milestone depends on one that isn't done, say so and suggest `/clear` then `/flow:verify M<k>` before continuing.

## 1. Implement
- Follow the plan and repo conventions. Keep the diff focused: no unrelated refactors, no silent contract changes.
- One writer per file. Work directly by default.
- Parallel tasks: only if the Spec marks them with disjoint owned files. Then spawn one Agent per task in a single message, `subagent_type: general-purpose`, `model: sonnet`. Give each agent the task, its acceptance criteria, its owned files, and the relevant conventions. It may edit only its owned files. You integrate and run the checks afterwards.
- Add or update tests for the changed behaviour and its failure paths. Never weaken or delete tests to get green.
- Run focused checks while working and the milestone's full relevant checks at the end, using the commands in Spec → Checks.
- Consequential ambiguity (changes behaviour, contracts or scope) → stop, explain it in two or three lines, and suggest `/flow:plan <question>`. Decide routine choices yourself.

## 2. Record
Write only to `.workflow/<task>.log.md` (create it if missing; one `### M<n>` block per milestone): status, changed files, checks run (command → result, revision), notes and remaining gaps. For fixes, list which findings were addressed. Don't paste logs or narratives. Don't edit the Spec, except to append unfinished or newly discovered follow-up work to Spec → **Next steps** (with the reason). Any other Spec change is `/flow:plan`.

## 3. Report (short)
- What behaviour changed, and the key control flow to read first (file:line).
- Trade-offs made.
- Verification evidence (commands and results). Say plainly what wasn't run.
- Remaining gaps.
- Commit only if the user authorized it. End with: `/clear` then `/flow:verify M<n>`.

Near the end of the time budget: stop adding features, get what exists green, and move what's left to Spec → Next steps.
