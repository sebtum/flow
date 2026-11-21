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
- Open the task record `.workflow/<task>.md` (task records are `.workflow/*.md` except `roadmap.md` and `*.log.md`; ask if several match). Read the Spec and the named milestone. For `fix M<n>`, also read that milestone's latest Findings. Your own notes are in `.workflow/<task>.log.md`.
- If the milestone is missing or underspecified, stop and suggest `/flow:plan M<n>`. Do not plan it yourself.
- Check `git status --short`; don't touch pre-existing changes listed in Baseline.
- Treat a milestone as done only when its newest Findings block (from either verifier) was taken at the current `git rev-parse --short HEAD`, has no "+ uncommitted", and lists no open Defects and no Blocked checks (or the user explicitly accepted them). If the named milestone depends on one that isn't done, say so and suggest `/clear` then the judge for that milestone before continuing.
- **Fix limit:** for `fix M<n>`, count the fix rounds already recorded in your log for M<n>. If this one would exceed Spec → `Fix rounds` (default 2), stop. Say which Defects are still open and suggest `/clear` then `/flow:plan M<n>`, where the user accepts the gaps, cuts scope or re-plans.

## 1. Implement
- Follow the plan and repo conventions. Keep the diff focused: no unrelated refactors, no silent contract changes.
- **Your lane:** application code and tests. Never edit files under Spec → `Contract path` or `QA path`. In a fix, never change or delete existing tests; adding tests or test cases is fine. A hook enforces this. If a contract, QA script or existing test looks wrong, stop, explain it in two or three lines, and suggest `/flow:plan <question>`.
- Implement against the contract files named in the milestone: they define names, inputs, outputs and errors.
- Scenarios are the acceptance criteria. Make each one true and test it.
- One writer per file. If the milestone has no `T<n> [W<n>]` task lines, or this is a fix, work directly and skip the next bullet.
- **Tasks in waves** (the milestone lists tasks). You are the lead: you run the waves, integrate the work and run the checks. You don't write task code yourself.
  1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/lane.js" tasks --task .workflow/<task>.md --milestone M<n>`. If it lists problems, stop and suggest `/flow:plan M<n>`.
  2. For each wave in order:
     - `node "${CLAUDE_PLUGIN_ROOT}/scripts/lane.js" start execute --task .workflow/<task>.md`
     - Spawn one Agent per task of the wave, all in a single message: `subagent_type: general-purpose`, `model: sonnet`. Use the prompt below.
     - When all have reported: `node "${CLAUDE_PLUGIN_ROOT}/scripts/lane.js" check execute --task .workflow/<task>.md --milestone M<n> --wave W<n>`, then the unit tests and `contract.js --static`.
     - If a task is blocked or a check fails, fix small integration problems yourself (imports, wiring), within your lane. Otherwise stop before the next wave and report.
  3. Agent prompt, filled in for each task:
     ```
     You implement task <T<n>> of milestone <M<n>> in <repo path>.
     First, before any edit, run: node "${CLAUDE_PLUGIN_ROOT}/scripts/lane.js" claim <T<n>> --task .workflow/<task>.md --milestone <M<n>>
     A hook refuses your edits until you have claimed the task, and afterwards it refuses edits outside the files the task owns.
     Task: <what>. Owns: <globs>. Scenarios (your acceptance criteria): <the Gherkin text of each>.
     Contract files to implement against (read-only): <files>. Code from earlier waves you build on: <files>.
     Conventions: <test command, style, patterns to follow>.
     Write tests for your scenarios and their failure cases. Run the unit tests for your files. Don't weaken or delete tests.
     If you need a change outside your files, don't make it: describe it under Problems.
     Reply with exactly:
     T<n> report
     - Status: done | blocked (<why>)
     - Changed: <files>
     - Tests: <tests added>
     - Checks: <command → result>
     - Problems: <needed changes outside your files, contract doubts, or —>
     ```
  4. Write each report, shortened, to your log under `### M<n>`.
- Add or update tests for the changed behaviour and its failure paths. Never weaken or delete tests to get green.
- Run focused checks while working and the milestone's full relevant checks at the end, using the commands in Spec → Checks. In standard and full mode, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/contract.js" --task .workflow/<task>.md --static` before reporting. A Stop hook runs it too and sends you back once if it fails.
- Consequential ambiguity (changes behaviour, contracts or scope) → stop, explain it in two or three lines, and suggest `/flow:plan <question>`. Decide routine choices yourself.

## 2. Record
Write only to `.workflow/<task>.log.md` (create it if missing; one `### M<n>` block per milestone): status, changed files, checks run (command → result, revision), notes and remaining gaps. For fixes, write `fix round <k>` and list which findings were addressed. Don't paste logs or narratives. Don't edit the Spec, except to append unfinished or newly discovered follow-up work to Spec → **Next steps** (with the reason). Any other Spec change is `/flow:plan`.

## 3. Report (short)
- What behaviour changed, and the key control flow to read first (file:line).
- Trade-offs made.
- Verification evidence (commands and results). Say plainly what wasn't run.
- Remaining gaps.
- Commit only if the user authorized it.
- End with the next command, after `/clear`:
  - New milestone: the first gate that applies, in the order clean → harden → qa (all three in full mode, otherwise the milestone's `Gates:` line), e.g. `/flow:clean M<n>`. With no gates: the milestone's judge, `/flow:verify M<n>` or `/flow:verify-codex M<n>` (from its `Judge:` line; default verify, verify-codex in full mode).
  - Fix: always the judge. The gates don't run again after a fix; the judge reruns their checks.

Near the end of the time budget: stop adding features, get what exists green, and move what's left to Spec → Next steps.
